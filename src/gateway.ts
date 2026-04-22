/**
 * Channel Gateway (omni-backed)
 *
 * Routes bot responses back to channel instances via OmniSender.
 * Inbound message handling is done by OmniConsumer.
 *
 * Subscriptions maintained here:
 *   ravi.session.*.response    → send via omni HTTP
 *   ravi.session.*.claude      → typing heartbeat (Claude compatibility)
 *   ravi.session.*.runtime     → typing heartbeat (provider-neutral)
 *   ravi.session.*.stream      → typing heartbeat renewal on streamed chunks
 *   ravi.outbound.deliver      → direct channel delivery
 *   ravi.outbound.reaction     → emoji reactions
 *   ravi.media.send            → media files
 *   ravi.stickers.send         → WhatsApp stickers
 *   ravi.config.changed        → reload router config + REBAC sync
 */

import { nats } from "./nats.js";
import type { ResponseMessage } from "./runtime/message-types.js";
import { configStore } from "./config-store.js";
import { recordDeliveryTrace, recordResponseEmittedTrace } from "./session-trace/channel-trace.js";
import { logger } from "./utils/logger.js";
import type { OmniSender } from "./omni/sender.js";
import type { OmniConsumer } from "./omni/consumer.js";
import { SessionTypingTracker } from "./gateway-typing.js";
import { assertChannelSupportsStickers } from "./channels/capabilities.js";
import type { StickerSendEvent } from "./stickers/send.js";

const log = logger.child("gateway");
const PRESENCE_RENEW_THROTTLE_MS = 4_000;
const POST_DELIVERY_RENEW_DELAY_MS = 1_000;
const INTERRUPTED_PRESENCE_GRACE_MS = 15_000;

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
  emitEvent?: typeof nats.emit;
}

type PresenceTarget = { channel: string; accountId: string; chatId: string; threadId?: string };

export class Gateway {
  private running = false;
  private omniSender: OmniSender;
  private omniConsumer: OmniConsumer;
  private emitEvent: typeof nats.emit;
  private activeSubscriptions = new Set<string>();
  private typingTracker = new SessionTypingTracker();
  private presenceRenewedAt = new Map<string, number>();
  private activeRuntimeSessions = new Set<string>();
  private postDeliveryRenewals = new Map<string, ReturnType<typeof setTimeout>>();
  private interruptedPresenceStops = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: GatewayOptions) {
    this.omniSender = options.omniSender;
    this.omniConsumer = options.omniConsumer;
    this.emitEvent = options.emitEvent ?? nats.emit;
    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }
  }

  async start(): Promise<void> {
    log.info("Starting gateway...");
    this.running = true;

    this.subscribeToResponses();
    this.subscribeToRuntimeEvents();
    this.subscribeToDirectSend();
    this.subscribeToReactions();
    this.subscribeToMediaSend();
    this.subscribeToStickerSend();
    this.subscribeToConfigChanges();

    log.info("Gateway started");
  }

  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;
    this.typingTracker = new SessionTypingTracker();
    this.presenceRenewedAt.clear();
    this.activeRuntimeSessions.clear();
    this.clearPostDeliveryRenewals();
    this.clearInterruptedPresenceStops();
    log.info("Gateway stopped");
  }

  private async sendTypingIfChanged(sessionName: string, target: PresenceTarget, active: boolean): Promise<void> {
    if (!this.typingTracker.shouldEmit(sessionName, active)) return;
    await this.sendTyping(target, active);
  }

  private async sendTyping(target: PresenceTarget, active: boolean): Promise<void> {
    const iid = configStore.resolveInstanceId(target.accountId);
    if (iid) {
      await this.omniSender.sendTyping(iid, normalizeOutboundJid(target.chatId), active);
    }
  }

  private presenceTargetKey(target: PresenceTarget | undefined): string | undefined {
    if (!target) return undefined;
    return [target.channel, target.accountId, normalizeOutboundJid(target.chatId), target.threadId ?? ""].join(":");
  }

  private targetsMatch(left: PresenceTarget | undefined, right: PresenceTarget | undefined): boolean {
    const leftKey = this.presenceTargetKey(left);
    const rightKey = this.presenceTargetKey(right);
    return !!leftKey && leftKey === rightKey;
  }

  private async renewActiveTargetIfCurrent(sessionName: string, expectedTarget: PresenceTarget): Promise<boolean> {
    const activeTarget = this.omniConsumer.getActiveTarget(sessionName) as PresenceTarget | undefined;
    if (!activeTarget) return false;
    if (!this.targetsMatch(activeTarget, expectedTarget)) {
      log.warn("Presence active target mismatch; using event target", {
        sessionName,
        activeTarget: this.presenceTargetKey(activeTarget),
        expectedTarget: this.presenceTargetKey(expectedTarget),
      });
      return false;
    }
    return this.omniConsumer.renewActiveTarget(sessionName);
  }

  private async forceRenewTyping(sessionName: string, target: PresenceTarget) {
    const renewed = await this.renewActiveTargetIfCurrent(sessionName, target);
    if (!renewed) {
      await this.sendTyping(target, true);
    }
    this.presenceRenewedAt.set(sessionName, Date.now());
  }

  private clearPostDeliveryRenewals(): void {
    for (const timer of this.postDeliveryRenewals.values()) {
      clearTimeout(timer);
    }
    this.postDeliveryRenewals.clear();
  }

  private clearPostDeliveryRenewal(sessionName: string): void {
    const timer = this.postDeliveryRenewals.get(sessionName);
    if (!timer) return;
    clearTimeout(timer);
    this.postDeliveryRenewals.delete(sessionName);
  }

  private clearInterruptedPresenceStops(): void {
    for (const timer of this.interruptedPresenceStops.values()) {
      clearTimeout(timer);
    }
    this.interruptedPresenceStops.clear();
  }

  private clearInterruptedPresenceStop(sessionName: string): void {
    const timer = this.interruptedPresenceStops.get(sessionName);
    if (!timer) return;
    clearTimeout(timer);
    this.interruptedPresenceStops.delete(sessionName);
  }

  private scheduleInterruptedPresenceStop(sessionName: string, target: PresenceTarget | undefined): void {
    this.clearInterruptedPresenceStop(sessionName);
    const timer = setTimeout(() => {
      this.interruptedPresenceStops.delete(sessionName);
      if (!this.running) return;
      this.stopPresenceForSession(sessionName, target).catch((error) => {
        log.debug("Interrupted presence cleanup failed", { sessionName, error });
      });
    }, INTERRUPTED_PRESENCE_GRACE_MS);
    timer.unref?.();
    this.interruptedPresenceStops.set(sessionName, timer);
  }

  private async stopPresenceForSession(sessionName: string, target?: PresenceTarget): Promise<void> {
    this.activeRuntimeSessions.delete(sessionName);
    this.presenceRenewedAt.delete(sessionName);
    this.clearPostDeliveryRenewal(sessionName);
    this.clearInterruptedPresenceStop(sessionName);

    const localTarget = this.omniConsumer.getActiveTarget(sessionName) as PresenceTarget | undefined;
    if (localTarget) {
      this.omniConsumer.clearActiveTarget(sessionName);
      if (target && !this.targetsMatch(localTarget, target)) {
        await this.sendTyping(target, false);
      }
      return;
    }

    if (target) {
      await this.sendTypingIfChanged(sessionName, target, false);
    }
  }

  private schedulePostDeliveryPresenceRenewal(sessionName: string, target: PresenceTarget): void {
    if (!this.activeRuntimeSessions.has(sessionName)) return;
    this.clearPostDeliveryRenewal(sessionName);
    const timer = setTimeout(() => {
      this.postDeliveryRenewals.delete(sessionName);
      if (!this.running || !this.activeRuntimeSessions.has(sessionName)) return;
      this.forceRenewTyping(sessionName, target).catch((error) => {
        log.debug("Post-delivery presence renewal failed", { sessionName, error });
      });
    }, POST_DELIVERY_RENEW_DELAY_MS);
    timer.unref?.();
    this.postDeliveryRenewals.set(sessionName, timer);
  }

  private async renewTypingForRuntimeActivity(sessionName: string, data: { _source?: PresenceTarget }): Promise<void> {
    const now = Date.now();
    const lastRenewedAt = this.presenceRenewedAt.get(sessionName) ?? 0;
    if (now - lastRenewedAt < PRESENCE_RENEW_THROTTLE_MS) return;

    const renewed = data._source
      ? await this.renewActiveTargetIfCurrent(sessionName, data._source)
      : await this.omniConsumer.renewActiveTarget(sessionName);
    if (!renewed && data._source) {
      await this.sendTyping(data._source, true);
    }

    if (renewed || data._source) {
      this.presenceRenewedAt.set(sessionName, now);
    }
  }

  private isTerminalRuntimeEvent(type: string | undefined): boolean {
    return (
      type === "result" ||
      type === "silent" ||
      type === "turn.complete" ||
      type === "turn.failed" ||
      type === "session.timeout"
    );
  }

  private isPresenceActivityEvent(type: string | undefined, status?: string): boolean {
    if (!type || this.isTerminalRuntimeEvent(type)) return false;
    if (type === "status" && status === "idle") return false;
    return true;
  }

  private recordResponseTrace(sessionName: string, response: ResponseMessage): void {
    try {
      recordResponseEmittedTrace({ sessionName, response });
    } catch (error) {
      log.warn("Failed to record response emitted trace", { sessionName, error });
    }
  }

  private async emitDeliveryEvent(
    sessionName: string,
    response: ResponseMessage,
    data: Record<string, unknown>,
  ): Promise<void> {
    const delivery = {
      emitId: response._emitId,
      sessionName,
      timestamp: Date.now(),
      ...data,
    };

    try {
      recordDeliveryTrace({ sessionName, response, delivery });
    } catch (error) {
      log.warn("Failed to record delivery trace", { sessionName, status: data.status, error });
    }

    await this.emitEvent(`ravi.session.${sessionName}.delivery`, delivery);
  }

  private async handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void> {
    this.recordResponseTrace(sessionName, response);

    const emitDelivery = (data: Record<string, unknown>) => this.emitDeliveryEvent(sessionName, response, data);

    const target = response.target;
    if (!target) {
      await emitDelivery({ status: "dropped", reason: "missing_target" });
      return;
    }

    const instanceId = configStore.resolveInstanceId(target.accountId);
    if (!instanceId) {
      await emitDelivery({ status: "dropped", reason: "missing_instance", target });
      return;
    }
    const chatId = normalizeOutboundJid(target.chatId);

    const text = response.error ? `Error: ${response.error}` : response.response;

    if (text && text.trim() === SILENT_TOKEN) {
      log.debug("Silent response, not sending to channel", { sessionName });
      await emitDelivery({ status: "dropped", reason: "silent", target });
      return;
    }

    if (!text) {
      await emitDelivery({ status: "dropped", reason: "empty_response", target });
      return;
    }

    if (!response._emitId) {
      log.warn("GHOST RESPONSE DROPPED", {
        sessionName,
        textPreview: text.slice(0, 200),
      });
      await emitDelivery({ status: "dropped", reason: "missing_emit_id", target, textLen: text.length });
      return;
    }

    const t0 = Date.now();
    log.info("Sending response", {
      sessionName,
      instanceId,
      chatId,
      textLen: text.length,
      emitId: response._emitId,
    });

    try {
      const delivered = await this.omniSender.send(instanceId, chatId, text, target.threadId);
      this.schedulePostDeliveryPresenceRenewal(sessionName, target);
      await emitDelivery({
        status: "delivered",
        emitId: response._emitId,
        messageId: delivered.messageId,
        target,
        deliveredAt: Date.now(),
        durationMs: Date.now() - t0,
        textLen: text.length,
      });
      log.info("Response delivered", { sessionName, durationMs: Date.now() - t0 });
    } catch (err) {
      log.error("Failed to send response", { instanceId, chatId, error: err });
      await emitDelivery({
        status: "failed",
        reason: "send_error",
        target,
        instanceId,
        chatId,
        textLen: text.length,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
    }
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
    opts?: { queue?: string },
  ): void {
    if (this.activeSubscriptions.has(key)) {
      log.warn(`${key} subscription already active, skipping duplicate`);
      return;
    }
    this.activeSubscriptions.add(key);

    (async () => {
      try {
        for await (const event of nats.subscribe(...topics, ...((opts?.queue ? [{ queue: opts.queue }] : []) as []))) {
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
    this.subscribe(
      "responses",
      ["ravi.session.*.response"],
      async (event) => {
        const sessionName = event.topic.split(".")[2];
        const response = event.data as unknown as ResponseMessage;
        await this.handleResponseEvent(sessionName, response);
      },
      { queue: "ravi-gateway" },
    );
  }

  /**
   * Subscribe to provider runtime events for typing heartbeat.
   * Keeps the legacy Claude topic for compatibility while new providers emit `.runtime`.
   */
  private subscribeToRuntimeEvents(): void {
    this.subscribe(
      "runtime",
      ["ravi.session.*.claude", "ravi.session.*.runtime", "ravi.session.*.stream"],
      async (event) => {
        const sessionName = event.topic.split(".")[2];
        const data = event.data as {
          type?: string;
          status?: string;
          _source?: PresenceTarget & { sourceMessageId?: string };
        };

        const eventType = event.topic.endsWith(".stream") ? "stream.chunk" : data.type;
        await this.handleRuntimePresenceEvent(sessionName, { ...data, type: eventType });
      },
    );
  }

  private async handleRuntimePresenceEvent(
    sessionName: string,
    data: {
      type?: string;
      status?: string;
      _source?: PresenceTarget & { sourceMessageId?: string };
    },
  ): Promise<void> {
    if (data.type === "turn.interrupted") {
      if (data._source) {
        await this.forceRenewTyping(sessionName, data._source);
      } else {
        await this.omniConsumer.renewActiveTarget(sessionName);
      }
      this.scheduleInterruptedPresenceStop(sessionName, data._source);
      return;
    }

    if (this.isTerminalRuntimeEvent(data.type)) {
      await this.stopPresenceForSession(sessionName, data._source);
      return;
    }

    if (!this.isPresenceActivityEvent(data.type, data.status)) return;

    this.clearInterruptedPresenceStop(sessionName);
    this.activeRuntimeSessions.add(sessionName);
    await this.renewTypingForRuntimeActivity(sessionName, data);
  }

  /**
   * Subscribe to direct delivery events.
   * Queue group: only one gateway daemon processes each deliver event.
   */
  private subscribeToDirectSend(): void {
    this.subscribe(
      "directSend",
      ["ravi.outbound.deliver"],
      async (event) => {
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
            nats.emit(data.replyTopic, { success: false, error: "No instance for account" }).catch(() => {});
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
            nats
              .emit(data.replyTopic, { success: true, messageId } as unknown as Record<string, unknown>)
              .catch(() => {});
          }
        } catch (err) {
          log.error("Failed to deliver direct send", { to, instanceId, error: err });
          if (data.replyTopic) {
            nats.emit(data.replyTopic, { success: false, error: String(err) }).catch(() => {});
          }
        }
      },
      { queue: "ravi-gateway" },
    );
  }

  /**
   * Subscribe to emoji reaction events from agents.
   * Queue group: only one gateway daemon sends each reaction.
   */
  private subscribeToReactions(): void {
    this.subscribe(
      "reactions",
      ["ravi.outbound.reaction"],
      async (event) => {
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
      },
      { queue: "ravi-gateway" },
    );
  }

  /**
   * Subscribe to media send events from agents.
   * Queue group: only one gateway daemon sends each media file.
   */
  private subscribeToMediaSend(): void {
    this.subscribe(
      "mediaSend",
      ["ravi.media.send"],
      async (event) => {
        const data = event.data as {
          channel: string;
          accountId: string;
          chatId: string;
          filePath: string;
          mimetype: string;
          type: "image" | "video" | "audio" | "document";
          filename: string;
          caption?: string;
          voiceNote?: boolean;
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
            data.caption,
            data.voiceNote,
          );
          log.info("Media sent", { chatId: mediaChatId, type: data.type, filename: data.filename });
        } catch (err) {
          log.error("Failed to send media", { error: err });
        }
      },
      { queue: "ravi-gateway" },
    );
  }

  private async handleStickerSendEvent(data: StickerSendEvent): Promise<void> {
    assertChannelSupportsStickers({
      channelId: data.channel,
      channelName: data.channel,
    });

    const stickerInstanceId = configStore.resolveInstanceId(data.accountId);
    if (!stickerInstanceId) {
      if (data.replyTopic) {
        await this.emitEvent(data.replyTopic, { success: false, error: "No instance for account" });
      }
      return;
    }

    const stickerChatId = normalizeOutboundJid(data.chatId);
    const result = await this.omniSender.sendSticker(stickerInstanceId, stickerChatId, data.filePath);
    log.info("Sticker sent", { chatId: stickerChatId, stickerId: data.stickerId, filename: data.filename });

    if (data.replyTopic) {
      await this.emitEvent(data.replyTopic, { success: true, messageId: result.messageId });
    }
  }

  /**
   * Subscribe to sticker send events from agents.
   * Queue group: only one gateway daemon sends each sticker.
   */
  private subscribeToStickerSend(): void {
    this.subscribe(
      "stickerSend",
      ["ravi.stickers.send"],
      async (event) => {
        try {
          await this.handleStickerSendEvent(event.data as StickerSendEvent);
        } catch (err) {
          log.error("Failed to send sticker", { error: err });
        }
      },
      { queue: "ravi-gateway" },
    );
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
