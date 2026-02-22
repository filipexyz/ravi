/**
 * ConfigStore — Singleton for cached RouterConfig + account identity resolution.
 *
 * Refresh strategy:
 *   1. NATS `ravi.config.changed` subscription (immediate)
 *   2. 30-second periodic fallback (safety net)
 *
 * Must be initialized after NATS is connected. First call to getConfig()
 * loads from DB; subsequent calls return cache.
 */

import { loadRouterConfig } from "./router/config.js";
import type { RouterConfig } from "./router/types.js";
import { logger } from "./utils/logger.js";

const log = logger.child("config-store");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConfigStore {
  private config: RouterConfig | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptionRunning = false;

  /** Return cached config, loading from DB on first call. */
  getConfig(): RouterConfig {
    if (!this.config) {
      this.config = loadRouterConfig();
    }
    return this.config;
  }

  /** Force a refresh from DB (called by NATS sub and periodic timer). */
  refresh(): void {
    this.config = loadRouterConfig();
    log.debug("Config refreshed");
  }

  /**
   * Resolve account name → omni instance UUID.
   * Returns undefined if not found. Passes through raw UUIDs.
   */
  resolveInstanceId(accountName: string): string | undefined {
    if (!accountName) {
      log.warn("Cannot resolve instance: accountId is empty (session has no account context)");
      return undefined;
    }
    if (UUID_RE.test(accountName)) return accountName;

    const cfg = this.getConfig();
    // Reverse of instanceToAccount: iterate to find name → UUID
    for (const [uuid, name] of Object.entries(cfg.instanceToAccount)) {
      if (name === accountName) return uuid;
    }
    log.warn(`Cannot resolve instance for account "${accountName}" — no matching instanceId setting found`);
    return undefined;
  }

  /**
   * Resolve omni instance UUID → account name.
   * Returns undefined if not registered.
   */
  resolveAccountName(instanceId: string): string | undefined {
    return this.getConfig().instanceToAccount[instanceId];
  }

  /**
   * Start background refresh: NATS subscription + periodic timer.
   * Call after NATS is connected (daemon startup).
   */
  async startRefresh(): Promise<void> {
    // Periodic fallback (30s)
    this.refreshTimer = setInterval(() => this.refresh(), 30_000);

    // NATS subscription with auto-reconnect
    this.runConfigSubscription();
  }

  /** Stop background refresh. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.subscriptionRunning = false;
  }

  private runConfigSubscription(): void {
    if (this.subscriptionRunning) return;
    this.subscriptionRunning = true;

    (async () => {
      // Lazy import to avoid circular dependency / import-before-connect issues
      const { nats } = await import("./nats.js");
      while (this.subscriptionRunning) {
        try {
          for await (const _event of nats.subscribe("ravi.config.changed")) {
            if (!this.subscriptionRunning) break;
            this.refresh();
          }
        } catch (err) {
          if (!this.subscriptionRunning) break;
          log.warn("Config subscription error, reconnecting in 2s", { error: err });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  }
}

/** Module-level singleton. */
export const configStore = new ConfigStore();
