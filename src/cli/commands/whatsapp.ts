/**
 * WhatsApp Commands - Account management via omni HTTP API
 */

import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import qrcode from "qrcode-terminal";
import { Group, Command, Option } from "../decorators.js";
import { fail } from "../context.js";
import { nats } from "../../nats.js";
import { createOmniClient } from "@omni/sdk";
import {
  dbGetSetting,
  dbSetSetting,
  dbDeleteSetting,
  dbGetAgent,
  dbCreateAgent,
  dbUpdateAgent,
} from "../../router/router-db.js";
import { resolveOmniConnection } from "../../omni-config.js";

function getOmniClient() {
  const conn = resolveOmniConnection();
  if (!conn) {
    fail("Omni not configured. Is omni running? (omni status)");
  }
  return createOmniClient({ baseUrl: conn.apiUrl, apiKey: conn.apiKey });
}

/**
 * Find or create a WhatsApp instance by name in omni.
 * Returns the instance UUID.
 */
async function resolveInstanceId(name: string): Promise<string | null> {
  // First check ravi settings for cached instanceId
  const cached = dbGetSetting(`account.${name}.instanceId`);
  if (cached) return cached;

  // Query omni for existing instance with this name
  try {
    const omni = getOmniClient();
    const result = await omni.instances.list({ channel: "whatsapp-baileys" });
    const existing = result.items.find((i: { name?: string | null; id?: string | null }) => i.name === name);
    if (existing?.id) {
      dbSetSetting(`account.${name}.instanceId`, existing.id);
      return existing.id;
    }
  } catch {
    // omni not available
  }

  return null;
}

@Group({
  name: "whatsapp",
  description: "WhatsApp account management",
  scope: "admin",
})
export class WhatsAppCommands {
  @Command({ name: "connect", description: "Connect a WhatsApp account (scan QR code)" })
  async connect(
    @Option({ flags: "--account <id>", description: 'Account name (default: "default")' }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to" }) agent?: string,
    @Option({ flags: "--mode <mode>", description: "Agent mode: active or sentinel" }) mode?: string
  ) {
    const accountName = account ?? "default";
    const TIMEOUT_MS = 120_000;

    const omni = getOmniClient();

    // Resolve agent: explicit --agent > accountName-as-agent > defaultAgent (for default account)
    const agentId = agent
      ?? (accountName !== "default" && dbGetAgent(accountName) ? accountName : undefined)
      ?? (accountName === "default" ? (dbGetSetting("defaultAgent") ?? undefined) : undefined);

    // Auto-create or update agent if --mode provided
    if (mode && (mode === "sentinel" || mode === "active")) {
      const targetAgent = agentId ?? accountName;
      if (!dbGetAgent(targetAgent)) {
        const cwd = `${homedir()}/ravi/${targetAgent}`;
        mkdirSync(cwd, { recursive: true });
        dbCreateAgent({ id: targetAgent, cwd, mode: mode as "active" | "sentinel" });
        console.log(`✓ Created agent "${targetAgent}" (${mode}) at ${cwd}`);
      } else {
        dbUpdateAgent(targetAgent, { mode: mode as "active" | "sentinel" });
      }
      if (accountName !== "default") {
        dbSetSetting(`account.${accountName}.agent`, targetAgent);
      }
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else if (agentId) {
      dbSetSetting(`account.${accountName}.agent`, agentId);
      nats.emit("ravi.config.changed", {}).catch(() => {});
    }

    const mappedAgent = dbGetSetting(`account.${accountName}.agent`);
    const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
    const modeLabel = agentConfig?.mode === "sentinel" ? " (sentinel)" : "";
    console.log(
      `Connecting WhatsApp account: ${accountName}${
        mappedAgent ? ` → agent ${mappedAgent}${modeLabel}` : " → default agent"
      }`
    );

    // Find or create the omni instance
    let instanceId = await resolveInstanceId(accountName);

    if (!instanceId) {
      // Create a new instance in omni
      console.log("Creating WhatsApp instance...");
      try {
        const instance = await omni.instances.create({
          name: accountName,
          channel: "whatsapp-baileys",
        });
        instanceId = instance.id ?? "";
        dbSetSetting(`account.${accountName}.instanceId`, instanceId);

        // Also bind instanceId → agent for router lookups
        if (mappedAgent) {
          dbSetSetting(`account.${instanceId}.agent`, mappedAgent);
        }

        console.log(`✓ Instance created: ${instanceId}`);
      } catch (err) {
        fail(`Failed to create WhatsApp instance: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      // Ensure agent binding is up to date
      if (mappedAgent) {
        dbSetSetting(`account.${instanceId}.agent`, mappedAgent);
      }
    }

    // Check if already connected
    try {
      const status = await omni.instances.status(instanceId);
      if (status.isConnected) {
        const phone = status.profileName ? ` as ${status.profileName}` : "";
        console.log(`\n✓ Already connected${phone}`);
        return;
      }
    } catch {
      // Ignore status check errors
    }

    // Initiate connection
    console.log("Waiting for QR code...\n");
    try {
      await omni.instances.connect(instanceId, {
        whatsapp: { syncFullHistory: false },
      });
    } catch (err) {
      fail(`Failed to initiate connection: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Subscribe to NATS topics that OmniConsumer relays from JetStream
    // These topics are emitted by OmniConsumer when it receives instance events
    const qrTopic = `ravi.whatsapp.qr.${instanceId}`;
    const connectedTopic = `ravi.whatsapp.connected.${instanceId}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => { settled = true; };

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        console.error("\n✗ Timeout waiting for connection (120s)");
        process.exit(1);
      }, TIMEOUT_MS);

      // Subscribe to QR and connected events
      (async () => {
        try {
          for await (const event of nats.subscribe(qrTopic, connectedTopic)) {
            if (settled) break;
            const data = event.data as Record<string, unknown>;

            if (event.topic === qrTopic && data.type === "qr") {
              console.log("Scan this QR code in WhatsApp > Linked Devices:\n");
              qrcode.generate(data.qr as string, { small: true });
            } else if (event.topic === connectedTopic && data.type === "connected") {
              clearTimeout(timer);
              cleanup();
              const name = data.profileName ? ` as ${data.profileName}` : "";
              console.log(`\n✓ Connected${name}`);
              resolve();
              process.exit(0);
            }
          }
        } catch (err) {
          if (!settled) {
            clearTimeout(timer);
            cleanup();
            reject(err);
          }
        }
      })();
    });
  }

  @Command({ name: "status", description: "Show WhatsApp account status" })
  async status(
    @Option({ flags: "--account <id>", description: 'Account ID (default: "default")' }) account?: string
  ) {
    const accountName = account ?? "default";

    const instanceId = await resolveInstanceId(accountName);
    if (!instanceId) {
      fail(`No WhatsApp instance found for account: ${accountName}. Run "ravi whatsapp connect" first.`);
      return;
    }

    try {
      const omni = getOmniClient();
      const [instance, status] = await Promise.all([
        omni.instances.get(instanceId),
        omni.instances.status(instanceId),
      ]);

      const mappedAgent = dbGetSetting(`account.${accountName}.agent`);
      const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
      const modeLabel = agentConfig?.mode ? ` (${agentConfig.mode})` : "";

      console.log(`\nWhatsApp Account: ${accountName}\n`);
      console.log(`  Instance ID: ${instanceId}`);
      console.log(`  State:       ${status.state}`);
      console.log(`  Connected:   ${status.isConnected}`);
      if (status.profileName) {
        console.log(`  Profile:     ${status.profileName}`);
      }
      console.log(`  Agent:       ${mappedAgent ?? "(default)"}${modeLabel}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
        fail("Daemon not responding. Is it running? (ravi daemon status)");
      }
      fail(msg);
    }
  }

  @Command({ name: "list", description: "List all WhatsApp accounts" })
  async list() {
    try {
      const omni = getOmniClient();
      const result = await omni.instances.list({ channel: "whatsapp-baileys" });

      if (result.items.length === 0) {
        console.log("No WhatsApp accounts configured.");
        return;
      }

      console.log("\nWhatsApp Accounts:\n");
      for (const instance of result.items) {
        const status = instance.isActive ? "connected" : "disconnected";
        console.log(`  ${instance.name.padEnd(20)} [${status}]  id: ${instance.id}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(msg);
    }
  }

  @Command({ name: "set", description: "Set account property (e.g., agent)" })
  async set(
    @Option({ flags: "--account <id>", description: 'Account name (default: "default")' }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to (use '-' to clear)" }) agent?: string
  ) {
    const accountName = account ?? "default";

    if (agent !== undefined) {
      if (agent === "-" || agent === "null") {
        dbDeleteSetting(`account.${accountName}.agent`);
        // Also clear instanceId-based binding
        const instanceId = dbGetSetting(`account.${accountName}.instanceId`);
        if (instanceId) dbDeleteSetting(`account.${instanceId}.agent`);
        console.log(`✓ Account ${accountName}: agent mapping cleared`);
      } else {
        if (!dbGetAgent(agent)) {
          fail(`Agent not found: ${agent}`);
        }
        dbSetSetting(`account.${accountName}.agent`, agent);
        // Also bind instanceId → agent for router
        const instanceId = dbGetSetting(`account.${accountName}.instanceId`);
        if (instanceId) dbSetSetting(`account.${instanceId}.agent`, agent);
        console.log(`✓ Account ${accountName}: agent → ${agent}`);
      }
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else {
      fail("Specify a property to set. Example: ravi whatsapp set --agent main");
    }
  }

  @Command({ name: "disconnect", description: "Disconnect a WhatsApp account" })
  async disconnect(
    @Option({ flags: "--account <id>", description: 'Account name (default: "default")' }) account?: string
  ) {
    const accountName = account ?? "default";

    const instanceId = await resolveInstanceId(accountName);
    if (!instanceId) {
      fail(`No WhatsApp instance found for account: ${accountName}`);
      return;
    }

    try {
      const omni = getOmniClient();
      await omni.instances.disconnect(instanceId);
      console.log(`✓ Disconnected account: ${accountName}`);
    } catch (err) {
      fail(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
