import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertChat } from "./router-db.js";
import {
  attachChatToSession,
  detachChatFromSession,
  expireEphemeralSession,
  getExpiredSessions,
  getOrCreateSession,
  getSession,
  getSessionTurnUsageSummary,
  listSessionSubscriptions,
  resetSession,
  setSessionEphemeral,
  updateSessionContext,
  updateProviderSession,
  updateSessionEffortOverride,
  updateSessionRuntimeProviderOverride,
  updateSessionThreadId,
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
});
