import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertChat } from "./router-db.js";
import {
  attachChatToSession,
  detachChatFromSession,
  getOrCreateSession,
  getSession,
  listSessionSubscriptions,
  updateSessionContext,
  updateSessionEffortOverride,
  updateSessionRuntimeProviderOverride,
  updateSessionThreadId,
} from "./sessions.js";
import type { MessageContext } from "../runtime/message-types.js";

let stateDir: string | null = null;

describe("sessions store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-sessions-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
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
});
