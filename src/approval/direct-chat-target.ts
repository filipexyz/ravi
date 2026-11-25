/**
 * Where one person can be asked privately: their direct chat with this bot on
 * the same instance as the turn. Used by person-bound questions (MCP
 * elicitation), which must never be asked in a group or on another instance.
 *
 * A chat qualifies only when it is a direct chat (never a group or a thread),
 * it is on one of the turn instance's own ids, and the chat belongs to that
 * contact alone and the contact still owns the peer identity of the chat
 * (`dmContactForChat`). The most recently seen chat wins. Nothing here sends.
 */

import "../channels/slack/grantors.js";
import { listSlackInstanceScopeAliases } from "../channels/slack/grantors.js";
import { dmContactForChat } from "../knowledge/contacts.js";
import { dbListChats, dbListInstances, type ChatRecord } from "../router/router-db.js";
import type { ApprovalTarget } from "./service.js";

export interface PersonDirectChatInput {
  /** The turn's channel (`whatsapp`, `slack`, ...). */
  readonly channel: string;
  /** The turn's account (instance name); outbound delivery addresses it. */
  readonly accountId: string;
  /** The turn's instance id when it differs from the account name. */
  readonly instanceId?: string | null;
  /** The person to ask. */
  readonly contactId: string;
}

const MAX_CHATS_SCANNED = 200;

/**
 * The person's direct chat on the turn's instance, as an approval target, or
 * null when there is none Ravi can prove belongs to them.
 */
export function resolvePersonDirectChatTarget(input: PersonDirectChatInput): ApprovalTarget | null {
  const channel = input.channel?.trim().toLowerCase();
  const accountId = input.accountId?.trim();
  const contactId = input.contactId?.trim();
  if (!channel || !accountId || !contactId) return null;

  const instanceIds = turnInstanceIds(channel, accountId, input.instanceId ?? null);
  if (instanceIds.length === 0) return null;

  let best: ChatRecord | null = null;
  for (const instanceId of instanceIds) {
    let chats: ChatRecord[];
    try {
      chats = dbListChats({ channel, instanceId, chatType: "dm", contactId, limit: MAX_CHATS_SCANNED }).items.map(
        (item) => item.chat,
      );
    } catch {
      // no-cause: An unreadable chat table proves no direct chat, so the person is not asked anywhere.
      return null;
    }
    for (const chat of chats) {
      if (!isPersonDirectChat(chat, channel, contactId)) continue;
      if (!best || chat.lastSeenAt > best.lastSeenAt) best = chat;
    }
  }
  if (!best) return null;
  const instanceId = input.instanceId?.trim();
  return {
    channel,
    accountId,
    chatId: best.platformChatId,
    ...(instanceId ? { instanceId } : {}),
  };
}

/** True when `chatId` is a direct chat that belongs to `contactId` alone. */
export function isPersonDirectChat(
  chat: Pick<ChatRecord, "id" | "chatType" | "channel" | "platformChatId">,
  channel: string,
  contactId: string,
): boolean {
  if (chat.chatType !== "dm") return false;
  if (chat.channel.trim().toLowerCase() !== channel) return false;
  // A thread or a sub-conversation is never a direct chat target.
  if (!chat.platformChatId || chat.platformChatId.includes("#")) return false;
  return dmContactForChat({ chatId: chat.id, channel }) === contactId;
}

/** Whether the chat a target names is a direct chat of this contact. */
export function targetIsPersonDirectChat(target: ApprovalTarget, contactId: string): boolean {
  const channel = target.channel?.trim().toLowerCase();
  const chatId = target.chatId?.trim();
  if (!channel || !chatId || !contactId.trim() || chatId.includes("#")) return false;
  return dmContactForChat({ chatId, channel }) === contactId.trim();
}

/**
 * Every `chats.instance_id` the turn's instance may be stored under. Slack
 * rows use the workspace's configured aliases; other channels store the
 * instance's id or its name, so both are listed for the one matching instance.
 */
function turnInstanceIds(channel: string, accountId: string, instanceId: string | null): string[] {
  if (channel === "slack") return listSlackInstanceScopeAliases(instanceId?.trim() || accountId);
  const ids = new Set<string>([accountId]);
  if (instanceId?.trim()) ids.add(instanceId.trim());
  try {
    for (const instance of dbListInstances()) {
      if (instance.deletedAt) continue;
      const names = [instance.name, instance.instanceId].filter((value): value is string => Boolean(value?.trim()));
      if (!names.some((name) => ids.has(name))) continue;
      for (const name of names) ids.add(name);
    }
  } catch {
    // no-cause: Without the instance table the lookup stays on the ids the turn gave, which is narrower.
  }
  return [...ids];
}
