/**
 * Channel Gateway
 *
 * Orchestrates channel plugins and routes messages to the bot.
 */

import { notif } from "./notif.js";
import { pendingReplyCallbacks } from "./bot.js";
import type { ChannelPlugin, InboundMessage, QuotedMessage, SendResult } from "./channels/types.js";
import { dispatchGroupOp, type GroupOpName } from "./channels/whatsapp/group-ops.js";
import { registerPlugin, shutdownAllPlugins } from "./channels/registry.js";
import { ChannelManager, createChannelManager } from "./channels/manager/index.js";
import {
  expandHome,
  loadRouterConfig,
  resolveRoute,
  dbSaveMessageMeta,
  type RouterConfig,
} from "./router/index.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage, MessageTarget, MessageContext } from "./bot.js";
import { dbGetEntry, dbFindActiveEntryByPhone, dbRecordEntryResponse, dbSetEntrySenderId, dbUpdateEntry } from "./outbound/index.js";
import { mkdir, readFile, rename } from "fs/promises";
import path from "path";
import { handleSlashCommand } from "./slash/index.js";


const log = logger.child("gateway");

/** Silent reply token - when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

/**
 * Format reply context block for quoted messages.
 */
function formatReplyContext(replyTo: QuotedMessage): string {
  const sender = replyTo.senderName ?? replyTo.senderId;
  const idPart = ` id:${replyTo.id}`;

  const parts: string[] = [];

  // Media type label
  if (replyTo.mediaType) {
    parts.push(`[${replyTo.mediaType}]`);
  }

  // Media file path
  if (replyTo.mediaPath) {
    parts.push(`[file: ${replyTo.mediaPath}]`);
  }

  // Text content (may be original text or enriched transcription)
  if (replyTo.text) {
    // If this is an audio reply with transcription, label it
    if (replyTo.mediaType === "audio") {
      parts.push(`Transcript:\n${replyTo.text}`);
    } else {
      parts.push(replyTo.text);
    }
  }

  // Fallback if nothing
  if (parts.length === 0) {
    parts.push("[media]");
  }

  const content = parts.join("\n");
  return `[Replying to ${sender}${idPart}]\n${content}\n[/Replying]\n\n`;
}

/**
 * Format message content including media and transcriptions.
 */
function formatMessageContent(message: InboundMessage): string {
  // Audio with transcription (voice message or audio file)
  if (message.transcription) {
    const label = message.media?.type === "audio" ? "Audio" : `Audio: ${message.media?.filename ?? "file"}`;
    const parts = [`[${label}]`];
    if (message.media?.localPath) {
      parts.push(`[file: ${message.media.localPath}]`);
    }
    parts.push(`Transcript:\n${message.transcription}`);
    return parts.join("\n");
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
  const dt = new Date(message.timestamp);
  const timestamp = dt.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const dow = dt.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).toLowerCase();

  // Build reply context prefix
  const replyPrefix = message.replyTo ? formatReplyContext(message.replyTo) : "";

  // Format the message content
  const content = formatMessageContent(message);

  // Message ID tag for reaction targeting
  const midTag = message.id ? ` mid:${message.id}` : "";

  if (message.isGroup) {
    // [WhatsApp Família id:123@g.us mid:XXX @mention 2024-01-30 14:30] João: texto
    const groupLabel = message.groupName ?? message.chatId;
    const sender = message.senderName ?? message.senderId;
    const mentionTag = message.isMentioned ? " @mention" : "";
    return `${replyPrefix}[${channel} ${groupLabel} id:${message.chatId}${midTag}${mentionTag} ${timestamp} ${dow}] ${sender}: ${content}`;
  } else {
    // [WhatsApp +5511999 mid:XXX 2024-01-30 14:30 fri] texto
    const from = message.senderPhone ?? message.senderId;
    return `${replyPrefix}[${channel} ${from}${midTag} ${timestamp} ${dow}] ${content}`;
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
    isMentioned: message.isMentioned,
    botTag: message.botTag,
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
  private activeTargets = new Map<string, MessageTarget>();
  private activeSubscriptions = new Set<string>();
  /** Periodic config refresh timer (safety net if event is missed) */
  private configRefreshTimer: ReturnType<typeof setInterval> | null = null;

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

    // Subscribe to config changes for cache invalidation
    this.subscribeToConfigChanges();

    // Subscribe to WhatsApp group operations
    this.subscribeToGroupOps();

    // Periodic config refresh as safety net (in case event is missed)
    this.configRefreshTimer = setInterval(() => {
      if (!this.running) return;
      this.routerConfig = loadRouterConfig();
    }, 60_000); // every 60 seconds

    log.info("Gateway started");
  }

  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;

    if (this.configRefreshTimer) {
      clearInterval(this.configRefreshTimer);
      this.configRefreshTimer = null;
    }

    // Stop via ChannelManager
    if (this.channelManager) {
      await this.channelManager.stopAll();
    }

    await shutdownAllPlugins();
    log.info("Gateway stopped");
  }

  /**
   * Generic subscription helper with auto-reconnect.
   * Reduces boilerplate across all subscription methods.
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

    log.info(`Subscribing to ${key}`, { topics });

    (async () => {
      try {
        for await (const event of notif.subscribe(...topics)) {
          if (!this.running) break;
          await handler(event);
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
   * Subscribe to inbound topics for all registered plugins.
   * Pattern: {channelId}.*.inbound
   */
  private subscribeToInbound(): void {
    const topics = this.plugins.map((p) => `${p.id}.*.inbound`);

    this.subscribe("inbound", topics, async (event) => {
      const parts = event.topic.split(".");
      const channelId = parts[0];
      const plugin = this.pluginsById.get(channelId);

      if (!plugin) {
        log.warn("No plugin for channel", { channelId });
        return;
      }

      const message = event.data as unknown as InboundMessage;
      await this.handleInboundMessage(plugin, message);
    });
  }

  /**
   * Subscribe to all bot responses and route based on target.
   */
  private subscribeToResponses(): void {
    this.subscribe("responses", ["ravi.session.*.response"], async (event) => {
      const sessionName = event.topic.split(".")[2];
      const response = event.data as unknown as ResponseMessage;

      log.debug("Response event received", {
        sessionName,
        keys: Object.keys(response),
        hasEmitId: !!response._emitId,
        emitId: response._emitId ?? "NONE",
      });

      const target = response.target;
      if (!target) return;

      const { channel, accountId, chatId } = target;
      const plugin = this.pluginsById.get(channel);
      if (!plugin) {
        log.warn("No plugin for channel", { channel });
        return;
      }

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
            sessionName,
            textPreview: text.slice(0, 200),
          });
          return;
        }
        log.info("Sending response", {
          sessionName, channel, chatId, textLen: text.length,
          emitId: response._emitId,
        });
        await plugin.outbound.send(accountId, chatId, { text });
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
        const target = this.activeTargets.get(sessionName);
        if (target) {
          const plugin = this.pluginsById.get(target.channel);
          if (plugin) {
            await plugin.outbound.sendTyping(target.accountId, target.chatId, false);
          }
          this.activeTargets.delete(sessionName);
        }
        return;
      }

      if (data.type === "system" || data.type === "assistant") {
        const target = this.activeTargets.get(sessionName);
        if (target) {
          const plugin = this.pluginsById.get(target.channel);
          if (plugin) {
            await plugin.outbound.sendTyping(target.accountId, target.chatId, true);
          }
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

      const plugin = this.pluginsById.get(data.channel);
      if (!plugin) {
        log.warn("No plugin for direct send channel", { channel: data.channel });
        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId: undefined });
          else notif.emit(data.replyTopic, { success: false, error: "No plugin" }).catch(() => {});
        }
        return;
      }

      try {
        let sendResult: SendResult = { success: true };

        if (data.pauseMs && data.pauseMs > 0) {
          await new Promise(resolve => setTimeout(resolve, data.pauseMs));
        }

        // Build outbound options (text or poll)
        const outboundOptions: import("./channels/types.js").OutboundOptions = data.poll
          ? { poll: data.poll }
          : { text: data.text };

        if (data.typingDelayMs && data.typingDelayMs > 0) {
          await plugin.outbound.sendTyping(data.accountId, data.to, true);
          await new Promise(resolve => setTimeout(resolve, data.typingDelayMs));
          sendResult = await plugin.outbound.send(data.accountId, data.to, outboundOptions);
          await plugin.outbound.sendTyping(data.accountId, data.to, false);
        } else {
          sendResult = await plugin.outbound.send(data.accountId, data.to, outboundOptions);
        }
        log.info("Direct send delivered", { to: data.to, channel: data.channel, messageId: sendResult.messageId });

        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId: sendResult.messageId });
          else notif.emit(data.replyTopic, sendResult as unknown as Record<string, unknown>).catch(() => {});
        }

        const entry = dbFindActiveEntryByPhone(data.to);
        if (entry && entry.id) {
          dbUpdateEntry(entry.id, {
            lastSentAt: Date.now(),
          });
        }
      } catch (err) {
        log.error("Failed to deliver direct send", { error: err });
        if (data.replyTopic) {
          const cb = pendingReplyCallbacks.get(data.replyTopic);
          if (cb) cb({ messageId: undefined });
          else notif.emit(data.replyTopic, { success: false, error: String(err) }).catch(() => {});
        }
      }
    });
  }

  /**
   * Subscribe to deferred outbound read receipts.
   */
  private subscribeToOutboundReceipts(): void {
    this.subscribe("receipts", ["ravi.outbound.receipt"], async (event) => {
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
        return;
      }

      try {
        await plugin.outbound.sendReadReceipt(data.accountId, data.chatId, data.messageIds);
        log.info("Deferred read receipt sent", { chatId: data.chatId, count: data.messageIds.length });
      } catch (err) {
        log.error("Failed to send deferred read receipt", { error: err });
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

      const plugin = this.pluginsById.get(data.channel);
      if (!plugin) {
        log.warn("No plugin for reaction channel", { channel: data.channel });
        return;
      }

      try {
        await plugin.outbound.sendReaction(data.accountId, data.chatId, data.messageId, data.emoji);
        log.info("Reaction sent", { chatId: data.chatId, messageId: data.messageId, emoji: data.emoji });
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

      const plugin = this.pluginsById.get(data.channel);
      if (!plugin) {
        log.warn("No plugin for media send channel", { channel: data.channel });
        return;
      }

      try {
        const buffer = await readFile(data.filePath);

        const result = await plugin.outbound.send(data.accountId, data.chatId, {
          media: {
            type: data.type,
            data: buffer,
            mimetype: data.mimetype,
            filename: data.filename,
            caption: data.caption,
          },
          text: data.caption,
        });
        if (result.success) {
          log.info("Media sent", { chatId: data.chatId, type: data.type, filename: data.filename });
        } else {
          log.error("Media send failed", { chatId: data.chatId, error: result.error });
        }
      } catch (err) {
        log.error("Failed to send media", { error: err });
      }
    });
  }

  /**
   * Subscribe to config changes for cache invalidation.
   * CLI commands emit this event when routes/settings change.
   */
  private subscribeToConfigChanges(): void {
    this.subscribe("config", ["ravi.config.changed"], async () => {
      this.routerConfig = loadRouterConfig();
      log.info("Router config reloaded");
    });
  }

  /**
   * Subscribe to WhatsApp group operation requests.
   * CLI commands emit ravi.whatsapp.group.{op} with a replyTopic.
   * We execute the operation and emit the result back.
   */
  private subscribeToGroupOps(): void {
    this.subscribe("groupOps", ["ravi.whatsapp.group.*"], async (event) => {
      const data = event.data as Record<string, unknown>;
      const replyTopic = data.replyTopic as string | undefined;

      // Extract operation from topic: ravi.whatsapp.group.{op}
      const op = event.topic.split(".").pop() as GroupOpName;

      try {
        const result = await dispatchGroupOp(op, data);

        if (replyTopic) {
          await notif.emit(replyTopic, result);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error("Group operation failed", { op, error });

        if (replyTopic) {
          await notif.emit(replyTopic, { error });
        }
      }
    });
  }

  private async handleInboundMessage(
    plugin: ChannelPlugin,
    message: InboundMessage
  ): Promise<void> {
    // Config is now kept fresh via subscribeToConfigChanges

    // Slash command interception — before any other processing
    const text = message.text?.trim() ?? "";
    if (text.startsWith("/")) {
      const handled = await handleSlashCommand({
        text,
        senderId: message.senderId,
        senderName: message.senderName,
        chatId: message.chatId,
        isGroup: message.isGroup,
        mentions: message.mentions,
        plugin,
        accountId: message.accountId,
        routerConfig: this.routerConfig,
      });
      if (handled) return;
      // Command not found or no permission → fall through to normal processing
    }

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

    const sessionName = resolved.sessionName;

    log.info("Inbound message", {
      channel: plugin.id,
      sender: message.senderId,
      sessionName,
      agentId: resolved.agent.id,
    });

    // Move media from /tmp staging to agent's attachments directory
    if (message.media?.localPath) {
      try {
        const agentCwd = expandHome(resolved.agent.cwd);
        const attachDir = path.join(agentCwd, "attachments");
        await mkdir(attachDir, { recursive: true });
        const filename = path.basename(message.media.localPath);
        const targetPath = path.join(attachDir, filename);
        await rename(message.media.localPath, targetPath);
        message.media.localPath = targetPath;
      } catch (err) {
        log.warn("Failed to move media to agent workspace, keeping original path", { error: err });
      }
    }

    // Persist message metadata (transcription + final media path) for reply reinjection
    if (message.transcription || message.media?.localPath) {
      dbSaveMessageMeta(message.id, message.chatId, {
        transcription: message.transcription,
        mediaPath: message.media?.localPath,
        mediaType: message.media?.type,
      });
    }

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
    this.activeTargets.set(sessionName, source);

    // Typing indicator
    await plugin.outbound.sendTyping(message.accountId, message.chatId, true);

    // Emit prompt with source and context
    try {
      await notif.emit(`ravi.session.${sessionName}.prompt`, {
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
