/**
 * Channel Gateway (omni-backed)
 *
 * Routes bot responses back to channel instances via OmniSender.
 * Inbound message handling is done by OmniConsumer.
 *
 * Subscriptions maintained here:
 *   ravi.session.*.response    → send via omni HTTP
 *   ravi.session.*.claude      → typing heartbeat
 *   ravi.outbound.deliver      → direct send (outbound module)
 *   ravi.outbound.reaction     → emoji reactions
 *   ravi.media.send            → media files
 *   ravi.config.changed        → reload router config + REBAC sync
 */

import { nats } from "./nats.js";
import { pendingReplyCallbacks } from "./bot.js";
import { configStore } from "./config-store.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage } from "./bot.js";
import {
  dbFindActiveEntryByPhone,
  dbUpdateEntry,
} from "./outbound/index.js";
import type { OmniSender } from "./omni/sender.js";
import type { OmniConsumer } from "./omni/consumer.js";

const log = logger.child("gateway");

/**
 * Normalize a chatId to a valid WhatsApp JID for the omni API.
 *
 * Handles ravi-internal formats:
 *   "group:120363407390920496"  → "120363407390920496@g.us"
 *   "120363407390920496@g.us"   → unchanged
 *   "178035101794451@lid"       → unchanged
 *   "5511999@s.whatsapp.net"    → unchanged
 */
function normalizeOutboundJid(chatId: string): string {
  if (chatId.startsWith("group:")) {
    return chatId.slice(6) + "@g.us";
  }
  return chatId;
}

/** Silent reply token — when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

export interface GatewayOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
  omniSender: OmniSender;
  omniConsumer: OmniConsumer;
}

export class Gateway {
  private running = false;
  private omniSender: OmniSender;
  private omniConsumer: OmniConsumer;
  private activeSubscriptions = new Set<string>();

  constructor(options: GatewayOptions) {
    this.omniSender = options.omniSender;
    this.omniConsumer = options.omniConsumer;
    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }
  }

  async start(): Promise<void> {
    log.info("Starting gateway...");
    this.running = true;

    this.subscribeToResponses();
    this.subscribeToClaudeEvents();
    this.subscribeToDirectSend();
    this.subscribeToReactions();
    this.subscribeToMediaSend();
    this.subscribeToConfigChanges();

    log.info("Gateway started");
  }

  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;
    log.info("Gateway stopped");
  }

  /**
   * Generic subscription helper with auto-reconnect.
   *
   * Pass queue to enable NATS queue group — only one daemon in the group processes each message.
   * Use this for any subscription where duplicate processing across daemons would cause side effects
   * (e.g. sending a message twice to the user).
   */
  private subscribe(
    key: string,
    topics: string[],
    handler: (event: { topic: string; data: unknown }) => Promise<void>,
    opts?: { queue?: string }
  ): void {
    if (this.activeSubscriptions.has(key)) {
      log.warn(`${key} subscription already active, skipping duplicate`);
      return;
    }
    this.activeSubscriptions.add(key);

    (async () => {
      try {
        for await (const event of nats.subscribe(...topics, ...(opts?.queue ? [{ queue: opts.queue }] : []) as [])) {
          if (!this.running) break;
          // Fire-and-forget: don't block the subscription loop on slow handlers
          // (e.g. omni sender timeouts shouldn't stall all other events)
          handler(event).catch((err) => {
            log.error(`${key} handler error`, { error: err });
          });
        }
      } catch (err) {
        if (this.running) {
          log.error(`${key} subscription error`, err);
        }
      } finally {
        this.activeSubscriptions.delete(key);
        if (this.running) {
          setTimeout(() => this.subscribe(key, topics, handler, opts), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to bot responses and send via omni.
   * Queue group: only one gateway daemon sends each response.
   */
  private subscribeToResponses(): void {
    this.subscribe("responses", ["ravi.session.*.response"], async (event) => {
      const sessionName = event.topic.split(".")[2];
      const response = event.data as unknown as ResponseMessage;

      const target = response.target;
      if (!target) return;

      const instanceId = configStore.resolveInstanceId(target.accountId);
      if (!instanceId) return;
      const chatId = normalizeOutboundJid(target.chatId);

      const text = response.error
        ? `Error: ${response.error}`
        : response.response;

      if (text && text.trim() === SILENT_TOKEN) {
        log.debug("Silent response, not sending to channel", { sessionName });
        return;
      }

      if (text) {
        if (!response._emitId) {
          log.warn("GHOST RESPONSE DROPPED", {
            sessionName, textPreview: text.slice(0, 200),
          });
          return;
        }

        const t0 = Date.now();
        log.info("Sending response", {
          sessionName, instanceId, chatId, textLen: text.length,
          emitId: response._emitId,
        });

        try {
          await this.omniSender.send(instanceId, chatId, text, target.threadId);
          log.info("Response delivered", { sessionName, durationMs: Date.now() - t0 });
        } catch (err) {
          log.error("Failed to send response", { instanceId, chatId, error: err });
        }
      }
    }, { queue: "ravi-gateway" });
  }

  /**
   * Subscribe to Claude SDK events for typing heartbeat.
   */
  private subscribeToClaudeEvents(): void {
    this.subscribe("claude", ["ravi.session.*.claude"], async (event) => {
      const sessionName = event.topic.split(".")[2];
      const data = event.data as { type?: string; _source?: { channel: string; accountId: string; chatId: string } };

      if (data.type === "result" || data.type === "silent") {
        // Prefer _source from event (works cross-daemon), fallback to local activeTargets
        const target = data._source ?? this.omniConsumer.getActiveTarget(sessionName);
        if (target) {
          const iid = configStore.resolveInstanceId(target.accountId);
          if (iid) await this.omniSender.sendTyping(iid, normalizeOutboundJid(target.chatId), false);
          this.omniConsumer.clearActiveTarget(sessionName);
        }
        return;
      }

      if (data.type === "system" || data.type === "assistant") {
        const target = this.omniConsumer.getActiveTarget(sessionName);
        if (target) {
          const iid = configStore.resolveInstanceId(target.accountId);
          if (iid) await this.omniSender.sendTyping(iid, normalizeOutboundJid(target.chatId), true);
        }
      }
    });
  }

  /**
   * Subscribe to direct send events from the outbound module.
   * Queue group: only one gateway daemon processes each deliver event.
   */
  private subscribeToDirectSend(): void {
    this.subscribe("directSend", ["ravi.outbound.deliver"], async (event) => {
      const data = event.data as {
        channel: string;
        accountId: string;
        to: string;
        text?: string;
        poll?: { name: string; values: string[]; selectableCount?: number };
        typingDelayMs?: number;
        pauseMs?: number;
        replyTopic?: string;
      };

      const instanceId = configStore.resolveInstanceId(data.accountId);
      if (!instanceId) {
        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId: undefined });
          else nats.emit(data.replyTopic, { success: false, error: "No instance for account" }).catch(() => {});
        }
        return;
      }
      const to = normalizeOutboundJid(data.to);

      try {
        let typingDelayMs = data.typingDelayMs ?? 0;
        let pauseMs = data.pauseMs ?? 0;

        // Auto sentinel humanization
        const isSentinelAuto = !data.typingDelayMs && !data.pauseMs;
        if (isSentinelAuto && data.text) {
          const routerConfig = configStore.getConfig();
          const mappedAgentId = routerConfig.accountAgents[data.accountId];
          const mappedAgent = mappedAgentId ? routerConfig.agents[mappedAgentId] : undefined;
          if (mappedAgent?.mode === "sentinel") {
            const len = data.text.length;
            pauseMs = 3000 + Math.min(len * 15, 2000) + Math.random() * 1000;
            typingDelayMs = Math.max(2000, Math.min(len * 50, 8000)) + Math.random() * 1500;
          }
        }

        if (pauseMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }

        let messageId: string | undefined;

        if (data.poll) {
          // Poll not supported via omni yet — send as text
          const pollText = `${data.poll.name}\n${data.poll.values.map((v, i) => `${i + 1}. ${v}`).join("\n")}`;
          if (typingDelayMs > 0) {
            await this.omniSender.sendTyping(instanceId, to, true);
            await new Promise((resolve) => setTimeout(resolve, typingDelayMs));
            const res = await this.omniSender.send(instanceId, to, pollText);
            messageId = res.messageId;
            await this.omniSender.sendTyping(instanceId, to, false);
          } else {
            const res = await this.omniSender.send(instanceId, to, pollText);
            messageId = res.messageId;
          }
        } else if (data.text) {
          const sendStart = Date.now();
          if (typingDelayMs > 0) {
            await this.omniSender.sendTyping(instanceId, to, true);
            await new Promise((resolve) => setTimeout(resolve, typingDelayMs));
            const res = await this.omniSender.send(instanceId, to, data.text);
            messageId = res.messageId;
            await this.omniSender.sendTyping(instanceId, to, false);
          } else {
            const res = await this.omniSender.send(instanceId, to, data.text);
            messageId = res.messageId;
          }
          log.info("Send HTTP completed", { to, durationMs: Date.now() - sendStart });
        }

        log.info("Direct send delivered", { to, instanceId, messageId });

        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId });
          else nats.emit(data.replyTopic, { success: true, messageId } as unknown as Record<string, unknown>).catch(() => {});
        }

        const entry = dbFindActiveEntryByPhone(to);
        if (entry?.id) {
          dbUpdateEntry(entry.id, { lastSentAt: Date.now() });
        }
      } catch (err) {
        log.error("Failed to deliver direct send", { to, instanceId, error: err });
        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId: undefined });
          else nats.emit(data.replyTopic, { success: false, error: String(err) }).catch(() => {});
        }
      }
    }, { queue: "ravi-gateway" });
  }

  /**
   * Subscribe to emoji reaction events from agents.
   * Queue group: only one gateway daemon sends each reaction.
   */
  private subscribeToReactions(): void {
    this.subscribe("reactions", ["ravi.outbound.reaction"], async (event) => {
      const data = event.data as {
        channel: string;
        accountId: string;
        chatId: string;
        messageId: string;
        emoji: string;
      };

      try {
        const reactionInstanceId = configStore.resolveInstanceId(data.accountId);
        if (!reactionInstanceId) return;
        const reactionChatId = normalizeOutboundJid(data.chatId);
        await this.omniSender.sendReaction(reactionInstanceId, reactionChatId, data.messageId, data.emoji);
        log.info("Reaction sent", { chatId: reactionChatId, messageId: data.messageId, emoji: data.emoji });
      } catch (err) {
        log.error("Failed to send reaction", { error: err });
      }
    }, { queue: "ravi-gateway" });
  }

  /**
   * Subscribe to media send events from agents.
   * Queue group: only one gateway daemon sends each media file.
   */
  private subscribeToMediaSend(): void {
    this.subscribe("mediaSend", ["ravi.media.send"], async (event) => {
      const data = event.data as {
        channel: string;
        accountId: string;
        chatId: string;
        filePath: string;
        mimetype: string;
        type: "image" | "video" | "audio" | "document";
        filename: string;
        caption?: string;
      };

      try {
        const mediaInstanceId = configStore.resolveInstanceId(data.accountId);
        if (!mediaInstanceId) return;
        const mediaChatId = normalizeOutboundJid(data.chatId);
        await this.omniSender.sendMedia(
          mediaInstanceId,
          mediaChatId,
          data.filePath,
          data.type,
          data.filename,
          data.caption
        );
        log.info("Media sent", { chatId: mediaChatId, type: data.type, filename: data.filename });
      } catch (err) {
        log.error("Failed to send media", { error: err });
      }
    }, { queue: "ravi-gateway" });
  }

  /**
   * Subscribe to config changes for cache invalidation and REBAC sync.
   * Fan-out intentional: all daemons must sync their own config cache.
   */
  private subscribeToConfigChanges(): void {
    this.subscribe("config", ["ravi.config.changed"], async () => {
      const { syncRelationsFromConfig } = await import("./permissions/relations.js");
      syncRelationsFromConfig();
      log.info("REBAC relations synced");
    });
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
