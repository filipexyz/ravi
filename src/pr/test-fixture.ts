import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GithubError, type GithubRequest } from "./github.js";
import { openPublicationJournal } from "./journal.js";
import type { GhWatchFollowDeps } from "../hooks/gh-watch.js";
import type { WatchRecord } from "../watch/types.js";
import type { Trigger } from "../triggers/types.js";
import { getOrCreateSession } from "../router/sessions.js";

/** Real Git databases at both ends; only HTTP and the unrelated daemon are simulated. */
export function publicationFixture() {
  getOrCreateSession("agent:test:publisher", "test", "/tmp/publication-test", { name: "publisher" });
  const root = mkdtempSync(join(tmpdir(), "ravi-pr-publish-"));
  const cwd = join(root, "local");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (args: string[], input?: Buffer | string, dir = cwd) =>
    execFileSync("git", ["-C", dir, ...args], { env, input, stdio: ["pipe", "pipe", "pipe"] });
  git(["init", "-b", "dev"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["remote", "add", "origin", "https://github.com/o/r.git"]);
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  git(["clone", "--bare", cwd, remote]);
  git(["checkout", "-b", "fix/publish"]);
  writeFileSync(join(cwd, "change.txt"), "change\n");
  git(["add", "."]);
  git(["commit", "-m", "change"]);
  const sha = () => git(["rev-parse", "HEAD"]).toString().trim();
  const tree = () => git(["rev-parse", "HEAD^{tree}"]).toString().trim();
  const object = (type: string, oid: string) => {
    try {
      return git(["cat-file", type, oid], undefined, remote);
    } catch {
      throw new GithubError(404);
    }
  };
  const hash = (type: string, content: Buffer | string) =>
    git(["hash-object", "-w", "-t", type, "--stdin"], content, remote).toString().trim();
  const calls: { endpoint: string; method: string; body?: Record<string, unknown> }[] = [];
  let pr: ReturnType<typeof makePr> | null = null;
  const makePr = (draft: boolean) => ({
    number: 7,
    node_id: "PR_7",
    html_url: "https://github.com/o/r/pull/7",
    state: "open",
    draft,
    title: "human title",
    body: "human body",
    head: { ref: "fix/publish", sha: sha(), repo: { full_name: "o/r" } },
    base: { ref: "dev", repo: { full_name: "o/r" } },
  });
  const identity = (person: unknown) => {
    const value = person as { name: string; email: string; date: string };
    const offset = value.date.slice(-6).replace(":", "");
    return `${value.name} <${value.email}> ${Date.parse(value.date) / 1000} ${offset}`;
  };
  const request: GithubRequest = (endpoint, method, body) => {
    calls.push({ endpoint, method, body });
    if (endpoint === "repos/o/r") return { full_name: "o/r", default_branch: "dev" };
    if (endpoint.includes("/git/ref/heads/")) {
      const name = decodeURIComponent(endpoint.split("/heads/")[1]!);
      try {
        return {
          ref: `refs/heads/${name}`,
          object: {
            type: "commit",
            sha: git(["rev-parse", `refs/heads/${name}`], undefined, remote)
              .toString()
              .trim(),
          },
        };
      } catch {
        throw new GithubError(404);
      }
    }
    const match = /\/git\/(blobs|trees|commits)\/([a-f0-9]{40})$/.exec(endpoint);
    if (match) {
      const type = match[1] === "trees" ? "tree" : match[1]!.slice(0, -1);
      const content = object(type, match[2]!);
      return {
        sha: match[2],
        ...(type === "commit" ? { tree: { sha: content.toString().split("\n")[0]!.slice(5) } } : {}),
      };
    }
    if (endpoint.endsWith("/git/blobs")) return { sha: hash("blob", Buffer.from(body!.content as string, "base64")) };
    if (endpoint.endsWith("/git/trees")) {
      const entries = body!.tree as { mode: string; type: string; sha: string; path: string }[];
      return {
        sha: git(["mktree", "-z"], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\0`).join(""), remote)
          .toString()
          .trim(),
      };
    }
    if (endpoint.endsWith("/git/commits"))
      return {
        sha: hash(
          "commit",
          `tree ${body!.tree}\n${(body!.parents as string[]).map((parent) => `parent ${parent}\n`).join("")}author ${identity(body!.author)}\ncommitter ${identity(body!.committer)}\n\n${body!.message}`,
        ),
      };
    if (endpoint.endsWith("/git/refs") || endpoint.includes("/git/refs/heads/")) {
      const ref =
        method === "POST" ? (body!.ref as string) : `refs/heads/${decodeURIComponent(endpoint.split("/heads/")[1]!)}`;
      if (method === "PATCH") {
        if (body!.force !== false) throw new Error("force update attempted");
        try {
          git(["merge-base", "--is-ancestor", ref, body!.sha as string], undefined, remote);
        } catch {
          throw new GithubError(422);
        }
      }
      git(["update-ref", ref, body!.sha as string], undefined, remote);
      if (pr) pr.head.sha = body!.sha as string;
      return { ref, object: { type: "commit", sha: body!.sha } };
    }
    if (endpoint.includes("/pulls?")) return pr ? [structuredClone(pr)] : [];
    if (endpoint.endsWith("/pulls") && method === "POST") {
      pr = makePr(body?.draft === true);
      pr.title = body?.title as string;
      pr.body = body?.body as string;
      return structuredClone(pr);
    }
    if (endpoint.endsWith("/pulls/7")) return structuredClone(pr);
    if (endpoint === "graphql") {
      pr!.draft = false;
      return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
    }
    if (endpoint.endsWith("/status")) return { state: "pending", total_count: 0 };
    if (endpoint.includes("/check-runs?"))
      return { total_count: 1, check_runs: [{ head_sha: sha(), status: "completed", conclusion: "success" }] };
    throw new Error(`Unexpected request ${method} ${endpoint}`);
  };
  const watches: WatchRecord[] = [];
  const triggers: Trigger[] = [];
  const follow: GhWatchFollowDeps = {
    listWatches: () => ({ items: watches }) as never,
    createWatch: async (input) => {
      const watch = {
        ...input,
        id: `watch-${watches.length}`,
        placement: input.placement ?? "console",
        status: "active",
        eventTypes: input.eventTypes ?? [],
      } as WatchRecord;
      watches.push(watch);
      return { watch, createdRemote: false };
    },
    listTriggers: () => triggers,
    createTrigger: (input) => {
      const trigger = { ...input, id: "follow-7", enabled: true } as Trigger;
      triggers.push(trigger);
      return trigger;
    },
    updateTrigger: (id, patch) => {
      const trigger = triggers.find((t) => t.id === id);
      if (!trigger) return false;
      Object.assign(trigger, patch);
      return trigger;
    },
    emitTriggersRefresh: async () => {},
  };
  const db = new Database(":memory:");
  const input = () => ({
    cwd,
    repo: "o/r",
    base: "dev",
    title: "test publication",
    body: "Validation: focused tests.",
    expectSha: sha(),
    context: {
      agentId: "test",
      sessionName: "publisher",
      sessionKey: "agent:test:publisher",
      accountId: "slack",
      source: { channel: "slack", accountId: "slack", chatId: "C-test" },
    },
  });
  const options = {
    authorize: () => {},
    provenance: { actor: "agent:test" },
    journal: (plan: Parameters<typeof openPublicationJournal>[0], provenance: Record<string, string | null>) =>
      openPublicationJournal(plan, provenance, db),
    publication: { follow, verifyFollow: async () => {} },
  };
  return {
    root,
    cwd,
    remote,
    git,
    sha,
    tree,
    hash,
    calls,
    request,
    input,
    options,
    watches,
    triggers,
    db,
    pr: () => pr,
    setPr: (draft = false) => {
      pr = makePr(draft);
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
