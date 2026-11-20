import { readFileSync } from "node:fs";
import { Transpiler } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSlackThreadLifecycle, registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import {
  ensurePageCommentFollow,
  pageCommentCreatorFromContext,
  pageCommentMatchesEvent,
  pageCommentReplyTargetPatch,
  repairThreadBoundPageCommentFollows,
} from "../pages/comment-follow.js";
import { dbCreateAgent } from "../router/router-db.js";
import { deleteSession, getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolveTriggerActivation } from "./activation.js";
import { handOffClosingThreadFollows, resolveDurableFollowOwner } from "./follow-owner.js";
import { dbCreateTrigger, dbGetTrigger, dbListTriggers } from "./triggers-db.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-page-comment-owner-");
  dbCreateAgent({ id: "agent-test", cwd: "/tmp/page-comment-owner" });
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

const PARENT_KEY = "agent:agent-test:main";
const THREAD_ONE = `${PARENT_KEY}:thread:1.2`;
const THREAD_TWO = `${PARENT_KEY}:thread:3.4`;
const ACCOUNT = "slack-account";

function seedParent() {
  getOrCreateSession(PARENT_KEY, "agent-test", "/tmp/page-comment-owner", { name: "parent" });
}

function seedThread(key: string, name: string, providerThreadId: string) {
  getOrCreateSession(key, "agent-test", "/tmp/page-comment-owner", { name });
  return registerInboundSlackThread({
    parentSessionKey: PARENT_KEY,
    parentSessionName: "parent",
    childSessionKey: key,
    childSessionName: name,
    accountId: ACCOUNT,
    instanceId: "slack-instance",
    platformChatId: "C123",
    threadCanonicalChatId: `thread-chat-${providerThreadId}`,
    providerThreadId,
  });
}

function threadContext(key: string, name: string, providerThreadId: string) {
  return {
    agentId: "agent-test",
    sessionName: name,
    sessionKey: key,
    source: { channel: "slack", accountId: ACCOUNT, chatId: `C123#${providerThreadId}`, threadId: providerThreadId },
  } as never;
}

// Keys that carry `:thread:` and that no Slack lifecycle ever stood behind: a thread of
// another channel (its id is that channel's message id) and a task's own thread.
const WHATSAPP_THREAD_KEY = "agent:agent-test:whatsapp:main:group:120363024772797713@g.us:thread:3EB0C767D0F1A2B3";
const WHATSAPP_THREAD_SOURCE = {
  channel: "whatsapp",
  accountId: "wa-main",
  chatId: "120363024772797713@g.us",
  threadId: "3EB0C767D0F1A2B3",
};
const TASK_THREAD_KEY = "agent:agent-test:thread:thr_m3k2x9_a1b2c3d4e5";

function seedNonSlackThreads() {
  getOrCreateSession(WHATSAPP_THREAD_KEY, "agent-test", "/tmp/page-comment-owner", { name: "wa-thread" });
  getOrCreateSession(TASK_THREAD_KEY, "agent-test", "/tmp/page-comment-owner", { name: "task-worker" });
}

const ship = (route: string) => ({
  site: { id: "site_1" },
  organizationId: "org_1",
  projectId: "proj_1",
  route,
});

const shipDeps = (context: unknown) => ({
  getCreator: () => pageCommentCreatorFromContext(() => context as never),
  agentExists: () => true,
  emitTriggersRefresh: async () => {},
});

describe("durable owner of a follow armed from a Slack thread", () => {
  it("hands the follow to the thread's durable parent with the parent's agent and chat", () => {
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    const resolved = resolveDurableFollowOwner(
      {
        agentId: "someone-else",
        sessionName: "child",
        sessionKey: THREAD_ONE,
        source: { channel: "slack", accountId: ACCOUNT, chatId: "C123#1.2", threadId: "1.2" },
      },
      "page comment follow",
    );
    expect(resolved).toMatchObject({
      agentId: "agent-test",
      accountId: ACCOUNT,
      sessionName: "parent",
      sessionKey: PARENT_KEY,
      source: { channel: "slack", accountId: ACCOUNT, chatId: "C123" },
    });
    expect(resolved.source).not.toHaveProperty("threadId");
  });

  it("keeps a PR follow with the open child that published it, until the thread closes", () => {
    seedParent();
    const record = seedThread(THREAD_ONE, "child", "1.2");
    const context = threadContext(THREAD_ONE, "child", "1.2");

    // Only a follow that asks for it (the PR follow) stays with the open child, in that thread.
    expect(resolveDurableFollowOwner(context, "PR follow", undefined, { openThreadOwns: true })).toMatchObject({
      agentId: "agent-test",
      accountId: ACCOUNT,
      sessionName: "child",
      sessionKey: THREAD_ONE,
      source: { channel: "slack", accountId: ACCOUNT, chatId: "C123", threadId: "1.2" },
    });
    expect(resolveDurableFollowOwner(context, "page comment follow")).toMatchObject({ sessionName: "parent" });

    closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! });
    expect(resolveDurableFollowOwner(context, "PR follow", undefined, { openThreadOwns: true })).toMatchObject({
      sessionName: "parent",
      source: { channel: "slack", accountId: ACCOUNT, chatId: "C123" },
    });
  });

  it("never arms a PR follow on an open child whose parent is gone, and hands over only gh-follow triggers", () => {
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    const context = threadContext(THREAD_ONE, "child", "1.2");
    deleteSession(PARENT_KEY);
    expect(() => resolveDurableFollowOwner(context, "PR follow", undefined, { openThreadOwns: true })).toThrow(
      "Cannot register PR follow: durable parent session is missing.",
    );

    seedParent();
    const addressed = { replySession: "child", replySource: { channel: "slack", accountId: ACCOUNT, chatId: "C123" } };
    const follow = dbCreateTrigger({
      name: "gh-follow:o/r#9",
      topic: "ravi.watch.github.>",
      message: "f",
      session: "main",
      ...addressed,
    });
    const comment = dbCreateTrigger({
      name: "page-comment:site_1:/blog/a",
      topic: "ravi.watch.console.page.comment.created",
      message: "comment",
      agentId: "agent-test",
      session: "main",
      replySession: "child",
    });
    const handedOff = handOffClosingThreadFollows({ childSessionKey: THREAD_ONE, childSessionName: "child" });
    expect(handedOff).toEqual([follow.id]);
    expect(dbGetTrigger(follow.id)!.replySession).toBe("parent");
    // A page comment follow is repaired by its own boot step, not by the close handoff.
    expect(dbGetTrigger(comment.id)!.replySession).toBe("child");
  });

  it("leaves a session that is not a thread child with its own follow", () => {
    seedParent();
    const context = { agentId: "agent-test", sessionName: "parent", sessionKey: PARENT_KEY };
    expect(resolveDurableFollowOwner(context, "page comment follow")).toEqual(context);
    expect(resolveDurableFollowOwner({}, "page comment follow")).toEqual({});
  });

  it("fails closed, naming the follow, when the thread or its parent cannot be resolved", () => {
    expect(() => resolveDurableFollowOwner({ sessionKey: `${PARENT_KEY}:thread:9.9` }, "page comment follow")).toThrow(
      "Cannot register page comment follow: thread lifecycle is missing or ambiguous.",
    );
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    deleteSession(PARENT_KEY);
    expect(() => resolveDurableFollowOwner({ sessionKey: THREAD_ONE }, "page comment follow")).toThrow(
      "Cannot register page comment follow: durable parent session is missing.",
    );
  });

  it("refuses a missing lifecycle only for a Slack thread when asked to: another channel's thread or a task's keeps its own follow", () => {
    seedNonSlackThreads();
    const slackOnly = { refuse: "slack-thread" } as const;
    // By key, by name (the session row supplies the key), and with a source that carries a thread id.
    const own = [
      {
        agentId: "agent-test",
        sessionName: "wa-thread",
        sessionKey: WHATSAPP_THREAD_KEY,
        source: WHATSAPP_THREAD_SOURCE,
      },
      { agentId: "agent-test", sessionName: "wa-thread", source: WHATSAPP_THREAD_SOURCE },
      { agentId: "agent-test", sessionName: "task-worker", sessionKey: TASK_THREAD_KEY },
      { agentId: "agent-test", sessionName: "task-worker" },
      // No session row to read a key from, and the source is not Slack's: nothing says this is a Slack thread.
      { agentId: "agent-test", sessionName: "no-row", source: WHATSAPP_THREAD_SOURCE },
    ];
    for (const context of own) {
      expect(resolveDurableFollowOwner(context, "page comment follow", undefined, slackOnly)).toEqual(context);
    }

    // The same shapes for a Slack thread (its id is a timestamp) are still refused.
    const slackKey = `${PARENT_KEY}:thread:9.9`;
    getOrCreateSession(slackKey, "agent-test", "/tmp/page-comment-owner", { name: "slack-ghost" });
    const slack = { channel: "slack", accountId: ACCOUNT, chatId: "C123#9.9", threadId: "9.9" };
    for (const context of [
      { sessionKey: slackKey },
      { sessionName: "slack-ghost" },
      { sessionName: "no-row", source: slack },
    ]) {
      expect(() => resolveDurableFollowOwner(context, "page comment follow", undefined, slackOnly)).toThrow(
        "Cannot register page comment follow: thread lifecycle is missing or ambiguous.",
      );
    }
  });

  it("keeps refusing every thread-like key by default: the PR follow and `ravi pr publish` do not take the narrower rule", () => {
    seedNonSlackThreads();
    for (const context of [
      { sessionKey: WHATSAPP_THREAD_KEY },
      { sessionName: "wa-thread" },
      { sessionKey: TASK_THREAD_KEY },
      { sessionName: "task-worker" },
    ]) {
      expect(() => resolveDurableFollowOwner(context, "PR follow")).toThrow(
        "Cannot register PR follow: thread lifecycle is missing or ambiguous.",
      );
    }
  });
});

describe("page comment follow armed by a ship from a thread", () => {
  it("wakes the parent, lets the thread close, and still matches the page's comments", async () => {
    seedParent();
    const record = seedThread(THREAD_ONE, "child", "1.2");

    const result = await ensurePageCommentFollow(
      ship("/blog/post-1"),
      shipDeps(threadContext(THREAD_ONE, "child", "1.2")),
    );

    expect(result).toMatchObject({ ok: true, reused: false, replySession: "parent", agentId: "agent-test" });
    const stored = dbGetTrigger(result.triggerId!)!;
    expect(stored).toMatchObject({
      name: "page-comment:site_1:/blog/post-1",
      replySession: "parent",
      replySource: { channel: "slack", accountId: ACCOUNT, chatId: "C123" },
    });
    expect(resolveTriggerActivation(stored).state).toBe("active");
    expect(
      pageCommentMatchesEvent(
        { pageId: "site_1", routePath: "/blog/post-1", orgId: "org_1", projectId: "proj_1" },
        { payload: { pageId: "site_1", routePath: "/blog/post-1", orgId: "org_1", projectId: "proj_1" } },
      ),
    ).toBe(true);
    // The thread no longer receives any active trigger, so it closes.
    expect(closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! }).changed).toBe(true);
  });

  it("keeps a route shared by several threads on the same parent instead of moving it to the last thread", async () => {
    seedParent();
    seedThread(THREAD_ONE, "child-one", "1.2");
    seedThread(THREAD_TWO, "child-two", "3.4");

    const first = await ensurePageCommentFollow(ship("/blog"), shipDeps(threadContext(THREAD_ONE, "child-one", "1.2")));
    const second = await ensurePageCommentFollow(
      ship("/blog"),
      shipDeps(threadContext(THREAD_TWO, "child-two", "3.4")),
    );

    expect(second.triggerId).toBe(first.triggerId);
    expect(second).toMatchObject({ ok: true, reused: true, replySession: "parent" });
    expect(second.rebound).toBeUndefined();
    expect(dbGetTrigger(first.triggerId!)!.replySession).toBe("parent");
  });

  it("moves a route that an older ship left on the thread to the parent", async () => {
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    const legacy = dbCreateTrigger({
      name: "page-comment:site_1:/blog/post-1",
      topic: "ravi.watch.console.page.comment.created",
      message: "comment",
      agentId: "agent-test",
      session: "main",
      replySession: "child",
    });

    const result = await ensurePageCommentFollow(
      ship("/blog/post-1"),
      shipDeps(threadContext(THREAD_ONE, "child", "1.2")),
    );

    expect(result).toMatchObject({ ok: true, reused: true, rebound: true, triggerId: legacy.id });
    expect(dbGetTrigger(legacy.id)!.replySession).toBe("parent");
  });

  it("does not arm a follow it could not hand to a durable owner", () => {
    seedParent();
    // A thread child that the lifecycle store never saw: the ship must not bind a follow to it.
    expect(() =>
      pageCommentCreatorFromContext(() => threadContext(`${PARENT_KEY}:thread:9.9`, "ghost", "9.9")),
    ).toThrow("Cannot register page comment follow: thread lifecycle is missing or ambiguous.");
  });

  it("arms a ship from a plain session on that session, unchanged", async () => {
    seedParent();
    const context = { agentId: "agent-test", sessionName: "parent", sessionKey: PARENT_KEY } as never;
    const result = await ensurePageCommentFollow(ship("/pipeline"), shipDeps(context));
    expect(result).toMatchObject({ ok: true, replySession: "parent" });
  });

  it("arms a ship from another channel's thread or a task's thread on that session, as before", async () => {
    seedNonSlackThreads();
    const fromWhatsApp = {
      agentId: "agent-test",
      sessionName: "wa-thread",
      sessionKey: WHATSAPP_THREAD_KEY,
      source: WHATSAPP_THREAD_SOURCE,
    } as never;
    const fromTask = { agentId: "agent-test", sessionName: "task-worker", sessionKey: TASK_THREAD_KEY } as never;

    const whatsapp = await ensurePageCommentFollow(ship("/from-whatsapp"), shipDeps(fromWhatsApp));
    const task = await ensurePageCommentFollow(ship("/from-task"), shipDeps(fromTask));

    expect(whatsapp).toMatchObject({ ok: true, replySession: "wa-thread" });
    expect(task).toMatchObject({ ok: true, replySession: "task-worker" });
    const stored = Object.fromEntries(dbListTriggers().map((trigger) => [trigger.name, trigger]));
    expect(stored["page-comment:site_1:/from-whatsapp"]).toMatchObject({
      replySession: "wa-thread",
      replySource: WHATSAPP_THREAD_SOURCE,
    });
    expect(stored["page-comment:site_1:/from-task"]).toMatchObject({ replySession: "task-worker" });
  });
});

describe("repair of page comment triggers left on a thread", () => {
  function legacyTrigger(name: string, replySession: string | undefined, extra: Record<string, unknown> = {}) {
    return dbCreateTrigger({
      name,
      topic: "ravi.watch.console.page.comment.created",
      message: "comment",
      agentId: "agent-test",
      session: "main",
      ...(replySession ? { replySession } : {}),
      ...extra,
    });
  }

  it("moves route triggers off open, closed and pruned threads and leaves everything else alone", () => {
    seedParent();
    const openThread = seedThread(THREAD_ONE, "child-open", "1.2");
    const closedThread = seedThread(THREAD_TWO, "child-closed", "3.4");
    closeSlackThreadLifecycle({ childSessionKey: closedThread.childSessionKey! });
    deleteSession(THREAD_TWO);

    const onOpen = legacyTrigger("page-comment:site_1:/blog/a", "child-open");
    const onClosed = legacyTrigger("page-comment:site_1:/blog/b", "child-closed");
    const byKey = legacyTrigger("page-comment:site_1:/blog/c", THREAD_ONE);
    const onParent = legacyTrigger("page-comment:site_1:/blog/d", "parent");
    const unowned = legacyTrigger("page-comment:site_1:/blog/e", undefined);
    // Not the product's own follow: the close guard keeps refusing these, repair does not touch them.
    const arbitrary = legacyTrigger("ci-follow", "child-open");

    const result = repairThreadBoundPageCommentFollows();

    expect(result.failures).toEqual([]);
    expect(result.repaired).toBe(3);
    for (const trigger of [onOpen, onClosed, byKey]) {
      expect(dbGetTrigger(trigger.id)).toMatchObject({ replySession: "parent", agentId: "agent-test" });
    }
    expect(dbGetTrigger(onParent.id)!.replySession).toBe("parent");
    expect(dbGetTrigger(unowned.id)!.replySession).toBeUndefined();
    expect(dbGetTrigger(arbitrary.id)!.replySession).toBe("child-open");
    expect(repairThreadBoundPageCommentFollows().repaired).toBe(0);
    expect(() => closeSlackThreadLifecycle({ childSessionKey: openThread.childSessionKey! })).toThrow(
      "Thread still receives active triggers",
    );
  });

  it("closes a thread that only the repaired follows were holding", () => {
    seedParent();
    const record = seedThread(THREAD_ONE, "child", "1.2");
    legacyTrigger("page-comment:site_1:/blog/a", "child");
    legacyTrigger("page-comment:site_1:/blog/b", "child");
    expect(() => closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! })).toThrow(
      "Thread still receives active triggers",
    );

    expect(repairThreadBoundPageCommentFollows().repaired).toBe(2);

    expect(closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! }).changed).toBe(true);
  });

  it("leaves a trigger it cannot verify and reports why", () => {
    seedParent();
    const ghost = legacyTrigger("page-comment:site_1:/blog/a", `${PARENT_KEY}:thread:9.9`);

    const result = repairThreadBoundPageCommentFollows();

    expect(result.repaired).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ triggerId: ghost.id });
    expect(String(result.failures[0]!.error)).toContain("thread lifecycle is missing or ambiguous");
    expect(dbGetTrigger(ghost.id)!.replySession).toBe(`${PARENT_KEY}:thread:9.9`);
  });

  it("leaves a trigger on another channel's thread or a task's thread alone, and reports no failure", () => {
    seedNonSlackThreads();
    const onTask = legacyTrigger("page-comment:site_1:/blog/a", "task-worker");
    const byKey = legacyTrigger("page-comment:site_1:/blog/b", WHATSAPP_THREAD_KEY);

    expect(repairThreadBoundPageCommentFollows()).toEqual({ repaired: 0, failures: [] });

    expect(dbGetTrigger(onTask.id)!.replySession).toBe("task-worker");
    expect(dbGetTrigger(byKey.id)!.replySession).toBe(WHATSAPP_THREAD_KEY);
  });

  it("reports a write that fails and keeps repairing the others", () => {
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    const first = legacyTrigger("page-comment:site_1:/blog/a", "child");
    const second = legacyTrigger("page-comment:site_1:/blog/b", "child");

    const result = repairThreadBoundPageCommentFollows({
      updateTrigger: (id, updates) => {
        if (id === first.id) throw new Error("db busy");
        return dbGetTrigger(second.id) && Object.assign({}, updates);
      },
    });

    expect(result.repaired).toBe(1);
    expect(result.failures).toEqual([{ triggerId: first.id, error: expect.objectContaining({ message: "db busy" }) }]);
  });

  it("reads the target of a stored trigger without writing", () => {
    seedParent();
    seedThread(THREAD_ONE, "child", "1.2");
    const trigger = legacyTrigger("page-comment:site_1:/blog/a", "child", {
      replySource: { channel: "slack", accountId: ACCOUNT, chatId: "C123#1.2", threadId: "1.2" },
    });
    expect(pageCommentReplyTargetPatch(trigger)).toEqual({
      agentId: "agent-test",
      accountId: ACCOUNT,
      replySession: "parent",
      replySource: { channel: "slack", accountId: ACCOUNT, chatId: "C123" },
    });
    expect(dbGetTrigger(trigger.id)!.replySession).toBe("child");
  });
});

describe("daemon boot repairs the triggers left on threads before the trigger runner loads", () => {
  // The daemon's own boot step, as written in daemon.ts, run without importing the
  // daemon and starting its services. A change to that function's boundaries
  // intentionally requires updating this test.
  const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
  const bootStep = "function repairThreadBoundPageCommentFollowsAtBoot(): void {";
  const bootStart = daemonSource.indexOf(bootStep);
  const bootEnd = daemonSource.indexOf("\n}\n", bootStart) + 2;
  const startDaemonAt = daemonSource.indexOf("export async function startDaemon()");

  type LogCall = { level: "info" | "warn" | "error"; message: string; fields: Record<string, unknown> };

  function runBootStep(repair: () => unknown = repairThreadBoundPageCommentFollows) {
    const calls: LogCall[] = [];
    const record =
      (level: LogCall["level"]) =>
      (message: string, fields: Record<string, unknown> = {}) => {
        calls.push({ level, message, fields });
      };
    const log = { info: record("info"), warn: record("warn"), error: record("error") };
    const js = new Transpiler({ loader: "ts" }).transformSync(daemonSource.slice(bootStart, bootEnd));
    const step = new Function(
      "repairThreadBoundPageCommentFollows",
      "log",
      `${js}\nreturn repairThreadBoundPageCommentFollowsAtBoot;`,
    )(repair, log) as () => void;
    return { step, calls };
  }

  const pageCommentTrigger = (route: string, replySession: string) =>
    dbCreateTrigger({
      name: `page-comment:site_1:${route}`,
      topic: "ravi.watch.console.page.comment.created",
      message: "comment",
      agentId: "agent-test",
      session: "main",
      replySession,
    });

  it("finds the boot step and the repair it runs in the daemon source", () => {
    expect(bootStart).toBeGreaterThan(-1);
    expect(bootEnd).toBeGreaterThan(bootStart);
    expect(daemonSource).toContain('import { repairThreadBoundPageCommentFollows } from "./pages/comment-follow.js";');
  });

  it("moves the triggers a restart finds on threads, so the threads close, and reports what it could not verify", () => {
    seedParent();
    const record = seedThread(THREAD_ONE, "child", "1.2");
    const held = pageCommentTrigger("/blog/a", "child");
    const unverifiable = pageCommentTrigger("/blog/b", `${PARENT_KEY}:thread:9.9`);
    expect(() => closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! })).toThrow(
      "Thread still receives active triggers",
    );

    const { step, calls } = runBootStep();
    step();

    expect(dbGetTrigger(held.id)!.replySession).toBe("parent");
    expect(dbGetTrigger(unverifiable.id)!.replySession).toBe(`${PARENT_KEY}:thread:9.9`);
    expect(calls.map((call) => call.level)).toEqual(["info", "warn"]);
    expect(calls[0]).toMatchObject({ level: "info", fields: { repaired: 1 } });
    expect(calls[1]).toMatchObject({ level: "warn", fields: { triggerId: unverifiable.id } });
    expect(closeSlackThreadLifecycle({ childSessionKey: record.childSessionKey! }).changed).toBe(true);
  });

  it("is silent when there is nothing to move, and boot goes on when the repair itself fails", () => {
    seedParent();
    pageCommentTrigger("/blog/a", "parent");
    const quiet = runBootStep();
    quiet.step();
    expect(quiet.calls).toEqual([]);

    const failing = runBootStep(() => {
      throw new Error("db locked");
    });
    expect(() => failing.step()).not.toThrow();
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0]).toMatchObject({
      level: "error",
      fields: { error: expect.objectContaining({ message: "db locked" }) },
    });
  });

  it("startDaemon runs the step once, after the runtime state is ready and before the trigger runner starts", () => {
    const call = "\n  repairThreadBoundPageCommentFollowsAtBoot();\n";
    const body = daemonSource.slice(startDaemonAt);
    const callAt = body.indexOf(call);
    expect(startDaemonAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(daemonSource.split("repairThreadBoundPageCommentFollowsAtBoot();").length - 1).toBe(1);
    expect(body.indexOf("initializeRuntimeState()")).toBeGreaterThan(-1);
    expect(body.indexOf("initializeRuntimeState()")).toBeLessThan(callAt);
    expect(body.indexOf("await startTriggerRunner();")).toBeGreaterThan(callAt);
  });
});
