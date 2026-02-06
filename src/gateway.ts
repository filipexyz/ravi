/**
 * Channel Gateway
 *
 * Orchestrates channel plugins and routes messages to the bot.
 */

import { notif } from "./notif.js";
import type { ChannelPlugin, InboundMessage, QuotedMessage } from "./channels/types.js";
import { registerPlugin, shutdownAllPlugins } from "./channels/registry.js";
import { ChannelManager, createChannelManager } from "./channels/manager/index.js";
import {
  loadRouterConfig,
  resolveRoute,
  type RouterConfig,
} from "./router/index.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage, MessageTarget, MessageContext } from "./bot.js";
import { dbGetEntry, dbFindActiveEntryByPhone, dbRecordEntryResponse, dbSetEntrySenderId, dbUpdateEntry } from "./outbound/index.js";

const log = logger.child("gateway");

/** Silent reply token - when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

/**
 * Format reply context block for quoted messages.
 */
function formatReplyContext(replyTo: QuotedMessage): string {
  const sender = replyTo.senderName ?? replyTo.senderId;
  const idPart = ` id:${replyTo.id}`;
  const content = replyTo.text ?? (replyTo.mediaType ? `[${replyTo.mediaType}]` : "[media]");
  return `[Replying to ${sender}${idPart}]\n${content}\n[/Replying]\n\n`;
}

/**
 * Format message content including media and transcriptions.
 */
function formatMessageContent(message: InboundMessage): string {
  // Audio with transcription (voice message or audio file)
  if (message.transcription) {
    const label = message.media?.type === "audio" ? "Audio" : `Audio: ${message.media?.filename ?? "file"}`;
    return `[${label}]\nTranscript:\n${message.transcription}`;
  }

  // Other media
  if (message.media) {
    const parts: string[] = [];

    // Media label with optional caption
    const mediaLabel = message.media.caption
      ? `[${message.media.type}] ${message.media.caption}`
      : `[${message.media.type}]`;
    parts.push(mediaLabel);

    // File path if downloaded, or size note if too large
    if (message.media.localPath) {
      parts.push(`[file: ${message.media.localPath}]`);
    } else if (message.media.sizeBytes) {
      const mb = (message.media.sizeBytes / 1024 / 1024).toFixed(1);
      parts.push(`[file too large: ${mb}MB, not downloaded]`);
    }

    // Append text if present
    if (message.text) {
      parts.push(message.text);
    }

    return parts.join("\n");
  }

  // Text only
  return message.text ?? "[media]";
}

/**
 * Format message envelope with metadata for structured prompts.
 */
function formatEnvelope(
  plugin: ChannelPlugin,
  message: InboundMessage
): string {
  const channel = plugin.meta.name;
  const timestamp = new Date(message.timestamp).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Build reply context prefix
  const replyPrefix = message.replyTo ? formatReplyContext(message.replyTo) : "";

  // Format the message content
  const content = formatMessageContent(message);

  // Message ID suffix for reaction targeting
  const midTag = message.id ? ` [mid:${message.id}]` : "";

  if (message.isGroup) {
    // [WhatsApp Família id:123@g.us 2024-01-30 14:30] João: texto [mid:XXX]
    const groupLabel = message.groupName ?? message.chatId;
    const sender = message.senderName ?? message.senderId;
    return `${replyPrefix}[${channel} ${groupLabel} id:${message.chatId} ${timestamp}] ${sender}: ${content}${midTag}`;
  } else {
    // [WhatsApp +5511999 2024-01-30 14:30] texto [mid:XXX]
    const from = message.senderPhone ?? message.senderId;
    return `${replyPrefix}[${channel} ${from} ${timestamp}] ${content}${midTag}`;
  }
}

/**
 * Build MessageContext from an inbound message.
 */
function buildMessageContext(
  plugin: ChannelPlugin,
  message: InboundMessage
): MessageContext {
  return {
    channelId: plugin.id,
    channelName: plugin.meta.name,
    accountId: message.accountId,
    chatId: message.chatId,
    messageId: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    senderPhone: message.senderPhone,
    isGroup: message.isGroup,
    groupName: message.groupName,
    groupId: message.isGroup ? message.chatId : undefined,
    groupMembers: message.groupMembers,
    timestamp: message.timestamp,
  };
}

export interface GatewayOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
}

export class Gateway {
  private routerConfig: RouterConfig;
  private running = false;
  private plugins: ChannelPlugin[] = [];
  private pluginsById = new Map<string, ChannelPlugin>();
  private channelManager: ChannelManager | null = null;
  private responseSubscriptions = new Map<string, AbortController>();
  private activeTargets = new Map<string, MessageTarget>();
  private activeSubscriptions = new Set<string>();

  constructor(options: GatewayOptions = {}) {
    this.routerConfig = loadRouterConfig();
    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }
  }

  use(plugin: ChannelPlugin): this {
    registerPlugin(plugin);
    this.plugins.push(plugin);
    this.pluginsById.set(plugin.id, plugin);
    return this;
  }

  /**
   * Get the ChannelManager instance.
   */
  getChannelManager(): ChannelManager | null {
    return this.channelManager;
  }

  async start(): Promise<void> {
    log.info("Starting gateway...");
    this.running = true;

    // Create ChannelManager from registered plugins
    this.channelManager = createChannelManager(this.pluginsById);

    // Start all channels via ChannelManager
    await this.channelManager.startChannels();

    // Subscribe to inbound topics for all plugins
    this.subscribeToInbound();

    // Subscribe to all responses
    this.subscribeToResponses();

    // Subscribe to Claude events for typing heartbeat
    this.subscribeToClaudeEvents();

    // Subscribe to direct send events from outbound module
    this.subscribeToDirectSend();

    // Subscribe to deferred outbound read receipts
    this.subscribeToOutboundReceipts();

    // Subscribe to emoji reactions from agents
    this.subscribeToReactions();

    // Subscribe to media send events from agents
    this.subscribeToMediaSend();

    log.info("Gateway started");
  }

  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;

    for (const [, controller] of this.responseSubscriptions) {
      controller.abort();
    }
    this.responseSubscriptions.clear();

    // Stop via ChannelManager
    if (this.channelManager) {
      await this.channelManager.stopAll();
    }

    await shutdownAllPlugins();
    log.info("Gateway stopped");
  }

  /**
   * Subscribe to inbound topics for all registered plugins.
   * Pattern: {channelId}.*.inbound
   */
  private subscribeToInbound(): void {
    if (this.activeSubscriptions.has("inbound")) {
      log.warn("Inbound subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("inbound");

    const topics = this.plugins.map((p) => `${p.id}.*.inbound`);
    log.info("Subscribing to inbound topics", { topics });

    (async () => {
      try {
        for await (const event of notif.subscribe(...topics)) {
          if (!this.running) break;

          // Parse topic: {channelId}.{accountId}.inbound
          const parts = event.topic.split(".");
          const channelId = parts[0];
          const plugin = this.pluginsById.get(channelId);

          if (!plugin) {
            log.warn("No plugin for channel", { channelId });
            continue;
          }

          const message = event.data as unknown as InboundMessage;
          await this.handleInboundMessage(plugin, message);
        }
      } catch (err) {
        if (this.running) {
          log.error("Inbound subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("inbound");
        if (this.running) {
          setTimeout(() => this.subscribeToInbound(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to all bot responses and route based on target.
   */
  private subscribeToResponses(): void {
    if (this.activeSubscriptions.has("responses")) {
      log.warn("Response subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("responses");

    log.info("Subscribing to responses");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.*.response")) {
          if (!this.running) break;

          // Parse topic: ravi.{sessionKey}.response
          const sessionKey = event.topic.split(".").slice(1, -1).join(".");
          const response = event.data as unknown as ResponseMessage;

          log.debug("Response event received", {
            sessionKey,
            eventId: event.id,
            keys: Object.keys(response),
            hasEmitId: !!(response as any)._emitId,
            emitId: (response as any)._emitId ?? "NONE",
          });

          // Target is required to route to a channel
          const target = response.target;
          if (!target) {
            continue;
          }

          const { channel, accountId, chatId } = target;

          // Get plugin for this channel
          const plugin = this.pluginsById.get(channel);
          if (!plugin) {
            log.warn("No plugin for channel", { channel });
            continue;
          }

          const text = response.error
            ? `Error: ${response.error}`
            : response.response;

          // Skip silent responses
          if (text && text.trim() === SILENT_TOKEN) {
            log.debug("Silent response, not sending to channel", { sessionKey });
            continue;
          }

          if (text) {
            // Validate _emitId to prevent ghost/duplicate responses from orphaned SDK subprocesses
            if (!(response as any)._emitId) {
              log.warn("GHOST RESPONSE DROPPED", {
                sessionKey,
                textPreview: text.slice(0, 200),
                hasInstanceId: !!(response as any)._instanceId,
                instanceId: (response as any)._instanceId ?? "NONE",
                pid: (response as any)._pid ?? "NONE",
                version: (response as any)._v ?? "NONE",
                keys: Object.keys(response),
                fullPayload: JSON.stringify(response).slice(0, 500),
                // Full notif event tracing
                eventId: event.id,
                eventTimestamp: event.timestamp,
                eventAttempt: event.attempt,
                eventMaxAttempts: (event as any).maxAttempts,
                eventTopic: event.topic,
              });
              continue;
            }
            log.info("Sending response", {
              sessionKey, channel, chatId, textLen: text.length,
              emitId: (response as any)._emitId,
              instanceId: (response as any)._instanceId ?? "?",
            });
            await plugin.outbound.send(accountId, chatId, { text });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Response subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("responses");
        if (this.running) {
          setTimeout(() => this.subscribeToResponses(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to Claude SDK events for typing heartbeat.
   */
  private subscribeToClaudeEvents(): void {
    if (this.activeSubscriptions.has("claude")) {
      log.warn("Claude events subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("claude");

    log.info("Subscribing to Claude events");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.*.claude")) {
          if (!this.running) break;

          const sessionKey = event.topic.split(".").slice(1, -1).join(".");
          const data = event.data as { type?: string };

          // On result or silent, stop typing and clear target
          if (data.type === "result" || data.type === "silent") {
            const target = this.activeTargets.get(sessionKey);
            if (target) {
              const plugin = this.pluginsById.get(target.channel);
              if (plugin) {
                await plugin.outbound.sendTyping(target.accountId, target.chatId, false);
              }
              this.activeTargets.delete(sessionKey);
            }
            continue;
          }

          // Send typing heartbeat if we have a target
          const target = this.activeTargets.get(sessionKey);
          if (target) {
            const plugin = this.pluginsById.get(target.channel);
            if (plugin) {
              await plugin.outbound.sendTyping(target.accountId, target.chatId, true);
            }
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Claude events subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("claude");
        if (this.running) {
          setTimeout(() => this.subscribeToClaudeEvents(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to direct send events from the outbound module.
   */
  private subscribeToDirectSend(): void {
    if (this.activeSubscriptions.has("directSend")) {
      log.warn("Direct send subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("directSend");

    log.info("Subscribing to outbound direct send");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.outbound.deliver")) {
          if (!this.running) break;

          const data = event.data as {
            channel: string;
            accountId: string;
            to: string;
            text: string;
            typingDelayMs?: number;
            pauseMs?: number;
          };

          const plugin = this.pluginsById.get(data.channel);
          if (!plugin) {
            log.warn("No plugin for direct send channel", { channel: data.channel });
            continue;
          }

          try {
            // Pause before typing (simulates reading/thinking)
            if (data.pauseMs && data.pauseMs > 0) {
              await new Promise(resolve => setTimeout(resolve, data.pauseMs));
            }

            if (data.typingDelayMs && data.typingDelayMs > 0) {
              await plugin.outbound.sendTyping(data.accountId, data.to, true);
              await new Promise(resolve => setTimeout(resolve, data.typingDelayMs));
              await plugin.outbound.send(data.accountId, data.to, { text: data.text });
              await plugin.outbound.sendTyping(data.accountId, data.to, false);
            } else {
              await plugin.outbound.send(data.accountId, data.to, { text: data.text });
            }
            log.info("Direct send delivered", { to: data.to, channel: data.channel, typingDelayMs: data.typingDelayMs });

            // Mark last_sent_at on outbound entry so we can match LID replies
            const entry = dbFindActiveEntryByPhone(data.to);
            if (entry) {
              dbUpdateEntry(entry.id, { lastSentAt: Date.now() });

              // Resolve LID from local mapping store
              if (!entry.senderId && plugin.outbound.resolveJid) {
                const resolved = await plugin.outbound.resolveJid(data.accountId, data.to);
                if (resolved && resolved !== data.to) {
                  dbSetEntrySenderId(entry.id, resolved);
                  log.info("LID resolved from mapping store", { entryId: entry.id, phone: data.to, lid: resolved });
                }
              }
            }
          } catch (err) {
            log.error("Direct send delivery failed", { to: data.to, error: err });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Direct send subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("directSend");
        if (this.running) {
          setTimeout(() => this.subscribeToDirectSend(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to deferred outbound read receipt events.
   * When the runner processes an entry with a pending receipt, it emits here.
   */
  private subscribeToOutboundReceipts(): void {
    if (this.activeSubscriptions.has("receipts")) {
      log.warn("Receipts subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("receipts");

    log.info("Subscribing to outbound receipts");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.outbound.receipt")) {
          if (!this.running) break;

          const data = event.data as {
            channel: string;
            accountId: string;
            chatId: string;
            senderId: string;
            messageIds: string[];
          };

          const plugin = this.pluginsById.get(data.channel);
          if (!plugin) {
            log.warn("No plugin for outbound receipt channel", { channel: data.channel });
            continue;
          }

          try {
            await plugin.outbound.sendReadReceipt(data.accountId, data.chatId, data.messageIds);
            log.info("Deferred read receipt sent", { chatId: data.chatId, count: data.messageIds.length });
          } catch (err) {
            log.error("Failed to send deferred read receipt", { error: err });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Outbound receipt subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("receipts");
        if (this.running) {
          setTimeout(() => this.subscribeToOutboundReceipts(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to emoji reaction events from agents.
   * Pattern: ravi.outbound.reaction → plugin.outbound.sendReaction()
   */
  private subscribeToReactions(): void {
    if (this.activeSubscriptions.has("reactions")) {
      log.warn("Reactions subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("reactions");

    log.info("Subscribing to outbound reactions");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.outbound.reaction")) {
          if (!this.running) break;

          const data = event.data as {
            channel: string;
            accountId: string;
            chatId: string;
            messageId: string;
            emoji: string;
          };

          const plugin = this.pluginsById.get(data.channel);
          if (!plugin) {
            log.warn("No plugin for reaction channel", { channel: data.channel });
            continue;
          }

          try {
            await plugin.outbound.sendReaction(data.accountId, data.chatId, data.messageId, data.emoji);
            log.info("Reaction sent", { chatId: data.chatId, messageId: data.messageId, emoji: data.emoji });
          } catch (err) {
            log.error("Failed to send reaction", { error: err });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Reactions subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("reactions");
        if (this.running) {
          setTimeout(() => this.subscribeToReactions(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to media send events from agents.
   * Pattern: ravi.media.send → plugin.outbound.send() with media
   */
  private subscribeToMediaSend(): void {
    if (this.activeSubscriptions.has("mediaSend")) {
      log.warn("Media send subscription already active, skipping duplicate");
      return;
    }
    this.activeSubscriptions.add("mediaSend");

    log.info("Subscribing to media send");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.media.send")) {
          if (!this.running) break;

          const data = event.data as {
            channel: string;
            accountId: string;
            chatId: string;
            media: import("./channels/types.js").OutboundMedia;
            caption?: string;
          };

          const plugin = this.pluginsById.get(data.channel);
          if (!plugin) {
            log.warn("No plugin for media send channel", { channel: data.channel });
            continue;
          }

          try {
            await plugin.outbound.send(data.accountId, data.chatId, {
              media: data.media,
              text: data.caption,
            });
            log.info("Media sent", { chatId: data.chatId, type: data.media.type, filename: data.media.filename });
          } catch (err) {
            log.error("Failed to send media", { error: err });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Media send subscription error", err);
        }
      } finally {
        this.activeSubscriptions.delete("mediaSend");
        if (this.running) {
          setTimeout(() => this.subscribeToMediaSend(), 1000);
        }
      }
    })();
  }

  private async handleInboundMessage(
    plugin: ChannelPlugin,
    message: InboundMessage
  ): Promise<void> {
    // Reload config to pick up route changes (routes may be added via CLI)
    this.routerConfig = loadRouterConfig();

    // Check if sender has an active outbound entry (plugin already resolved the ID)
    // If so, record the response and DON'T emit prompt (let the runner handle it)
    if (!message.isGroup && message.outboundEntryId) {
      const outboundEntry = dbGetEntry(message.outboundEntryId);

      if (outboundEntry && outboundEntry.status !== 'agent') {
        log.info("Inbound from outbound contact, recording response (suppressing prompt)", {
          senderId: message.senderId,
          entryId: outboundEntry.id,
        });

        // Record the response text on the entry (reactivates completed queues)
        const content = formatMessageContent(message);
        dbRecordEntryResponse(outboundEntry.id, content);

        // Store sender ID for future LID-based lookups
        if (!outboundEntry.senderId) {
          dbSetEntrySenderId(outboundEntry.id, message.senderId);
        }

        // Notify runner to re-arm timer (queue may have been reactivated)
        notif.emit("ravi.outbound.refresh", {}).catch(() => {});

        return;
      }
    }

    // Resolve route to get session key
    const resolved = resolveRoute(this.routerConfig, {
      phone: message.senderId,
      channel: plugin.id,
      accountId: message.accountId,
      isGroup: message.isGroup,
      groupId: message.isGroup ? message.chatId : undefined,
    });

    const sessionKey = resolved.sessionKey;

    log.info("Inbound message", {
      channel: plugin.id,
      sender: message.senderId,
      sessionKey,
      agentId: resolved.agent.id,
    });

    // Build source info for prompt
    const source: MessageTarget = {
      channel: plugin.id,
      accountId: message.accountId,
      chatId: message.chatId,
    };

    // Build context and formatted envelope
    const context = buildMessageContext(plugin, message);
    const envelope = formatEnvelope(plugin, message);

    // Store target for typing heartbeat
    this.activeTargets.set(sessionKey, source);

    // Typing indicator
    await plugin.outbound.sendTyping(message.accountId, message.chatId, true);

    // Emit prompt with source and context
    try {
      await notif.emit(`ravi.${sessionKey}.prompt`, {
        prompt: envelope,
        source,
        context,
      });
    } catch (err) {
      log.error("Failed to emit prompt", err);
      await plugin.outbound.sendTyping(message.accountId, message.chatId, false);
      await plugin.outbound.send(message.accountId, message.chatId, {
        text: "Something went wrong. Please try again.",
      });
    }
  }
}

export function createGateway(options?: GatewayOptions): Gateway {
  return new Gateway(options);
}
