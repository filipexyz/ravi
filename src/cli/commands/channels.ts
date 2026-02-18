/**
 * Channels Commands - Channel status via omni HTTP API
 *
 * Channels are now managed through omni. Use `ravi whatsapp` for WhatsApp.
 */

import "reflect-metadata";
import { Group, Command } from "../decorators.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createOmniClient } from "@omni/sdk";

const OMNI_API_KEY_FILE = join(homedir(), ".ravi", "omni-api-key");
const DEFAULT_OMNI_API_URL = `http://127.0.0.1:${process.env.OMNI_API_PORT ?? "8882"}`;

function getOmniClient() {
  const apiUrl = process.env.OMNI_API_URL ?? DEFAULT_OMNI_API_URL;
  if (!existsSync(OMNI_API_KEY_FILE)) return null;
  const apiKey = readFileSync(OMNI_API_KEY_FILE, "utf-8").trim();
  if (!apiKey) return null;
  return createOmniClient({ baseUrl: apiUrl, apiKey });
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
