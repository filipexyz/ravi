import { canonicalChannelId } from "../channels/capabilities.js";
import type { ChatRecord } from "../router/router-db.js";
import type { MessageTarget } from "./message-types.js";

/**
 * WhatsApp inbound and leftover lastChannel can disagree on form:
 * `whatsapp` vs `whatsapp-baileys`, `group:<id>` vs `<id>@g.us` vs `chat_*`.
 * Matching must treat those as one chat identity.
 */
export function runtimeChannelsMatch(left?: string | null, right?: string | null): boolean {
  const a = canonicalChannelId(left ?? undefined);
  const b = canonicalChannelId(right ?? undefined);
  return a !== "unknown" && a === b;
}

export function runtimeChatIdVariants(chatId: string | null | undefined): string[] {
  const normalized = chatId?.trim();
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  const groupMatch = normalized.match(/^group:(.+)$/i);
  if (groupMatch?.[1]) {
    variants.add(groupMatch[1]);
    variants.add(`${groupMatch[1]}@g.us`);
  }
  const jidGroup = normalized.match(/^(.+)@g\.us$/i);
  if (jidGroup?.[1]) {
    variants.add(jidGroup[1]);
    variants.add(`group:${jidGroup[1]}`);
  }
  return [...variants];
}

export function runtimeChatIdsOverlap(left?: string | null, right?: string | null): boolean {
  const needles = new Set(runtimeChatIdVariants(left));
  if (needles.size === 0) return false;
  return runtimeChatIdVariants(right).some((id) => needles.has(id));
}

export function sourceMatchesChat(
  source: Pick<MessageTarget, "channel" | "chatId" | "canonicalChatId" | "threadId">,
  chat: Pick<ChatRecord, "id" | "channel" | "platformChatId" | "normalizedChatId">,
): boolean {
  if (source.channel && chat.channel && !runtimeChannelsMatch(source.channel, chat.channel)) {
    return false;
  }
  const chatTokens = [chat.id, chat.platformChatId, chat.normalizedChatId];
  const sourceTokens = [source.canonicalChatId, source.chatId];
  const overlap = sourceTokens.some((sourceToken) =>
    chatTokens.some((chatToken) => runtimeChatIdsOverlap(sourceToken, chatToken)),
  );
  if (!overlap) return false;
  const separator = chat.platformChatId.indexOf("#");
  const threadId = separator === -1 ? undefined : chat.platformChatId.slice(separator + 1);
  if (source.threadId && threadId && source.threadId !== threadId) return false;
  return true;
}
