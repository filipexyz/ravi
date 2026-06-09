import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  dbBindSessionToChat,
  dbAddChatToReadingList,
  dbCanonicalizeDmChatForContact,
  dbCreateChatReadingList,
  dbFindChat,
  dbFindChatByRef,
  dbFindChatReadingList,
  dbFindAgentChatMessageByRef,
  dbContactDmNormalizedChatId,
  dbGetSessionChatBinding,
  dbGetChatReadingDelta,
  dbListAgentChatMessagesPage,
  dbListChatIdsByContactIds,
  dbListChats,
  dbListChatParticipants,
  dbListChatReadingListMembers,
  dbListSessionChatBindings,
  dbListSessionParticipants,
  dbMarkChatReadingCursor,
  dbUpsertChat,
  dbFindChatMessage,
  dbListChatMessages,
  dbListChatMessagesPage,
  dbListChatMessagesPageByContactId,
  dbMarkChatMessageDeleted,
  dbMarkChatMessageEdited,
  dbUpsertChatMessage,
  dbUpsertChatParticipant,
  dbUpsertSessionParticipant,
  getDb,
} from "./router-db.js";
import { recomputeChatReadingListMembers } from "../chats/reading-lists.js";
import { getOrCreateSession } from "./sessions.js";
import { attachTagSlugsToAsset } from "../tags/helpers.js";
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
          AND name IN ('chats', 'chat_messages', 'chat_participants', 'session_chat_bindings', 'session_participants')
        ORDER BY name
      `,
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "chat_messages",
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

  it("stores channel messages durably and idempotently per provider message", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });

    const first = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999",
      normalizedSenderId: "5511999999999",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_contact_1",
      messageType: "text",
      content: { type: "text", text: "oi" },
      rawProvenance: { source: "test" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    });
    const repeated = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999",
      normalizedSenderId: "5511999999999",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_contact_1",
      messageType: "text",
      content: { type: "text", text: "oi atualizado" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_200,
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.message.id).toBe(first.message.id);
    expect(repeated.message.content).toMatchObject({ text: "oi atualizado" });
    expect(
      dbFindChatMessage({
        channel: "whatsapp",
        instanceId: "instance-1",
        chatId: chat.id,
        providerMessageId: "wamid-1",
      })?.id,
    ).toBe(first.message.id);
    expect(dbListChatMessages(chat.id)).toHaveLength(1);
  });

  it("lists and marks an agent's own messages for session actions", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });
    const own = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "outbound-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511000000000@s.whatsapp.net",
      normalizedSenderId: "5511000000000",
      actorType: "agent",
      agentId: "dev",
      platformIdentityId: "pi_agent_dev",
      messageType: "text",
      content: { type: "text", text: "vou corrigir" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    }).message;
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "contact-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "humano" },
    });

    expect(
      dbFindAgentChatMessageByRef({
        agentId: "dev",
        messageRef: "outbound-1",
        chatIds: [chat.id],
      })?.id,
    ).toBe(own.id);
    expect(dbListAgentChatMessagesPage({ agentId: "dev", chatIds: [chat.id] }).items.map((m) => m.id)).toEqual([
      own.id,
    ]);

    const deleted = dbMarkChatMessageDeleted(own.id, 1_700_000_001_000);
    expect(deleted?.deletedAt).toBe(1_700_000_001_000);
    expect(dbFindAgentChatMessageByRef({ agentId: "dev", messageRef: own.id, chatIds: [chat.id] })).toBeNull();
    expect(
      dbFindAgentChatMessageByRef({ agentId: "dev", messageRef: own.id, chatIds: [chat.id], includeDeleted: true })?.id,
    ).toBe(own.id);
  });

  it("marks an agent's own message as edited for session actions", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });
    const own = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "outbound-edit-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511000000000@s.whatsapp.net",
      normalizedSenderId: "5511000000000",
      actorType: "agent",
      agentId: "dev",
      messageType: "text",
      content: { type: "text", text: "texto antigo" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    }).message;

    const edited = dbMarkChatMessageEdited(own.id, "texto novo", 1_700_000_002_000);

    expect(edited?.editedAt).toBe(1_700_000_002_000);
    expect(edited?.content).toMatchObject({ type: "text", text: "texto novo", editedAt: 1_700_000_002_000 });
    expect(edited?.rawProvenance?.raviEditHistory).toEqual([
      { editedAt: 1_700_000_002_000, previousText: "texto antigo", text: "texto novo" },
    ]);
    expect(
      dbFindAgentChatMessageByRef({ agentId: "dev", messageRef: "outbound-edit-1", chatIds: [chat.id] })?.content,
    ).toMatchObject({ text: "texto novo" });
  });

  it("lists chats and reads messages through the durable ledger", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
      title: "Maria",
    });

    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "primeira" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-2",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999",
      actorType: "contact",
      contactId: "contact_1",
      content: { type: "text", text: "segunda" },
      providerTimestamp: 1_700_000_001_000,
      ingestedAt: 1_700_000_001_100,
    });

    expect(dbFindChatByRef({ ref: "5511999999999", instanceId: "instance-1", channel: "whatsapp" })?.id).toBe(chat.id);

    const chats = dbListChats({ instanceId: "instance-1", contactId: "contact_1" });
    expect(chats.total).toBe(1);
    expect(chats.items[0]?.lastMessage?.content).toMatchObject({ text: "segunda" });

    const messages = dbListChatMessagesPage({ chatId: chat.id });
    expect(messages.total).toBe(2);
    expect(messages.items.map((message) => message.content?.text)).toEqual(["primeira", "segunda"]);
    expect(messages.items[0]?.sortKey).toMatch(/cm_/);

    const contactMessages = dbListChatMessagesPageByContactId({ contactId: "contact_1" });
    expect(contactMessages.total).toBe(2);
    expect(contactMessages.items.map((message) => message.content?.text)).toEqual(["segunda", "primeira"]);
  });

  it("lists related chat ids for contacts in one batched indexed query shape", () => {
    const first = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511991111111@s.whatsapp.net",
      chatType: "dm",
      title: "First",
    });
    const second = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511992222222@s.whatsapp.net",
      chatType: "dm",
      title: "Second",
    });
    const shared = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363424772797713@g.us",
      chatType: "group",
      title: "Shared",
    });

    dbUpsertChatParticipant({ chatId: first.id, contactId: "contact_a", source: "test" });
    dbUpsertChatParticipant({ chatId: shared.id, contactId: "contact_a", source: "test" });
    dbUpsertChatMessage({
      chatId: second.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-batch-contact-b",
      rawChatId: "5511992222222@s.whatsapp.net",
      actorType: "contact",
      contactId: "contact_b",
      content: { type: "text", text: "hello" },
      providerTimestamp: 1_700_000_010_000,
      ingestedAt: 1_700_000_010_100,
    });

    const byContact = dbListChatIdsByContactIds({ contactIds: ["contact_a", "contact_b", "contact_empty"] });
    expect(byContact.get("contact_a")?.sort()).toEqual([first.id, shared.id].sort());
    expect(byContact.get("contact_b")).toEqual([second.id]);
    expect(byContact.get("contact_empty")).toEqual([]);
  });

  it("canonicalizes WhatsApp DM LID and phone chats for the same contact", () => {
    const normalizedChatId = dbContactDmNormalizedChatId("contact_1");
    const list = dbCreateChatReadingList({ name: "crm-analysis", ownerType: "agent", ownerId: "crm" });
    const lidChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "238289734901889@lid",
      chatType: "dm",
      title: "Raquel",
    });
    dbUpsertChatMessage({
      chatId: lidChat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-lid",
      rawChatId: "238289734901889@lid",
      rawSenderId: "238289734901889@lid",
      normalizedSenderId: "lid:238289734901889",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_lid",
      content: { type: "text", text: "via lid" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    });
    dbUpsertChatParticipant({
      chatId: lidChat.id,
      contactId: "contact_1",
      platformIdentityId: "pi_lid",
      rawPlatformUserId: "238289734901889@lid",
      normalizedPlatformUserId: "lid:238289734901889",
      source: "inbound_message",
    });
    dbAddChatToReadingList({ listId: list.id, chatId: lidChat.id, source: "crm" });

    expect(
      dbUpsertChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: "238289734901889@lid",
        normalizedChatId,
        chatType: "dm",
      }).id,
    ).toBe(lidChat.id);

    const canonicalLid = dbCanonicalizeDmChatForContact({
      chatId: lidChat.id,
      contactId: "contact_1",
      platformChatId: "238289734901889@lid",
      title: "Raquel",
      rawProvenance: { source: "test", alias: "lid" },
      seenAt: 1_700_000_000_100,
    });
    expect(canonicalLid.id).toBe(lidChat.id);
    expect(canonicalLid.normalizedChatId).toBe(normalizedChatId);

    const phoneChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
      title: "Raquel",
    });
    dbUpsertChatMessage({
      chatId: phoneChat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-phone",
      rawChatId: "5511999999999@s.whatsapp.net",
      rawSenderId: "5511999999999@s.whatsapp.net",
      normalizedSenderId: "5511999999999",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_phone",
      content: { type: "text", text: "via phone" },
      providerTimestamp: 1_700_000_001_000,
      ingestedAt: 1_700_000_001_100,
    });
    dbUpsertChatParticipant({
      chatId: phoneChat.id,
      contactId: "contact_1",
      platformIdentityId: "pi_phone",
      rawPlatformUserId: "5511999999999@s.whatsapp.net",
      normalizedPlatformUserId: "5511999999999",
      source: "inbound_message",
    });
    dbAddChatToReadingList({ listId: list.id, chatId: phoneChat.id, source: "crm" });

    const canonicalPhone = dbCanonicalizeDmChatForContact({
      chatId: phoneChat.id,
      contactId: "contact_1",
      platformChatId: "5511999999999@s.whatsapp.net",
      title: "Raquel",
      rawProvenance: { source: "test", alias: "phone" },
      seenAt: 1_700_000_001_100,
    });

    expect(canonicalPhone.id).toBe(canonicalLid.id);
    expect(canonicalPhone.normalizedChatId).toBe(normalizedChatId);
    expect(
      dbFindChat({ channel: "whatsapp", instanceId: "instance-1", platformChatId: "238289734901889@lid" })?.id,
    ).toBe(canonicalLid.id);
    expect(
      dbFindChat({ channel: "whatsapp", instanceId: "instance-1", platformChatId: "5511999999999@s.whatsapp.net" })?.id,
    ).toBe(canonicalLid.id);
    expect(
      dbUpsertChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: "238289734901889@lid",
        normalizedChatId,
        chatType: "dm",
      }).id,
    ).toBe(canonicalLid.id);
    expect(
      dbUpsertChat({
        channel: "whatsapp",
        instanceId: "instance-1",
        platformChatId: "5511999999999@s.whatsapp.net",
        chatType: "dm",
      }).id,
    ).toBe(canonicalLid.id);
    expect(
      dbFindChat({ channel: "whatsapp", instanceId: "instance-1", platformChatId: "238289734901889@lid" })?.id,
    ).toBe(canonicalLid.id);

    const chats = dbListChats({ instanceId: "instance-1", contactId: "contact_1" });
    expect(chats.total).toBe(1);
    expect(chats.items[0]?.chat.id).toBe(canonicalLid.id);
    expect(
      dbListChatMessages(canonicalLid.id)
        .map((message) => message.providerMessageId)
        .sort(),
    ).toEqual(["wamid-lid", "wamid-phone"]);
    expect(dbListChatParticipants(canonicalLid.id)).toHaveLength(1);
    const members = dbListChatReadingListMembers({ listId: list.id });
    expect(members.total).toBe(1);
    expect(members.items[0]?.chat.id).toBe(canonicalLid.id);
  });

  it("keeps reading-list cursors independent per list and reader", () => {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });

    const commercial = dbCreateChatReadingList({ name: "commercial", ownerType: "agent", ownerId: "crm" });
    const support = dbCreateChatReadingList({ name: "support", ownerType: "agent", ownerId: "crm" });
    dbAddChatToReadingList({ listId: commercial.id, chatId: chat.id, source: "manual" });
    dbAddChatToReadingList({ listId: support.id, chatId: chat.id, source: "manual" });

    const first = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-1",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      content: { type: "text", text: "oi" },
      providerTimestamp: 1_700_000_000_000,
      ingestedAt: 1_700_000_000_100,
    }).message;
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-2",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      content: { type: "text", text: "novo contexto" },
      providerTimestamp: 1_700_000_001_000,
      ingestedAt: 1_700_000_001_100,
    });

    expect(
      dbGetChatReadingDelta({ listId: commercial.id, chatId: chat.id, readerType: "agent", readerId: "observer" })
        ?.newMessageCount,
    ).toBe(2);
    expect(
      dbGetChatReadingDelta({ listId: support.id, chatId: chat.id, readerType: "agent", readerId: "observer" })
        ?.newMessageCount,
    ).toBe(2);

    dbMarkChatReadingCursor({
      listId: commercial.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "observer",
      messageId: first.id,
      reason: "test",
    });

    expect(
      dbGetChatReadingDelta({ listId: commercial.id, chatId: chat.id, readerType: "agent", readerId: "observer" })
        ?.newMessageCount,
    ).toBe(1);
    expect(
      dbGetChatReadingDelta({ listId: support.id, chatId: chat.id, readerType: "agent", readerId: "observer" })
        ?.newMessageCount,
    ).toBe(2);

    const members = dbListChatReadingListMembers({
      listId: commercial.id,
      readerType: "agent",
      readerId: "observer",
    });
    expect(members.items[0]?.unreadMessageCount).toBe(1);
  });

  it("materializes dynamic reading-list members from contact tag selectors", () => {
    const eligibleChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999901@s.whatsapp.net",
      chatType: "dm",
      title: "Eligible",
    });
    dbUpsertChatParticipant({
      chatId: eligibleChat.id,
      contactId: "contact_eligible",
      source: "test",
    });

    const preservedChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999902@s.whatsapp.net",
      chatType: "dm",
      title: "Preserved",
    });
    dbUpsertChatParticipant({
      chatId: preservedChat.id,
      contactId: "contact_preserved",
      source: "test",
    });

    const staleChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999903@s.whatsapp.net",
      chatType: "dm",
      title: "Stale",
    });
    dbUpsertChatParticipant({
      chatId: staleChat.id,
      contactId: "contact_stale",
      source: "test",
    });

    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: "contact_eligible",
      tags: ["crm-eligible"],
      source: "test",
    });

    const list = dbCreateChatReadingList({
      name: "dynamic-crm",
      ownerType: "agent",
      ownerId: "crm",
      mode: "dynamic",
      selector: { contactTags: ["crm-eligible"] },
    });
    dbAddChatToReadingList({ listId: list.id, chatId: preservedChat.id, source: "manual" });
    dbAddChatToReadingList({ listId: list.id, chatId: staleChat.id, source: "selector" });

    const recompute = recomputeChatReadingListMembers(list);
    expect(recompute.eligibleChatIds).toEqual([eligibleChat.id]);
    expect(recompute.addedChatIds).toEqual([eligibleChat.id]);
    expect(recompute.removedChatIds).toEqual([staleChat.id]);
    expect(recompute.preservedChatIds).toEqual([preservedChat.id]);

    const members = dbListChatReadingListMembers({ listId: list.id });
    expect(members.items.map((item) => item.chat.id).sort()).toEqual([eligibleChat.id, preservedChat.id].sort());
  });

  it("requires active reading-list membership before reading deltas or writing cursors", () => {
    const listedChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });
    const unlistedChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511888888888@s.whatsapp.net",
      chatType: "dm",
    });
    const list = dbCreateChatReadingList({ name: "membership-required", ownerType: "agent", ownerId: "crm" });

    dbAddChatToReadingList({ listId: list.id, chatId: listedChat.id, source: "manual" });
    dbUpsertChatMessage({
      chatId: listedChat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-listed",
      rawChatId: "5511999999999@s.whatsapp.net",
      actorType: "contact",
      content: { type: "text", text: "listed" },
    });
    dbUpsertChatMessage({
      chatId: unlistedChat.id,
      channel: "whatsapp",
      instanceId: "instance-1",
      providerMessageId: "wamid-unlisted",
      rawChatId: "5511888888888@s.whatsapp.net",
      actorType: "contact",
      content: { type: "text", text: "unlisted" },
    });

    expect(dbGetChatReadingDelta({ listId: list.id, chatId: listedChat.id })?.newMessageCount).toBe(1);
    expect(() => dbGetChatReadingDelta({ listId: list.id, chatId: unlistedChat.id })).toThrow(/not an active member/);
    expect(() => dbMarkChatReadingCursor({ listId: list.id, chatId: unlistedChat.id })).toThrow(/not an active member/);
  });

  it("does not resolve duplicate reading-list names without an owner scope", () => {
    const first = dbCreateChatReadingList({ name: "shared-queue", ownerType: "agent", ownerId: "a" });
    const second = dbCreateChatReadingList({ name: "shared-queue", ownerType: "agent", ownerId: "b" });

    expect(first.id).not.toBe(second.id);
    expect(() => dbFindChatReadingList({ ref: "shared-queue" })).toThrow(/ambiguous/);
    expect(dbFindChatReadingList({ ref: "shared-queue", ownerType: "agent", ownerId: "a" })?.id).toBe(first.id);
    expect(dbFindChatReadingList({ ref: second.id })?.id).toBe(second.id);
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
