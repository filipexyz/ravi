/**
 * Channel Gateway
 *
 * Orchestrates multiple channel plugins and bridges them to the bot via notif.sh.
 */

import { Notif } from "notif.sh";
import type { ChannelPlugin, InboundMessage, AccountState } from "./channels/types.js";
import { registerPlugin, getAllPlugins, shutdownAllPlugins } from "./channels/registry.js";
import { jidToSessionId } from "./channels/whatsapp/normalize.js";
import { logger } from "./utils/logger.js";
import type { ResponseMessage } from "./bot.js";

const log = logger.child("gateway");

// ============================================================================
// Types
// ============================================================================

export interface GatewayOptions {
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface GatewayEvents {
  message: (message: InboundMessage) => void;
  stateChange: (channelId: string, accountId: string, state: AccountState) => void;
}

// ============================================================================
// Gateway Class
// ============================================================================

/**
 * Channel Gateway
 *
 * Manages channel plugins and routes messages between channels and the bot.
 */
export class Gateway {
  private notif: Notif;
  private running = false;
  private plugins: ChannelPlugin[] = [];
  private responseSubscriptions = new Map<string, AbortController>();
  private listeners = new Map<keyof GatewayEvents, Set<GatewayEvents[keyof GatewayEvents]>>();

  constructor(options: GatewayOptions = {}) {
    this.notif = new Notif();
    if (options.logLevel) {
      logger.setLevel(options.logLevel);
    }
  }

  /**
   * Register a channel plugin
   */
  use(plugin: ChannelPlugin): this {
    registerPlugin(plugin);
    this.plugins.push(plugin);
    return this;
  }

  /**
   * Start the gateway and all plugins
   */
  async start(): Promise<void> {
    log.info("Starting gateway...");
    this.running = true;

    // Initialize all plugins
    for (const plugin of this.plugins) {
      log.info(`Initializing plugin: ${plugin.id}`);
      await plugin.init();

      // Subscribe to plugin messages
      plugin.gateway.onMessage((message) => {
        this.handleInboundMessage(plugin, message);
      });

      // Subscribe to state changes
      plugin.gateway.onStateChange((accountId, state) => {
        this.emit("stateChange", plugin.id, accountId, state);
      });

      // Start all configured accounts
      const config = plugin.config.getConfig();
      for (const accountId of plugin.config.listAccounts()) {
        try {
          await plugin.gateway.start(accountId, config);
        } catch (err) {
          log.error(`Failed to start ${plugin.id}:${accountId}`, err);
        }
      }
    }

    log.info("Gateway started");
  }

  /**
   * Stop the gateway and all plugins
   */
  async stop(): Promise<void> {
    log.info("Stopping gateway...");
    this.running = false;

    // Cancel all response subscriptions
    for (const [, controller] of this.responseSubscriptions) {
      controller.abort();
    }
    this.responseSubscriptions.clear();

    // Shutdown all plugins
    await shutdownAllPlugins();

    this.notif.close();
    log.info("Gateway stopped");
  }

  /**
   * Subscribe to gateway events
   */
  on<K extends keyof GatewayEvents>(
    event: K,
    callback: GatewayEvents[K]
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as GatewayEvents[keyof GatewayEvents]);

    return () => {
      this.listeners.get(event)?.delete(callback as GatewayEvents[keyof GatewayEvents]);
    };
  }

  /**
   * Get a registered plugin
   */
  getPlugin(id: string): ChannelPlugin | undefined {
    return this.plugins.find((p) => p.id === id);
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): ChannelPlugin[] {
    return [...this.plugins];
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private emit<K extends keyof GatewayEvents>(
    event: K,
    ...args: Parameters<GatewayEvents[K]>
  ): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          (callback as (...args: unknown[]) => void)(...args);
        } catch (err) {
          log.error(`Error in ${event} listener`, err);
        }
      }
    }
  }

  private async handleInboundMessage(
    plugin: ChannelPlugin,
    message: InboundMessage
  ): Promise<void> {
    log.info("Inbound message", {
      channel: plugin.id,
      account: message.accountId,
      sender: message.senderId,
      textLen: message.text?.length,
    });

    // Emit to listeners
    this.emit("message", message);

    // Generate session ID
    const sessionId = this.messageToSessionId(plugin, message);

    // Show typing indicator
    await plugin.outbound.sendTyping(
      message.accountId,
      message.chatId,
      true
    );

    // Subscribe to response for this session
    this.subscribeToResponse(plugin, message, sessionId);

    // Emit prompt to notif.sh
    try {
      await this.notif.emit(`ravi.${sessionId}.prompt`, {
        prompt: message.text ?? "[media]",
      });
      log.debug("Emitted prompt", { sessionId });
    } catch (err) {
      log.error("Failed to emit prompt", err);
      await this.sendErrorResponse(plugin, message, "Something went wrong. Please try again.");
    }
  }

  private subscribeToResponse(
    plugin: ChannelPlugin,
    message: InboundMessage,
    sessionId: string
  ): void {
    // Skip if already subscribed
    if (this.responseSubscriptions.has(sessionId)) return;

    const controller = new AbortController();
    this.responseSubscriptions.set(sessionId, controller);

    const topic = `ravi.${sessionId}.response`;

    (async () => {
      try {
        for await (const event of this.notif.subscribe(topic)) {
          if (controller.signal.aborted) break;

          const response = event.data as unknown as ResponseMessage;

          // Stop typing indicator
          await plugin.outbound.sendTyping(
            message.accountId,
            message.chatId,
            false
          );

          // Send response
          if (response.error) {
            await plugin.outbound.send(message.accountId, message.chatId, {
              text: `Error: ${response.error}`,
            });
          } else if (response.response) {
            await plugin.outbound.send(message.accountId, message.chatId, {
              text: response.response,
            });
          }

          log.debug("Sent response via channel", {
            channel: plugin.id,
            sessionId,
            hasError: !!response.error,
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          log.error("Response subscription error", err);
        }
      }
    })();
  }

  private async sendErrorResponse(
    plugin: ChannelPlugin,
    message: InboundMessage,
    errorText: string
  ): Promise<void> {
    await plugin.outbound.sendTyping(message.accountId, message.chatId, false);
    await plugin.outbound.send(message.accountId, message.chatId, {
      text: errorText,
    });
  }

  private messageToSessionId(
    plugin: ChannelPlugin,
    message: InboundMessage
  ): string {
    // For WhatsApp, use the existing JID-based session ID format
    if (plugin.id === "whatsapp") {
      const waMessage = message as import("./channels/types.js").WhatsAppInbound;
      return jidToSessionId(waMessage.jid);
    }

    // Generic format for other channels
    return `${plugin.id}-${message.chatId}`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new gateway instance
 */
export function createGateway(options?: GatewayOptions): Gateway {
  return new Gateway(options);
}
