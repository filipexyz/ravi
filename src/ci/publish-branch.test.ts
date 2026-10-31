import { afterEach, beforeEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPublication, publishPlan, type GitApi, type PublishPlan } from "./publish-branch.js";

let cwd: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ravi-publish-test-"));
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("remote", "add", "origin", "https://github.com/example/fixture.git");
  writeFileSync(join(cwd, "delete me"), "old");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  rmSync(join(cwd, "delete me"));
  writeFileSync(join(cwd, "binary file"), Buffer.from([0, 255, 1]));
  writeFileSync(join(cwd, "executable"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(cwd, "executable"), 0o755);
  symlinkSync("executable", join(cwd, "link"));
  git("add", ".");
  git("commit", "-qm", "work");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function backend(
  plan: PublishPlan,
  options: { existing?: boolean; badBlob?: boolean; badTree?: boolean; moved?: boolean } = {},
) {
  const calls: Array<{ method: string; endpoint: string; body: unknown }> = [];
  const api: GitApi = (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === "GET" && endpoint.includes("matching-refs"))
      return options.existing
        ? [{ ref: `refs/heads/${plan.branch}`, object: { sha: options.moved ? "new-head" : plan.base } }]
        : [];
    if (method === "GET") return { tree: { sha: plan.baseTree } };
    if (endpoint.endsWith("/blobs")) {
      const blob = body as { encoding: string; content: string };
      expect(blob.encoding).toBe("base64");
      const bytes = Buffer.from(blob.content, "base64");
      return {
        sha: options.badBlob ? "bad" : createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      };
    }
    if (endpoint.endsWith("/trees")) return { sha: options.badTree ? "bad" : plan.tree };
    return { sha: "remote-commit" };
  };
  return { api, calls };
}

it("plans the exact committed delta, including deletes, binary, executable and symlink modes", () => {
  const plan = planPublication("fix/fixture", cwd);
  expect(plan.repository).toBe("example/fixture");
  expect(plan.changes).toEqual([
    expect.objectContaining({ path: "binary file", mode: "100644", sha: expect.any(String) }),
    expect.objectContaining({ path: "delete me", sha: null }),
    expect.objectContaining({ path: "executable", mode: "100755" }),
    expect.objectContaining({ path: "link", mode: "120000" }),
  ]);
  const { api, calls } = backend(plan);
  expect(publishPlan(plan, api, (sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd }))).toBe(
    "remote-commit",
  );
  expect(calls.at(-1)).toMatchObject({ method: "POST", body: { ref: "refs/heads/fix/fixture", sha: "remote-commit" } });
  expect(calls.find((c) => c.endpoint.endsWith("/trees"))?.body).toEqual({
    base_tree: plan.baseTree,
    tree: plan.changes,
  });
  expect(calls.find((c) => c.endpoint.endsWith("/commits"))?.body).toMatchObject({
    tree: plan.tree,
    parents: [plan.base],
  });
});

it("refuses release targets, dirty state and an unrelated base", () => {
  for (const branch of ["dev", "main", "release/v1", "fix/../dev"])
    expect(() => planPublication(branch, cwd)).toThrow();
  writeFileSync(join(cwd, "uncommitted"), "no");
  expect(() => planPublication("fix/fixture", cwd)).toThrow("worktree must be clean");
  rmSync(join(cwd, "uncommitted"));
  git("checkout", "--orphan", "unrelated");
  git("commit", "-qm", "unrelated");
  expect(() => planPublication("fix/fixture", cwd)).toThrow();
});

it("does not mutate existing refs or publish a mismatching blob/tree", () => {
  const plan = planPublication("fix/fixture", cwd);
  for (const options of [{ existing: true }, { badBlob: true }, { badTree: true }]) {
    const { api, calls } = backend(plan, options);
    expect(() => publishPlan(plan, api, (sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd }))).toThrow();
    expect(calls.some((c) => c.endpoint.endsWith("/refs"))).toBe(false);
    if (options.existing) expect(calls.some((c) => c.method === "POST")).toBe(false);
  }
});

it("only updates explicitly, from an integrated remote parent, with force false; refuses stale heads", () => {
  git("update-ref", "refs/remotes/origin/fix/fixture", "origin/dev");
  const plan = planPublication("fix/fixture", cwd, true);
  const { api, calls } = backend(plan, { existing: true });
  publishPlan(plan, api, (sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd }));
  expect(calls.at(-1)).toMatchObject({
    method: "PATCH",
    endpoint: "repos/example/fixture/git/refs/heads/fix/fixture",
    body: { sha: "remote-commit", force: false },
  });
  for (const options of [{ existing: true, moved: true }, {}]) {
    const stale = backend(plan, options);
    expect(() => publishPlan(plan, stale.api, () => Buffer.from("unused"))).toThrow("fetch and integrate");
    expect(stale.calls.every((call) => call.method === "GET")).toBe(true);
  }
  git("checkout", "--orphan", "unrelated-update");
  git("commit", "-qm", "unrelated");
  expect(() => planPublication("fix/fixture", cwd, true)).toThrow();
});

it("requires integrating dev and preserves its ancestry when updating an existing work branch", () => {
  const workBranch = git("branch", "--show-current");
  git("update-ref", "refs/remotes/origin/fix/fixture", "HEAD");
  git("checkout", "-qb", "dev-advance", "origin/dev");
  writeFileSync(join(cwd, "from-dev"), "upstream change");
  git("add", ".");
  git("commit", "-qm", "advance dev");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  git("checkout", workBranch);
  expect(() => planPublication("fix/fixture", cwd, true)).toThrow();
  git("merge", "--no-edit", "dev-advance");
  const plan = planPublication("fix/fixture", cwd, true);
  expect(plan.parents).toEqual([git("rev-parse", "origin/fix/fixture"), git("rev-parse", "origin/dev")]);
  const { api, calls } = backend(plan, { existing: true });
  publishPlan(plan, api, (sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd }));
  expect(calls.find((call) => call.endpoint.endsWith("/commits"))?.body).toMatchObject({
    parents: plan.parents,
    tree: plan.tree,
  });
  expect(calls.at(-1)?.body).toMatchObject({ force: false });
});
