/**
 * Matrix Inbound Message Processing
 *
 * Normalizes Matrix events into InboundMessage format,
 * handles media downloads, and provides message filtering.
 */

import type { MatrixClient, EncryptedFile as SdkEncryptedFile } from "@vector-im/matrix-bot-sdk";
import type { InboundMedia, QuotedMessage } from "../types.js";
import {
  EventType,
  RelationType,
  type MatrixRawEvent,
  type RoomMessageEventContent,
  type MatrixInbound,
  type EncryptedFile,
} from "./types.js";

// ============================================================================
// Message Filtering
// ============================================================================

interface FilterResult {
  pass: boolean;
  reason?: string;
}

/**
 * Determine if an event should be processed
 */
export function shouldProcessEvent(
  event: MatrixRawEvent,
  selfUserId: string,
  startupMs: number
): FilterResult {
  // Check event type
  const eventType = event.type;

  // Skip encrypted events (handled separately when decrypted)
  if (eventType === EventType.RoomMessageEncrypted) {
    return { pass: false, reason: "encrypted_event" };
  }

  // Only process room messages
  if (eventType !== EventType.RoomMessage) {
    return { pass: false, reason: "not_room_message" };
  }

  // Skip redacted messages
  if (event.unsigned?.redacted_because) {
    return { pass: false, reason: "redacted" };
  }

  // Skip messages from self
  const senderId = event.sender;
  if (!senderId) {
    return { pass: false, reason: "no_sender" };
  }
  if (senderId === selfUserId) {
    return { pass: false, reason: "self_message" };
  }

  // Skip old messages (before startup)
  const eventTs = event.origin_server_ts;
  const eventAge = event.unsigned?.age;
  const graceMs = 5000; // 5 second grace period

  if (typeof eventTs === "number" && eventTs < startupMs - graceMs) {
    return { pass: false, reason: "old_message" };
  }
  if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > graceMs) {
    return { pass: false, reason: "old_message_by_age" };
  }

  // Skip edit events
  const content = event.content as unknown as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  if (relates && "rel_type" in relates && relates.rel_type === RelationType.Replace) {
    return { pass: false, reason: "edit_event" };
  }

  return { pass: true };
}

// ============================================================================
// Message Normalization
// ============================================================================

interface NormalizeParams {
  accountId: string;
  roomId: string;
  event: MatrixRawEvent;
  isDirect: boolean;
  roomName?: string;
  senderDisplayName?: string;
}

/**
 * Normalize a Matrix event into InboundMessage format
 */
export function normalizeMessage(params: NormalizeParams): MatrixInbound | null {
  const { accountId, roomId, event, isDirect, roomName, senderDisplayName } = params;

  const content = event.content as unknown as RoomMessageEventContent;
  const senderId = event.sender;
  const eventId = event.event_id;

  if (!senderId || !eventId) {
    return null;
  }

  // Extract text body
  const rawBody = typeof content.body === "string" ? content.body.trim() : "";

  // Extract media info
  const media = extractMediaInfo(content);

  // Skip if no text and no media
  if (!rawBody && !media) {
    return null;
  }

  // Extract reply info
  const replyTo = extractReplyInfo(content);

  // Extract thread info
  const threadId = extractThreadId(content);

  return {
    id: eventId,
    channelId: "matrix",
    accountId,
    senderId,
    senderName: senderDisplayName ?? senderId.split(":")[0]?.replace(/^@/, ""),
    chatId: roomId,
    text: rawBody || undefined,
    media: media ?? undefined,
    replyTo,
    timestamp: event.origin_server_ts ?? Date.now(),
    isGroup: !isDirect,
    groupName: !isDirect ? roomName : undefined,
    raw: event,
    // Matrix-specific fields
    roomId,
    eventId,
    isDirect,
    threadId,
    replyToEventId: content["m.relates_to"]?.["m.in_reply_to"]?.event_id,
  };
}

/**
 * Extract media info from message content
 */
function extractMediaInfo(content: RoomMessageEventContent): InboundMedia | null {
  const msgtype = content.msgtype;

  // Check if this is a media message
  if (!["m.image", "m.audio", "m.video", "m.file"].includes(msgtype)) {
    return null;
  }

  // Get media URL (either unencrypted or encrypted)
  const mediaUrl = content.url ?? content.file?.url;
  if (!mediaUrl) {
    return null;
  }

  const info = content.info;
  const mimetype = info?.mimetype ?? "application/octet-stream";

  // Map Matrix message types to our media types
  let type: InboundMedia["type"];
  switch (msgtype) {
    case "m.image":
      type = "image";
      break;
    case "m.audio":
      type = "audio";
      break;
    case "m.video":
      type = "video";
      break;
    default:
      type = "document";
  }

  return {
    type,
    mimetype,
    filename: content.body,
    url: mediaUrl,
    sizeBytes: info?.size ?? undefined,
  };
}

/**
 * Extract reply info from message content
 */
function extractReplyInfo(content: RoomMessageEventContent): QuotedMessage | undefined {
  const replyToId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
  if (!replyToId) {
    return undefined;
  }

  // Note: To get the full quoted message content, we'd need to fetch the event
  // For now, just return the event ID
  return {
    id: replyToId,
    senderId: "", // Would need to fetch event to get this
  };
}

/**
 * Extract thread root ID from message content
 */
function extractThreadId(content: RoomMessageEventContent): string | undefined {
  const relates = content["m.relates_to"];
  if (!relates) return undefined;

  if ("rel_type" in relates && relates.rel_type === RelationType.Thread) {
    return relates.event_id;
  }

  return undefined;
}

// ============================================================================
// Media Download
// ============================================================================

/**
 * Download media from Matrix
 */
export async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  sizeBytes?: number;
  maxBytes: number;
  file?: EncryptedFile;
}): Promise<Buffer | null> {
  const { client, mxcUrl, sizeBytes, maxBytes, file } = params;

  // Check size limit
  if (typeof sizeBytes === "number" && sizeBytes > maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }

  let buffer: Buffer;

  if (file) {
    // Encrypted media - use crypto.decryptMedia
    if (!client.crypto) {
      throw new Error("Cannot decrypt media: crypto not enabled");
    }

    // Cast to SDK's EncryptedFile type
    const decrypted = await client.crypto.decryptMedia(file as unknown as SdkEncryptedFile);
    if (decrypted.byteLength > maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }
    buffer = decrypted;
  } else {
    // Unencrypted media
    const downloaded = await client.downloadContent(mxcUrl);
    if (downloaded.data.byteLength > maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }
    buffer = Buffer.from(downloaded.data);
  }

  return buffer;
}

// ============================================================================
// Debouncing
// ============================================================================

interface DebouncedMessage {
  message: MatrixInbound;
  timer: ReturnType<typeof setTimeout>;
  resolve: (messages: MatrixInbound[]) => void;
}

const debounceQueues = new Map<string, DebouncedMessage[]>();

/**
 * Debounce messages from the same chat
 */
export async function debounceMessage(
  message: MatrixInbound,
  debounceMs: number
): Promise<MatrixInbound[]> {
  if (debounceMs <= 0) {
    return [message];
  }

  const key = `${message.accountId}:${message.chatId}`;

  return new Promise((resolve) => {
    const existing = debounceQueues.get(key) ?? [];

    // Clear existing timer if any
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      clearTimeout(last.timer);
    }

    // Add message to queue
    const entry: DebouncedMessage = {
      message,
      timer: setTimeout(() => {
        const queue = debounceQueues.get(key) ?? [];
        debounceQueues.delete(key);

        // Resolve all promises with the full queue
        const messages = queue.map((e) => e.message);
        for (const e of queue) {
          e.resolve(messages);
        }
      }, debounceMs),
      resolve,
    };

    debounceQueues.set(key, [...existing, entry]);
  });
}

/**
 * Merge multiple messages into one
 */
export function mergeMessages(messages: MatrixInbound[]): MatrixInbound {
  const first = messages[0];
  if (!first) {
    throw new Error("Cannot merge empty message array");
  }

  if (messages.length === 1) {
    return first;
  }

  const texts = messages
    .map((m) => m.text)
    .filter(Boolean)
    .join("\n\n");

  const last = messages[messages.length - 1];
  return {
    ...first,
    text: texts || undefined,
    id: last?.id ?? first.id, // Use last message ID
  };
}

// ============================================================================
// Room Info Resolution
// ============================================================================

interface RoomInfo {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
}

const roomInfoCache = new Map<string, { info: RoomInfo; ts: number }>();
const ROOM_INFO_CACHE_TTL_MS = 60_000;

/**
 * Get room info (name, aliases)
 */
export async function getRoomInfo(
  client: MatrixClient,
  roomId: string
): Promise<RoomInfo> {
  // Check cache
  const cached = roomInfoCache.get(roomId);
  if (cached && Date.now() - cached.ts < ROOM_INFO_CACHE_TTL_MS) {
    return cached.info;
  }

  const info: RoomInfo = {
    altAliases: [],
  };

  try {
    // Get room name
    const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "");
    if (nameState?.name) {
      info.name = nameState.name;
    }
  } catch {
    // Room may not have a name
  }

  try {
    // Get canonical alias
    const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "");
    if (aliasState?.alias) {
      info.canonicalAlias = aliasState.alias;
    }
    if (Array.isArray(aliasState?.alt_aliases)) {
      info.altAliases = aliasState.alt_aliases;
    }
  } catch {
    // Room may not have aliases
  }

  // Cache result
  roomInfoCache.set(roomId, { info, ts: Date.now() });

  return info;
}

/**
 * Get display name for a room member
 */
export async function getMemberDisplayName(
  client: MatrixClient,
  roomId: string,
  userId: string
): Promise<string> {
  try {
    const memberState = await client.getRoomStateEvent(roomId, "m.room.member", userId);
    if (memberState?.displayname) {
      return memberState.displayname;
    }
  } catch {
    // Fall through to default
  }

  // Default to local part of user ID
  return userId.split(":")[0]?.replace(/^@/, "") ?? userId;
}
