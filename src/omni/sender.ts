/**
 * Omni Sender
 *
 * HTTP client for the omni REST API. Wraps @omni/sdk to send messages,
 * typing indicators, reactions, and media via omni-managed channel instances.
 */

import { createOmniClient, type OmniClient } from "@omni/sdk";
import { readFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

const log = logger.child("omni:sender");

const MAX_RETRIES = 3;

/**
 * Determine if an error is retryable (network/server errors, not client errors).
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch network error (ECONNREFUSED etc.)
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    return status >= 500; // Only retry 5xx, not 4xx
  }
  return false; // Don't retry unknown errors (could be application bugs)
}

export class OmniSender {
  private client: OmniClient;

  constructor(apiUrl: string, apiKey: string) {
    this.client = createOmniClient({ baseUrl: apiUrl, apiKey });
  }

  /**
   * Retry wrapper with exponential backoff.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const delayMs = attempt * 1000;
          log.warn(`${context} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms`, { error: err });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          break;
        }
      }
    }
    throw lastError;
  }

  /**
   * Send a text message via omni.
   */
  async send(instanceId: string, to: string, text: string, threadId?: string): Promise<{ messageId?: string }> {
    try {
      const result = await this.withRetry(
        () => this.client.messages.send({ instanceId, to, text, ...(threadId ? { threadId } : {}) }),
        `send(${instanceId})`
      ) as { messageId?: string };
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
        `sendReaction(${instanceId})`
      );
    } catch (err) {
      log.error("Failed to send reaction", { instanceId, to, messageId, emoji, error: err });
      throw err;
    }
  }

  /**
   * Send a media file (image, video, document, audio).
   * Reads the file as base64 and sends via omni.
   */
  async sendMedia(
    instanceId: string,
    to: string,
    localPath: string,
    type: "image" | "video" | "audio" | "document",
    filename: string,
    caption?: string
  ): Promise<{ messageId?: string }> {
    try {
      const data = readFileSync(localPath);
      const base64 = data.toString("base64");
      const result = await this.client.messages.sendMedia({
        instanceId,
        to,
        type,
        base64,
        filename,
        caption,
      });
      return { messageId: result.messageId };
    } catch (err) {
      log.error("Failed to send media", { instanceId, to, localPath, type, error: err });
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

  /**
   * Get the underlying omni client for advanced operations (CLI commands).
   */
  getClient(): OmniClient {
    return this.client;
  }
}
