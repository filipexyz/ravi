// Direct chats of a contact (contract §10.3). chat.db `messages.chat_id` is the
// platform chat id (`MessageTarget.chatId`), while `chat_participants.chat_id`
// is the semantic `chats.id` of ravi.db, so the two are matched through the
// `chats` rows, never by a direct join.

import { dbListChatParticipants, dbListChats, dbListChatsByRef, type ChatRecord } from "../router/router-db.js";

/**
 * The contact of a known direct chat: every chat row matching the id must be
 * a direct chat of one and the same contact. Anything else is null. (A copy
 * of `readDmChatContact` in src/link/connector-turn.ts, which is not exported.)
 */
export function dmContactForChat(input: { chatId: string; channel: string | null }): string | null {
  const chatId = input.chatId?.trim();
  if (!chatId) return null;
  try {
    const chats = dbListChatsByRef({ ref: chatId, channel: input.channel, limit: 10 });
    if (chats.length === 0) return null;
    const contacts = new Set<string>();
    for (const chat of chats) {
      if (chat.chatType !== "dm") return null;
      if (chat.normalizedChatId.startsWith("contact:")) {
        contacts.add(chat.normalizedChatId.slice("contact:".length));
        continue;
      }
      const members = new Set(
        dbListChatParticipants(chat.id)
          .map((participant) => participant.contactId)
          .filter((contactId): contactId is string => Boolean(contactId)),
      );
      if (members.size !== 1) return null;
      for (const contactId of members) contacts.add(contactId);
    }
    return contacts.size === 1 ? ([...contacts][0] ?? null) : null;
  } catch {
    return null;
  }
}

export interface PlatformChatKey {
  channel: string;
  /** `chats.instance_id` as stored. */
  instanceId: string;
  platformChatId: string;
  normalizedChatId: string;
}

/**
 * Every direct chat of the contact, with both ids a chat.db row or an
 * outbound target may carry: `platformChatId` and `normalizedChatId`.
 */
export function platformChatKeysForContact(contactId: string): PlatformChatKey[] {
  const id = contactId?.trim();
  if (!id) return [];
  const chats = new Map<string, ChatRecord>();
  try {
    for (let offset = 0; offset < 5_000; offset += 500) {
      const page = dbListChats({ contactId: id, chatType: "dm", limit: 500, offset });
      for (const item of page.items) chats.set(item.chat.id, item.chat);
      if (page.items.length < 500) break;
    }
    const canonical = `contact:${id}`;
    for (const chat of dbListChatsByRef({ ref: canonical, chatType: "dm", limit: 500 })) {
      if (chat.normalizedChatId === canonical) chats.set(chat.id, chat);
    }
  } catch {
    return [];
  }
  return [...chats.values()]
    .filter((chat) => chat.chatType === "dm" && dmChatBelongsTo(chat, id))
    .map((chat) => ({
      channel: chat.channel,
      instanceId: chat.instanceId,
      platformChatId: chat.platformChatId,
      normalizedChatId: chat.normalizedChatId,
    }));
}

/** Every id a chat.db row of the contact's direct chats may carry in `chat_id`. */
export function chatIdsForContact(contactId: string): string[] {
  const ids = new Set<string>();
  for (const key of platformChatKeysForContact(contactId)) {
    if (key.platformChatId) ids.add(key.platformChatId);
    if (key.normalizedChatId) ids.add(key.normalizedChatId);
  }
  return [...ids];
}

/** A direct chat listed for the contact must not belong to another contact too. */
function dmChatBelongsTo(chat: ChatRecord, contactId: string): boolean {
  if (chat.normalizedChatId.startsWith("contact:")) return chat.normalizedChatId === `contact:${contactId}`;
  const members = new Set(
    dbListChatParticipants(chat.id)
      .map((participant) => participant.contactId)
      .filter((member): member is string => Boolean(member)),
  );
  return members.size === 0 || (members.size === 1 && members.has(contactId));
}
