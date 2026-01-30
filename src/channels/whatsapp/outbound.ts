/**
 * WhatsApp Outbound Message Handler
 *
 * Handles sending messages, reactions, and typing indicators.
 */

import type { WASocket, AnyMessageContent } from "@whiskeysockets/baileys";
import type { SendResult, OutboundOptions, OutboundMedia } from "../types.js";
import type { AckReactionConfig } from "./config.js";
import { phoneToJid } from "./normalize.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("wa:outbound");

// ============================================================================
// Message Sending
// ============================================================================

/**
 * Send a message via WhatsApp
 */
export async function sendMessage(
  socket: WASocket,
  targetId: string,
  options: OutboundOptions
): Promise<SendResult> {
  const jid = phoneToJid(targetId);
  if (!jid) {
    return {
      success: false,
      error: `Invalid target: ${targetId}`,
    };
  }

  try {
    let content: AnyMessageContent;

    if (options.media) {
      content = buildMediaContent(options.media, options.text);
    } else if (options.text) {
      content = { text: options.text };
    } else if (options.reaction) {
      // Handle reaction separately
      return await sendReaction(socket, targetId, options.replyTo ?? "", options.reaction);
    } else {
      return {
        success: false,
        error: "No content to send",
      };
    }

    // Add reply context if specified
    if (options.replyTo && "text" in content) {
      content = {
        ...content,
        // Note: Baileys handles quoted messages internally
      };
    }

    const result = await socket.sendMessage(jid, content);

    log.debug("Message sent", { jid, messageId: result?.key?.id });

    return {
      success: true,
      messageId: result?.key?.id ?? undefined,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    log.error("Failed to send message", { jid, error });
    return {
      success: false,
      error,
    };
  }
}

/**
 * Build media content for sending
 */
function buildMediaContent(
  media: OutboundMedia,
  caption?: string
): AnyMessageContent {
  const buffer = typeof media.data === "string"
    ? Buffer.from(media.data, "base64")
    : media.data;

  switch (media.type) {
    case "image":
      return {
        image: buffer,
        caption: caption ?? media.caption,
        mimetype: media.mimetype,
      };
    case "video":
      return {
        video: buffer,
        caption: caption ?? media.caption,
        mimetype: media.mimetype,
      };
    case "audio":
      return {
        audio: buffer,
        mimetype: media.mimetype,
        ptt: media.mimetype.includes("ogg"),
      };
    case "document":
      return {
        document: buffer,
        fileName: media.filename ?? "document",
        mimetype: media.mimetype,
        caption: caption ?? media.caption,
      };
    default:
      throw new Error(`Unsupported media type: ${media.type}`);
  }
}

// ============================================================================
// Typing Indicators
// ============================================================================

/**
 * Send typing indicator (composing/paused)
 */
export async function sendTyping(
  socket: WASocket,
  targetId: string,
  typing: boolean
): Promise<void> {
  const jid = phoneToJid(targetId);
  if (!jid) {
    log.warn("Cannot send typing - invalid target", { targetId });
    return;
  }

  try {
    await socket.sendPresenceUpdate(typing ? "composing" : "paused", jid);
    log.debug("Typing indicator sent", { jid, typing });
  } catch (err) {
    log.error("Failed to send typing indicator", err);
  }
}

// ============================================================================
// Read Receipts
// ============================================================================

/**
 * Send read receipt
 */
export async function sendReadReceipt(
  socket: WASocket,
  chatId: string,
  senderId: string,
  messageIds: string[]
): Promise<void> {
  const chatJid = phoneToJid(chatId);
  const senderJid = phoneToJid(senderId);

  if (!chatJid) {
    log.warn("Cannot send read receipt - invalid chat", { chatId });
    return;
  }

  try {
    await socket.readMessages([
      {
        remoteJid: chatJid,
        id: messageIds[0],
        participant: chatJid !== senderJid ? senderJid ?? undefined : undefined,
      },
    ]);
    log.debug("Read receipt sent", { chatJid, messageIds });
  } catch (err) {
    log.error("Failed to send read receipt", err);
  }
}

// ============================================================================
// Reactions
// ============================================================================

/**
 * Send a reaction to a message
 */
export async function sendReaction(
  socket: WASocket,
  chatId: string,
  messageId: string,
  emoji: string
): Promise<SendResult> {
  const jid = phoneToJid(chatId);
  if (!jid) {
    return {
      success: false,
      error: `Invalid chat: ${chatId}`,
    };
  }

  try {
    await socket.sendMessage(jid, {
      react: {
        text: emoji,
        key: {
          remoteJid: jid,
          id: messageId,
        },
      },
    });

    log.debug("Reaction sent", { jid, messageId, emoji });

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    log.error("Failed to send reaction", { jid, messageId, error });
    return {
      success: false,
      error,
    };
  }
}

/**
 * Send ACK reaction based on config
 */
export async function sendAckReaction(
  socket: WASocket,
  chatId: string,
  messageId: string,
  isGroup: boolean,
  isMention: boolean,
  config: AckReactionConfig | undefined
): Promise<void> {
  if (!config) return;

  // Check if we should send ACK for this message type
  if (isGroup) {
    if (config.group === "never") return;
    if (config.group === "mentions" && !isMention) return;
  } else {
    if (!config.direct) return;
  }

  await sendReaction(socket, chatId, messageId, config.emoji);
}
