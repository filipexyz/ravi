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
import { loadRouterConfig, type RouterConfig } from "./router/index.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage } from "./bot.js";
import {
  dbFindActiveEntryByPhone,
  dbUpdateEntry,
} from "./outbound/index.js";
import { readFile } from "fs/promises";
import path from "path";
import type { OmniSender } from "./omni/sender.js";
import type { OmniConsumer } from "./omni/consumer.js";
import { dbGetSetting } from "./router/router-db.js";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve accountId to omni instance UUID.
 * Sessions store friendly names like "default" or "vendas" instead of UUIDs.
 */
function resolveInstanceId(accountId: string): string {
  if (UUID_RE.test(accountId)) return accountId;
  const resolved = dbGetSetting(`account.${accountId}.instanceId`);
  if (resolved) return resolved;
  return accountId;
}

/** Silent reply token — when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

export interface GatewayOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
  omniSender: OmniSender;
  omniConsumer: OmniConsumer;
}

export class Gateway {
  private routerConfig: RouterConfig;
  private running = false;
  private omniSender: OmniSender;
  private omniConsumer: OmniConsumer;
  private activeSubscriptions = new Set<string>();
  private configRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GatewayOptions) {
    this.routerConfig = loadRouterConfig();
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

    // Periodic config refresh as safety net
    this.configRefreshTimer = setInterval(() => {
      if (!this.running) return;
      this.routerConfig = loadRouterConfig();
    }, 60_000);

    log.info("Gateway started");
  }

  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;

    if (this.configRefreshTimer) {
      clearInterval(this.configRefreshTimer);
      this.configRefreshTimer = null;
    }

    log.info("Gateway stopped");
  }

  /**
   * Generic subscription helper with auto-reconnect.
   */
  private subscribe(
    key: string,
    topics: string[],
    handler: (event: { topic: string; data: unknown }) => Promise<void>
  ): void {
    if (this.activeSubscriptions.has(key)) {
      log.warn(`${key} subscription already active, skipping duplicate`);
      return;
    }
    this.activeSubscriptions.add(key);

    (async () => {
      try {
        for await (const event of nats.subscribe(...topics)) {
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
          setTimeout(() => this.subscribe(key, topics, handler), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to bot responses and send via omni.
   */
  private subscribeToResponses(): void {
    this.subscribe("responses", ["ravi.session.*.response"], async (event) => {
      const sessionName = event.topic.split(".")[2];
      const response = event.data as unknown as ResponseMessage;

      const target = response.target;
      if (!target) return;

      const instanceId = resolveInstanceId(target.accountId);
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
          await this.omniSender.send(instanceId, chatId, text);
          log.info("Response delivered", { sessionName, durationMs: Date.now() - t0 });
        } catch (err) {
          log.error("Failed to send response", { instanceId, chatId, error: err });
        }
      }
    });
  }

  /**
   * Subscribe to Claude SDK events for typing heartbeat.
   */
  private subscribeToClaudeEvents(): void {
    this.subscribe("claude", ["ravi.session.*.claude"], async (event) => {
      const sessionName = event.topic.split(".")[2];
      const data = event.data as { type?: string };

      if (data.type === "result" || data.type === "silent") {
        const target = this.omniConsumer.getActiveTarget(sessionName);
        if (target) {
          await this.omniSender.sendTyping(resolveInstanceId(target.accountId), normalizeOutboundJid(target.chatId), false);
          this.omniConsumer.clearActiveTarget(sessionName);
        }
        return;
      }

      if (data.type === "system" || data.type === "assistant") {
        const target = this.omniConsumer.getActiveTarget(sessionName);
        if (target) {
          await this.omniSender.sendTyping(resolveInstanceId(target.accountId), normalizeOutboundJid(target.chatId), true);
        }
      }
    });
  }

  /**
   * Subscribe to direct send events from the outbound module.
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

      const instanceId = resolveInstanceId(data.accountId);
      const to = normalizeOutboundJid(data.to);

      try {
        let typingDelayMs = data.typingDelayMs ?? 0;
        let pauseMs = data.pauseMs ?? 0;

        // Auto sentinel humanization
        const isSentinelAuto = !data.typingDelayMs && !data.pauseMs;
        if (isSentinelAuto && data.text) {
          const mappedAgentId = this.routerConfig.accountAgents[data.accountId];
          const mappedAgent = mappedAgentId ? this.routerConfig.agents[mappedAgentId] : undefined;
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
    });
  }

  /**
   * Subscribe to emoji reaction events from agents.
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
        const reactionChatId = normalizeOutboundJid(data.chatId);
        await this.omniSender.sendReaction(resolveInstanceId(data.accountId), reactionChatId, data.messageId, data.emoji);
        log.info("Reaction sent", { chatId: reactionChatId, messageId: data.messageId, emoji: data.emoji });
      } catch (err) {
        log.error("Failed to send reaction", { error: err });
      }
    });
  }

  /**
   * Subscribe to media send events from agents.
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
        const mediaChatId = normalizeOutboundJid(data.chatId);
        await this.omniSender.sendMedia(
          resolveInstanceId(data.accountId),
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
    });
  }

  /**
   * Subscribe to config changes for cache invalidation and REBAC sync.
   */
  private subscribeToConfigChanges(): void {
    this.subscribe("config", ["ravi.config.changed"], async () => {
      this.routerConfig = loadRouterConfig();
      const { syncRelationsFromConfig } = await import("./permissions/relations.js");
      syncRelationsFromConfig();
      log.info("Router config reloaded");
    });
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options);
}
