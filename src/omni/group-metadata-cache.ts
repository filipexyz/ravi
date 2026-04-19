import { getDb } from "../router/router-db.js";
import { fetchWithTimeout } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

const log = logger.child("omni:group-metadata");

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export interface OmniGroupParticipant {
  id?: string | null;
  platformUserId: string;
  displayName?: string | null;
  role?: string | null;
}

export interface OmniGroupMetadata {
  accountId: string;
  instanceId: string;
  chatId: string;
  chatUuid?: string | null;
  externalId?: string | null;
  channel?: string | null;
  name?: string | null;
  description?: string | null;
  avatarUrl?: string | null;
  participantCount?: number | null;
  participants: OmniGroupParticipant[];
  settings?: Record<string, unknown> | null;
  platformMetadata?: Record<string, unknown> | null;
  fetchedAt: number;
}

export interface ResolveOmniGroupMetadataInput {
  omniApiUrl: string;
  omniApiKey: string;
  accountId: string;
  instanceId: string;
  chatId: string;
  channel?: string;
  fallbackName?: string;
  maxAgeMs?: number;
  fetchTimeoutMs?: number;
}

interface OmniGroupMetadataRow {
  account_id: string;
  instance_id: string;
  chat_id: string;
  chat_uuid: string | null;
  external_id: string | null;
  channel: string | null;
  name: string | null;
  description: string | null;
  avatar_url: string | null;
  participant_count: number | null;
  participants_json: string | null;
  settings_json: string | null;
  platform_metadata_json: string | null;
  fetched_at: number;
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

interface OmniParticipantRecord {
  id?: string | null;
  platformUserId?: string | null;
  userId?: string | null;
  displayName?: string | null;
  name?: string | null;
  role?: string | null;
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

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseParticipants(value: string | null): OmniGroupParticipant[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeParticipant)
      .filter((participant): participant is OmniGroupParticipant => Boolean(participant));
  } catch {
    return [];
  }
}

function rowToMetadata(row: OmniGroupMetadataRow): OmniGroupMetadata {
  return {
    accountId: row.account_id,
    instanceId: row.instance_id,
    chatId: row.chat_id,
    chatUuid: row.chat_uuid,
    externalId: row.external_id,
    channel: row.channel,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatar_url,
    participantCount: row.participant_count,
    participants: parseParticipants(row.participants_json),
    settings: parseJsonRecord(row.settings_json),
    platformMetadata: parseJsonRecord(row.platform_metadata_json),
    fetchedAt: row.fetched_at,
  };
}

function getCachedOmniGroupMetadata(input: {
  accountId: string;
  instanceId: string;
  chatId: string;
  maxAgeMs?: number;
}): OmniGroupMetadata | null {
  const row = getDb()
    .prepare(
      `
      SELECT * FROM omni_group_metadata
      WHERE account_id = ? AND instance_id = ? AND chat_id = ?
    `,
    )
    .get(input.accountId, input.instanceId, input.chatId) as OmniGroupMetadataRow | undefined;

  if (!row) return null;
  if (input.maxAgeMs !== undefined && Date.now() - row.fetched_at > input.maxAgeMs) return null;
  return rowToMetadata(row);
}

export function upsertOmniGroupMetadata(metadata: OmniGroupMetadata): void {
  const now = Date.now();
  getDb()
    .prepare(
      `
      INSERT INTO omni_group_metadata (
        account_id, instance_id, chat_id, chat_uuid, external_id, channel,
        name, description, avatar_url, participant_count, participants_json,
        settings_json, platform_metadata_json, fetched_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, instance_id, chat_id) DO UPDATE SET
        chat_uuid = excluded.chat_uuid,
        external_id = excluded.external_id,
        channel = excluded.channel,
        name = COALESCE(excluded.name, omni_group_metadata.name),
        description = COALESCE(excluded.description, omni_group_metadata.description),
        avatar_url = COALESCE(excluded.avatar_url, omni_group_metadata.avatar_url),
        participant_count = COALESCE(excluded.participant_count, omni_group_metadata.participant_count),
        participants_json = COALESCE(excluded.participants_json, omni_group_metadata.participants_json),
        settings_json = COALESCE(excluded.settings_json, omni_group_metadata.settings_json),
        platform_metadata_json = COALESCE(excluded.platform_metadata_json, omni_group_metadata.platform_metadata_json),
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      metadata.accountId,
      metadata.instanceId,
      metadata.chatId,
      metadata.chatUuid ?? null,
      metadata.externalId ?? metadata.chatId,
      metadata.channel ?? null,
      metadata.name ?? null,
      metadata.description ?? null,
      metadata.avatarUrl ?? null,
      metadata.participantCount ?? metadata.participants.length,
      JSON.stringify(metadata.participants),
      metadata.settings ? JSON.stringify(metadata.settings) : null,
      metadata.platformMetadata ? JSON.stringify(metadata.platformMetadata) : null,
      metadata.fetchedAt,
      now,
      now,
    );
}

function apiUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`/api/v2${path}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function omniGet<T>(
  input: Pick<ResolveOmniGroupMetadataInput, "omniApiUrl" | "omniApiKey" | "fetchTimeoutMs">,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<OmniListEnvelope<T>> {
  const response = await fetchWithTimeout(
    apiUrl(input.omniApiUrl, path, query),
    {
      headers: {
        "x-api-key": input.omniApiKey,
        "Accept-Encoding": "identity",
      },
    },
    input.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
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

function normalizeParticipant(value: unknown): OmniGroupParticipant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as OmniParticipantRecord;
  const platformUserId = cleanString(record.platformUserId) ?? cleanString(record.userId);
  if (!platformUserId) return null;

  return {
    ...(cleanString(record.id) ? { id: cleanString(record.id) } : {}),
    platformUserId,
    ...((cleanString(record.displayName) ?? cleanString(record.name))
      ? { displayName: cleanString(record.displayName) ?? cleanString(record.name) }
      : {}),
    ...(cleanString(record.role) ? { role: cleanString(record.role) } : {}),
  };
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

async function fetchOmniGroupMetadata(input: ResolveOmniGroupMetadataInput): Promise<OmniGroupMetadata | null> {
  const searches = Array.from(
    new Set(
      [input.chatId, normalizeChatId(input.chatId), input.fallbackName].map((value) => value?.trim()).filter(Boolean),
    ),
  ) as string[];

  let selectedChat: OmniChatRecord | null = null;
  for (const search of searches) {
    const payload = await omniGet<OmniChatRecord>(input, "/chats", {
      instanceId: input.instanceId,
      chatType: "group",
      search,
      limit: 20,
    });
    selectedChat = chooseChat(envelopeItems(payload), input.chatId, input.fallbackName);
    if (selectedChat) break;
  }

  if (!selectedChat?.id) {
    const payload = await omniGet<OmniChatRecord>(input, "/chats", {
      instanceId: input.instanceId,
      chatType: "group",
      limit: 500,
    });
    selectedChat = chooseChat(envelopeItems(payload), input.chatId, input.fallbackName);
  }

  if (!selectedChat?.id) return null;

  const participantsPayload = await omniGet<OmniParticipantRecord>(input, `/chats/${selectedChat.id}/participants`);
  const participants = envelopeItems(participantsPayload)
    .map(normalizeParticipant)
    .filter((participant): participant is OmniGroupParticipant => Boolean(participant));

  return {
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
    platformMetadata: selectedChat.platformMetadata ?? null,
    fetchedAt: Date.now(),
  };
}

export async function resolveOmniGroupMetadata(
  input: ResolveOmniGroupMetadataInput,
): Promise<OmniGroupMetadata | null> {
  const fresh = getCachedOmniGroupMetadata({
    accountId: input.accountId,
    instanceId: input.instanceId,
    chatId: input.chatId,
    maxAgeMs: input.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  });
  if (fresh) return fresh;

  try {
    const fetched = await fetchOmniGroupMetadata(input);
    if (fetched) {
      upsertOmniGroupMetadata(fetched);
      return fetched;
    }
  } catch (error) {
    log.warn("Failed to refresh Omni group metadata", {
      accountId: input.accountId,
      instanceId: input.instanceId,
      chatId: input.chatId,
      error,
    });
  }

  return getCachedOmniGroupMetadata({
    accountId: input.accountId,
    instanceId: input.instanceId,
    chatId: input.chatId,
  });
}

export function formatOmniGroupMembersForPrompt(metadata: OmniGroupMetadata | null | undefined): string[] | undefined {
  if (!metadata?.participants.length) return undefined;

  return metadata.participants.map((participant) => {
    const label = participant.displayName?.trim() || participant.platformUserId;
    const role = participant.role?.trim();
    return role && role !== "-" && role !== "member" ? `${label} (${role})` : label;
  });
}
