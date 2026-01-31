/**
 * Matrix Outbound Message Sending
 *
 * Send messages, typing indicators, read receipts, and reactions to Matrix rooms.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { OutboundOptions, SendResult } from "../types.js";
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixTextContent,
  type MatrixRelation,
  type MatrixReplyRelation,
  type MatrixThreadRelation,
  type ReactionEventContent,
  type MatrixDirectAccountData,
} from "./types.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("matrix:outbound");

const MATRIX_TEXT_LIMIT = 4000;

// ============================================================================
// Target Resolution
// ============================================================================

const directRoomCache = new Map<string, string>();

/**
 * Normalize a target string to room ID
 */
function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required");
  }
  return trimmed;
}

/**
 * Resolve a direct message room for a user
 */
async function resolveDirectRoomId(
  client: MatrixClient,
  userId: string
): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }

  // Check cache
  const cached = directRoomCache.get(trimmed);
  if (cached) return cached;

  // 1. Check m.direct account data
  try {
    const directContent = (await client.getAccountData(
      EventType.Direct
    )) as MatrixDirectAccountData | null;

    const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
    if (list.length > 0) {
      directRoomCache.set(trimmed, list[0]);
      return list[0];
    }
  } catch {
    // Ignore and fall back
  }

  // 2. Look for existing 1:1 room
  let fallbackRoom: string | null = null;
  try {
    const rooms = await client.getJoinedRooms();
    for (const roomId of rooms) {
      let members: string[];
      try {
        members = await client.getJoinedRoomMembers(roomId);
      } catch {
        continue;
      }
      if (!members.includes(trimmed)) continue;

      // Prefer classic 1:1 rooms
      if (members.length === 2) {
        directRoomCache.set(trimmed, roomId);
        await persistDirectRoom(client, trimmed, roomId);
        return roomId;
      }
      if (!fallbackRoom) {
        fallbackRoom = roomId;
      }
    }
  } catch {
    // Ignore
  }

  if (fallbackRoom) {
    directRoomCache.set(trimmed, fallbackRoom);
    await persistDirectRoom(client, trimmed, fallbackRoom);
    return fallbackRoom;
  }

  throw new Error(`No direct room found for ${trimmed}`);
}

/**
 * Persist direct room to m.direct account data
 */
async function persistDirectRoom(
  client: MatrixClient,
  userId: string,
  roomId: string
): Promise<void> {
  let directContent: MatrixDirectAccountData | null = null;
  try {
    directContent = (await client.getAccountData(
      EventType.Direct
    )) as MatrixDirectAccountData | null;
  } catch {
    // Fall back to empty
  }

  const existing = directContent && !Array.isArray(directContent) ? directContent : {};
  const current = Array.isArray(existing[userId]) ? existing[userId] : [];
  if (current[0] === roomId) return;

  const next = [roomId, ...current.filter((id) => id !== roomId)];
  try {
    await client.setAccountData(EventType.Direct, {
      ...existing,
      [userId]: next,
    });
  } catch {
    // Ignore persistence errors
  }
}

/**
 * Resolve a target to a Matrix room ID
 */
export async function resolveRoomId(
  client: MatrixClient,
  target: string
): Promise<string> {
  const raw = normalizeTarget(target);
  const lowered = raw.toLowerCase();

  // Strip prefixes
  if (lowered.startsWith("matrix:")) {
    return resolveRoomId(client, raw.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return resolveRoomId(client, raw.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return resolveRoomId(client, raw.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return resolveDirectRoomId(client, raw.slice("user:".length));
  }

  // Direct user ID
  if (raw.startsWith("@")) {
    return resolveDirectRoomId(client, raw);
  }

  // Room alias
  if (raw.startsWith("#")) {
    const resolved = await client.resolveRoom(raw);
    if (!resolved) {
      throw new Error(`Matrix alias ${raw} could not be resolved`);
    }
    return resolved;
  }

  // Assume it's a room ID
  return raw;
}

// ============================================================================
// Content Building
// ============================================================================

/**
 * Build text message content
 */
function buildTextContent(
  body: string,
  relation?: MatrixRelation
): MatrixTextContent {
  const content: MatrixTextContent = {
    msgtype: MsgType.Text as "m.text",
    body,
  };

  if (relation) {
    content["m.relates_to"] = relation;
  }

  // Convert markdown to HTML (simple implementation)
  const formatted = markdownToHtml(body);
  if (formatted !== body) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = formatted;
  }

  return content;
}

/**
 * Build reply relation
 */
function buildReplyRelation(replyToId?: string): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) return undefined;
  return { "m.in_reply_to": { event_id: trimmed } };
}

/**
 * Build thread relation
 */
function buildThreadRelation(
  threadId: string,
  replyToId?: string
): MatrixThreadRelation {
  const trimmed = threadId.trim();
  return {
    rel_type: RelationType.Thread as "m.thread",
    event_id: trimmed,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToId?.trim() || trimmed },
  };
}

/**
 * Simple markdown to HTML conversion
 */
function markdownToHtml(text: string): string {
  // Basic markdown conversions for Matrix
  let html = text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Code
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // Links
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    // Line breaks
    .replace(/\n/g, "<br>");

  return html;
}

/**
 * Chunk text for Matrix's message size limits
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = limit;
    const lastNewline = remaining.lastIndexOf("\n", limit);
    const lastSpace = remaining.lastIndexOf(" ", limit);

    if (lastNewline > limit * 0.7) {
      breakPoint = lastNewline + 1;
    } else if (lastSpace > limit * 0.7) {
      breakPoint = lastSpace + 1;
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

// ============================================================================
// Message Sending
// ============================================================================

/**
 * Send a message to a Matrix room
 */
export async function sendMessage(
  client: MatrixClient,
  targetId: string,
  options: OutboundOptions
): Promise<SendResult> {
  const text = options.text?.trim() ?? "";

  if (!text && !options.media) {
    return { success: false, error: "Message requires text or media" };
  }

  try {
    const roomId = await resolveRoomId(client, targetId);

    // Build relation (thread or reply)
    let relation: MatrixRelation | undefined;
    if (options.replyTo) {
      // Check if this is a thread reply (threadId:eventId format)
      if (options.replyTo.includes(":") && options.replyTo.startsWith("$")) {
        const [threadId, replyToId] = options.replyTo.split(":");
        relation = buildThreadRelation(threadId, replyToId || threadId);
      } else {
        relation = buildReplyRelation(options.replyTo);
      }
    }

    let lastMessageId = "";

    if (options.media) {
      // Upload and send media
      const mediaBuffer =
        typeof options.media.data === "string"
          ? Buffer.from(options.media.data, "base64")
          : options.media.data;

      const uploaded = await client.uploadContent(mediaBuffer, options.media.mimetype);

      // Determine message type
      let msgtype: string;
      if (options.media.mimetype.startsWith("image/")) {
        msgtype = MsgType.Image;
      } else if (options.media.mimetype.startsWith("audio/")) {
        msgtype = MsgType.Audio;
      } else if (options.media.mimetype.startsWith("video/")) {
        msgtype = MsgType.Video;
      } else {
        msgtype = MsgType.File;
      }

      const mediaContent = {
        msgtype,
        body: options.media.filename || "file",
        url: uploaded,
        info: {
          mimetype: options.media.mimetype,
          size: mediaBuffer.length,
        },
        ...(relation ? { "m.relates_to": relation } : {}),
      };

      const eventId = await client.sendMessage(roomId, mediaContent);
      lastMessageId = eventId;

      // Send caption as separate text if provided
      if (text) {
        const textContent = buildTextContent(text, relation);
        const textEventId = await client.sendMessage(roomId, textContent);
        lastMessageId = textEventId;
      }
    } else {
      // Send text message(s)
      const chunks = chunkText(text, MATRIX_TEXT_LIMIT);

      for (const chunk of chunks) {
        const content = buildTextContent(chunk, relation);
        const eventId = await client.sendMessage(roomId, content);
        lastMessageId = eventId;
        // Only apply relation to first message
        relation = undefined;
      }
    }

    return {
      success: true,
      messageId: lastMessageId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Send message failed: ${error}`);
    return {
      success: false,
      error,
    };
  }
}

// ============================================================================
// Typing Indicator
// ============================================================================

/**
 * Send typing indicator
 */
export async function sendTyping(
  client: MatrixClient,
  roomId: string,
  typing: boolean,
  timeoutMs: number = 30000
): Promise<void> {
  try {
    await client.setTyping(roomId, typing, timeoutMs);
  } catch (err) {
    log.debug(`Typing indicator failed: ${err}`);
  }
}

// ============================================================================
// Read Receipt
// ============================================================================

/**
 * Send read receipt
 */
export async function sendReadReceipt(
  client: MatrixClient,
  roomId: string,
  eventId: string
): Promise<void> {
  if (!eventId?.trim()) return;

  try {
    await client.sendReadReceipt(roomId, eventId.trim());
  } catch (err) {
    log.debug(`Read receipt failed: ${err}`);
  }
}

// ============================================================================
// Reaction
// ============================================================================

/**
 * Send reaction to a message
 */
export async function sendReaction(
  client: MatrixClient,
  roomId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  if (!emoji?.trim()) {
    throw new Error("Reaction requires an emoji");
  }

  try {
    const reaction: ReactionEventContent = {
      "m.relates_to": {
        rel_type: RelationType.Annotation as "m.annotation",
        event_id: messageId,
        key: emoji.trim(),
      },
    };

    await client.sendEvent(roomId, EventType.Reaction, reaction);
  } catch (err) {
    log.debug(`Reaction failed: ${err}`);
    throw err;
  }
}
