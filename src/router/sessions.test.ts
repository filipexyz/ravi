import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeRouterDb, dbUpsertChat, getDb } from "./router-db.js";
import {
  applySessionRuntimeConfigAtomically,
  attachChatToSession,
  bumpSessionRuntimeProviderConfigRevision,
  clearProviderSession,
  clearProviderSessionIfRuntimeConfigOwned,
  closeSessionStore,
  restoreSessionRuntimeConfigIfOwned,
  sessionRuntimeConfigOwned,
  updateSessionModelOverride,
  detachChatFromSession,
  expireEphemeralSession,
  findSessionByChatId,
  getExpiredSessions,
  getOrCreateSession,
  getSession,
  getSessionByName,
  getSessionTurnUsageSummary,
  isReservedSessionKey,
  listSessionSubscriptions,
  renameSessionName,
  ReservedSessionKeyError,
  resetSession,
  resolveSession,
  setSessionEphemeral,
  updateSessionContext,
  updateSessionName,
  updateSessionSource,
  updateProviderSession,
  updateProviderSessionId,
  updateRuntimeProviderState,
  updateSdkSessionId,
  updateSessionEffortOverride,
  updateSessionRuntimeProviderOverride,
  updateSessionThreadId,
  updateTokens,
} from "./sessions.js";
import { getRecentHistory, saveMessage } from "../db.js";
import type { MessageContext } from "../runtime/message-types.js";
import { lowestTierReadInTurn, recordKnowledgeRead } from "../knowledge/store/turn-reads.js";
import { upsertSessionTurn } from "../session-trace/session-trace-db.js";

let stateDir: string | null = null;

describe("sessions store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-sessions-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates a session under a trigger's key for the trigger runner only", () => {
    const isolated = "agent:main:trigger:ab12cd34";
    const own = "agent:main:trigger:ab12cd34:own";
    const named = "agent:main:trigger:ab12cd34:key:0123456789abcdef01234567";
    expect(isReservedSessionKey(isolated)).toBe(true);
    expect(isReservedSessionKey(own)).toBe(true);
    expect(isReservedSessionKey(named)).toBe(true);

    // A session created from a name someone chose, however it got here.
    for (const key of [isolated, own, named]) {
      expect(() => getOrCreateSession(key, "main", stateDir!, { name: key })).toThrow(ReservedSessionKeyError);
      expect(() => getOrCreateSession(key, "main", stateDir!)).toThrow(/reserved for the trigger/);
      expect(() => getOrCreateSession(key, "main", stateDir!, undefined, {})).toThrow(ReservedSessionKeyError);
      expect(getSession(key)).toBeNull();
      expect(resolveSession(key)).toBeNull();
    }

    // The trigger runner creates it; from then on it is an existing session
    // like any other, returned to whoever asks for it by key.
    const created = getOrCreateSession(
      isolated,
      "main",
      stateDir!,
      { name: "main-trigger-rows" },
      { triggerRunner: true },
    );
    expect(created).toMatchObject({ sessionKey: isolated, name: "main-trigger-rows" });
    expect(getOrCreateSession(isolated, "main", stateDir!)).toMatchObject({ sessionKey: isolated });
    expect(getOrCreateSession(named, "main", stateDir!, undefined, { triggerRunner: true }).sessionKey).toBe(named);
    expect(getOrCreateSession(own, "main", stateDir!, undefined, { triggerRunner: true }).sessionKey).toBe(own);
  });

  it("lets a name spelled like a trigger's session key be only that session's own key", () => {
    const chat = "agent:main:whatsapp:dm:5511888888888";
    // Created under a trigger's session key as its name: a session could then be taken for that one.
    for (const name of [
      "agent:main:trigger:ab12cd34:own",
      "agent:main:trigger:ab12cd34",
      "agent:main:trigger:ab12cd34:key:0123456789abcdef01234567",
      "Agent:Main:Trigger:ab12cd34:own",
      " agent:main:trigger:ab12cd34:own ",
    ]) {
      expect(() => getOrCreateSession(chat, "main", stateDir!, { name })).toThrow("reserved for the trigger's session");
    }
    expect(getSession(chat)).toBeNull();

    // Given such a name later.
    const created = getOrCreateSession(chat, "main", stateDir!, { name: "ana-chat" });
    expect(() => updateSessionName(created.sessionKey, "agent:main:trigger:ab12cd34:own")).toThrow(
      "reserved for the trigger's session",
    );
    expect(getSession(chat)?.name).toBe("ana-chat");

    // Any other name is taken as before, one spelled like another kind of key included
    // (a route may force one); only `renameSessionName` refuses those, as it always did.
    updateSessionName(created.sessionKey, "agent:main:main");
    expect(getSession(chat)?.name).toBe("agent:main:main");
    const byName = getOrCreateSession("agent:main:by-name", "main", stateDir!, { name: "agent:main:by-name" });
    expect(byName.name).toBe("agent:main:by-name");
    updateSessionName(created.sessionKey, chat);
    expect(getSession(chat)?.name).toBe(chat);
  });

  it("names a trigger's own session by its key, whatever it is asked, and never lets it go by another name", () => {
    const own = "agent:main:trigger:ab12cd34:own";
    expect(getOrCreateSession(own, "main", stateDir!, undefined, { triggerRunner: true }).name).toBe(own);
    expect(() => updateSessionName(own, "payroll-sync")).toThrow("goes by its own name only");
    expect(() => renameSessionName(own, "payroll-sync")).toThrow("goes by its own name only");
    // Keeping the name it has is not a rename.
    expect(renameSessionName(own, own).changed).toBe(false);
    expect(getSession(own)?.name).toBe(own);

    // Asked for another name when it is created: refused, and nothing is created.
    const other = "agent:main:trigger:cd34ef56:own";
    expect(() =>
      getOrCreateSession(other, "main", stateDir!, { name: "payroll-sync" }, { triggerRunner: true }),
    ).toThrow("goes by its own name only");
    expect(getSession(other)).toBeNull();

    // An agent id with a dot or a space: the name stays one subject token.
    const dotted = "agent:acme.support:trigger:ab12cd34:own";
    const dottedName = "agent:acme~2E~support:trigger:ab12cd34:own";
    expect(getOrCreateSession(dotted, "acme.support", stateDir!, undefined, { triggerRunner: true }).name).toBe(
      dottedName,
    );
    expect(getSessionByName(dottedName)?.sessionKey).toBe(dotted);
    expect(renameSessionName(dotted, dottedName).changed).toBe(false);
    expect(() => updateSessionName(dotted, "payroll-sync")).toThrow("goes by its own name only");
    // That name is reserved like any name spelled like a trigger's session key.
    const chat = "agent:acme.support:whatsapp:dm:5511888888888";
    expect(() => getOrCreateSession(chat, "acme.support", stateDir!, { name: dottedName })).toThrow(
      "reserved for the trigger's session",
    );

    // The plain and named sessions of a trigger keep the names the runner generates.
    const plain = "agent:main:trigger:ab12cd34";
    expect(
      getOrCreateSession(plain, "main", stateDir!, { name: "main-trigger-rows" }, { triggerRunner: true }).name,
    ).toBe("main-trigger-rows");
  });

  it("never resolves a chat id to a trigger's own session", () => {
    const chatId = "5511888888888@s.whatsapp.net";
    const source = { channel: "whatsapp", accountId: "wa", chatId };
    const chat = "agent:main:whatsapp:dm:5511888888888";
    getOrCreateSession(chat, "main", stateDir!, { name: "ana-chat" });
    updateSessionSource(chat, source);
    expect(findSessionByChatId(chatId)?.sessionKey).toBe(chat);

    // A fire that answers into that chat makes the own session the last one to talk to it.
    const own = "agent:main:trigger:ab12cd34:own";
    getOrCreateSession(own, "main", stateDir!, undefined, { triggerRunner: true });
    getDb()
      .prepare(
        "UPDATE sessions SET last_channel = ?, last_account_id = ?, last_to = ?, updated_at = ? WHERE session_key = ?",
      )
      .run(source.channel, source.accountId, chatId, Date.now() + 60_000, own);
    expect(findSessionByChatId(chatId)?.sessionKey).toBe(chat);

    // With no other session for the chat, the chat id finds nothing.
    getDb().prepare("DELETE FROM sessions WHERE session_key = ?").run(chat);
    expect(findSessionByChatId(chatId)).toBeNull();

    // The plain session of a trigger nobody owns is found as before.
    const plain = "agent:main:trigger:ab12cd34";
    getOrCreateSession(plain, "main", stateDir!, { name: "main-trigger-rows" }, { triggerRunner: true });
    updateSessionSource(plain, source);
    expect(findSessionByChatId(chatId)?.sessionKey).toBe(plain);
  });

  it("leaves every other key open, the ones that only resemble a trigger's included", () => {
    for (const key of [
      "agent:main:main",
      "agent:main:whatsapp:dm:5511999999999",
      "agent:main:cron:job_1",
      "requests-queue",
      // Derived from a trigger's session: a thread of it, or a hash the runner does not write.
      "agent:main:trigger:ab12cd34:thread:1700000000.000100",
      "agent:main:trigger:ab12cd34:own:thread:1700000000.000100",
      "agent:main:trigger:ab12cd34:key:not-a-hash",
      "agent:main:whatsapp:trigger:ab12cd34",
    ]) {
      expect(isReservedSessionKey(key)).toBe(false);
      expect(getOrCreateSession(key, "main", stateDir!).sessionKey).toBe(key);
    }
  });

  it("accounts for a retired turn without replacing the current context snapshot", () => {
    const session = getOrCreateSession("agent:main:retired-usage", "main", stateDir!);
    updateTokens(session.sessionKey, 100, 20, 800);
    updateTokens(session.sessionKey, 10, 4, null);
    expect(getSession(session.sessionKey)).toMatchObject({
      inputTokens: 110,
      outputTokens: 24,
      totalTokens: 134,
      contextTokens: 800,
    });
    updateTokens(session.sessionKey, 0, 0, 0);
    expect(getSession(session.sessionKey)?.contextTokens).toBe(0);
  });

  it("reports unknown usage as null and counts it apart instead of summing it as zero", () => {
    const sessionKey = "agent:main:usage-summary";
    const now = Date.now();
    upsertSessionTurn({
      turnId: "turn-known",
      sessionKey,
      status: "complete",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      startedAt: now - 2_000,
      completedAt: now - 1_500,
      updatedAt: now - 1_500,
    });
    upsertSessionTurn({
      turnId: "turn-unknown",
      sessionKey,
      status: "failed",
      inputTokens: null,
      outputTokens: null,
      outputState: "incomplete",
      startedAt: now - 1_000,
      completedAt: now - 500,
      updatedAt: now - 500,
    });

    const summary = getSessionTurnUsageSummary(sessionKey);
    expect(summary.lastTurn?.inputTokens).toBeNull();
    expect(summary.lastTurn?.effectiveContextTokens).toBeNull();
    expect(summary.lastTurn?.outputState).toBe("incomplete");
    expect(summary.recent.inputTokensAvg).toBe(100);
    expect(summary.recent.unknownUsageTurns).toBe(1);
  });

  it("clears the session's Knowledge reads on reset, so the old context no longer gates writes", () => {
    const session = getOrCreateSession("agent:dev:reads", "dev", "/tmp/dev");
    recordKnowledgeRead({ turnKey: null, sessionKey: session.sessionKey }, "said");
    expect(lowestTierReadInTurn(null, Date.now(), session.sessionKey)).toBe("said");

    resetSession(session.sessionKey);
    expect(lowestTierReadInTurn(null, Date.now(), session.sessionKey)).toBeNull();
  });

  it("keeps a durable recovery boundary across explicit reset, provider updates and automatic recovery", () => {
    const session = getOrCreateSession("agent:main:reset-boundary", "main", "/tmp/main", { name: "reset-boundary" });
    saveMessage("reset-boundary", "user", "old decision");
    const boundary = getRecentHistory("reset-boundary", 1)[0]!.id;
    resetSession(session.sessionKey);
    expect(getSession(session.sessionKey)?.historyResetAfterId).toBe(boundary);
    saveMessage("reset-boundary", "user", "new decision");
    updateProviderSession(session.sessionKey, "codex", "new-provider");
    resetSession(session.sessionKey, { preserveHistoryContext: true });
    expect(getSession(session.sessionKey)?.historyResetAfterId).toBe(boundary);
    expect(
      getRecentHistory("reset-boundary")
        .filter((message) => message.id > boundary)
        .map((message) => message.content),
    ).toEqual(["new decision"]);
    expect(getRecentHistory("reset-boundary")).toHaveLength(2);
  });

  it("persists effort overrides while preserving default fallback semantics", () => {
    const session = getOrCreateSession("agent:dev:effort", "dev", "/tmp/dev");

    expect(session.effortOverride).toBeUndefined();
    expect(getSession(session.sessionKey)?.effortOverride).toBeUndefined();

    updateSessionEffortOverride(session.sessionKey, "high");
    expect(getSession(session.sessionKey)?.effortOverride).toBe("high");

    updateSessionEffortOverride(session.sessionKey, null);
    expect(getSession(session.sessionKey)?.effortOverride).toBeUndefined();
  });

  it("stores an initial effort override when creating a session", () => {
    const session = getOrCreateSession("agent:dev:initial-effort", "dev", "/tmp/dev", {
      effortOverride: "medium",
    });

    expect(session.effortOverride).toBe("medium");
    expect(getSession(session.sessionKey)?.effortOverride).toBe("medium");
  });

  it("persists runtime provider overrides separately from observed provider state", () => {
    const session = getOrCreateSession("agent:dev:provider-override", "dev", "/tmp/dev", {
      runtimeProvider: "codex",
    });

    expect(session.runtimeProvider).toBe("codex");
    expect(session.runtimeProviderOverride).toBeUndefined();

    updateSessionRuntimeProviderOverride(session.sessionKey, "claude");
    expect(getSession(session.sessionKey)).toMatchObject({
      runtimeProvider: "codex",
      runtimeProviderOverride: "claude",
    });

    updateSessionRuntimeProviderOverride(session.sessionKey, null);
    expect(getSession(session.sessionKey)).toMatchObject({
      runtimeProvider: "codex",
      runtimeProviderOverride: undefined,
    });
  });

  it("starts provider configuration revisions at zero, including an initial override", () => {
    for (const runtimeProviderOverride of [undefined, "codex"]) {
      const session = getOrCreateSession(
        `agent:dev:revision-${runtimeProviderOverride ?? "default"}`,
        "dev",
        "/tmp/dev",
        {
          runtimeProviderOverride,
        },
      );
      expect(session.runtimeProviderConfigRevision).toBe(0);
      expect(getSession(session.sessionKey)?.runtimeProviderConfigRevision).toBe(0);
    }
  });

  it("advances provider configuration revisions for repeated clears and repeated selections", () => {
    const session = getOrCreateSession("agent:dev:revision-repeated", "dev", "/tmp/dev");
    const selections = [null, null, "claude", "claude"];
    for (const [index, provider] of selections.entries()) {
      updateSessionRuntimeProviderOverride(session.sessionKey, provider);
      expect(getSession(session.sessionKey)).toMatchObject({
        runtimeProviderOverride: provider ?? undefined,
        runtimeProviderConfigRevision: index + 1,
      });
    }
  });

  it("keeps provider configuration revisions unchanged when writing native continuity", () => {
    const session = getOrCreateSession("agent:dev:revision-native", "dev", "/tmp/dev");
    const writes = [
      () => updateRuntimeProviderState(session.sessionKey, "codex"),
      () => updateProviderSession(session.sessionKey, "codex", "native-one"),
      () => updateRuntimeProviderState(session.sessionKey, "codex", { providerSessionId: "native-two" }),
      () => updateProviderSessionId(session.sessionKey, "native-three", "codex"),
      () => updateSdkSessionId(session.sessionKey, "native-four"),
      () => clearProviderSession(session.sessionKey),
    ];
    for (const write of writes) {
      write();
      expect(getSession(session.sessionKey)?.runtimeProviderConfigRevision).toBe(0);
    }
  });

  it("rolls back the provider override and its configuration revision together", () => {
    const session = getOrCreateSession("agent:dev:revision-rollback", "dev", "/tmp/dev");
    expect(() =>
      getDb().transaction(() => {
        updateSessionRuntimeProviderOverride(session.sessionKey, "claude");
        expect(getSession(session.sessionKey)?.runtimeProviderConfigRevision).toBe(1);
        throw new Error("rollback provider selection");
      })(),
    ).toThrow("rollback provider selection");
    expect(getSession(session.sessionKey)).toMatchObject({
      runtimeProviderOverride: undefined,
      runtimeProviderConfigRevision: 0,
    });
  });

  it("applies the runtime-config axis writes as one transaction", () => {
    const session = getOrCreateSession("agent:dev:atomic-axes", "dev", "/tmp/dev");
    const key = session.sessionKey;

    // Success: every write lands and the callback's value comes back.
    const value = applySessionRuntimeConfigAtomically(() => {
      updateSessionRuntimeProviderOverride(key, "claude");
      updateSessionModelOverride(key, "sonnet");
      updateSessionEffortOverride(key, "low");
      return "applied";
    });
    expect(value).toBe("applied");
    const applied = {
      runtimeProviderOverride: "claude",
      modelOverride: "sonnet",
      effortOverride: "low",
      runtimeProviderConfigRevision: 1,
    };
    expect(getSession(key)).toMatchObject(applied);

    // Failure: a throw after earlier writes takes every one of them back, the
    // revision bump included, and the original error reaches the caller.
    expect(() =>
      applySessionRuntimeConfigAtomically(() => {
        updateSessionRuntimeProviderOverride(key, "codex");
        updateSessionModelOverride(key, "gpt-6-astra");
        throw new Error("boom midway");
      }),
    ).toThrow("boom midway");
    expect(getSession(key)).toMatchObject(applied);
  });

  it("bumps the provider configuration revision without changing native or override state", () => {
    const session = getOrCreateSession("agent:dev:revision-bump", "dev", "/tmp/dev", {
      runtimeProvider: "codex",
      runtimeProviderOverride: "claude",
      providerSessionId: "native-one",
    });
    bumpSessionRuntimeProviderConfigRevision(session.sessionKey);
    expect(getSession(session.sessionKey)).toEqual({ ...session, runtimeProviderConfigRevision: 1 });
    bumpSessionRuntimeProviderConfigRevision(session.sessionKey);
    expect(getSession(session.sessionKey)).toEqual({ ...session, runtimeProviderConfigRevision: 2 });
  });

  it("migrates an existing session to provider configuration revision zero", () => {
    const session = getOrCreateSession("agent:dev:revision-migration", "dev", "/tmp/dev", {
      runtimeProvider: "codex",
      runtimeProviderOverride: "claude",
    });
    closeSessionStore();
    getDb().exec("ALTER TABLE sessions DROP COLUMN runtime_provider_config_revision");
    closeRouterDb();
    expect(getSession(session.sessionKey)).toEqual(session);
    updateSessionRuntimeProviderOverride(session.sessionKey, null);
    expect(getSession(session.sessionKey)?.runtimeProviderConfigRevision).toBe(1);
  });

  it("persists and clears the provider thread id for programmatic session forks", () => {
    const session = getOrCreateSession("agent:dev:slack-thread", "dev", "/tmp/dev");

    expect(session.lastThreadId).toBeUndefined();

    updateSessionThreadId(session.sessionKey, "1784998026.863699");
    expect(getSession(session.sessionKey)?.lastThreadId).toBe("1784998026.863699");

    updateSessionThreadId(session.sessionKey, null);
    expect(getSession(session.sessionKey)?.lastThreadId).toBeUndefined();
  });

  it("persists only stable channel presentation fields from richer message context", () => {
    const session = getOrCreateSession("agent:dev:channel-context", "dev", "/tmp/dev");
    const messageContext: MessageContext = {
      channelId: "slack",
      channelName: "Slack",
      accountId: "main",
      instanceId: "slack-main",
      chatId: "C123",
      canonicalChatId: "chat-123",
      messageId: "m-1",
      senderId: "agent:operator:main",
      senderName: "Operator",
      actorType: "agent",
      actorAgentId: "operator",
      isGroup: true,
      groupId: "C123",
      groupName: "Engineering",
      groupMembers: ["Operator", "Ravi"],
      botTag: "@ravi",
      timestamp: 1,
    };

    updateSessionContext(session.sessionKey, messageContext);

    expect(JSON.parse(getSession(session.sessionKey)!.lastContext!)).toEqual({
      channelId: "slack",
      channelName: "Slack",
      isGroup: true,
      groupName: "Engineering",
      groupId: "C123",
      groupMembers: ["Operator", "Ravi"],
      botTag: "@ravi",
    });
  });

  it("keeps cross-channel attachments and clears only the detached default", () => {
    const session = getOrCreateSession("agent:dev:multi-surface", "dev", "/tmp/dev");
    const slackChat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-primary",
      platformChatId: "channel-1",
      chatType: "group",
      title: "Team channel",
    });
    const whatsappChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "whatsapp-primary",
      platformChatId: "contact-1",
      chatType: "dm",
      title: "Direct chat",
    });

    attachChatToSession({ sessionKey: session.sessionKey, chatId: slackChat.id });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: whatsappChat.id });

    const attached = listSessionSubscriptions(session.sessionKey);
    expect(attached).toHaveLength(2);
    expect(attached.find((entry) => entry.chatId === slackChat.id)?.outputAttachedAt).toBeUndefined();
    expect(attached.find((entry) => entry.chatId === whatsappChat.id)?.outputAttachedAt).toBeNumber();

    expect(detachChatFromSession(session.sessionKey, whatsappChat.id)).toMatchObject({
      detached: true,
      outputDetached: true,
      attached: false,
    });
    expect(listSessionSubscriptions(session.sessionKey)).toEqual([
      expect.objectContaining({ chatId: slackChat.id, outputAttachedAt: undefined }),
    ]);
  });

  it("marks an ephemeral work session expired so the next cleanup tick can delete it", () => {
    const sessionKey = "agent:demo-agent:task-work-1";
    getOrCreateSession(sessionKey, "demo-agent", "/tmp/demo-agent");
    setSessionEphemeral(sessionKey, 60_000);

    expect(getSession(sessionKey)?.ephemeral).toBe(true);
    expect(getExpiredSessions().map((entry) => entry.sessionKey)).not.toContain(sessionKey);

    expect(expireEphemeralSession(sessionKey)).toBe(true);
    expect(expireEphemeralSession(sessionKey)).toBe(true);
    expect(expireEphemeralSession("agent:demo-agent:missing-work")).toBe(false);

    const expired = getExpiredSessions();
    expect(expired.map((entry) => entry.sessionKey)).toContain(sessionKey);
    expect(getSession(sessionKey)).toMatchObject({
      sessionKey,
      ephemeral: true,
    });
    expect(getSession(sessionKey)?.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it("guards runtime-config restore and continuity clear behind revision+value ownership", () => {
    const session = getOrCreateSession("agent:main:runtime-ownership", "main", stateDir!);
    const original = {
      runtimeProviderOverride: null,
      modelOverride: null,
      effortOverride: null,
      thinkingLevel: null,
    };

    // Update A applies (the provider setter bumps the persisted revision).
    updateSessionRuntimeProviderOverride(session.sessionKey, "claude");
    updateSessionModelOverride(session.sessionKey, "sonnet");
    const appliedA = getSession(session.sessionKey);
    if (!appliedA) throw new Error("expected session after apply");
    const ownedA = appliedA.runtimeProviderConfigRevision ?? 0;
    const writtenA = {
      runtimeProviderOverride: appliedA.runtimeProviderOverride ?? null,
      modelOverride: appliedA.modelOverride ?? null,
      effortOverride: appliedA.effortOverride ?? null,
      thinkingLevel: appliedA.thinkingLevel ?? null,
    };
    expect(sessionRuntimeConfigOwned(session.sessionKey, ownedA, writtenA)).toBe(true);

    // Update B lands while A's probe is in flight and completes successfully.
    updateSessionRuntimeProviderOverride(session.sessionKey, "codex");
    updateSessionModelOverride(session.sessionKey, "gpt-6-astra");
    updateProviderSessionId(session.sessionKey, "prov-b", "codex");

    // A lost ownership: its failed-probe restore and continuity clear refuse,
    // and B's successful configuration survives untouched (lost-update guard).
    expect(sessionRuntimeConfigOwned(session.sessionKey, ownedA, writtenA)).toBe(false);
    expect(restoreSessionRuntimeConfigIfOwned(session.sessionKey, ownedA, writtenA, original)).toBe(false);
    expect(clearProviderSessionIfRuntimeConfigOwned(session.sessionKey, ownedA, writtenA)).toBe(false);
    const afterRefusal = getSession(session.sessionKey);
    expect(afterRefusal).toMatchObject({
      runtimeProviderOverride: "codex",
      modelOverride: "gpt-6-astra",
      providerSessionId: "prov-b",
    });

    // The current owner still passes the same gate: continuity clear applies,
    // and its own rollback restores in one conditional statement, bumping the
    // revision so the live daemon reloads the restored configuration.
    const current = getSession(session.sessionKey);
    if (!current) throw new Error("expected session after concurrent update");
    const ownedB = current.runtimeProviderConfigRevision ?? 0;
    const writtenB = {
      runtimeProviderOverride: current.runtimeProviderOverride ?? null,
      modelOverride: current.modelOverride ?? null,
      effortOverride: current.effortOverride ?? null,
      thinkingLevel: current.thinkingLevel ?? null,
    };
    expect(clearProviderSessionIfRuntimeConfigOwned(session.sessionKey, ownedB, writtenB)).toBe(true);
    expect(getSession(session.sessionKey)?.providerSessionId ?? null).toBeNull();
    expect(restoreSessionRuntimeConfigIfOwned(session.sessionKey, ownedB, writtenB, writtenA)).toBe(true);
    const restored = getSession(session.sessionKey);
    expect(restored).toMatchObject({ runtimeProviderOverride: "claude", modelOverride: "sonnet" });
    expect(restored?.runtimeProviderConfigRevision).toBe(ownedB + 1);
  });
});
