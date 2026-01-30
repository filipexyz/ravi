/**
 * Channels Commands - Channel management CLI
 *
 * Provides status, start, stop, and restart commands for channels.
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { createWhatsAppPlugin } from "../../channels/whatsapp/plugin.js";
import { createChannelManager, type ChannelAccountSnapshot } from "../../channels/manager/index.js";
import type { ChannelPlugin } from "../../channels/types.js";

/**
 * Parse channel:account identifier
 */
function parseChannelSpec(spec: string): { channelId: string; accountId?: string } {
  const parts = spec.split(":");
  return {
    channelId: parts[0],
    accountId: parts[1],
  };
}

/**
 * Format uptime duration
 */
function formatUptime(startAt: number | undefined): string {
  if (!startAt) return "-";
  const ms = Date.now() - startAt;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format account status indicator
 */
function formatStatus(snapshot: ChannelAccountSnapshot): { icon: string; status: string } {
  if (!snapshot.enabled) {
    return { icon: "○", status: "disabled" };
  }
  if (!snapshot.configured) {
    return { icon: "○", status: "not configured" };
  }
  if (!snapshot.running) {
    return { icon: "○", status: "stopped" };
  }
  if (snapshot.connected) {
    return { icon: "✓", status: "connected" };
  }
  if (snapshot.lastError) {
    return { icon: "✗", status: `error: ${snapshot.lastError}` };
  }
  return { icon: "◐", status: "connecting" };
}

/**
 * Load all plugins for the manager
 */
function loadPlugins(): Map<string, ChannelPlugin> {
  const plugins = new Map<string, ChannelPlugin>();

  // WhatsApp plugin with default account
  const wa = createWhatsAppPlugin({
    accounts: {
      default: {
        name: "Ravi WhatsApp",
        enabled: true,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        sendReadReceipts: true,
        debounceMs: 500,
      },
    },
  });
  plugins.set(wa.id, wa);

  return plugins;
}

@Group({
  name: "channels",
  description: "Channel management",
})
export class ChannelsCommands {
  @Command({ name: "status", description: "Show channel status" })
  async status(
    @Arg("channel", { required: false, description: "Channel ID (e.g., whatsapp)" }) channel?: string
  ) {
    const plugins = loadPlugins();
    const manager = createChannelManager(plugins, { autoStart: false });

    // Initialize plugins to get account info
    for (const plugin of plugins.values()) {
      await plugin.init();
    }

    // Build status from plugins (without starting)
    const channelsToShow = channel ? [channel] : Array.from(plugins.keys());

    console.log("\nChannel Status");
    console.log("──────────────\n");

    for (const channelId of channelsToShow) {
      const plugin = plugins.get(channelId);
      if (!plugin) {
        console.log(`${channelId} (unknown channel)`);
        continue;
      }

      console.log(channelId);

      const accountIds = plugin.config.listAccounts();
      if (accountIds.length === 0) {
        console.log("  (no accounts configured)");
        continue;
      }

      for (const accountId of accountIds) {
        const resolved = plugin.config.resolveAccount(accountId);
        if (!resolved) continue;

        // Build a minimal snapshot from resolved account
        const snapshot: ChannelAccountSnapshot = {
          accountId,
          name: resolved.name,
          enabled: resolved.enabled,
          configured: true,
          linked: resolved.state === "connected",
          running: resolved.state !== "disconnected",
          connected: resolved.state === "connected",
          reconnectAttempts: 0,
        };

        const { icon, status } = formatStatus(snapshot);
        const phone = resolved.phone ? `(+${resolved.phone})` : "";
        const name = snapshot.name || accountId;

        console.log(`  ${name.padEnd(10)} ${icon} ${status.padEnd(15)} ${phone}`);
      }

      console.log();
    }

    // Shutdown plugins
    for (const plugin of plugins.values()) {
      await plugin.shutdown();
    }
  }

  @Command({ name: "start", description: "Start a channel or account" })
  async start(
    @Arg("target", { description: "Channel or channel:account (e.g., whatsapp, whatsapp:main)" }) target: string
  ) {
    const { channelId, accountId } = parseChannelSpec(target);

    const plugins = loadPlugins();
    const manager = createChannelManager(plugins);

    // Subscribe to events
    manager.on("started", (ch, acc) => {
      console.log(`✓ Started ${ch}:${acc}`);
    });

    manager.on("error", (ch, acc, err) => {
      console.error(`✗ Error ${ch}:${acc}: ${err.message}`);
    });

    try {
      if (accountId) {
        console.log(`Starting ${channelId}:${accountId}...`);
        await manager.startChannel(channelId, accountId);
      } else {
        console.log(`Starting all accounts for ${channelId}...`);
        await manager.startChannel(channelId);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "stop", description: "Stop a channel or account" })
  async stop(
    @Arg("target", { description: "Channel or channel:account (e.g., whatsapp, whatsapp:main)" }) target: string
  ) {
    const { channelId, accountId } = parseChannelSpec(target);

    const plugins = loadPlugins();
    const manager = createChannelManager(plugins);

    // Subscribe to events
    manager.on("stopped", (ch, acc) => {
      console.log(`✓ Stopped ${ch}:${acc}`);
    });

    try {
      if (accountId) {
        console.log(`Stopping ${channelId}:${accountId}...`);
        await manager.stopChannel(channelId, accountId);
      } else {
        console.log(`Stopping all accounts for ${channelId}...`);
        await manager.stopChannel(channelId);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "restart", description: "Restart a channel or account" })
  async restart(
    @Arg("target", { description: "Channel or channel:account (e.g., whatsapp, whatsapp:main)" }) target: string
  ) {
    const { channelId, accountId } = parseChannelSpec(target);

    const plugins = loadPlugins();
    const manager = createChannelManager(plugins);

    // Subscribe to events
    manager.on("stopped", (ch, acc) => {
      console.log(`  Stopped ${ch}:${acc}`);
    });

    manager.on("started", (ch, acc) => {
      console.log(`  Started ${ch}:${acc}`);
    });

    manager.on("error", (ch, acc, err) => {
      console.error(`✗ Error ${ch}:${acc}: ${err.message}`);
    });

    try {
      if (accountId) {
        console.log(`Restarting ${channelId}:${accountId}...`);
        await manager.stopChannel(channelId, accountId);
        await manager.startChannel(channelId, accountId);
        console.log(`✓ Restarted ${channelId}:${accountId}`);
      } else {
        console.log(`Restarting all accounts for ${channelId}...`);
        await manager.stopChannel(channelId);
        await manager.startChannel(channelId);
        console.log(`✓ Restarted ${channelId}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "list", description: "List all configured channels" })
  async list() {
    const plugins = loadPlugins();

    console.log("\nConfigured Channels");
    console.log("───────────────────\n");

    console.log("  ID          VERSION     CAPABILITIES");
    console.log("  ──────────  ──────────  ────────────────────────────────────");

    for (const [id, plugin] of plugins) {
      const caps = Object.entries(plugin.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ");

      console.log(`  ${id.padEnd(10)}  ${plugin.meta.version.padEnd(10)}  ${caps}`);
    }

    console.log(`\n  Total: ${plugins.size}\n`);
  }
}
