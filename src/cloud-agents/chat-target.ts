/**
 * Where a delivery session talks, and how a cloud run's words reach it.
 *
 * The chat of a session is the one it answers in: its output chat binding,
 * else its last delivery context (the same order the runtime and session
 * followups use). Text goes out on `ravi.outbound.deliver`, the gateway's
 * normal path, which applies the Knowledge egress guard and sends Slack
 * private cards. On WhatsApp an agent never starts a conversation, so a
 * message only goes to a chat where a person already wrote.
 */

import {
  dbFindChat,
  dbGetChat,
  dbGetInstance,
  dbGetInstanceByInstanceId,
  dbGetSessionOutputAttachment,
  dbListChatMessages,
} from "../router/router-db.js";
import { resolveSession } from "../router/sessions.js";
import { requestReply } from "../utils/request-reply.js";

export interface CloudChatTarget {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  threadId?: string;
  canonicalChatId?: string;
}

export interface CloudChatDeliveryReply {
  messageId: string | null;
  deliveries: Array<{ userId: string; kind: string; chatId: string; messageId: string }>;
}

/** `whatsapp-baileys` and `whatsapp` are one channel here. */
export function normalizeChatChannel(channel: string | null | undefined): string {
  return (channel ?? "")
    .trim()
    .toLowerCase()
    .replace(/-baileys$/, "");
}

/** The chat a session answers in, or null when it has none (a terminal or routine session). */
export function resolveSessionChat(sessionName: string): CloudChatTarget | null {
  const session = resolveSession(sessionName);
  if (!session) return null;
  const output = dbGetSessionOutputAttachment(session.sessionKey);
  const chat = output ? dbGetChat(output.chatId) : null;
  if (chat) {
    const instance = dbGetInstanceByInstanceId(chat.instanceId);
    const platformChatId = chat.platformChatId || chat.normalizedChatId;
    const separator = normalizeChatChannel(chat.channel) === "slack" ? platformChatId.indexOf("#") : -1;
    return {
      channel: chat.channel,
      accountId: instance?.name ?? chat.instanceId,
      instanceId: chat.instanceId,
      chatId: separator > 0 ? platformChatId.slice(0, separator) : platformChatId,
      ...(separator > 0 ? { threadId: platformChatId.slice(separator + 1) } : {}),
      canonicalChatId: chat.id,
    };
  }
  if (!session.lastChannel || !session.lastTo) return null;
  return {
    channel: session.lastChannel,
    accountId: session.lastAccountId ?? session.accountId ?? "",
    chatId: session.lastTo,
    ...(session.lastThreadId ? { threadId: session.lastThreadId } : {}),
  };
}

/** True when a person (a contact) already wrote in this chat; an agent's own messages do not count. */
export function personWroteFirst(target: CloudChatTarget): boolean {
  const chat = target.canonicalChatId ? dbGetChat(target.canonicalChatId) : findChat(target);
  if (!chat) return false;
  return dbListChatMessages(chat.id, 200).some((message) => message.actorType === "contact");
}

function findChat(target: CloudChatTarget) {
  const channel = normalizeChatChannel(target.channel);
  const candidates = [target.instanceId, dbGetInstance(target.accountId)?.instanceId, target.accountId];
  for (const instanceId of new Set(candidates.filter((value): value is string => Boolean(value?.trim())))) {
    const chat = dbFindChat({ channel, instanceId, platformChatId: target.chatId });
    if (chat) return chat;
  }
  return null;
}

/** Sends through the gateway (`ravi.outbound.deliver`); `privateTo` sends a Slack card only to those people. */
export async function deliverToChat(
  target: CloudChatTarget,
  message: { text: string; blocks?: readonly Record<string, unknown>[]; privateTo?: readonly string[] },
  timeoutMs = 30_000,
): Promise<CloudChatDeliveryReply> {
  const reply = await requestReply<{ messageId?: unknown; deliveries?: unknown }>(
    "ravi.outbound.deliver",
    {
      channel: target.channel,
      accountId: target.accountId,
      to: target.chatId,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.privateTo ? { privateTo: message.privateTo } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
    },
    timeoutMs,
  );
  const deliveries = Array.isArray(reply.deliveries)
    ? reply.deliveries.flatMap((entry) => {
        const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
        return record &&
          typeof record.userId === "string" &&
          typeof record.chatId === "string" &&
          typeof record.messageId === "string"
          ? [
              {
                userId: record.userId,
                kind: typeof record.kind === "string" ? record.kind : "ephemeral",
                chatId: record.chatId,
                messageId: record.messageId,
              },
            ]
          : [];
      })
    : [];
  return { messageId: typeof reply.messageId === "string" ? reply.messageId : null, deliveries };
}
