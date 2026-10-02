/**
 * WhatsApp group metadata fetcher.
 *
 * Refreshes the channel group metadata cache (`channels/group-metadata/cache.ts`) through
 * the runner's `groups.metadata` RPC and maps the result into the cache shape.
 */

import { enrichParticipantsFromChatModel } from "../group-metadata/cache.js";
import type {
  ChannelGroupMetadata,
  ChannelGroupParticipant,
  GroupMetadataFetchInput,
  GroupMetadataFetcher,
} from "../group-metadata/types.js";
import type { WhatsAppClient } from "./client.js";
import type { WhatsAppRpcGroupMetadataParticipant, WhatsAppRpcResult } from "./contract.js";

/** The part of the WhatsApp client the fetcher needs. A full `WhatsAppClient` satisfies it. */
export interface WhatsAppGroupMetadataClient {
  readonly groups: Pick<WhatsAppClient["groups"], "metadata">;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return undefined;
  return trimmed;
}

/** Group JID for the RPC: `<id>@g.us` for bare ids and `group:<id>` refs; JIDs pass through. */
export function toWhatsAppGroupJid(chatId: string): string {
  if (chatId.includes("@")) return chatId;
  return `${chatId.replace(/^group:/, "")}@g.us`;
}

function toChannelParticipant(participant: WhatsAppRpcGroupMetadataParticipant): ChannelGroupParticipant | null {
  const platformUserId = cleanString(participant.platformUserId);
  if (!platformUserId) return null;
  const phoneJid = cleanString(participant.phoneJid);
  const phoneNumber = cleanString(participant.phoneNumber);
  const displayName = cleanString(participant.displayName);
  return {
    platformUserId,
    ...(phoneJid ? { phoneJid, mentionUserId: phoneJid } : {}),
    ...(phoneNumber ? { phoneNumber, normalizedPlatformUserId: phoneNumber.replace(/\D+/g, "") || phoneNumber } : {}),
    ...(displayName ? { displayName } : {}),
    role: participant.role,
  };
}

/** Map a `groups.metadata` RPC result into the channel group metadata cache shape. */
export function whatsappGroupMetadataToChannel(
  result: WhatsAppRpcResult<"groups.metadata">,
  input: Pick<GroupMetadataFetchInput, "accountId" | "instanceId" | "chatId" | "channel" | "fallbackName">,
): ChannelGroupMetadata {
  const participants = result.participants
    .map(toChannelParticipant)
    .filter((participant): participant is ChannelGroupParticipant => Boolean(participant));
  const owner = cleanString(result.owner);
  return enrichParticipantsFromChatModel({
    accountId: input.accountId,
    instanceId: input.instanceId,
    chatId: input.chatId,
    chatUuid: null,
    externalId: cleanString(result.groupJid) ?? input.chatId,
    channel: input.channel ?? "whatsapp-baileys",
    name: cleanString(result.subject) ?? input.fallbackName ?? null,
    description: cleanString(result.description) ?? null,
    avatarUrl: null,
    participantCount: participants.length,
    participants,
    settings: null,
    platformMetadata: { transport: "whatsapp", ...(owner ? { owner } : {}) },
    fetchedAt: Number.isFinite(result.fetchedAt) && result.fetchedAt > 0 ? result.fetchedAt : Date.now(),
  });
}

/**
 * Fetcher over the runner RPC. An instance that is not bound to a WhatsApp channel rejects
 * with 404 `WHATSAPP_NOT_BOUND` (the client never reaches the network); `resolveGroupMetadata`
 * logs it and falls back to the cache.
 */
export function createWhatsAppGroupMetadataFetcher(client: WhatsAppGroupMetadataClient): GroupMetadataFetcher {
  return async (input) => {
    const result = await client.groups.metadata(
      input.instanceId,
      { groupJid: toWhatsAppGroupJid(input.chatId) },
      { timeoutMs: input.fetchTimeoutMs },
    );
    return whatsappGroupMetadataToChannel(result, input);
  };
}
