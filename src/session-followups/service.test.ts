import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { getChatDbPath, saveMessage } from "../db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachChatToSession, getOrCreateSession, getSession, updateSessionDisplayName } from "../router/sessions.js";
import {
  dbAddChatToReadingList,
  dbCreateChatReadingList,
  dbUpsertChat,
  dbUpsertChatMessage,
  dbUpsertInstance,
} from "../router/router-db.js";
import { createSessionFollowupCadence, createSessionFollowupRun, listSessionFollowupRuns } from "./db.js";
import { runDueSessionFollowups, setSessionFollowupPublishersForTests } from "./service.js";

let stateDir: string | null = null;
let events: Array<{ topic: string; data: Record<string, unknown> }> = [];
let prompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-followups-service-");
  events = [];
  prompts = [];
  setSessionFollowupPublishersForTests({
    eventPublisher: async (topic, data) => {
      events.push({ topic, data });
    },
    promptPublisher: async (sessionName, payload) => {
      prompts.push({ sessionName, payload });
    },
  });
});

afterEach(async () => {
  setSessionFollowupPublishersForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("session followup service", () => {
  it("publishes direct session followups with after_response delivery", async () => {
    getOrCreateSession("agent:dev:followup-direct", "dev", "/tmp/dev", { name: "dev-followup-direct" });
    const cadence = createSessionFollowupCadence({
      name: "Direct check",
      targetType: "session",
      targetRef: "dev-followup-direct",
      schedule: { type: "at", at: 60_000 },
      messageTemplate: "Review {{data.cadence.name}} at {{data.schedule.dueAt}}.",
      now: 1_000,
    });

    const result = await runDueSessionFollowups({ now: 61_000 });

    expect(result).toMatchObject({ cadencesScanned: 1, runsCreated: 1, runsProcessed: 1, sent: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      sessionName: "dev-followup-direct",
      payload: {
        deliveryBarrier: "after_response",
        deliveryBarrierSource: "default",
        _sessionFollowup: true,
        _sessionFollowupCadenceId: cadence.id,
      },
    });
    expect(String(prompts[0]?.payload.prompt)).toStartWith(
      "[Session Followup: Direct check | Event: ravi.sessions.followup.due | Target: session:dev-followup-direct]",
    );
    expect(String(prompts[0]?.payload.prompt)).not.toContain("\nEvent: ravi.sessions.followup.due");
    expect(String(prompts[0]?.payload.prompt)).not.toContain("\nCadence:");
    expect(events.map((event) => event.topic)).toEqual(["ravi.sessions.followup.due", "ravi.sessions.followup.sent"]);
  });

  it("expands reading lists to the active attached session for each chat", async () => {
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
      title: "Ravi Dev",
      seenAt: 1_000,
    });
    const session = getOrCreateSession("agent:dev:whatsapp:main:group:120363424772797713", "dev", "/tmp/dev", {
      name: "dev-ravi-dev",
      accountId: "main",
      channel: "whatsapp",
    });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, attachedByType: "system" });
    const list = dbCreateChatReadingList({ name: "followup-groups", ownerType: "system", ownerId: "test" });
    dbAddChatToReadingList({ listId: list.id, chatId: chat.id, source: "manual" });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "main",
      providerMessageId: "external-1",
      rawChatId: "120363424772797713@g.us",
      actorType: "contact",
      contactId: "contact-1",
      messageType: "text",
      content: { text: "oi" },
      providerTimestamp: 1_000,
    });

    createSessionFollowupCadence({
      name: "List check",
      targetType: "reading_list",
      targetRef: list.id,
      schedule: { type: "every", every: 10_000 },
      messageTemplate: "Check {{data.chat.title}}.",
      now: 1_000,
    });

    const result = await runDueSessionFollowups({ now: 11_000 });

    expect(result.sent).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionName).toBe("dev-ravi-dev");
    expect(prompts[0]?.payload.source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "120363424772797713@g.us",
    });
    expect(String(prompts[0]?.payload.prompt)).toContain("Check Ravi Dev.");
  });

  it("resolves chat followups to a recent routed session when no subscription exists", async () => {
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "recent-routed@g.us",
      chatType: "group",
      title: "Recent Routed",
      seenAt: 1_000,
    });
    getOrCreateSession("agent:dev:whatsapp:main:group:recent-routed", "dev", "/tmp/dev", {
      name: "dev-recent-routed",
      lastChannel: "whatsapp-baileys",
      lastAccountId: "main",
      lastTo: "recent-routed@g.us",
    });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "main",
      providerMessageId: "external-recent-routed-1",
      rawChatId: "recent-routed@g.us",
      actorType: "contact",
      contactId: "contact-1",
      messageType: "text",
      content: { text: "oi" },
      providerTimestamp: 1_000,
    });

    createSessionFollowupCadence({
      name: "Recent routed check",
      targetType: "chat",
      targetRef: chat.id,
      schedule: { type: "every", every: 10_000 },
      messageTemplate: "Check recent routed.",
      now: 1_000,
    });

    const result = await runDueSessionFollowups({ now: 11_000 });

    expect(result.sent).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionName).toBe("dev-recent-routed");
    expect(prompts[0]?.payload.source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "recent-routed@g.us",
    });
  });

  it("canonicalizes duplicate platform chats to the active subscribed chat", async () => {
    dbUpsertInstance({ name: "main", channel: "whatsapp", instanceId: "main-instance" });
    dbUpsertInstance({ name: "luis", channel: "whatsapp", instanceId: "luis-instance" });
    const activeChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main-instance",
      platformChatId: "duplicate-group@g.us",
      chatType: "group",
      title: "Duplicate Group",
      seenAt: 1_000,
    });
    const staleDuplicate = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "luis-instance",
      platformChatId: "duplicate-group@g.us",
      chatType: "group",
      title: "Duplicate Group",
      seenAt: 5_000,
    });
    const session = getOrCreateSession("agent:dev:whatsapp:main:group:duplicate-group", "dev", "/tmp/dev", {
      name: "dev-duplicate-group",
      lastChannel: "whatsapp-baileys",
      lastAccountId: "main",
      lastTo: "duplicate-group@g.us",
    });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: activeChat.id, attachedByType: "system" });
    dbUpsertChatMessage({
      chatId: activeChat.id,
      channel: "whatsapp",
      instanceId: "main-instance",
      providerMessageId: "external-duplicate-1",
      rawChatId: "duplicate-group@g.us",
      actorType: "contact",
      contactId: "contact-1",
      messageType: "text",
      content: { text: "oi" },
      providerTimestamp: 1_000,
    });

    const cadence = createSessionFollowupCadence({
      name: "Duplicate group check",
      targetType: "chat",
      targetRef: "duplicate-group@g.us",
      schedule: { type: "at", at: 60_000 },
      messageTemplate: "Check duplicate group.",
      now: 1_000,
    });
    createSessionFollowupRun({
      cadenceId: cadence.id,
      targetType: "chat",
      targetRef: staleDuplicate.id,
      chatId: staleDuplicate.id,
      dueAt: 11_000,
      idempotencyKey: "duplicate-platform-chat-stale-run",
      now: 1_000,
    });

    const result = await runDueSessionFollowups({ now: 11_000 });

    expect(result.sent).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.sessionName).toBe("dev-duplicate-group");
    expect(prompts[0]?.payload.source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "duplicate-group@g.us",
    });
    expect(String(prompts[0]?.payload.prompt)).toContain("Target: chat:Duplicate Group");
    expect(String(prompts[0]?.payload.prompt)).not.toContain("\nTarget:");
  });

  it("skips chat followups when the chat has no active attached session", async () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "orphan@g.us",
      chatType: "group",
      title: "Orphan",
      seenAt: 1_000,
    });
    const cadence = createSessionFollowupCadence({
      name: "Orphan check",
      targetType: "chat",
      targetRef: chat.id,
      schedule: { type: "every", every: 10_000 },
      messageTemplate: "Check orphan.",
      now: 1_000,
    });

    const result = await runDueSessionFollowups({ now: 11_000 });

    expect(result.skipped).toBe(1);
    expect(prompts).toHaveLength(0);
    const runs = listSessionFollowupRuns({ cadenceId: cadence.id }).items;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "skipped",
      lastError: "Chat has no active attached or recent routed session",
    });
  });

  it("runs progressive idle steps from the latest external chat activity and resets on new activity", async () => {
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "cadence@g.us",
      chatType: "group",
      title: "Cadence Group",
      seenAt: 1_000,
    });
    const session = getOrCreateSession("agent:dev:whatsapp:main:group:cadence", "dev", "/tmp/dev", {
      name: "dev-cadence",
      accountId: "main",
      channel: "whatsapp",
    });
    attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, attachedByType: "system" });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "main",
      providerMessageId: "external-anchor-1",
      rawChatId: "cadence@g.us",
      actorType: "contact",
      contactId: "contact-1",
      messageType: "text",
      content: { text: "ultima resposta" },
      providerTimestamp: 1_000,
    });

    const cadence = createSessionFollowupCadence({
      name: "Progressive followup",
      targetType: "chat",
      targetRef: chat.id,
      schedule: {
        type: "every",
        every: 2 * 60 * 60 * 1000,
        steps: [
          { afterMs: 2 * 60 * 60 * 1000, messageTemplate: "Primeiro followup." },
          { afterMs: 3 * 60 * 60 * 1000, messageTemplate: "Segundo followup." },
        ],
      },
      messageTemplate: "Primeiro followup.",
      now: 1_000,
    });

    const first = await runDueSessionFollowups({ now: 1_000 + 2 * 60 * 60 * 1000 });
    expect(first.sent).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]?.payload.prompt)).toContain("Step: 1/2 after 2h");
    expect(String(prompts[0]?.payload.prompt)).toContain("Primeiro followup.");

    const second = await runDueSessionFollowups({ now: 1_000 + 3 * 60 * 60 * 1000 });
    expect(second.sent).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(String(prompts[1]?.payload.prompt)).toContain("Step: 2/2 after 3h");
    expect(String(prompts[1]?.payload.prompt)).toContain("Segundo followup.");

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "main",
      providerMessageId: "external-anchor-2",
      rawChatId: "cadence@g.us",
      actorType: "contact",
      contactId: "contact-1",
      messageType: "text",
      content: { text: "nova resposta" },
      providerTimestamp: 1_000 + 4 * 60 * 60 * 1000,
    });
    const reset = await runDueSessionFollowups({ now: 1_000 + 6 * 60 * 60 * 1000 });
    expect(reset.sent).toBe(1);
    expect(prompts).toHaveLength(3);
    expect(String(prompts[2]?.payload.prompt)).toContain("Step: 1/2 after 2h");
    expect(listSessionFollowupRuns({ cadenceId: cadence.id }).items).toHaveLength(3);
  });

  it("does not restart direct session idle steps from internal session updates", async () => {
    const session = getOrCreateSession("agent:dev:followup-direct-idle", "dev", "/tmp/dev", {
      name: "dev-followup-direct-idle",
    });
    const externalAt = Date.now() - 5_000;
    saveMessage("dev-followup-direct-idle", "user", "external message", null, {
      sourceMessageId: "external-direct-1",
    });
    setLatestMessageCreatedAt("dev-followup-direct-idle", externalAt);

    const cadence = createSessionFollowupCadence({
      name: "Direct idle",
      targetType: "session",
      targetRef: "dev-followup-direct-idle",
      schedule: { type: "every", every: 1_000 },
      messageTemplate: "Follow up direct session.",
      now: externalAt,
    });

    const first = await runDueSessionFollowups({ now: externalAt + 1_500 });
    expect(first.sent).toBe(1);

    updateSessionDisplayName(session.sessionKey, "Direct idle updated internally");
    const updated = getSession(session.sessionKey);
    expect(updated?.updatedAt).toBeGreaterThan(externalAt);

    const duplicate = await runDueSessionFollowups({ now: (updated?.updatedAt ?? Date.now()) + 1_500 });
    expect(duplicate.sent).toBe(0);
    expect(listSessionFollowupRuns({ cadenceId: cadence.id }).items).toHaveLength(1);
  });
});

function setLatestMessageCreatedAt(sessionId: string, createdAt: number): void {
  const db = new Database(getChatDbPath());
  try {
    db.prepare(
      `
      UPDATE messages
      SET created_at = ?
      WHERE id = (
        SELECT MAX(id)
        FROM messages
        WHERE session_id = ?
      )
      `,
    ).run(new Date(createdAt).toISOString(), sessionId);
  } finally {
    db.close();
  }
}
