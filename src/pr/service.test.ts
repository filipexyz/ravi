import { errorDiagnostic } from "../utils/error-diagnostic.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preparePublication, executePublication } from "./service.js";
import { publicationFixture } from "./test-fixture.js";
import { GithubError, type GithubRequest } from "./github.js";
import { parseCommit, LocalGit } from "./git.js";
import { ContractError } from "../cli/agent-contract.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { registerInboundSlackThread, closeSlackThreadLifecycle } from "../channels/slack/thread-lifecycle-store.js";
import { deleteSession, getOrCreateSession } from "../router/sessions.js";
import { getDb } from "../router/router-db.js";

let f: ReturnType<typeof publicationFixture>;
let state: string | null = null;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-pr-service-");
});
afterEach(async () => {
  f?.close();
  await cleanupIsolatedRaviState(state);
  state = null;
});
const mutations = () => f.calls.filter((call) => call.method !== "GET");
async function publish(request: GithubRequest = f.request) {
  const prepared = await preparePublication(f.input(), request);
  return executePublication(prepared, request, f.options);
}

function threadInput() {
  const input = f.input();
  const childKey = `${input.context.sessionKey}:thread:1.2`;
  getOrCreateSession(childKey, "test", f.cwd, { name: "publisher-thread" });
  registerInboundSlackThread({
    parentSessionKey: input.context.sessionKey,
    parentSessionName: input.context.sessionName,
    childSessionKey: childKey,
    childSessionName: "publisher-thread",
    accountId: "slack",
    instanceId: "slack-test",
    platformChatId: "C-test",
    threadCanonicalChatId: "chat-thread-test",
    providerThreadId: "1.2",
  });
  return {
    ...input,
    context: {
      ...input.context,
      sessionKey: childKey,
      sessionName: "publisher-thread",
      source: { ...input.context.source, threadId: "1.2" },
    },
  };
}

describe("publication lifecycle across object upload", () => {
  it.each(["missing", "ambiguous", "parent-missing", "root-missing"])(
    "rejects %s ownership before any GitHub request or journal",
    async (kind) => {
      f = publicationFixture();
      const input = kind === "root-missing" ? f.input() : threadInput();
      if (kind === "missing") getDb().exec("DELETE FROM slack_thread_lifecycle");
      if (kind === "ambiguous")
        registerInboundSlackThread({
          parentSessionKey: "agent:test:publisher",
          parentSessionName: "publisher",
          childSessionKey: input.context.sessionKey,
          childSessionName: input.context.sessionName,
          accountId: "slack",
          instanceId: "slack-test",
          platformChatId: "C-test",
          threadCanonicalChatId: "chat-thread-other",
          providerThreadId: "3.4",
        });
      if (kind === "parent-missing" || kind === "root-missing") deleteSession("agent:test:publisher");
      const before = getDb().query("SELECT total_changes() AS changes").get();
      await expect(preparePublication(input, f.request)).rejects.toMatchObject({
        code: "PUBLICATION_SESSION_REQUIRED",
      });
      expect(f.calls).toHaveLength(0);
      expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
      expect(getDb().query("SELECT total_changes() AS changes").get()).toEqual(before);
    },
  );

  it("checks again between preview and execute, without uploading or moving the branch", async () => {
    f = publicationFixture();
    const prepared = await preparePublication(threadInput(), f.request);
    getDb().exec("DELETE FROM slack_thread_lifecycle");
    f.calls.length = 0;
    await expect(executePublication(prepared, f.request, f.options)).rejects.toMatchObject({
      code: "PUBLICATION_SESSION_REQUIRED",
      details: { partial: { phase: "preflight", refPublished: false } },
    });
    expect(f.calls).toHaveLength(0);
    expect(f.triggers).toHaveLength(0);
  });

  it("stops further GitHub mutations if lineage disappears during object upload", async () => {
    f = publicationFixture();
    const prepared = await preparePublication(threadInput(), f.request);
    const request: GithubRequest = async (endpoint, method, body) => {
      const value = await f.request(endpoint, method, body);
      if (method === "POST") getDb().exec("DELETE FROM slack_thread_lifecycle");
      return value;
    };
    await expect(executePublication(prepared, request, f.options)).rejects.toMatchObject({
      code: "PUBLICATION_SESSION_REQUIRED",
      details: { partial: { phase: "objects", refPublished: false } },
    });
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]!.endpoint).toEndWith("/git/blobs");
    expect(f.pr()).toBeNull();
    expect(f.triggers).toHaveLength(0);
  });

  it("keeps the original publisher lineage through child closure/pruning during upload", async () => {
    f = publicationFixture();
    const input = threadInput();
    const prepared = await preparePublication(input, f.request);
    expect(prepared.plan.replySession).toBe("publisher");
    let closed = false;
    const request: GithubRequest = async (endpoint, method, body) => {
      const value = await f.request(endpoint, method, body);
      if (!closed && method === "POST") {
        closeSlackThreadLifecycle({ childSessionKey: input.context.sessionKey });
        deleteSession(input.context.sessionKey);
        closed = true;
      }
      return value;
    };
    const result = await executePublication(prepared, request, f.options);
    expect(result.follow.replySession).toBe("publisher");
    expect(f.triggers[0]).toMatchObject({
      replySession: "publisher",
      replySource: { channel: "slack", accountId: "slack", chatId: "C-test" },
    });
    expect(f.triggers[0]!.replySource?.threadId).toBeUndefined();
  });
});

describe("verified Git Data API publication", () => {
  it("plans without writes and publishes byte-identical objects, ready PR and one follow", async () => {
    f = publicationFixture();
    const plan = await preparePublication(f.input(), f.request);
    expect(plan.plan).toMatchObject({ refAction: "create", prAction: "create", commitCount: 1 });
    expect(mutations()).toHaveLength(0);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
    const result = await executePublication(plan, f.request, f.options);
    expect(result).toMatchObject({
      localSha: f.sha(),
      remoteSha: f.sha(),
      treeSha: f.tree(),
      pr: { ready: true, reused: false },
      checks: { state: "success" },
    });
    expect(f.triggers).toHaveLength(1);
    expect(f.git(["rev-parse", "fix/publish^{tree}"], undefined, f.remote).toString().trim()).toBe(f.tree());
    f.git(["fsck", "--no-reflogs"], undefined, f.remote);
    const rows = f.db.query("SELECT phase,state,detail_json FROM pr_publication_events").all();
    expect(rows).toContainEqual(expect.objectContaining({ phase: "complete", state: "confirmed" }));
    expect(JSON.stringify(rows)).not.toContain("Validation: focused tests");
    f.calls.length = 0;
    const again = await publish();
    expect(again.publicationId).toBe(result.publicationId);
    expect(again.attemptId).not.toBe(result.attemptId);
    expect(again.pr.reused).toBe(true);
    expect(mutations()).toHaveLength(0);
    expect(f.triggers).toHaveLength(1);
  });

  it("preserves binary bytes, odd path names, executable modes, symlinks, deletion and rename", async () => {
    f = publicationFixture();
    writeFileSync(join(f.cwd, "space tab\tline\n.bin"), Buffer.from([0, 255, 128, 13, 10]));
    writeFileSync(join(f.cwd, "run.sh"), "#!/bin/sh\ntrue\n");
    chmodSync(join(f.cwd, "run.sh"), 0o755);
    symlinkSync("base.txt", join(f.cwd, "link"));
    renameSync(join(f.cwd, "change.txt"), join(f.cwd, "renamed.txt"));
    rmSync(join(f.cwd, "base.txt"));
    f.git(["add", "."]);
    f.git(["commit", "-m", "types and names"]);
    expect((await preparePublication(f.input(), f.request)).plan.commitCount).toBe(2);
    await publish();
    expect(
      f.git(["ls-tree", "-rz", "HEAD"]).equals(f.git(["ls-tree", "-rz", "fix/publish"], undefined, f.remote)),
    ).toBe(true);
  });

  it("preserves merge parent order and non-UTC author/committer times and message bytes", async () => {
    f = publicationFixture();
    const first = f.sha();
    const base = f.git(["rev-parse", "dev"]).toString().trim();
    const raw = `tree ${f.tree()}\nparent ${first}\nparent ${base}\nauthor A <a@example.test> 1700000000 -0330\ncommitter B <b@example.test> 1700000020 +0545\n\nmerge\n\nmessage with trailing spaces  \n`;
    const sha = f.git(["hash-object", "-w", "-t", "commit", "--stdin"], raw).toString().trim();
    f.git(["update-ref", "refs/heads/fix/publish", sha]);
    const parsed = parseCommit(Buffer.from(raw));
    expect(parsed.parents).toEqual([first, base]);
    expect((parsed.payload.author as { date: string }).date.endsWith("-03:30")).toBe(true);
    await publish();
    expect(f.git(["cat-file", "commit", sha], undefined, f.remote).toString()).toBe(raw);
  });

  it("rejects unsupported missing commit headers and dirty worktrees before any remote write", async () => {
    f = publicationFixture();
    writeFileSync(join(f.cwd, "untracked"), "not committed");
    await expect(publish()).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    rmSync(join(f.cwd, "untracked"));
    const raw = f.git(["cat-file", "commit", f.sha()]).toString().replace("\n\n", "\ngpgsig fake-signature\n\n");
    const sha = f.git(["hash-object", "-w", "-t", "commit", "--stdin"], raw).toString().trim();
    f.git(["update-ref", "refs/heads/fix/publish", sha]);
    await expect(publish()).rejects.toMatchObject({ code: "GIT_FORMAT_UNSUPPORTED" });
    expect(mutations()).toHaveLength(0);
  });

  it("stops on object SHA mismatch before moving a ref", async () => {
    f = publicationFixture();
    const bad: GithubRequest = async (endpoint, method, body) =>
      endpoint.endsWith("/git/trees") && method === "POST"
        ? { sha: "f".repeat(40) }
        : f.request(endpoint, method, body);
    await expect(publish(bad)).rejects.toMatchObject({
      code: "GIT_OBJECT_MISMATCH",
      details: { partial: { phase: "objects", refPublished: false } },
    });
    expect(mutations().some((call) => call.endpoint.includes("/git/refs"))).toBe(false);
  });

  it("recovers an interrupted upload without duplicating the PR", async () => {
    f = publicationFixture();
    let stopped = false;
    const interrupted: GithubRequest = async (endpoint, method, body) => {
      const value = await f.request(endpoint, method, body);
      if (!stopped && method === "POST" && endpoint.endsWith("/git/trees")) {
        stopped = true;
        throw new GithubError(503);
      }
      return value;
    };
    await expect(publish(interrupted)).rejects.toMatchObject({
      details: { partial: { uncertain: true, phase: "objects" } },
    });
    expect(f.pr()).toBeNull();
    await publish();
    expect(f.pr()?.draft).toBe(false);
    expect(f.calls.filter((call) => call.endpoint.endsWith("/pulls") && call.method === "POST")).toHaveLength(1);
  });

  it("recovers successful ref and PR mutations whose responses were lost", async () => {
    f = publicationFixture();
    const lost: GithubRequest = async (endpoint, method, body) => {
      const value = await f.request(endpoint, method, body);
      if (method === "POST" && (endpoint.endsWith("/git/refs") || endpoint.endsWith("/pulls")))
        throw new GithubError(503);
      return value;
    };
    expect((await publish(lost)).pr.ready).toBe(true);
    expect(f.triggers).toHaveLength(1);
  });

  it("repairs a partial follow while preserving the existing PR's title and body", async () => {
    f = publicationFixture();
    f.options.publication.verifyFollow = async () => {
      throw new Error("runner unavailable");
    };
    await expect(publish()).rejects.toMatchObject({
      code: "PR_PUBLICATION_INCOMPLETE",
      details: { partial: { phase: "follow", refPublished: true, prNumber: 7 } },
    });
    f.pr()!.title = "human edit";
    f.pr()!.body = "human review context";
    f.pr()!.draft = true;
    f.options.publication.verifyFollow = async () => {};
    const result = await publish();
    expect(result.pr).toMatchObject({ reused: true, ready: true });
    expect(f.pr()).toMatchObject({ title: "human edit", body: "human review context" });
    expect(f.triggers).toHaveLength(1);
  });

  it("refuses an advanced ref and never uses force", async () => {
    f = publicationFixture();
    const prepared = await preparePublication(f.input(), f.request);
    f.git(["update-ref", "refs/heads/fix/publish", f.git(["rev-parse", "dev"]).toString().trim()], undefined, f.remote);
    await expect(executePublication(prepared, f.request, f.options)).rejects.toMatchObject({
      code: "REMOTE_REF_CHANGED",
    });
    expect(mutations().some((call) => call.endpoint.includes("/git/refs"))).toBe(false);
  });

  it("blocks a revoked authorization before upload and protects expected SHA", async () => {
    f = publicationFixture();
    await expect(preparePublication({ ...f.input(), expectSha: "f".repeat(40) }, f.request)).rejects.toMatchObject({
      code: "LOCAL_HEAD_CHANGED",
    });
    const prepared = await preparePublication(f.input(), f.request);
    await expect(
      executePublication(prepared, f.request, {
        ...f.options,
        authorize: () => {
          throw new ContractError("pr publish", "PERMISSION_DENIED", "denied", 1, {
            ...errorDiagnostic("denied", { operation: "pr publish" }),
            ...{},
          });
        },
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(mutations()).toHaveLength(0);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(0);
  });

  it("does not trust Git replacement refs", async () => {
    f = publicationFixture();
    f.git(["replace", f.sha(), f.git(["rev-parse", "dev"]).toString().trim()]);
    const git = new LocalGit(f.cwd);
    expect((await git.object("commit", f.sha())).toString()).toContain("change");
  });
});
