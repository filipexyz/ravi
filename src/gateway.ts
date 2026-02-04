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
import { dbFindActiveEntryByPhone, dbFindActiveEntryBySenderId, dbFindUnmappedActiveEntry, dbRecordEntryResponse, dbSetEntrySenderId, dbUpdateEntry } from "./outbound/index.js";

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

  if (message.isGroup) {
    // [WhatsApp Família id:123@g.us 2024-01-30 14:30] João: texto
    const groupLabel = message.groupName ?? message.chatId;
    const sender = message.senderName ?? message.senderId;
    return `${replyPrefix}[${channel} ${groupLabel} id:${message.chatId} ${timestamp}] ${sender}: ${content}`;
  } else {
    // [WhatsApp +5511999 2024-01-30 14:30] texto
    const from = message.senderPhone ?? message.senderId;
    return `${replyPrefix}[${channel} ${from} ${timestamp}] ${content}`;
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
          // Reconnect after delay
          setTimeout(() => this.subscribeToInbound(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to all bot responses and route based on target.
   */
  private subscribeToResponses(): void {
    log.info("Subscribing to responses");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.*.response")) {
          if (!this.running) break;

          // Parse topic: ravi.{sessionKey}.response
          const sessionKey = event.topic.split(".").slice(1, -1).join(".");
          const response = event.data as unknown as ResponseMessage;

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
            await plugin.outbound.send(accountId, chatId, { text });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Response subscription error", err);
          // Reconnect after delay
          setTimeout(() => this.subscribeToResponses(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to Claude SDK events for typing heartbeat.
   */
  private subscribeToClaudeEvents(): void {
    log.info("Subscribing to Claude events");

    (async () => {
      try {
        for await (const event of notif.subscribe("ravi.*.claude")) {
          if (!this.running) break;

          const sessionKey = event.topic.split(".").slice(1, -1).join(".");
          const data = event.data as { type?: string };

          // On result, stop typing and clear target
          if (data.type === "result") {
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
          setTimeout(() => this.subscribeToClaudeEvents(), 1000);
        }
      }
    })();
  }

  /**
   * Subscribe to direct send events from the outbound module.
   */
  private subscribeToDirectSend(): void {
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
          };

          const plugin = this.pluginsById.get(data.channel);
          if (!plugin) {
            log.warn("No plugin for direct send channel", { channel: data.channel });
            continue;
          }

          try {
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
            }
          } catch (err) {
            log.error("Direct send delivery failed", { to: data.to, error: err });
          }
        }
      } catch (err) {
        if (this.running) {
          log.error("Direct send subscription error", err);
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
          setTimeout(() => this.subscribeToOutboundReceipts(), 1000);
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

    // Check if sender has an active outbound entry
    // If so, record the response and DON'T emit prompt (let the runner handle it)
    if (!message.isGroup) {
      const outboundEntry = message.senderPhone
        ? dbFindActiveEntryByPhone(message.senderPhone)
        : (dbFindActiveEntryBySenderId(message.senderId) ?? dbFindUnmappedActiveEntry());

      if (outboundEntry) {
        log.info("Inbound from outbound contact, recording response (suppressing prompt)", {
          senderId: message.senderId,
          entryId: outboundEntry.id,
        });

        // Record the response text on the entry
        const content = formatMessageContent(message);
        dbRecordEntryResponse(outboundEntry.id, content);

        // Store sender ID for future LID-based lookups
        if (!outboundEntry.senderId) {
          dbSetEntrySenderId(outboundEntry.id, message.senderId);
        }

        // Trigger the runner to process this entry (event-driven, not timer-based)
        await notif.emit("ravi.outbound.response", {
          queueId: outboundEntry.queueId,
          entryId: outboundEntry.id,
        });

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
