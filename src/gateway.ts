/**
 * Channel Gateway
 *
 * Orchestrates channel plugins and routes messages to the bot.
 */

import { Notif } from "notif.sh";
import type { ChannelPlugin, InboundMessage, AccountState } from "./channels/types.js";
import { registerPlugin, getAllPlugins, shutdownAllPlugins } from "./channels/registry.js";
import { ChannelManager, createChannelManager } from "./channels/manager/index.js";
import {
  loadRouterConfig,
  resolveRoute,
  type RouterConfig,
} from "./router/index.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage, MessageTarget } from "./bot.js";

const log = logger.child("gateway");

export interface GatewayOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
}

export class Gateway {
  private notif: Notif;
  private routerConfig: RouterConfig;
  private running = false;
  private plugins: ChannelPlugin[] = [];
  private pluginsById = new Map<string, ChannelPlugin>();
  private channelManager: ChannelManager | null = null;
  private responseSubscriptions = new Map<string, AbortController>();
  private activeTargets = new Map<string, MessageTarget>();

  constructor(options: GatewayOptions = {}) {
    this.notif = new Notif();
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
    this.notif.close();
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
        for await (const event of this.notif.subscribe(...topics)) {
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
        for await (const event of this.notif.subscribe("ravi.*.response")) {
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
        for await (const event of this.notif.subscribe("ravi.*.claude")) {
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

  private async handleInboundMessage(
    plugin: ChannelPlugin,
    message: InboundMessage
  ): Promise<void> {
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

    // Store target for typing heartbeat
    this.activeTargets.set(sessionKey, source);

    // Typing indicator
    await plugin.outbound.sendTyping(message.accountId, message.chatId, true);

    // Emit prompt with source
    try {
      await this.notif.emit(`ravi.${sessionKey}.prompt`, {
        prompt: message.text ?? "[media]",
        source,
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
