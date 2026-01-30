/**
 * Channel Manager
 *
 * Orchestrates the lifecycle of all channel accounts.
 * Provides unified start/stop, status tracking, and AbortSignal integration.
 */

import type { ChannelPlugin, AccountState } from "../types.js";
import type {
  ChannelAccountSnapshot,
  ChannelRuntimeStore,
  ChannelGatewayContext,
  ChannelManagerConfig,
  ChannelManagerEvents,
} from "./types.js";
import { DEFAULT_MANAGER_CONFIG } from "./types.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("channel-manager");

/**
 * ChannelManager orchestrates the lifecycle of all channel accounts.
 *
 * Features:
 * - Unified start/stop for all channels
 * - AbortSignal for graceful shutdown
 * - Runtime state tracking per account
 * - Event emission for state changes
 */
export class ChannelManager {
  private stores = new Map<string, ChannelRuntimeStore>();
  private listeners = new Map<
    keyof ChannelManagerEvents,
    Set<ChannelManagerEvents[keyof ChannelManagerEvents]>
  >();
  private config: ChannelManagerConfig;

  constructor(
    private plugins: Map<string, ChannelPlugin>,
    config: Partial<ChannelManagerConfig> = {}
  ) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };

    // Initialize stores for each plugin
    for (const [channelId] of plugins) {
      this.stores.set(channelId, {
        channelId,
        aborts: new Map(),
        tasks: new Map(),
        runtimes: new Map(),
      });
    }
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Start all enabled channels and accounts.
   */
  async startChannels(): Promise<void> {
    log.info("Starting all channels...");

    const startPromises: Promise<void>[] = [];

    for (const [channelId, plugin] of this.plugins) {
      // Initialize plugin first
      await plugin.init();

      // Start each account in parallel
      for (const accountId of plugin.config.listAccounts()) {
        startPromises.push(
          this.startAccount(channelId, accountId).catch((err) => {
            log.error(`Failed to start ${channelId}:${accountId}`, err);
          })
        );
      }
    }

    await Promise.all(startPromises);
    log.info("All channels started");
  }

  /**
   * Start a specific channel (all accounts) or a specific account.
   */
  async startChannel(channelId: string, accountId?: string): Promise<void> {
    const plugin = this.plugins.get(channelId);
    if (!plugin) {
      throw new Error(`Unknown channel: ${channelId}`);
    }

    if (accountId) {
      await this.startAccount(channelId, accountId);
    } else {
      // Start all accounts for this channel
      const startPromises = plugin.config.listAccounts().map((accId) =>
        this.startAccount(channelId, accId).catch((err) => {
          log.error(`Failed to start ${channelId}:${accId}`, err);
        })
      );
      await Promise.all(startPromises);
    }
  }

  /**
   * Stop a specific channel (all accounts) or a specific account.
   */
  async stopChannel(channelId: string, accountId?: string): Promise<void> {
    const plugin = this.plugins.get(channelId);
    if (!plugin) {
      throw new Error(`Unknown channel: ${channelId}`);
    }

    if (accountId) {
      await this.stopAccount(channelId, accountId);
    } else {
      // Stop all accounts for this channel
      const store = this.stores.get(channelId);
      if (!store) return;

      const stopPromises = Array.from(store.runtimes.keys()).map((accId) =>
        this.stopAccount(channelId, accId).catch((err) => {
          log.error(`Failed to stop ${channelId}:${accId}`, err);
        })
      );
      await Promise.all(stopPromises);
    }
  }

  /**
   * Stop all channels and accounts.
   */
  async stopAll(): Promise<void> {
    log.info("Stopping all channels...");

    const stopPromises: Promise<void>[] = [];

    for (const [channelId] of this.plugins) {
      stopPromises.push(this.stopChannel(channelId));
    }

    await Promise.all(stopPromises);
    log.info("All channels stopped");
  }

  // ===========================================================================
  // Status Methods
  // ===========================================================================

  /**
   * Get snapshots for all accounts of a channel.
   */
  getChannelSnapshot(channelId: string): ChannelAccountSnapshot[] {
    const store = this.stores.get(channelId);
    if (!store) {
      return [];
    }
    return Array.from(store.runtimes.values());
  }

  /**
   * Get snapshots for all channels and accounts.
   */
  getAllSnapshots(): Map<string, ChannelAccountSnapshot[]> {
    const result = new Map<string, ChannelAccountSnapshot[]>();
    for (const [channelId, store] of this.stores) {
      result.set(channelId, Array.from(store.runtimes.values()));
    }
    return result;
  }

  /**
   * Get snapshot for a specific account.
   */
  getAccountSnapshot(
    channelId: string,
    accountId: string
  ): ChannelAccountSnapshot | null {
    const store = this.stores.get(channelId);
    return store?.runtimes.get(accountId) ?? null;
  }

  /**
   * Get list of all channel IDs.
   */
  getChannelIds(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * Get a plugin by channel ID.
   */
  getPlugin(channelId: string): ChannelPlugin | undefined {
    return this.plugins.get(channelId);
  }

  // ===========================================================================
  // Event Methods
  // ===========================================================================

  /**
   * Subscribe to manager events.
   */
  on<K extends keyof ChannelManagerEvents>(
    event: K,
    callback: ChannelManagerEvents[K]
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners
      .get(event)!
      .add(callback as ChannelManagerEvents[keyof ChannelManagerEvents]);

    return () => {
      this.listeners
        .get(event)
        ?.delete(callback as ChannelManagerEvents[keyof ChannelManagerEvents]);
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async startAccount(
    channelId: string,
    accountId: string
  ): Promise<void> {
    const plugin = this.plugins.get(channelId);
    const store = this.stores.get(channelId);
    if (!plugin || !store) return;

    const accountLog = logger.child(`${channelId}:${accountId}`);

    // Check if already running
    const existing = store.runtimes.get(accountId);
    if (existing?.running) {
      accountLog.debug("Already running, skipping start");
      return;
    }

    // Resolve account to check if enabled
    const resolved = plugin.config.resolveAccount(accountId);
    if (!resolved) {
      this.setRuntime(channelId, accountId, {
        accountId,
        enabled: false,
        configured: false,
        linked: false,
        running: false,
        connected: false,
        reconnectAttempts: 0,
        lastError: "Account not found",
      });
      return;
    }

    if (!resolved.enabled) {
      this.setRuntime(channelId, accountId, {
        accountId,
        name: resolved.name,
        enabled: false,
        configured: true,
        linked: false,
        running: false,
        connected: false,
        reconnectAttempts: 0,
        lastError: "Account disabled",
      });
      accountLog.info("Account disabled, skipping");
      return;
    }

    // Create AbortController
    const abortController = new AbortController();
    store.aborts.set(accountId, abortController);

    // Initialize runtime state
    this.setRuntime(channelId, accountId, {
      accountId,
      name: resolved.name,
      enabled: true,
      configured: true,
      linked: resolved.state === "connected",
      running: true,
      connected: false,
      lastStartAt: Date.now(),
      reconnectAttempts: 0,
      lastError: null,
    });

    accountLog.info("Starting account");

    // Create context for the gateway
    const ctx = this.createGatewayContext(channelId, accountId, abortController);

    // Subscribe to state changes from the plugin
    const unsubscribe = plugin.gateway.onStateChange((accId, state) => {
      if (accId !== accountId) return;
      this.handleStateChange(channelId, accountId, state);
    });

    // Start the gateway (returns a promise that resolves when connected or rejects on error)
    const config = plugin.config.getConfig();

    try {
      // The gateway.start may return immediately or block until connected
      // We wrap it in a task so we can track it
      const task = (async () => {
        try {
          await plugin.gateway.start(accountId, config);
        } catch (err) {
          if (!abortController.signal.aborted) {
            accountLog.error("Gateway start failed", err);
            this.setRuntime(channelId, accountId, {
              running: false,
              lastError: err instanceof Error ? err.message : String(err),
            });
            this.emit("error", channelId, accountId, err as Error);
          }
        }
      })();

      store.tasks.set(accountId, task);

      // Attach cleanup on abort
      abortController.signal.addEventListener("abort", () => {
        unsubscribe();
      });

      this.emit("started", channelId, accountId);
    } catch (err) {
      accountLog.error("Failed to start account", err);
      store.aborts.delete(accountId);
      this.setRuntime(channelId, accountId, {
        running: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      this.emit("error", channelId, accountId, err as Error);
      throw err;
    }
  }

  private async stopAccount(
    channelId: string,
    accountId: string
  ): Promise<void> {
    const plugin = this.plugins.get(channelId);
    const store = this.stores.get(channelId);
    if (!plugin || !store) return;

    const accountLog = logger.child(`${channelId}:${accountId}`);
    accountLog.info("Stopping account");

    // Abort the controller to signal shutdown
    const abort = store.aborts.get(accountId);
    if (abort) {
      abort.abort();
    }

    // Call plugin's stop
    try {
      await plugin.gateway.stop(accountId);
    } catch (err) {
      accountLog.error("Error stopping gateway", err);
    }

    // Wait for task to complete
    const task = store.tasks.get(accountId);
    if (task) {
      try {
        await task;
      } catch {
        // Ignore - already logged
      }
    }

    // Cleanup
    store.aborts.delete(accountId);
    store.tasks.delete(accountId);

    // Update runtime
    this.setRuntime(channelId, accountId, {
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });

    this.emit("stopped", channelId, accountId);
    accountLog.info("Account stopped");
  }

  private createGatewayContext(
    channelId: string,
    accountId: string,
    abortController: AbortController
  ): ChannelGatewayContext {
    const plugin = this.plugins.get(channelId)!;
    const config = plugin.config.getConfig();

    return {
      channelId,
      accountId,
      account: plugin.config.resolveAccount(accountId),
      config,
      abortSignal: abortController.signal,
      getStatus: () => this.getAccountSnapshot(channelId, accountId)!,
      setStatus: (partial) => this.setRuntime(channelId, accountId, partial),
      log: logger.child(`${channelId}:${accountId}`),
    };
  }

  private setRuntime(
    channelId: string,
    accountId: string,
    partial: Partial<ChannelAccountSnapshot>
  ): void {
    const store = this.stores.get(channelId);
    if (!store) return;

    const existing = store.runtimes.get(accountId) ?? {
      accountId,
      enabled: false,
      configured: false,
      linked: false,
      running: false,
      connected: false,
      reconnectAttempts: 0,
    };

    const updated: ChannelAccountSnapshot = { ...existing, ...partial };
    store.runtimes.set(accountId, updated);

    this.emit("stateChange", channelId, accountId, updated);
  }

  private handleStateChange(
    channelId: string,
    accountId: string,
    state: AccountState
  ): void {
    const connected = state === "connected";
    const updates: Partial<ChannelAccountSnapshot> = {
      connected,
      linked: connected,
    };

    if (connected) {
      updates.lastConnectedAt = Date.now();
      updates.reconnectAttempts = 0;
      updates.lastError = null;
    } else if (state === "disconnected") {
      updates.lastDisconnect = {
        reason: "disconnected",
        at: Date.now(),
      };
    } else if (state === "error") {
      updates.lastError = "Connection error";
    }

    this.setRuntime(channelId, accountId, updates);
  }

  private emit<K extends keyof ChannelManagerEvents>(
    event: K,
    ...args: Parameters<ChannelManagerEvents[K]>
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
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ChannelManager from a map of plugins.
 */
export function createChannelManager(
  plugins: Map<string, ChannelPlugin>,
  config?: Partial<ChannelManagerConfig>
): ChannelManager {
  return new ChannelManager(plugins, config);
}

// Re-export types
export * from "./types.js";
