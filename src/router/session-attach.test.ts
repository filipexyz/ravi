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
  SessionAttachConflictError,
  SessionAttachInstanceMismatchError,
  isChatCompatibleWithSession,
} from "./sessions.js";
import {
  closeRouterDb,
  dbLegacySessionChatBindingsTableExists,
  dbPlantLegacySessionChatBindingForTests,
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
    const first = detachChatFromSession(session.sessionKey, chat.id, session.name);
    expect(first.detached).toBe(true);
    expect(first.outputDetached).toBe(true);
    expect(first.attached).toBe(false);
    expect(first.defaultOutput).toBe(false);
    expect(first.legacy).toEqual({ table: "session_chat_bindings", status: "none" });
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(0);
    const second = detachChatFromSession(session.sessionKey, chat.id, session.name);
    expect(second.detached).toBe(false);
    expect(second.outputDetached).toBe(false);
    expect(second.attached).toBe(false);
    expect(second.legacy.status).toBe("none");
  });

  it("detach with another output selected keeps that output and is idempotent", () => {
    const session = makeSession("detach-other-output");
    const outputChat = makeChat("keep-output");
    const extraChat = makeChat("detach-extra");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: outputChat.id, setOutputTarget: true });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: extraChat.id, setOutputTarget: false });

    const first = detachChatFromSession(session.sessionKey, extraChat.id, session.name);
    expect(first.detached).toBe(true);
    expect(first.outputDetached).toBe(false);
    expect(first.attached).toBe(false);
    expect(first.subscriptions).toEqual([
      expect.objectContaining({
        chatId: outputChat.id,
        defaultOutput: true,
        detached: false,
      }),
    ]);

    const second = detachChatFromSession(session.sessionKey, extraChat.id, session.name);
    expect(second.detached).toBe(false);
    expect(second.attached).toBe(false);
    expect(listSessionSubscriptions(session.sessionKey).map((row) => row.chatId)).toEqual([outputChat.id]);
    expect(listSessionSubscriptions(session.sessionKey)[0].outputAttachedAt).toBeNumber();
  });

  it("detach with no competing output does not resurrect after repeated db init", () => {
    const session = makeSession("no-compete");
    const chat = makeChat("only-output");
    const other = makeChat("unrelated-history");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: other.id, setOutputTarget: false });
    dbPlantLegacySessionChatBindingForTests({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      bindingReason: "stale-after-detach",
      seenAt: 9_000,
    });

    detachChatFromSession(session.sessionKey, chat.id);
    expect(listSessionSubscriptions(session.sessionKey).map((row) => row.chatId)).toEqual([other.id]);

    closeRouterDb();
    getDb();
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);
    expect(listSessionSubscriptions(session.sessionKey).map((row) => row.chatId)).toEqual([other.id]);
    expect(findSessionByAttachedChat(chat.id)).toBeNull();

    closeRouterDb();
    getDb();
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);
    expect(listSessionSubscriptions(session.sessionKey).map((row) => row.chatId)).toEqual([other.id]);
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

  it("detaches the only primary subscription", () => {
    const session = makeSession("solo");
    const chat = makeChat("solo-chat");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, role: "primary" });
    const result = detachChatFromSession(session.sessionKey, chat.id);
    expect(result).toMatchObject({ detached: true, outputDetached: true, attached: false, defaultOutput: false });
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(0);
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
    expect(inputSub?.outputAttachedAt).toBeUndefined();
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
  function chatOnChannelInstance(suffix: string, channel: string, instanceId: string) {
    return dbUpsertChat({
      channel,
      instanceId,
      platformChatId: channel === "slack" ? suffix : `${suffix}@g.us`,
      chatType: "group",
      title: `${channel}-${suffix}`,
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

  it("reports a same-channel chat on a different instance as incompatible", () => {
    const session = sessionOnInstance("iso-2", "main");
    const fgnChat = chatOnInstance("iso-2", "luis");
    expect(isChatCompatibleWithSession(fgnChat.id, session.sessionKey)).toBe(false);
  });

  it("allows cross-channel attach even when instances differ", () => {
    const session = sessionOnInstance("iso-slack", "main");
    const slackChat = chatOnChannelInstance("C0BG33ZUWJC", "slack", "ravi-rbbt-slack");
    const result = attachChatToSession({ sessionKey: session.sessionKey, chatId: slackChat.id });
    expect(result.created).toBe(true);
    expect(isChatCompatibleWithSession(slackChat.id, session.sessionKey)).toBe(true);
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

describe("sessions/attach — migration (dedupe + one-time binding drop)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-attach-migration-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("converts the newest leftover binding per chat and never creates a second output", () => {
    const older = makeSession("older");
    const newer = makeSession("newer");
    const shared = makeChat("shared-legacy");
    const existingOutput = makeChat("existing-output");
    attachChatToSession({ sessionKey: newer.sessionKey, chatId: existingOutput.id, setOutputTarget: true });

    dbPlantLegacySessionChatBindingForTests({
      sessionKey: older.sessionKey,
      chatId: shared.id,
      bindingReason: "legacy",
      seenAt: 1_000,
    });
    dbPlantLegacySessionChatBindingForTests({
      sessionKey: newer.sessionKey,
      chatId: shared.id,
      bindingReason: "legacy",
      seenAt: 2_000,
    });

    dbRunSessionAttachMigrationForTests();

    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);
    const olderSubs = listSessionSubscriptions(older.sessionKey).filter((s) => s.chatId === shared.id);
    const newerSubs = listSessionSubscriptions(newer.sessionKey).filter((s) => s.chatId === shared.id);
    expect(olderSubs).toHaveLength(0);
    expect(newerSubs).toHaveLength(1);
    expect(newerSubs[0].outputAttachedAt).toBeUndefined();
    expect(
      listSessionSubscriptions(newer.sessionKey).find((s) => s.chatId === existingOutput.id)?.outputAttachedAt,
    ).toBeNumber();
  });

  it("does not resurrect an intentionally detached pair from a leftover binding", () => {
    const session = makeSession("stale-bind");
    const keep = makeChat("keep-output");
    const detached = makeChat("stale-detached");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: keep.id, setOutputTarget: true });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: detached.id, setOutputTarget: false });
    detachChatFromSession(session.sessionKey, detached.id);
    dbPlantLegacySessionChatBindingForTests({
      sessionKey: session.sessionKey,
      chatId: detached.id,
      bindingReason: "stale",
      seenAt: 9_000,
    });

    expect(() => dbRunSessionAttachMigrationForTests()).not.toThrow();
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);
    expect(findSessionByAttachedChat(detached.id)).toBeNull();
    expect(listSessionSubscriptions(session.sessionKey).map((row) => row.chatId)).toEqual([keep.id]);
    expect(listSessionSubscriptions(session.sessionKey)[0].outputAttachedAt).toBeNumber();
  });

  it("migration is idempotent — re-running keeps the same state and drops the legacy table", () => {
    const session = makeSession("idem-sess");
    const chat = makeChat("idem-chat");
    dbPlantLegacySessionChatBindingForTests({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      bindingReason: "legacy",
      seenAt: 1_000,
    });

    dbRunSessionAttachMigrationForTests();
    const after1 = listSessionSubscriptions(session.sessionKey);
    expect(after1).toHaveLength(1);
    expect(after1[0].outputAttachedAt).toBeNumber();
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);

    dbRunSessionAttachMigrationForTests();
    const after2 = listSessionSubscriptions(session.sessionKey);
    expect(after2).toHaveLength(1);
    expect(after2[0].id).toBe(after1[0].id);
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);

    closeRouterDb();
    getDb();
    expect(listSessionSubscriptions(session.sessionKey)).toHaveLength(1);
    expect(dbLegacySessionChatBindingsTableExists()).toBe(false);

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

describe("sessions/attach — CLI final state", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-attach-cli-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function captureStdout(run: () => void): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    };
    try {
      run();
      return lines.join("\n");
    } finally {
      console.log = original;
    }
  }

  it("prints JSON and human attach/detach state with no legacy binding", async () => {
    const { SessionCommands } = await import("../cli/commands/sessions.js");
    const commands = new SessionCommands();
    const session = makeSession("cli-state");
    const chat = makeChat("cli-chat");
    const other = makeChat("cli-other");
    attachChatToSession({ sessionKey: session.sessionKey, chatId: other.id, setOutputTarget: true });

    const attachJson = JSON.parse(
      captureStdout(() => commands.attach(session.sessionKey, chat.id, "cli-test", true)),
    ) as Record<string, unknown>;
    expect(attachJson).toMatchObject({
      session: { sessionKey: session.sessionKey },
      chatId: chat.id,
      attached: true,
      defaultOutput: true,
      created: true,
      legacy: { table: "session_chat_bindings", status: "none" },
    });
    expect(attachJson.subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: chat.id, defaultOutput: true, detached: false }),
        expect.objectContaining({ chatId: other.id, defaultOutput: false, detached: false }),
      ]),
    );

    const attachHuman = captureStdout(() => commands.attach(session.sessionKey, chat.id, undefined, false));
    expect(attachHuman).toContain("Already attached");
    expect(attachHuman).toContain("Attached: yes");
    expect(attachHuman).toContain(`Default output: ${chat.id}`);
    expect(attachHuman).toContain("Legacy bindings: none");

    const detachJson = JSON.parse(captureStdout(() => commands.detach(session.sessionKey, chat.id, true))) as Record<
      string,
      unknown
    >;
    expect(detachJson).toMatchObject({
      session: { sessionKey: session.sessionKey },
      chatId: chat.id,
      attached: false,
      defaultOutput: false,
      detached: true,
      outputDetached: true,
      legacy: { table: "session_chat_bindings", status: "none" },
    });
    expect(detachJson.subscriptions).toEqual([
      expect.objectContaining({ chatId: other.id, defaultOutput: false, detached: false }),
    ]);

    const detachHuman = captureStdout(() => commands.detach(session.sessionKey, chat.id, false));
    expect(detachHuman).toContain("is not currently attached");
    expect(detachHuman).toContain("Attached: no");
    expect(detachHuman).toContain("Legacy bindings: none");
  });
});
