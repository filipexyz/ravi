/**
 * Transport-neutral group metadata contract.
 *
 * The cache (`cache.ts`) stores one row per group in `channel_group_metadata` and
 * refreshes it through a transport-specific `GroupMetadataFetcher`: the WhatsApp
 * runner RPC (`channels/whatsapp/group-metadata.ts`) or the legacy Omni REST bridge
 * (`omni/group-metadata.ts`).
 */

export interface ChannelGroupParticipant {
  id?: string | null;
  platformUserId: string;
  normalizedPlatformUserId?: string | null;
  mentionUserId?: string | null;
  phoneJid?: string | null;
  phoneNumber?: string | null;
  displayName?: string | null;
  role?: string | null;
}

export interface ChannelGroupMetadata {
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
  participants: ChannelGroupParticipant[];
  settings?: Record<string, unknown> | null;
  /** Includes `transport: "whatsapp" | "omni"`. */
  platformMetadata?: Record<string, unknown> | null;
  fetchedAt: number;
}

export interface GroupMetadataFetchInput {
  accountId: string;
  instanceId: string;
  chatId: string;
  channel?: string;
  fallbackName?: string;
  fetchTimeoutMs: number;
}

/** Fetches fresh metadata from the transport. May throw; resolveGroupMetadata logs and falls back to cache. */
export type GroupMetadataFetcher = (input: GroupMetadataFetchInput) => Promise<ChannelGroupMetadata | null>;

export interface ResolveGroupMetadataInput {
  accountId: string;
  instanceId: string;
  chatId: string;
  channel?: string;
  fallbackName?: string;
  /** Default 10 minutes. */
  maxAgeMs?: number;
  /** Default 5 seconds. */
  fetchTimeoutMs?: number;
  fetcher?: GroupMetadataFetcher | null;
}
