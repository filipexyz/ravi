/**
 * WhatsApp `ChannelMessageSender` over the typed WhatsApp client (runner RPC).
 *
 * Retry policy (DESIGN-v2 addendum R2; deliberately stricter than the legacy bridge sender):
 * - Non-idempotent sends (`send` text, `sendMedia`, `sendSticker`) never retry an
 *   ambiguous outcome: a 504 `WHATSAPP_RPC_TIMEOUT` or a 502 (transport error or
 *   invalid response) may mean the message went out. They retry (3 attempts, 1s/2s,
 *   at least the runner's `retryAfterMs`) only when the request certainly did not
 *   send: 503 `WHATSAPP_RUNNER_UNAVAILABLE` (no responders / no NATS connection),
 *   503 `NOT_CONNECTED` and 429 `RATE_LIMITED`.
 * - Idempotent operations (`sendReaction`, `editMessage`, `deleteMessage`) also retry
 *   any 5xx (including 504/502) and network `TypeError`s.
 * - `sendTyping` and `markRead` are best-effort and never throw.
 */

import { resolve } from "node:path";
import { logger } from "../../utils/logger.js";
import { isRetryableTransportError } from "../outbound/errors.js";
import { type TransportRetryOptions, withTransportRetry } from "../outbound/retry.js";
import type {
  ChannelMediaType,
  ChannelMessageSender,
  ChannelReactionTarget,
  ChannelSendOptions,
  ChannelSendResult,
} from "../outbound/sender.js";
import type { WhatsAppClient } from "./client.js";
import { WHATSAPP_RPC_ERROR_CODES } from "./contract.js";
import { isWhatsAppRpcError } from "./errors.js";

const log = logger.child("channels:whatsapp:sender");

/** Typing indicator duration; the runner auto-pauses after it. */
const TYPING_DURATION_MS = 30_000;

/**
 * NATS client codes behind a 503 WHATSAPP_RUNNER_UNAVAILABLE that may hide a request
 * that was already published (the connection dropped mid-request).
 */
const AMBIGUOUS_RUNNER_UNAVAILABLE_DETAILS = new Set(["DISCONNECT"]);

/** "group:<id>" → "<id>@g.us"; anything else unchanged (same as the gateway's normalizeOutboundJid). */
export function toWhatsAppJid(chatId: string): string {
  if (chatId.startsWith("group:")) return `${chatId.slice("group:".length)}@g.us`;
  return chatId;
}

/** The runner certainly did not send: nobody answered, the socket is down, or it was rate-limited. */
export function isWhatsAppSendNotAttempted(err: unknown): boolean {
  if (!isWhatsAppRpcError(err)) return false;
  switch (err.code) {
    case WHATSAPP_RPC_ERROR_CODES.runnerUnavailable:
      return !(typeof err.details === "string" && AMBIGUOUS_RUNNER_UNAVAILABLE_DETAILS.has(err.details));
    case WHATSAPP_RPC_ERROR_CODES.notConnected:
    case WHATSAPP_RPC_ERROR_CODES.rateLimited:
      return true;
    default:
      return false;
  }
}

/** Retry policy for non-idempotent sends (text, media, sticker). */
export function isRetryableWhatsAppSend(err: unknown): boolean {
  return isWhatsAppSendNotAttempted(err);
}

/** Retry policy for idempotent operations (reaction, edit, delete). */
export function isRetryableWhatsAppIdempotentOp(err: unknown): boolean {
  return isWhatsAppSendNotAttempted(err) || isRetryableTransportError(err);
}

export interface CreateWhatsAppSenderOptions {
  /** Shared retry settings (attempts, delays, sleep seam, log). `isRetryable` is chosen per operation. */
  retry?: TransportRetryOptions;
}

export function createWhatsAppSender(
  client: WhatsAppClient,
  options: CreateWhatsAppSenderOptions = {},
): ChannelMessageSender {
  const retryBase: TransportRetryOptions = { ...options.retry };
  delete retryBase.isRetryable;

  function sendRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    return withTransportRetry(operation, context, { ...retryBase, isRetryable: isRetryableWhatsAppSend });
  }

  function idempotentRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    return withTransportRetry(operation, context, { ...retryBase, isRetryable: isRetryableWhatsAppIdempotentOp });
  }

  return {
    async send(instanceId: string, to: string, text: string, sendOptions: ChannelSendOptions = {}) {
      try {
        const result = await sendRetry(
          () =>
            client.messages.sendText(instanceId, {
              to: toWhatsAppJid(to),
              text,
              ...(sendOptions.threadId ? { threadId: sendOptions.threadId } : {}),
              ...(sendOptions.mentions?.length ? { mentions: sendOptions.mentions } : {}),
            }),
          `send(${instanceId})`,
        );
        return { messageId: result.messageId };
      } catch (err) {
        log.error("Failed to send message", { instanceId, to, error: err });
        throw err;
      }
    },

    async sendTyping(instanceId: string, to: string, active = true) {
      try {
        await client.presence.set(instanceId, {
          to: toWhatsAppJid(to),
          state: active ? "typing" : "paused",
          durationMs: active ? TYPING_DURATION_MS : 0,
        });
      } catch (err) {
        // Typing indicators are best-effort — don't throw
        log.debug("Failed to send typing indicator", { instanceId, to, active, error: err });
      }
    },

    async sendReaction(
      instanceId: string,
      to: string,
      messageId: string,
      emoji: string,
      target?: ChannelReactionTarget,
    ) {
      const params = {
        to: toWhatsAppJid(to),
        messageId,
        emoji,
        ...(target?.participant ? { participant: target.participant } : {}),
        ...(target?.fromMe !== undefined ? { fromMe: target.fromMe } : {}),
      };
      try {
        await idempotentRetry(() => client.messages.react(instanceId, params), `sendReaction(${instanceId})`);
      } catch (err) {
        log.error("Failed to send reaction", { instanceId, to, messageId, emoji, error: err });
        throw err;
      }
    },

    async deleteMessage(instanceId: string, chatId: string, messageId: string) {
      try {
        await idempotentRetry(
          () => client.messages.delete(instanceId, { chatId: toWhatsAppJid(chatId), messageId }),
          `deleteMessage(${instanceId})`,
        );
      } catch (err) {
        log.error("Failed to delete message", { instanceId, to: chatId, messageId, error: err });
        throw err;
      }
    },

    async editMessage(instanceId: string, chatId: string, messageId: string, text: string) {
      try {
        await idempotentRetry(
          () => client.messages.edit(instanceId, { chatId: toWhatsAppJid(chatId), messageId, text }),
          `editMessage(${instanceId})`,
        );
      } catch (err) {
        log.error("Failed to edit message", { instanceId, to: chatId, messageId, error: err });
        throw err;
      }
    },

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
        // The runner reads the file from disk (same host); relative paths resolve against this cwd.
        const filePath = resolve(localPath);
        const result = await sendRetry(
          () =>
            client.messages.sendMedia(instanceId, {
              to: toWhatsAppJid(to),
              type,
              filePath,
              filename,
              ...(caption !== undefined ? { caption } : {}),
              ...(voiceNote ? { voiceNote: true } : {}),
            }),
          `sendMedia(${instanceId})`,
        );
        return { messageId: result.messageId };
      } catch (err) {
        log.error("Failed to send media", { instanceId, to, localPath, type, error: err });
        throw err;
      }
    },

    async sendSticker(instanceId: string, to: string, localPath: string): Promise<ChannelSendResult> {
      try {
        const filePath = resolve(localPath);
        const result = await sendRetry(
          () => client.messages.sendSticker(instanceId, { to: toWhatsAppJid(to), filePath }),
          `sendSticker(${instanceId})`,
        );
        return { messageId: result.messageId };
      } catch (err) {
        log.error("Failed to send sticker", { instanceId, to, localPath, error: err });
        throw err;
      }
    },

    async markRead(instanceId: string, chatId: string, messageIds: string[]) {
      try {
        await client.messages.markRead(instanceId, { chatId: toWhatsAppJid(chatId), messageIds });
      } catch (err) {
        // Best-effort — don't throw
        log.debug("Failed to mark messages as read", { instanceId, chatId, error: err });
      }
    },
  };
}
