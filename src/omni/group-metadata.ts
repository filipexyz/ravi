/**
 * Legacy-bridge (Omni REST) group metadata fetcher.
 *
 * Finds the group chat through `/api/v2/chats` and reads its participants, for the
 * channel group metadata cache (`channels/group-metadata/cache.ts`). Only legacy-bridge
 * instances (Telegram/Discord) use it.
 */

import { enrichParticipantsFromChatModel, normalizeGroupParticipant } from "../channels/group-metadata/cache.js";
import type {
  ChannelGroupMetadata,
  ChannelGroupParticipant,
  GroupMetadataFetchInput,
  GroupMetadataFetcher,
} from "../channels/group-metadata/types.js";
import { fetchWithTimeout } from "../utils/paths.js";

export interface OmniGroupMetadataConnection {
  apiUrl: string;
  apiKey: string;
}

interface OmniChatRecord {
  id?: string;
  instanceId?: string;
  externalId?: string | null;
  channel?: string | null;
  name?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  participantCount?: number | null;
  settings?: Record<string, unknown> | null;
  platformMetadata?: Record<string, unknown> | null;
}

interface OmniListEnvelope<T> {
  items?: T[];
  data?: T[] | T;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return undefined;
  return trimmed;
}

function normalizeChatId(chatId: string): string {
  return chatId.includes("@") ? chatId.slice(0, chatId.indexOf("@")) : chatId.replace(/^group:/, "");
}

function apiUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`/api/v2${path}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function omniGet<T>(
  connection: OmniGroupMetadataConnection,
  fetchTimeoutMs: number,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<OmniListEnvelope<T>> {
  const response = await fetchWithTimeout(
    apiUrl(connection.apiUrl, path, query),
    {
      headers: {
        "x-api-key": connection.apiKey,
        "Accept-Encoding": "identity",
      },
    },
    fetchTimeoutMs,
  );
  const payload = (await response.json().catch(() => ({}))) as OmniListEnvelope<T> & {
    error?: { message?: string } | string;
    message?: string;
  };

  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(error ?? payload.message ?? `Omni API error ${response.status}`);
  }

  return payload;
}

function envelopeItems<T>(payload: OmniListEnvelope<T>): T[] {
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function chatMatches(chat: OmniChatRecord, chatId: string): boolean {
  const expected = normalizeChatId(chatId);
  const externalId = cleanString(chat.externalId);
  return externalId === chatId || (externalId ? normalizeChatId(externalId) === expected : false);
}

function chooseChat(chats: OmniChatRecord[], chatId: string, fallbackName?: string): OmniChatRecord | null {
  const exact = chats.find((chat) => chatMatches(chat, chatId));
  if (exact) return exact;

  const expectedName = fallbackName?.trim().toLowerCase();
  if (expectedName) {
    const byName = chats.find((chat) => chat.name?.trim().toLowerCase() === expectedName);
    if (byName) return byName;
  }

  return null;
}

async function fetchOmniGroupMetadata(
  connection: OmniGroupMetadataConnection,
  input: GroupMetadataFetchInput,
): Promise<ChannelGroupMetadata | null> {
  const searches = Array.from(
    new Set(
      [input.chatId, normalizeChatId(input.chatId), input.fallbackName].map((value) => value?.trim()).filter(Boolean),
    ),
  ) as string[];

  let selectedChat: OmniChatRecord | null = null;
  for (const search of searches) {
    const payload = await omniGet<OmniChatRecord>(connection, input.fetchTimeoutMs, "/chats", {
      instanceId: input.instanceId,
      chatType: "group",
      search,
      limit: 20,
    });
    selectedChat = chooseChat(envelopeItems(payload), input.chatId, input.fallbackName);
    if (selectedChat) break;
  }

  if (!selectedChat?.id) {
    const payload = await omniGet<OmniChatRecord>(connection, input.fetchTimeoutMs, "/chats", {
      instanceId: input.instanceId,
      chatType: "group",
      limit: 500,
    });
    selectedChat = chooseChat(envelopeItems(payload), input.chatId, input.fallbackName);
  }

  if (!selectedChat?.id) return null;

  const participantsPayload = await omniGet<unknown>(
    connection,
    input.fetchTimeoutMs,
    `/chats/${selectedChat.id}/participants`,
  );
  const participants = envelopeItems(participantsPayload)
    .map(normalizeGroupParticipant)
    .filter((participant): participant is ChannelGroupParticipant => Boolean(participant));

  return enrichParticipantsFromChatModel({
    accountId: input.accountId,
    instanceId: input.instanceId,
    chatId: input.chatId,
    chatUuid: selectedChat.id,
    externalId: selectedChat.externalId ?? input.chatId,
    channel: selectedChat.channel ?? input.channel ?? null,
    name: selectedChat.name ?? input.fallbackName ?? null,
    description: selectedChat.description ?? null,
    avatarUrl: selectedChat.avatarUrl ?? null,
    participantCount: selectedChat.participantCount ?? participants.length,
    participants,
    settings: selectedChat.settings ?? null,
    platformMetadata: { ...(selectedChat.platformMetadata ?? {}), transport: "omni" },
    fetchedAt: Date.now(),
  });
}

/** Fetcher over the Omni REST API (`/api/v2/chats`, `/api/v2/chats/:id/participants`). */
export function createOmniGroupMetadataFetcher(connection: OmniGroupMetadataConnection): GroupMetadataFetcher {
  return (input) => fetchOmniGroupMetadata(connection, input);
}
