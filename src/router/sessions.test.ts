import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertChat, getDb } from "./router-db.js";
import { SESSION_CREATED_TOPIC, setLifecycleEventPublisher } from "../events/lifecycle-events.js";
import {
  attachChatToSession,
  detachChatFromSession,
  expireEphemeralSession,
  getExpiredSessions,
  getOrCreateSession,
  getSession,
  listSessionSubscriptions,
  setSessionEphemeral,
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

  describe("session created event", () => {
    let emitted: Array<{ topic: string; data: Record<string, unknown> }>;

    beforeEach(() => {
      emitted = [];
      setLifecycleEventPublisher(async (topic, data) => {
        emitted.push({ topic, data });
      });
    });

    afterEach(() => {
      setLifecycleEventPublisher(null);
    });

    it("emits ravi.sessions.created exactly once on insert and never on reuse", () => {
      const created = getOrCreateSession("agent:dev:whatsapp:group:123", "dev", "/tmp/dev-secret-cwd", {
        name: "dev-group",
        channel: "whatsapp",
        accountId: "main",
        chatType: "group",
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0].topic).toBe(SESSION_CREATED_TOPIC);
      expect(emitted[0].topic.startsWith("ravi.session.")).toBe(false);
      expect(emitted[0].data).toMatchObject({
        version: 1,
        eventType: "session.created",
        sessionKey: "agent:dev:whatsapp:group:123",
        sessionName: "dev-group",
        agentId: "dev",
        channel: "whatsapp",
        accountId: "main",
        chatType: "group",
        createdAt: created.createdAt,
      });
      expect(emitted[0].data._trigger).toBeUndefined();
      expect(JSON.stringify(emitted[0].data)).not.toContain("/tmp/dev-secret-cwd");

      getOrCreateSession("agent:dev:whatsapp:group:123", "dev", "/tmp/dev-secret-cwd");
      getOrCreateSession("agent:dev:whatsapp:group:123", "other", "/tmp/other");

      expect(emitted).toHaveLength(1);
    });

    it("does not emit when another writer inserts the same key first, even in the same millisecond", () => {
      const sessionKey = "agent:dev:concurrent-insert";
      // Simulate a concurrent writer: right before this call's INSERT, another
      // writer creates the row with the same created_at.
      getDb().exec(`
        CREATE TEMP TRIGGER concurrent_session_insert BEFORE INSERT ON sessions
        WHEN NEW.session_key = '${sessionKey}'
          AND NOT EXISTS (SELECT 1 FROM sessions WHERE session_key = NEW.session_key)
        BEGIN
          INSERT INTO sessions (session_key, agent_id, agent_cwd, created_at, updated_at)
          VALUES (NEW.session_key, 'dev', '/tmp/dev', NEW.created_at, NEW.created_at);
        END;
      `);
      try {
        const session = getOrCreateSession(sessionKey, "dev", "/tmp/dev", { name: "late-writer" });

        expect(emitted).toHaveLength(0);
        expect(session.name).toBe("late-writer");
      } finally {
        getDb().exec("DROP TRIGGER IF EXISTS concurrent_session_insert");
      }
    });

    it("marks trigger sessions so the trigger runner skips them", () => {
      getOrCreateSession("agent:dev:trigger:abc123", "dev", "/tmp/dev");

      expect(emitted).toHaveLength(1);
      expect(emitted[0].data._trigger).toBe(true);
    });

    it("does not fail the write when the publisher throws", () => {
      setLifecycleEventPublisher(() => {
        throw new Error("nats down");
      });

      const created = getOrCreateSession("agent:dev:publisher-failure", "dev", "/tmp/dev");

      expect(getSession(created.sessionKey)?.agentId).toBe("dev");
    });
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
