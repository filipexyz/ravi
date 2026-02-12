/**
 * WhatsApp Inbound Message Handler
 *
 * Processes incoming WhatsApp messages and normalizes them.
 */

import type { WAMessage, proto } from "@whiskeysockets/baileys";
import type { WhatsAppInbound, InboundMedia, QuotedMessage } from "../types.js";
import type { AccountConfig } from "./config.js";
import {
  normalizePhone,
  isGroup,
  isLid,
  isBroadcast,
} from "./normalize.js";
import { logger } from "../../utils/logger.js";
import { getContactName } from "../../contacts.js";

const log = logger.child("wa:inbound");

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract text content from a WhatsApp message
 */
export function extractText(message: WAMessage): string | undefined {
  const m = message.message;
  if (!m) return undefined;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    undefined
  );
}

/**
 * Extract mentioned JIDs from a WhatsApp message
 */
export function extractMentions(message: WAMessage): string[] {
  const m = message.message;
  if (!m) return [];

  return m.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
}

/**
 * Check if a specific JID is mentioned in the message
 */
export function isMentioned(message: WAMessage, botJid: string): boolean {
  const mentions = extractMentions(message);
  // Compare without the resource part (everything after @)
  const botUser = botJid.split("@")[0];
  return mentions.some((jid) => jid.split("@")[0] === botUser);
}

/**
 * Resolve @LID mentions in text to @Name using contacts DB.
 *
 * WhatsApp sends mentions as @LID_NUMBER in text (e.g. @119546774069478).
 * This replaces them with @ContactName for readability.
 * Returns the resolved text and array of mentioned names.
 */
export function resolveMentionsInbound(text: string, mentionedJids: string[]): { text: string; mentions: string[] } {
  if (!mentionedJids.length || !text) return { text, mentions: [] };

  const mentions: string[] = [];
  let resolved = text;

  for (const jid of mentionedJids) {
    const userPart = jid.split("@")[0]; // e.g. "119546774069478" or "5511999999999"
    const normalizedId = normalizePhone(jid); // e.g. "lid:119546774069478" or "5511999999999"
    const name = getContactName(normalizedId);

    if (name) {
      mentions.push(name);
      // Replace @LID_NUMBER with @Name in text
      resolved = resolved.replace(new RegExp(`@${userPart}\\b`, "g"), `@${name}`);
    } else {
      // No name found — keep as-is but still track
      mentions.push(normalizedId);
    }
  }

  return { text: resolved, mentions };
}

/**
 * Extract media info from a WhatsApp message
 */
export function extractMedia(message: WAMessage): InboundMedia | undefined {
  const m = message.message;
  if (!m) return undefined;

  // Image
  if (m.imageMessage) {
    return {
      type: "image",
      mimetype: m.imageMessage.mimetype ?? "image/jpeg",
      caption: m.imageMessage.caption ?? undefined,
      sizeBytes: Number(m.imageMessage.fileLength) || undefined,
    };
  }

  // Video
  if (m.videoMessage) {
    return {
      type: "video",
      mimetype: m.videoMessage.mimetype ?? "video/mp4",
      caption: m.videoMessage.caption ?? undefined,
      sizeBytes: Number(m.videoMessage.fileLength) || undefined,
    };
  }

  // Audio
  if (m.audioMessage) {
    return {
      type: "audio",
      mimetype: m.audioMessage.mimetype ?? "audio/ogg",
      sizeBytes: Number(m.audioMessage.fileLength) || undefined,
    };
  }

  // Document
  if (m.documentMessage) {
    return {
      type: "document",
      mimetype: m.documentMessage.mimetype ?? "application/octet-stream",
      filename: m.documentMessage.fileName ?? undefined,
      caption: m.documentMessage.caption ?? undefined,
      sizeBytes: Number(m.documentMessage.fileLength) || undefined,
    };
  }

  // Sticker
  if (m.stickerMessage) {
    return {
      type: "sticker",
      mimetype: m.stickerMessage.mimetype ?? "image/webp",
      sizeBytes: Number(m.stickerMessage.fileLength) || undefined,
    };
  }

  return undefined;
}

/**
 * Detect media type from a quoted message
 */
function detectQuotedMediaType(
  quoted: proto.IMessage | null | undefined
): QuotedMessage["mediaType"] | undefined {
  if (!quoted) return undefined;
  if (quoted.imageMessage) return "image";
  if (quoted.videoMessage) return "video";
  if (quoted.audioMessage) return "audio";
  if (quoted.documentMessage) return "document";
  if (quoted.stickerMessage) return "sticker";
  return undefined;
}

/**
 * Extract quoted message info if this is a reply
 */
export function extractQuotedMessage(message: WAMessage): QuotedMessage | undefined {
  const contextInfo =
    message.message?.extendedTextMessage?.contextInfo ??
    message.message?.imageMessage?.contextInfo ??
    message.message?.videoMessage?.contextInfo ??
    message.message?.documentMessage?.contextInfo ??
    message.message?.audioMessage?.contextInfo ??
    message.message?.stickerMessage?.contextInfo;

  if (!contextInfo?.stanzaId) return undefined;

  const quoted = contextInfo.quotedMessage;

  // Extract text from quoted message
  const text =
    quoted?.conversation ??
    quoted?.extendedTextMessage?.text ??
    quoted?.imageMessage?.caption ??
    quoted?.videoMessage?.caption ??
    quoted?.documentMessage?.caption ??
    undefined;

  return {
    id: contextInfo.stanzaId,
    senderId: contextInfo.participant ?? "",
    text,
    mediaType: detectQuotedMediaType(quoted),
  };
}

// ============================================================================
// Media Download
// ============================================================================

/**
 * Download media from a WhatsApp message
 */
export async function downloadMedia(
  message: WAMessage
): Promise<Buffer | undefined> {
  try {
    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
    const buffer = await downloadMediaMessage(message, "buffer", {});
    return buffer as Buffer;
  } catch (err) {
    log.warn("Failed to download media", { error: err });
    return undefined;
  }
}

// ============================================================================
// Message Normalization
// ============================================================================

/**
 * Normalize a WhatsApp message to common format
 */
export function normalizeMessage(
  accountId: string,
  message: WAMessage,
  groupName?: string,
  groupMembers?: string[]
): WhatsAppInbound | null {
  const jid = message.key.remoteJid;
  if (!jid) {
    log.warn("Message has no remoteJid");
    return null;
  }

  // Skip broadcast messages
  if (isBroadcast(jid)) {
    log.debug("Skipping broadcast message");
    return null;
  }

  const messageId = message.key.id;
  if (!messageId) {
    log.warn("Message has no ID");
    return null;
  }

  const isGroupChat = isGroup(jid);
  const isLidJid = isLid(jid);

  // Get sender for groups (participant) or DMs (remoteJid)
  const senderJid = isGroupChat
    ? message.key.participant ?? jid
    : jid;

  const senderId = normalizePhone(senderJid);
  const chatId = normalizePhone(jid);
  const rawText = extractText(message);
  const media = extractMedia(message);
  const replyTo = extractQuotedMessage(message);

  // Resolve @LID mentions in text to @Name
  const mentionedJids = extractMentions(message);
  const { text: resolvedText, mentions } = resolveMentionsInbound(rawText ?? "", mentionedJids);
  const text = rawText ? resolvedText : undefined;

  // Extract phone number from sender JID (format: 5511999999999@s.whatsapp.net)
  const senderPhone = senderJid.split("@")[0].replace(/^lid:/, "");

  return {
    id: messageId,
    channelId: "whatsapp",
    accountId,
    senderId,
    senderName: message.pushName ?? undefined,
    senderPhone: isLidJid ? undefined : senderPhone,
    chatId,
    text,
    media,
    replyTo,
    mentions: mentions.length > 0 ? mentions : undefined,
    timestamp: (message.messageTimestamp as number) * 1000 || Date.now(),
    isGroup: isGroupChat,
    groupName: isGroupChat ? groupName : undefined,
    groupMembers: isGroupChat ? groupMembers : undefined,
    raw: message,
    jid,
    isLid: isLidJid,
  };
}

// ============================================================================
// Message Filtering
// ============================================================================

/** Filter result */
export interface FilterResult {
  pass: boolean;
  reason?: string;
}

/**
 * Check if message should be processed based on config
 */
export function shouldProcess(
  message: WAMessage,
  _config: AccountConfig
): FilterResult {
  // Skip own messages
  if (message.key.fromMe) {
    return { pass: false, reason: "own_message" };
  }

  const jid = message.key.remoteJid;
  if (!jid) {
    return { pass: false, reason: "no_jid" };
  }

  // Skip broadcast
  if (isBroadcast(jid)) {
    return { pass: false, reason: "broadcast" };
  }

  // Group policy is checked in securityAdapter.checkAccess

  // Has some content
  const hasText = !!extractText(message);
  const hasMedia = !!extractMedia(message);

  if (!hasText && !hasMedia) {
    return { pass: false, reason: "no_content" };
  }

  return { pass: true };
}

// ============================================================================
// Debouncing
// ============================================================================

interface DebounceEntry {
  timer: NodeJS.Timeout;
  messages: WhatsAppInbound[];
  resolve: (messages: WhatsAppInbound[]) => void;
}

const debounceMap = new Map<string, DebounceEntry>();

/**
 * Debounce messages from the same sender
 *
 * Collects rapid messages and returns them as a batch.
 */
export function debounceMessage(
  message: WhatsAppInbound,
  debounceMs: number
): Promise<WhatsAppInbound[]> {
  const key = `${message.accountId}:${message.chatId}`;

  return new Promise((resolve) => {
    const existing = debounceMap.get(key);

    if (existing) {
      // Add to existing batch
      existing.messages.push(message);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        debounceMap.delete(key);
        existing.resolve(existing.messages);
      }, debounceMs);
    } else {
      // Start new batch
      const entry: DebounceEntry = {
        messages: [message],
        resolve,
        timer: setTimeout(() => {
          debounceMap.delete(key);
          resolve(entry.messages);
        }, debounceMs),
      };
      debounceMap.set(key, entry);
    }
  });
}

/**
 * Merge multiple messages into one
 */
export function mergeMessages(messages: WhatsAppInbound[]): WhatsAppInbound {
  if (messages.length === 1) {
    return messages[0];
  }

  // Use the last message as base
  const base = messages[messages.length - 1];

  // Combine all text
  const texts = messages
    .map((m) => m.text)
    .filter((t): t is string => !!t);

  return {
    ...base,
    text: texts.join("\n"),
  };
}
