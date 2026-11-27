/**
 * Who may drain a session inbox. Spec: `runtime/session-inbox`.
 *
 * Only the session's owner sees the deferred notices: a contact tagged as the owner
 * (`permission-owner`), recognised by the platform identity of a direct chat, never by the text
 * of the message nor by the actor type alone. `dmContactForChat` returns a contact only for a
 * direct chat whose single participant still owns that platform identity, so a third party in a
 * shared chat, a group or a channel never drains the inbox and never sees the block.
 */

import { findContactsByTag } from "../contacts.js";
import { dmContactForChat } from "../knowledge/contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import { dbGetChat, dbGetSessionDefaultChatId } from "../router/router-db.js";
import { logger } from "../utils/logger.js";

const ownerLog = logger.child("session-inbox:owner");

export interface InboxOwnerPrompt {
  source?: { chatId?: string | null; channel?: string | null } | null;
  context?: { isGroup?: boolean | null } | null;
}

export interface InboxOwnerDeps {
  ownerContactIds?: () => string[];
  dmContact?: (input: { chatId: string; channel: string | null }) => string | null;
  sessionDefaultChat?: (sessionKey: string) => { chatId: string; channel: string; isDirect: boolean } | null;
}

function ownerIds(deps: InboxOwnerDeps): Set<string> {
  return new Set((deps.ownerContactIds ?? (() => findContactsByTag(OWNER_CONTACT_TAG).map((c) => c.id)))());
}

/**
 * Exactly one owner, as Knowledge requires (src/knowledge/owner.ts): with no owner or with more
 * than one contact tagged as owner, nobody drains the inbox (fail closed).
 */
function isOwnersDirectChat(chat: { chatId: string; channel: string | null }, deps: InboxOwnerDeps): boolean {
  const owners = ownerIds(deps);
  if (owners.size !== 1) return false;
  const contactId = (deps.dmContact ?? dmContactForChat)(chat);
  return Boolean(contactId && owners.has(contactId));
}

/** A human turn drains only when it comes from the owner's own direct chat. Never throws. */
export function isInboxOwnerTurn(prompt: InboxOwnerPrompt | undefined, deps: InboxOwnerDeps = {}): boolean {
  try {
    if (!prompt || prompt.context?.isGroup === true) return false;
    const chatId = prompt.source?.chatId?.trim();
    const channel = prompt.source?.channel?.trim() || null;
    if (!chatId || !channel) return false;
    return isOwnersDirectChat({ chatId, channel }, deps);
  } catch (error) {
    // Fail closed: an identity lookup that throws never drains the inbox.
    ownerLog.warn("Owner check failed; the turn does not drain the inbox", { error });
    return false;
  }
}

function defaultSessionChat(sessionKey: string): { chatId: string; channel: string; isDirect: boolean } | null {
  const chatId = dbGetSessionDefaultChatId(sessionKey);
  const chat = chatId ? dbGetChat(chatId) : null;
  if (!chat) return null;
  return { chatId: chat.platformChatId, channel: chat.channel, isDirect: chat.chatType === "dm" };
}

/**
 * A heartbeat has no chat: its answer goes to the session's default chat. It drains only when that
 * chat is the owner's own direct chat. Never throws.
 */
export function isInboxOwnerSession(sessionKey: string | null | undefined, deps: InboxOwnerDeps = {}): boolean {
  try {
    if (!sessionKey) return false;
    const chat = (deps.sessionDefaultChat ?? defaultSessionChat)(sessionKey);
    if (!chat || !chat.isDirect) return false;
    return isOwnersDirectChat({ chatId: chat.chatId, channel: chat.channel }, deps);
  } catch (error) {
    // Fail closed: a session lookup that throws never lets a heartbeat drain the inbox.
    ownerLog.warn("Owner session check failed; the heartbeat does not drain the inbox", { error });
    return false;
  }
}
