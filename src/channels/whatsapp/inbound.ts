/**
 * WhatsApp Inbound Message Handler
 *
 * Processes incoming WhatsApp messages and normalizes them.
 */

import type { WAMessage, proto } from "@whiskeysockets/baileys";
import type { WhatsAppInbound, InboundMedia } from "../types.js";
import type { AccountConfig } from "./config.js";
import {
  normalizePhone,
  jidToSessionId,
  isGroup,
  isLid,
  isBroadcast,
} from "./normalize.js";
import { logger } from "../../utils/logger.js";

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
    };
  }

  // Video
  if (m.videoMessage) {
    return {
      type: "video",
      mimetype: m.videoMessage.mimetype ?? "video/mp4",
      caption: m.videoMessage.caption ?? undefined,
    };
  }

  // Audio
  if (m.audioMessage) {
    return {
      type: "audio",
      mimetype: m.audioMessage.mimetype ?? "audio/ogg",
    };
  }

  // Document
  if (m.documentMessage) {
    return {
      type: "document",
      mimetype: m.documentMessage.mimetype ?? "application/octet-stream",
      filename: m.documentMessage.fileName ?? undefined,
      caption: m.documentMessage.caption ?? undefined,
    };
  }

  // Sticker
  if (m.stickerMessage) {
    return {
      type: "sticker",
      mimetype: m.stickerMessage.mimetype ?? "image/webp",
    };
  }

  return undefined;
}

/**
 * Extract quoted message ID if this is a reply
 */
export function extractReplyTo(message: WAMessage): string | undefined {
  const contextInfo =
    message.message?.extendedTextMessage?.contextInfo ??
    message.message?.imageMessage?.contextInfo ??
    message.message?.videoMessage?.contextInfo ??
    message.message?.documentMessage?.contextInfo;

  return contextInfo?.stanzaId ?? undefined;
}

// ============================================================================
// Message Normalization
// ============================================================================

/**
 * Normalize a WhatsApp message to common format
 */
export function normalizeMessage(
  accountId: string,
  message: WAMessage
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
  const text = extractText(message);
  const media = extractMedia(message);
  const replyTo = extractReplyTo(message);

  return {
    id: messageId,
    channelId: "whatsapp",
    accountId,
    senderId,
    senderName: message.pushName ?? undefined,
    chatId,
    text,
    media,
    replyTo,
    timestamp: (message.messageTimestamp as number) * 1000 || Date.now(),
    isGroup: isGroupChat,
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
  config: AccountConfig
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

  // Check group policy
  if (isGroup(jid)) {
    if (config.groupPolicy === "closed") {
      return { pass: false, reason: "groups_disabled" };
    }

    if (config.groupPolicy === "allowlist") {
      const groupId = normalizePhone(jid);
      if (!config.groupAllowFrom.includes(groupId)) {
        return { pass: false, reason: "group_not_allowed" };
      }
    }
  }

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
