/**
 * Reaction target of a WhatsApp group message, from the daemon's chat ledger.
 *
 * A group reaction addresses the target message's key, which includes its sender
 * (`key.participant`). The runner remembers recent keys in memory only, so right after a
 * runner restart it would react with an incomplete key. The daemon still has the key: the
 * inbound pipeline stores the runner's raw message (`rawProvenance.rawPayload`, a
 * WAMessage with its `key`) in `chat_messages`. The gateway passes what it finds here
 * along with the reaction; the runner prefers an explicit `participant`/`fromMe`.
 */

import { dbFindChat, dbFindChatMessage } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import type { ChannelReactionTarget } from "../outbound/sender.js";

const log = logger.child("channels:whatsapp:reaction-target");

/** Ledger channel id of WhatsApp chats (the pipeline strips `-baileys`). */
const LEDGER_CHANNEL = "whatsapp";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `{participant}` or `{fromMe: true}` from a stored raw message key; null when the key says nothing useful. */
export function reactionTargetFromRawProvenance(rawProvenance: unknown): ChannelReactionTarget | null {
  const key = asRecord(asRecord(asRecord(rawProvenance)?.rawPayload)?.key);
  if (!key) return null;
  if (key.fromMe === true) return { fromMe: true };
  const participant = typeof key.participant === "string" ? key.participant.trim() : "";
  return participant ? { participant, fromMe: false } : null;
}

/**
 * The stored key fields of `messageId` in the group `chatJid` of instance `instanceId`
 * (transport UUID), or undefined (not a group, not in the ledger, no raw key). Never throws.
 */
export function findWhatsAppGroupReactionTarget(
  instanceId: string,
  chatJid: string,
  messageId: string,
): ChannelReactionTarget | undefined {
  if (!chatJid.endsWith("@g.us") || !instanceId.trim() || !messageId.trim()) return undefined;
  try {
    const chat = dbFindChat({ channel: LEDGER_CHANNEL, instanceId, platformChatId: chatJid, chatType: "group" });
    if (!chat) return undefined;
    const message = dbFindChatMessage({
      channel: LEDGER_CHANNEL,
      instanceId,
      chatId: chat.id,
      providerMessageId: messageId,
    });
    return reactionTargetFromRawProvenance(message?.rawProvenance) ?? undefined;
  } catch (error) {
    log.debug("Reaction target lookup failed", { instanceId, chatJid, messageId, error });
    return undefined;
  }
}
