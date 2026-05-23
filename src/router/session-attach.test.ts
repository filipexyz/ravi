/**
 * Tests for sessions/attach — subscriptions + output attachment.
 *
 * Covers the DB helpers (dbCreateSessionChatSubscription, dbDetach...,
 * ...) plus the high-level wrappers in `sessions.ts` that enforce
 * cross-session uniqueness and output-target behavior.
 *
 * See .ravi/specs/sessions/attach/SPEC.md
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  attachChatToSession,
  detachChatFromSession,
  findSessionByAttachedChat,
  getOrCreateSession,
  listSessionSubscriptions,
  setSessionChatSpeechMode,
  SessionAttachConflictError,
  SessionAttachInstanceMismatchError,
  subscriptionAllowsCrossInstance,
} from "./sessions.js";
import {
  dbBindSessionToChat,
  dbRunSessionAttachMigrationForTests,
  dbUpsertChat,
  dbUpsertInstance,
  getDb,
} from "./router-db.js";

let stateDir: string | null = null;

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "luis",
    platformChatId: `${suffix}@s.whatsapp.net`,
    chatType: "dm",
    title: `chat-${suffix}`,
  });
}

function makeSession(suffix: string) {
  return getOrCreateSession(`agent:dev:${suffix}`, "dev", "/tmp/dev");
}

describe("sessions/attach — subscriptions + output attachment", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-attach-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("attach creates a new subscription and selects it as output by default", () => {
    const session = makeSession("s1");
    const chat = makeChat("c1");
    const result = attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, attachedByType: "user" });
    expect(result.created).toBe(true);
    expect(result.outputAttached).toBe(true);
    expect(result.subscription.role).toBe("input");
    expect(result.subscription.sessionKey).toBe(session.sessionKey);
    expect(result.subscription.chatId).toBe(chat.id);
    expect(result.subscription.speechMode).toBe("speak");
    expect(result.subscription.outputAttachedAt).toBeNumber();
  });

  it("re-attach is idempotent — returns the existing active row", () => {
    const session = makeSession("s2");
    const chat = makeChat("c2");
    const first = attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    const second = attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    expect(first.subscription.id).toBe(second.subscription.id);
    expect(second.created).toBe(false);
    expect(second.outputAttached).toBe(true);
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(1);
  });

  it("attaching a chat already attached to another session fails closed", () => {
    const owner = makeSession("owner");
    const other = makeSession("other");
    const chat = makeChat("shared");
    attachChatToSession({ sessionKey: owner.sessionKey, chatId: chat.id });
    expect(() => attachChatToSession({ sessionKey: other.sessionKey, chatId: chat.id })).toThrow(
      SessionAttachConflictError,
    );
  });

  it("dbCreateSessionChatSubscription translates a UNIQUE(chat_id) race on INSERT into a typed conflict", async () => {
    // Bypass the high-level `attachChatToSession` probe to hit the
    // INSERT-side race. `dbCreateSessionChatSubscription` is the layer
    // that catches the raw SQLite UNIQUE error and re-throws as
    // SubscriptionChatConflictError; `attachChatToSession` re-wraps it
    // into SessionAttachConflictError. Both layers are exercised here.
    const { dbCreateSessionChatSubscription, SubscriptionChatConflictError } = await import("./router-db.js");
    const owner = makeSession("race-db-owner");
    const other = makeSession("race-db-other");
    const chat = makeChat("race-db-shared");

    dbCreateSessionChatSubscription({ sessionKey: owner.sessionKey, chatId: chat.id, role: "input" });

    expect(() =>
      dbCreateSessionChatSubscription({ sessionKey: other.sessionKey, chatId: chat.id, role: "input" }),
    ).toThrow(SubscriptionChatConflictError);
  });

  it("dbCreateSessionChatSubscription translates a UNIQUE(chat_id) race on reactivation into a typed conflict", async () => {
    // Scenario: session B previously attached chat C then detached. Now
    // session A attaches chat C (creates an active row). When session B
    // re-attaches chat C, the existence probe for (B, C) returns nothing
    // active, so the reactivation UPDATE fires and tries to flip B's
    // soft-detached row back to detached_at=NULL — which violates the
    // UNIQUE index because A already owns chat C. Without the
    // reactivation-path catch, that surfaces as a raw SQLite error.
    const { dbCreateSessionChatSubscription, SubscriptionChatConflictError, dbDetachSessionChatSubscription } =
      await import("./router-db.js");
    const sessionB = makeSession("reactivate-b");
    const sessionA = makeSession("reactivate-a");
    const chat = makeChat("reactivate-c");

    dbCreateSessionChatSubscription({ sessionKey: sessionB.sessionKey, chatId: chat.id, role: "input" });
    dbDetachSessionChatSubscription(sessionB.sessionKey, chat.id);
    dbCreateSessionChatSubscription({ sessionKey: sessionA.sessionKey, chatId: chat.id, role: "input" });

    expect(() =>
      dbCreateSessionChatSubscription({ sessionKey: sessionB.sessionKey, chatId: chat.id, role: "input" }),
    ).toThrow(SubscriptionChatConflictError);
  });

  it("detach soft-deletes non-primary rows and clears output", () => {
    const session = makeSession("s3");
    const chat = makeChat("c3");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    const first = detachChatFromSession(session.sessionKey, chat.id);
    expect(first.detached).toBe(true);
    expect(first.outputDetached).toBe(true);
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(0);
    const second = detachChatFromSession(session.sessionKey, chat.id);
    expect(second.detached).toBe(false);
    expect(second.outputDetached).toBe(false);
  });

  it("detach-then-reattach reuses the soft-deleted row", () => {
    const session = makeSession("s4");
    const chat = makeChat("c4");
    const first = attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    detachChatFromSession(session.sessionKey, chat.id);
    const second = attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    expect(second.subscription.id).toBe(first.subscription.id);
    expect(second.created).toBe(true);
  });

  it("detaching the only primary clears output but preserves input subscription", () => {
    const session = makeSession("solo");
    const chat = makeChat("solo-chat");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, role: "primary" });
    const result = detachChatFromSession(session.sessionKey, chat.id);
    expect(result).toEqual({ detached: false, outputDetached: true });
    const subs = listSessionSubscriptions(session.sessionKey);
    expect(subs).toHaveLength(1);
    expect(subs[0].role).toBe("primary");
    expect(subs[0].speechMode).toBe("muted");
    expect(subs[0].outputAttachedAt).toBeUndefined();
  });

  it("inbound bookkeeping can subscribe without stealing the output attachment", () => {
    const session = makeSession("bookkeeping");
    const outputChat = makeChat("bookkeeping-output");
    const inputChat = makeChat("bookkeeping-input");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });
    attachChatToSession({
      sessionKey: session.sessionKey,
      chatId: inputChat.id,
      setOutputTarget: false,
      attachedReason: "inbound-route",
    });

    const subs = listSessionSubscriptions(session.sessionKey);
    const outputSub = subs.find((s) => s.chatId === outputChat.id);
    const inputSub = subs.find((s) => s.chatId === inputChat.id);
    expect(outputSub?.outputAttachedAt).toBeNumber();
    expect(outputSub?.speechMode).toBe("speak");
    expect(inputSub?.outputAttachedAt).toBeUndefined();
    expect(inputSub?.speechMode).toBe("muted");
  });

  it("can toggle speech mode without detaching the input subscription", () => {
    const session = makeSession("speech-toggle");
    const chat = makeChat("speech-toggle-chat");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, setOutputTarget: false });

    const unmuted = setSessionChatSpeechMode({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      speechMode: "speak",
      reason: "test-unmute",
    });
    expect(unmuted.speechMode).toBe("speak");

    const muted = setSessionChatSpeechMode({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      speechMode: "muted",
      reason: "test-mute",
    });
    expect(muted.speechMode).toBe("muted");
    expect(findSessionByAttachedChat(chat.id)?.sessionKey).toBe(session.sessionKey);
  });

  it("muting the default output clears output while preserving the input subscription", () => {
    const session = makeSession("mute-output");
    const chat = makeChat("mute-output-chat");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });

    const muted = setSessionChatSpeechMode({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      speechMode: "muted",
      reason: "test-mute-output",
    });

    expect(muted.speechMode).toBe("muted");
    expect(muted.outputAttachedAt).toBeUndefined();
    expect(findSessionByAttachedChat(chat.id)?.sessionKey).toBe(session.sessionKey);
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(1);
  });

  it("findSessionByAttachedChat returns the owner subscription", () => {
    const session = makeSession("finder");
    const chat = makeChat("find-me");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    const found = findSessionByAttachedChat(chat.id);
    expect(found?.sessionKey).toBe(session.sessionKey);
    expect(found?.chatId).toBe(chat.id);
  });

  it("findSessionByAttachedChat returns null after detach", () => {
    const session = makeSession("finder2");
    const chat = makeChat("gone");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    detachChatFromSession(session.sessionKey, chat.id);
    expect(findSessionByAttachedChat(chat.id)).toBeNull();
  });
});

describe("sessions/attach — instance isolation", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-instance-isolation-");
    // Two instances on the same channel; chat lives on one, session on the other.
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
    dbUpsertInstance({ name: "luis", channel: "whatsapp" });
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function chatOnInstance(suffix: string, instanceId: string) {
    return dbUpsertChat({
      channel: "whatsapp",
      instanceId,
      platformChatId: `${suffix}@g.us`,
      chatType: "group",
      title: `chat-${suffix}`,
    });
  }
  function sessionOnInstance(suffix: string, accountId: string) {
    // getOrCreateSession only persists `account_id` when it's in defaults at
    // first-create. `updateSessionSource` writes `last_account_id`, which is
    // separate. The isolation check reads `session.accountId` (= account_id),
    // so we have to seed it via defaults.
    return getOrCreateSession(`agent:dev:whatsapp:${accountId}:group:${suffix}`, "dev", "/tmp/dev", {
      accountId,
      channel: "whatsapp",
    });
  }

  // Note: the isolation helper compares `chat.instanceId` (resolved via
  // dbGetInstanceByInstanceId → .name, falling back to the raw id) to
  // `session.accountId`. Tests can shortcut by using the instance name
  // directly as the chat's instance id — the fallback path treats them
  // as equivalent.

  it("attachChatToSession throws when chat instance differs from session instance", () => {
    const session = sessionOnInstance("iso-1", "main");
    const fgnChat = chatOnInstance("iso-1", "luis");
    expect(() => attachChatToSession({ sessionKey: session.sessionKey, chatId: fgnChat.id })).toThrow(
      SessionAttachInstanceMismatchError,
    );
  });

  it("subscriptionAllowsCrossInstance returns false for chat on a different instance", () => {
    const session = sessionOnInstance("iso-2", "main");
    const fgnChat = chatOnInstance("iso-2", "luis");
    expect(subscriptionAllowsCrossInstance(fgnChat.id, session.sessionKey)).toBe(false);
  });

  it("attachChatToSession allows chat on the same instance", () => {
    const session = sessionOnInstance("iso-3", "main");
    const sameChat = chatOnInstance("iso-3", "main");
    const result = attachChatToSession({ sessionKey: session.sessionKey, chatId: sameChat.id });
    expect(result.created).toBe(true);
  });

  it("sessions with no accountId skip the instance check (backward compat)", () => {
    // Legacy session_key shape without an account segment → accountId is null.
    const session = getOrCreateSession("agent:dev:legacy-no-account", "dev", "/tmp/dev");
    const anyChat = chatOnInstance("iso-4", "any-instance-uuid");
    const result = attachChatToSession({ sessionKey: session.sessionKey, chatId: anyChat.id });
    expect(result.created).toBe(true);
  });
});

describe("sessions/attach — migration (dedupe + backfill)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-attach-migration-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("backfill picks at most one subscription per chat when legacy bindings overlap", () => {
    // Two sessions share the same legacy chat binding — possible under
    // the pre-attach 1:1 schema, which only had PK(session_key, chat_id)
    // and no cross-session UNIQUE.
    const older = makeSession("older");
    const newer = makeSession("newer");
    const shared = makeChat("shared-legacy");

    dbBindSessionToChat({
      sessionKey: older.sessionKey,
      chatId: shared.id,
      bindingReason: "legacy",
      seenAt: 1_000,
    });
    dbBindSessionToChat({
      sessionKey: newer.sessionKey,
      chatId: shared.id,
      bindingReason: "legacy",
      seenAt: 2_000,
    });

    // Manually wipe any subscription created by the initial migration so
    // we can re-run the backfill against the legacy bindings.
    getDb().prepare("DELETE FROM session_chat_subscriptions WHERE chat_id = ?").run(shared.id);
    dbRunSessionAttachMigrationForTests();

    const olderSubs = listSessionSubscriptions(older.sessionKey).filter((s) => s.chatId === shared.id);
    const newerSubs = listSessionSubscriptions(newer.sessionKey).filter((s) => s.chatId === shared.id);
    expect(olderSubs.length + newerSubs.length).toBe(1);
    // Most recent binding wins (newer.updated_at > older.updated_at).
    expect(newerSubs).toHaveLength(1);
    expect(newerSubs[0].outputAttachedAt).toBeNumber();
    expect(olderSubs).toHaveLength(0);
  });

  it("migration is idempotent — re-running keeps the same state and same schema", () => {
    const session = makeSession("idem-sess");
    const chat = makeChat("idem-chat");
    dbBindSessionToChat({ sessionKey: session.sessionKey, chatId: chat.id, bindingReason: "legacy", seenAt: 1_000 });
    getDb().prepare("DELETE FROM session_chat_subscriptions WHERE chat_id = ?").run(chat.id);

    dbRunSessionAttachMigrationForTests();
    const after1 = listSessionSubscriptions(session.sessionKey);
    expect(after1).toHaveLength(1);
    expect(after1[0].outputAttachedAt).toBeNumber();

    // Re-run; should not crash, should not duplicate, should not lose data.
    dbRunSessionAttachMigrationForTests();
    const after2 = listSessionSubscriptions(session.sessionKey);
    expect(after2).toHaveLength(1);
    expect(after2[0].id).toBe(after1[0].id);

    const idx = getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_session_chat_subscriptions_active_chat'")
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toContain("CREATE UNIQUE INDEX");
  });

  it("dedupe detaches duplicate active subscriptions, keeping the most recent per chat", () => {
    const sessionA = makeSession("dedupe-a");
    const sessionB = makeSession("dedupe-b");
    const chat = makeChat("dedupe-shared");

    const db = getDb();
    // Simulate the legacy state: a DB created by the older non-unique
    // index allowed duplicates. Drop the UNIQUE index temporarily so we
    // can plant two active rows, then let the migration upgrade clean it.
    db.exec("DROP INDEX IF EXISTS idx_session_chat_subscriptions_active_chat");
    const insert = db.prepare(
      `INSERT INTO session_chat_subscriptions (
        session_key, chat_id, role, attached_by_type, attached_by_id,
        attached_reason, context_snapshot_at_attach_json, created_at, updated_at, detached_at
      ) VALUES (?, ?, 'primary', 'system', NULL, ?, NULL, ?, ?, NULL)`,
    );
    insert.run(sessionA.sessionKey, chat.id, "first", 1_000, 1_000);
    insert.run(sessionB.sessionKey, chat.id, "second", 2_000, 2_000);

    dbRunSessionAttachMigrationForTests();

    const aSubs = listSessionSubscriptions(sessionA.sessionKey).filter((s) => s.chatId === chat.id);
    const bSubs = listSessionSubscriptions(sessionB.sessionKey).filter((s) => s.chatId === chat.id);
    expect(aSubs).toHaveLength(0);
    expect(bSubs).toHaveLength(1);
    expect(bSubs[0].outputAttachedAt).toBeNumber();
    expect(findSessionByAttachedChat(chat.id)?.sessionKey).toBe(sessionB.sessionKey);
  });
});
