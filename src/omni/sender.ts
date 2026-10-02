/**
 * Omni Sender (legacy bridge, Telegram/Discord only)
 *
 * Sends messages, typing indicators, reactions, and media through the Omni REST API.
 * WhatsApp never goes through here: the per-instance router
 * (src/channels/outbound/router.ts) sends it through ravi's own runner.
 *
 * Retry: `send`, `sendReaction`, `deleteMessage` and `editMessage` retry network errors and
 * 5xx (3 attempts, 1s/2s); `sendMedia`/`sendSticker` do not retry; `sendTyping`/`markRead`
 * never throw. Media is always sent as base64 plus the absolute `filePath`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type TransportRetryOptions, withTransportRetry } from "../channels/outbound/retry.js";
import type {
  ChannelMediaType,
  ChannelMessageSender,
  ChannelSendOptions,
  ChannelSendResult,
} from "../channels/outbound/sender.js";
import { logger } from "../utils/logger.js";
import { createOmniClient, type OmniClient } from "./client.js";

const log = logger.child("omni:sender");

export interface OmniSenderOptions {
  /** Retry settings (attempts, delays, sleep seam). The default policy retries TypeError and 5xx. */
  retry?: TransportRetryOptions;
}

export class OmniSender implements ChannelMessageSender {
  private client: OmniClient;
  private retry: TransportRetryOptions;

  /** Omni REST sender. */
  constructor(apiUrl: string, apiKey: string, options: OmniSenderOptions = {}) {
    this.client = createOmniClient({ baseUrl: apiUrl, apiKey });
    this.retry = { ...options.retry };
  }

  private withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    return withTransportRetry(operation, context, this.retry);
  }

  /** Absolute path (relative paths resolve against the daemon cwd) plus the file as base64. */
  private mediaSource(localPath: string): { filePath: string; base64: string } {
    const filePath = resolve(localPath);
    return { filePath, base64: readFileSync(filePath).toString("base64") };
  }

  /**
   * Send a text message via Omni.
   */
  async send(
    instanceId: string,
    to: string,
    text: string,
    options: ChannelSendOptions = {},
  ): Promise<ChannelSendResult> {
    try {
      const result = (await this.withRetry(
        () =>
          this.client.messages.send({
            instanceId,
            to,
            text,
            ...(options.threadId ? { threadId: options.threadId } : {}),
            ...(options.mentions?.length ? { mentions: options.mentions } : {}),
          }),
        `send(${instanceId})`,
      )) as { messageId?: string };
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send message", { instanceId, to, error: err });
      throw err;
    }
  }

  /**
   * Send a typing presence indicator.
   * @param active - true = start typing, false = stop (paused)
   */
  async sendTyping(instanceId: string, to: string, active = true): Promise<void> {
    try {
      await this.client.messages.sendPresence({
        instanceId,
        to,
        type: active ? "typing" : "paused",
        duration: active ? 30_000 : 0,
      });
    } catch (err) {
      // Typing indicators are best-effort — don't throw
      log.debug("Failed to send typing indicator", { instanceId, to, active, error: err });
    }
  }

  /**
   * Send an emoji reaction to a message.
   */
  async sendReaction(instanceId: string, to: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.sendReaction({ instanceId, to, messageId, emoji }),
        `sendReaction(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to send reaction", { instanceId, to, messageId, emoji, error: err });
      throw err;
    }
  }

  /**
   * Delete a channel message sent by the current instance.
   */
  async deleteMessage(instanceId: string, chatId: string, messageId: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.deleteChannel({ instanceId, channelId: chatId, messageId }),
        `deleteMessage(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to delete message", { instanceId, to: chatId, messageId, error: err });
      throw err;
    }
  }

  /**
   * Edit a channel message sent by the current instance.
   */
  async editMessage(instanceId: string, chatId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.client.messages.editChannel({ instanceId, channelId: chatId, messageId, text }),
        `editMessage(${instanceId})`,
      );
    } catch (err) {
      log.error("Failed to edit message", { instanceId, to: chatId, messageId, error: err });
      throw err;
    }
  }

  /**
   * Send a media file (image, video, document, audio) as base64 plus the absolute `filePath`.
   * Not retried.
   */
  async sendMedia(
    instanceId: string,
    to: string,
    localPath: string,
    type: ChannelMediaType,
    filename: string,
    caption?: string,
    voiceNote?: boolean,
  ): Promise<ChannelSendResult> {
    try {
      const result = await this.client.messages.sendMedia({
        instanceId,
        to,
        type,
        ...this.mediaSource(localPath),
        filename,
        caption,
        ...(voiceNote ? { voiceNote: true } : {}),
      });
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send media", { instanceId, to, localPath, type, error: err });
      throw err;
    }
  }

  /**
   * Send a sticker.
   *
   * Omni exposes stickers as a dedicated contract instead of generic media.
   * Using /messages/send/media with type=sticker returns 400. Not retried.
   */
  async sendSticker(instanceId: string, to: string, localPath: string): Promise<ChannelSendResult> {
    try {
      const result = await this.client.messages.sendSticker({
        instanceId,
        to,
        ...this.mediaSource(localPath),
      });
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send sticker", { instanceId, to, localPath, error: err });
      throw err;
    }
  }

  /**
   * Mark messages as read in a chat.
   */
  async markRead(instanceId: string, chatId: string, messageIds: string[]): Promise<void> {
    try {
      await this.client.messages.batchMarkRead({
        instanceId,
        chatId,
        messageIds,
      });
    } catch (err) {
      // Best-effort — don't throw
      log.debug("Failed to mark messages as read", { instanceId, chatId, error: err });
    }
  }
}
