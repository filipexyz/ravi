/**
 * Channels Commands - Channel status via omni HTTP API
 *
 * Channels are now managed through omni. Use `ravi whatsapp` for WhatsApp.
 */

import "reflect-metadata";
import { Group, Command } from "../decorators.js";
import { createOmniClient } from "@omni/sdk";
import { resolveOmniConnection } from "../../omni-config.js";

function getOmniClient() {
  const conn = resolveOmniConnection();
  if (!conn) return null;
  return createOmniClient({ baseUrl: conn.apiUrl, apiKey: conn.apiKey });
}

@Group({
  name: "channels",
  description: "Channel status",
  scope: "admin",
})
export class ChannelsCommands {
  @Command({ name: "status", description: "Show channel status" })
  async status() {
    const omni = getOmniClient();
    if (!omni) {
      console.log("Omni not running. Start the daemon: ravi daemon start");
      return;
    }

    try {
      const result = await omni.instances.list({});
      if (result.items.length === 0) {
        console.log("No channel instances configured.");
        console.log("Connect WhatsApp: ravi whatsapp connect");
        return;
      }

      console.log("\nChannel Instances\n");
      for (const instance of result.items) {
        const status = instance.isActive ? "✓ connected" : "○ disconnected";
        console.log(`  ${instance.channel.padEnd(20)} ${instance.name.padEnd(20)} [${status}]`);
      }
      console.log();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
    }
  }

  @Command({ name: "list", description: "List all channel instances" })
  async list() {
    return this.status();
  }
}
