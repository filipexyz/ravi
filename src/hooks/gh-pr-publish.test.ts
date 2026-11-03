import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  publishGhPr,
  verifyPublicationFollow,
  type GhPrPublication,
  type GhPublicationRequest,
} from "./gh-pr-publish.js";
import { registerInboundSlackThread, closeSlackThreadLifecycle } from "../channels/slack/thread-lifecycle-store.js";
import { deleteSession, getOrCreateSession } from "../router/sessions.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { buildGhFollowTriggerInput, type GhWatchFollowDeps } from "./gh-watch.js";
import { evaluateFilter } from "../triggers/filter.js";
import type { Trigger } from "../triggers/types.js";
import type { WatchRecord } from "../watch/types.js";

const input: GhPrPublication = {
  repo: "o/r",
  head: "fix/publish",
  base: "dev",
  sha: "a".repeat(40),
  title: "Fix follow",
  body: "Reviewed change",
  context: {
    agentId: "main",
    accountId: "slack",
    sessionName: "publishing-thread",
    source: { channel: "slack", accountId: "slack", chatId: "C1", threadId: "1.2" },
  },
};

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gh-pr-publication-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const parentKey = "publishing-parent-key";
const childKey = `${parentKey}:thread:1.2`;
const parentSource = { channel: "slack", accountId: "slack", chatId: "C1" };

function fixture(options: { existing?: boolean; draft?: boolean; staleFollow?: boolean; noLifecycle?: boolean } = {}) {
  getOrCreateSession(parentKey, "main", "/tmp/publication-test", { name: "publishing-parent" });
  getOrCreateSession(childKey, "main", "/tmp/publication-test", { name: input.context.sessionName });
  if (!options.noLifecycle) {
    registerInboundSlackThread({
      parentSessionKey: parentKey,
      parentSessionName: "publishing-parent",
      childSessionKey: childKey,
      childSessionName: input.context.sessionName!,
      accountId: "slack",
      instanceId: "slack-instance",
      platformChatId: "C1",
      threadCanonicalChatId: "thread-chat",
      providerThreadId: "1.2",
    });
  }
  const calls: Array<{ endpoint: string; method: string; body?: Record<string, unknown> }> = [];
  let pr = options.existing ? makePr(options.draft) : undefined;
  const watches: WatchRecord[] = [];
  const triggers: Trigger[] = options.staleFollow
    ? [
        {
          id: "old-follow",
          ...buildGhFollowTriggerInput(input.repo, 9, { sessionName: "old-thread" }),
          topic: "ravi.watch.github.pull_request.*",
          filter: "old-filter",
          enabled: false,
        } as Trigger,
      ]
    : [];
  let refreshes = 0;
  const request: GhPublicationRequest = (endpoint, method, body) => {
    calls.push({ endpoint, method, body });
    if (endpoint.includes("/git/ref/")) return { object: { sha: input.sha } };
    if (endpoint.includes("/pulls?")) return pr ? [structuredClone(pr)] : [];
    if (endpoint.endsWith("/pulls") && method === "POST") {
      pr = makePr(body?.draft === true);
      return structuredClone(pr);
    }
    if (endpoint === "graphql") {
      pr!.draft = false;
      return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
    }
    if (endpoint.endsWith("/pulls/9")) return structuredClone(pr);
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };
  const follow: GhWatchFollowDeps = {
    listWatches: () => ({ items: watches }) as never,
    createWatch: async (value) => {
      const watch = {
        ...value,
        id: `watch-${watches.length}`,
        status: "active",
        placement: value.placement ?? "console",
        eventTypes: value.eventTypes ?? [],
      } as WatchRecord;
      watches.push(watch);
      return { watch, createdRemote: false };
    },
    listTriggers: () => triggers,
    createTrigger: (value) => {
      const trigger = { ...value, id: "new-follow", enabled: true } as Trigger;
      triggers.push(trigger);
      return trigger;
    },
    updateTrigger: (id, patch) => {
      const trigger = triggers.find((value) => value.id === id);
      if (!trigger) return false;
      Object.assign(trigger, patch);
      return true;
    },
    emitTriggersRefresh: async () => {
      refreshes += 1;
    },
  };
  return {
    calls,
    watches,
    triggers,
    deps: {
      request,
      follow,
      verifyFollow: (value: GhPrPublication, result: import("./gh-watch.js").GhWatchFollowResult, number: number) =>
        verifyPublicationFollow(value, result, number, {
          watch: (id) => watches.find((watch) => watch.id === id) ?? null,
          trigger: (id) => triggers.find((trigger) => trigger.id === id) ?? null,
          runtime: async () => {},
        }),
    },
    refreshes: () => refreshes,
  };
}

function makePr(draft = false) {
  return {
    number: 9,
    node_id: "PR_9",
    html_url: "https://github.com/o/r/pull/9",
    state: "open",
    draft,
    head: { ref: input.head, sha: input.sha, repo: { full_name: input.repo } },
    base: { ref: input.base, repo: { full_name: input.repo } },
  };
}

describe("Git Data API publication boundary", () => {
  it("publishes ready and registers CI in the same registry without observing a gh shell command", async () => {
    const f = fixture();
    const result = await publishGhPr(input, f.deps);
    expect(result).toMatchObject({ ready: true, reused: false, sha: input.sha });
    expect(f.calls.find((call) => call.method === "POST")?.body?.draft).toBe(false);
    expect(f.triggers).toHaveLength(1);
    expect(f.watches).toHaveLength(1);
    expect(f.watches[0]!.placement).toBe("local");
    expect(f.triggers[0]).toMatchObject({
      name: "gh-follow:o/r#9",
      replySession: "publishing-parent",
      agentId: "main",
      replySource: parentSource,
      topic: "ravi.watch.github.>",
      enabled: true,
    });
    expect(
      f.watches.some((watch) => watch.placement === "local" && watch.eventTypes.includes("workflow_run.completed")),
    ).toBe(true);
    expect(evaluateFilter(f.triggers[0]!.filter, { payload: { repository: "o/r", number: 9 } })).toBe(true);
    expect(evaluateFilter(f.triggers[0]!.filter, { payload: { repository: "other/r", number: 9 } })).toBe(false);
    expect(evaluateFilter(f.triggers[0]!.filter, { payload: { repository: "o/r", number: 10 } })).toBe(false);
    expect(f.refreshes()).toBe(1);
  });

  it("reconciles an existing orphan draft, and retry keeps exactly one PR and one follow", async () => {
    const f = fixture({ existing: true, draft: true });
    await publishGhPr(input, f.deps);
    await publishGhPr(input, f.deps);
    expect(f.calls.filter((call) => call.endpoint === "repos/o/r/pulls")).toHaveLength(0);
    expect(f.calls.filter((call) => call.endpoint === "graphql")).toHaveLength(1);
    expect(f.triggers).toHaveLength(1);
    expect(f.watches.filter((watch) => watch.placement === "local")).toHaveLength(1);
  });

  it("repairs a stale existing follow in place and restores its missing event producer", async () => {
    const f = fixture({ existing: true, staleFollow: true });
    const result = await publishGhPr(input, f.deps);
    expect(result.follow).toMatchObject({ triggerId: "old-follow", triggerReused: true, triggerRepaired: true });
    expect(f.triggers).toHaveLength(1);
    expect(f.triggers[0]).toMatchObject({
      enabled: true,
      replySession: "publishing-parent",
      replySource: parentSource,
      topic: "ravi.watch.github.>",
    });
    expect(f.watches.some((watch) => watch.placement === "local")).toBe(true);
  });

  it("reports follow failure and recovers the already created PR on rerun", async () => {
    const f = fixture();
    const create = f.deps.follow.createTrigger!;
    f.deps.follow.createTrigger = () => {
      throw new Error("DB unavailable");
    };
    await expect(publishGhPr(input, f.deps)).rejects.toThrow("DB unavailable");
    f.deps.follow.createTrigger = create;
    expect((await publishGhPr(input, f.deps)).reused).toBe(true);
    expect(f.calls.filter((call) => call.endpoint === "repos/o/r/pulls")).toHaveLength(1);
    expect(f.triggers).toHaveLength(1);
  });

  it("retries runner refresh after a failure even if the durable trigger already matches", async () => {
    const f = fixture();
    f.deps.follow.emitTriggersRefresh = async () => {
      throw new Error("NATS unavailable");
    };
    await expect(publishGhPr(input, f.deps)).rejects.toThrow("NATS unavailable");
    let refreshed = false;
    f.deps.follow.emitTriggersRefresh = async () => {
      refreshed = true;
    };
    await publishGhPr(input, f.deps);
    expect(refreshed).toBe(true);
    expect(f.triggers).toHaveLength(1);
  });

  it("does not claim success with a missing CI producer or failed trigger repair", async () => {
    const f = fixture({ existing: true, staleFollow: true });
    f.deps.follow.updateTrigger = () => false;
    await expect(publishGhPr(input, f.deps)).rejects.toThrow("reconcile gh follow");
    const missingWatch = fixture();
    missingWatch.deps.follow.createWatch = async () => {
      throw new Error("offline");
    };
    await expect(publishGhPr(input, missingWatch.deps)).rejects.toThrow("CI follow is incomplete");
  });

  it("fails before mutation without an owner or on remote SHA mismatch", async () => {
    const f = fixture();
    await expect(publishGhPr({ ...input, context: {} }, f.deps)).rejects.toThrow("publishing Ravi agent and session");
    expect(f.calls).toHaveLength(0);
    await expect(publishGhPr({ ...input, sha: "b".repeat(40) }, f.deps)).rejects.toThrow("Remote branch");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each(["missing", "unknown", "ambiguous", "parent-missing"])(
    "refuses %s lineage before creating a PR, promoting a draft or registering a follow",
    async (lineage) => {
      const f = fixture({ noLifecycle: lineage === "missing" || lineage === "unknown" });
      if (lineage === "unknown") deleteSession(childKey);
      if (lineage === "parent-missing") deleteSession(parentKey);
      if (lineage === "ambiguous") {
        registerInboundSlackThread({
          parentSessionKey: parentKey,
          parentSessionName: "publishing-parent",
          childSessionKey: childKey,
          childSessionName: input.context.sessionName!,
          accountId: "slack",
          instanceId: "slack-instance",
          platformChatId: "C1",
          threadCanonicalChatId: "other-thread-chat",
          providerThreadId: "3.4",
        });
      }
      await expect(publishGhPr(input, f.deps)).rejects.toThrow("Cannot register PR follow");
      expect(f.calls).toHaveLength(0);
      expect(f.watches).toHaveLength(0);
      expect(f.triggers).toHaveLength(0);
    },
  );

  it("publishes from a durable root session without requiring a thread lifecycle", async () => {
    const f = fixture({ noLifecycle: true });
    const rootInput = {
      ...input,
      context: { ...input.context, sessionName: "publishing-parent", source: parentSource },
    };
    expect((await publishGhPr(rootInput, f.deps)).ready).toBe(true);
    expect(f.triggers[0]).toMatchObject({ replySession: "publishing-parent", replySource: parentSource });
  });

  it("revalidates original lineage after the child closes and is pruned during GitHub I/O", async () => {
    const f = fixture();
    const request = f.deps.request;
    f.deps.request = (endpoint, method, body) => {
      const result = request(endpoint, method, body);
      if (endpoint.endsWith("/pulls") && method === "POST") {
        closeSlackThreadLifecycle({ childSessionKey: childKey });
        deleteSession(childKey);
      }
      return result;
    };
    expect((await publishGhPr(input, f.deps)).ready).toBe(true);
    expect(f.triggers[0]).toMatchObject({ replySession: "publishing-parent", replySource: parentSource });
  });

  it.each(["before-follow", "verification"])(
    "refuses lineage lost at %s instead of reporting success",
    async (phase) => {
      const f = fixture();
      const request = f.deps.request;
      f.deps.request = (endpoint, method, body) => {
        const result = request(endpoint, method, body);
        if (
          (phase === "before-follow" && endpoint.endsWith("/pulls") && method === "POST") ||
          (phase === "verification" && endpoint.endsWith("/pulls/9"))
        ) {
          getDb().query("DELETE FROM slack_thread_lifecycle WHERE child_session_key=?").run(childKey);
        }
        return result;
      };
      await expect(publishGhPr(input, f.deps)).rejects.toMatchObject({ code: "PUBLICATION_SESSION_REQUIRED" });
      if (phase === "before-follow") expect(f.triggers).toHaveLength(0);
      else expect(f.triggers[0]!.replySession).toBe("publishing-parent");
    },
  );

  it("refuses another repository or a moved PR head without registering or promoting it", async () => {
    for (const mismatch of ["repo", "sha"] as const) {
      const pr = makePr(true);
      const f = fixture();
      if (mismatch === "sha") pr.head.sha = "b".repeat(40);
      else pr.head.repo.full_name = "other/r";
      const request = f.deps.request;
      f.deps.request = (endpoint, method, body) =>
        endpoint.includes("/pulls?") ? [pr] : request(endpoint, method, body);
      await expect(publishGhPr(input, f.deps)).rejects.toMatchObject({
        code: mismatch === "repo" ? "PR_CONFLICT" : "PR_PUBLICATION_INCOMPLETE",
      });
      expect(f.triggers).toHaveLength(0);
    }
  });

  it("reports ready mutation errors and a head moving during publication", async () => {
    for (const failure of ["graphql", "head"] as const) {
      const f = fixture({ existing: true, draft: true });
      const request = f.deps.request;
      f.deps.request = (endpoint, method, body) => {
        if (endpoint === "graphql" && failure === "graphql") return { errors: [{ message: "denied" }] };
        if (endpoint.endsWith("/pulls/9") && failure === "head")
          return { ...makePr(), head: { ...makePr().head, sha: "b".repeat(40) } };
        return request(endpoint, method, body);
      };
      await expect(publishGhPr(input, f.deps)).rejects.toThrow(
        failure === "graphql" ? "Could not mark" : "PR does not match",
      );
    }
  });
});
