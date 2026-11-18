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
import { resolveDurableFollowOwner } from "./follow-owner.js";
import { dbCreateTrigger, dbGetTrigger } from "./triggers-db.js";

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
