import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  dbBindSessionToChat,
  dbFindChat,
  dbGetSessionChatBinding,
  dbListChatParticipants,
  dbListSessionChatBindings,
  dbListSessionParticipants,
  dbUpsertChat,
  dbUpsertChatParticipant,
  dbUpsertSessionParticipant,
  getDb,
} from "./router-db.js";
import { getOrCreateSession } from "./sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-chat-schema-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("identity chat schema", () => {
  it("creates the chat model tables in ravi.db", () => {
    const db = getDb();
    const tables = db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('chats', 'chat_participants', 'session_chat_bindings', 'session_participants')
        ORDER BY name
      `,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "chat_participants",
      "chats",
      "session_chat_bindings",
      "session_participants",
    ]);
  });

  it("allows one chat to bind to multiple sessions while keeping chat and session participants separate", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp-baileys",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
      title: "Ravi Dev",
      rawProvenance: { rawChatId: "120363424772797713@g.us" },
    });

    const first = getOrCreateSession("agent:main:whatsapp:main:group:120363424772797713", "main", "/tmp/main");
    const second = getOrCreateSession("agent:support:whatsapp:main:group:120363424772797713", "main", "/tmp/main");

    dbBindSessionToChat({
      sessionKey: first.sessionKey,
      chatId: chat.id,
      agentId: "main",
      bindingReason: "test",
    });
    dbBindSessionToChat({
      sessionKey: second.sessionKey,
      chatId: chat.id,
      agentId: "support",
      bindingReason: "test",
    });

    dbUpsertChatParticipant({
      chatId: chat.id,
      rawPlatformUserId: "5511999999999@s.whatsapp.net",
      normalizedPlatformUserId: "5511999999999",
      role: "admin",
      source: "omni",
    });
    dbUpsertSessionParticipant({
      sessionKey: first.sessionKey,
      ownerType: "contact",
      ownerId: "contact_1",
      role: "human",
    });

    expect(dbListSessionChatBindings(chat.id)).toHaveLength(2);
    expect(dbGetSessionChatBinding(first.sessionKey)?.chatId).toBe(chat.id);
    expect(dbListChatParticipants(chat.id)).toHaveLength(1);
    expect(dbListSessionParticipants(first.sessionKey)).toHaveLength(1);
    expect(dbListSessionParticipants(second.sessionKey)).toHaveLength(0);
  });

  it("keeps channel threads as distinct chats under the same base chat", () => {
    const dmThreadA = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net#thread-a",
      chatType: "thread",
    });
    const dmThreadB = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net#thread-b",
      chatType: "thread",
    });
    const groupThreadA = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us#topic-a",
      chatType: "thread",
    });
    const groupThreadB = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us#topic-b",
      chatType: "thread",
    });

    expect(dmThreadA.id).not.toBe(dmThreadB.id);
    expect(groupThreadA.id).not.toBe(groupThreadB.id);
    expect(dmThreadA.normalizedChatId).toBe("5511999999999#thread-a");
    expect(groupThreadA.normalizedChatId).toBe("group:120363424772797713#topic-a");
    expect(
      dbFindChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: "5511999999999@s.whatsapp.net#thread-a",
      })?.id,
    ).toBe(dmThreadA.id);
    expect(
      dbFindChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: "120363424772797713@g.us#topic-b",
      })?.id,
    ).toBe(groupThreadB.id);
  });

  it("merges session participant rows when platform identity becomes resolved", () => {
    const session = getOrCreateSession("session-participant-upsert", "main", "/tmp/main");

    const first = dbUpsertSessionParticipant({
      sessionKey: session.sessionKey,
      ownerType: "unknown",
      platformIdentityId: "pi_1",
      role: "unknown",
      seenAt: 1_000,
      metadata: { source: "raw" },
    });
    const resolved = dbUpsertSessionParticipant({
      sessionKey: session.sessionKey,
      ownerType: "contact",
      ownerId: "contact_1",
      platformIdentityId: "pi_1",
      role: "human",
      seenAt: 2_000,
      metadata: { resolvedBy: "identity-graph" },
    });
    const observedAgain = dbUpsertSessionParticipant({
      sessionKey: session.sessionKey,
      ownerType: "unknown",
      platformIdentityId: "pi_1",
      role: "unknown",
      incrementMessageCount: false,
      seenAt: 1_500,
      metadata: { lastObservation: "raw" },
    });

    expect(resolved.id).toBe(first.id);
    expect(observedAgain.id).toBe(first.id);
    expect(observedAgain.ownerType).toBe("contact");
    expect(observedAgain.ownerId).toBe("contact_1");
    expect(observedAgain.platformIdentityId).toBe("pi_1");
    expect(observedAgain.role).toBe("human");
    expect(observedAgain.firstSeenAt).toBe(1_000);
    expect(observedAgain.lastSeenAt).toBe(2_000);
    expect(observedAgain.messageCount).toBe(2);
    expect(observedAgain.metadata).toMatchObject({
      source: "raw",
      resolvedBy: "identity-graph",
      lastObservation: "raw",
    });
    expect(dbListSessionParticipants(session.sessionKey)).toHaveLength(1);
  });

  it("represents chat participants as contact, agent, or raw actors", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });

    const contact = dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: "contact_1",
      platformIdentityId: "pi_contact",
      rawPlatformUserId: "5511999999999@s.whatsapp.net",
      role: "member",
      source: "inbound_message",
    });
    const agent = dbUpsertChatParticipant({
      chatId: chat.id,
      agentId: "dev",
      platformIdentityId: "pi_agent",
      rawPlatformUserId: "5511888888888@s.whatsapp.net",
      role: "agent",
      source: "manual",
    });
    const raw = dbUpsertChatParticipant({
      chatId: chat.id,
      rawPlatformUserId: "unknown-user",
      normalizedPlatformUserId: "unknown-user",
      role: "unknown",
      source: "omni",
    });

    expect(contact.participantType).toBe("contact");
    expect(agent.participantType).toBe("agent");
    expect(raw.participantType).toBe("raw");
    expect(
      dbListChatParticipants(chat.id)
        .map((participant) => participant.participantType)
        .sort(),
    ).toEqual(["agent", "contact", "raw"]);
    expect(() =>
      dbUpsertChatParticipant({
        chatId: chat.id,
        contactId: "contact_2",
        agentId: "dev",
      }),
    ).toThrow(/both contact and agent/);
  });

  it("reuses existing participant rows that already satisfy a unique actor key", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
    });
    const now = Date.now();

    getDb()
      .prepare(
        `
        INSERT INTO chat_participants (
          id, chat_id, platform_identity_id, contact_id, agent_id,
          raw_platform_user_id, normalized_platform_user_id, role, status, source,
          first_seen_at, last_seen_at, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `,
      )
      .run(
        "legacy-participant-id",
        chat.id,
        "contact_1",
        "178035101794451",
        "178035101794451",
        "unknown",
        "active",
        "omni",
        now,
        now,
        now,
        now,
      );

    const participant = dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: "contact_1",
      rawPlatformUserId: "178035101794451",
      normalizedPlatformUserId: "5511947879044",
      role: "member",
      source: "inbound_message",
    });

    expect(participant.id).toBe("legacy-participant-id");
    expect(participant.normalizedPlatformUserId).toBe("5511947879044");
    expect(participant.role).toBe("member");
    expect(dbListChatParticipants(chat.id)).toHaveLength(1);
  });

  it("merges conflicting contact and platform participant rows into one canonical row", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
    });

    const platformParticipant = dbUpsertChatParticipant({
      chatId: chat.id,
      platformIdentityId: "pi_1",
      rawPlatformUserId: "5511947879044@s.whatsapp.net",
      normalizedPlatformUserId: "5511947879044",
      role: "member",
      source: "omni",
      metadata: { omniParticipantId: "omni-1" },
    });
    const contactParticipant = dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: "contact_1",
      rawPlatformUserId: "5511947879044@s.whatsapp.net",
      normalizedPlatformUserId: "5511947879044",
      role: "member",
      source: "manual",
      metadata: { displayName: "Luis" },
    });

    expect(dbListChatParticipants(chat.id)).toHaveLength(2);

    const merged = dbUpsertChatParticipant({
      chatId: chat.id,
      contactId: "contact_1",
      platformIdentityId: "pi_1",
      rawPlatformUserId: "5511947879044@s.whatsapp.net",
      normalizedPlatformUserId: "5511947879044",
      role: "admin",
      source: "inbound_message",
      metadata: { resolvedSenderId: "5511947879044" },
    });

    expect(platformParticipant.id).not.toBe(contactParticipant.id);
    expect(merged.id).toBe(contactParticipant.id);
    expect(merged.contactId).toBe("contact_1");
    expect(merged.platformIdentityId).toBe("pi_1");
    expect(merged.role).toBe("admin");
    expect(merged.metadata).toMatchObject({
      omniParticipantId: "omni-1",
      displayName: "Luis",
      resolvedSenderId: "5511947879044",
    });
    expect(dbListChatParticipants(chat.id)).toHaveLength(1);
  });
});
