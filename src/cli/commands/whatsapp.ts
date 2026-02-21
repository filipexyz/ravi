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
    @Option({ flags: "--name <name>", description: "Instance name in omni (default: auto-detect or prompt)" }) name?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to" }) agent?: string,
    @Option({ flags: "--mode <mode>", description: "Agent mode: active or sentinel" }) mode?: string
  ) {
    const TIMEOUT_MS = 120_000;
    const omni = getOmniClient();

    // Resolve or create omni instance
    let instanceId: string;
    let instanceName: string;

    if (name) {
      // Explicit name: find or create
      instanceId = (await resolveInstanceId(name)) ?? "";
      instanceName = name;
    } else {
      // Auto-detect: find first WhatsApp instance in omni
      try {
        const result = await omni.instances.list({ channel: "whatsapp-baileys" });
        const first = result.items[0] as { id?: string; name?: string } | undefined;
        if (first?.id && first?.name) {
          instanceId = first.id;
          instanceName = first.name;
        } else {
          instanceId = "";
          instanceName = "";
        }
      } catch {
        instanceId = "";
        instanceName = "";
      }
    }

    if (!instanceId) {
      if (!instanceName) {
        fail("No WhatsApp instance found in omni. Create one with: ravi whatsapp connect --name <name>");
        return;
      }
      // Create a new instance in omni
      console.log(`Creating WhatsApp instance "${instanceName}"...`);
      try {
        const instance = await omni.instances.create({
          name: instanceName,
          channel: "whatsapp-baileys",
        });
        instanceId = instance.id ?? "";
        console.log(`✓ Instance created: ${instanceId}`);
      } catch (err) {
        fail(`Failed to create WhatsApp instance: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    // Cache instanceId → name mapping
    dbSetSetting(`account.${instanceName}.instanceId`, instanceId);

    // Resolve agent: explicit --agent > agent with same name as instance > defaultAgent
    const agentId = agent
      ?? (dbGetAgent(instanceName) ? instanceName : undefined)
      ?? (dbGetSetting("defaultAgent") ?? undefined);

    // Auto-create or update agent if --mode provided
    if (mode && (mode === "sentinel" || mode === "active")) {
      const targetAgent = agentId ?? instanceName;
      if (!dbGetAgent(targetAgent)) {
        const cwd = `${homedir()}/ravi/${targetAgent}`;
        mkdirSync(cwd, { recursive: true });
        dbCreateAgent({ id: targetAgent, cwd, mode: mode as "active" | "sentinel" });
        console.log(`✓ Created agent "${targetAgent}" (${mode}) at ${cwd}`);
      } else {
        dbUpdateAgent(targetAgent, { mode: mode as "active" | "sentinel" });
      }
      dbSetSetting(`account.${instanceName}.agent`, targetAgent);
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else if (agentId) {
      dbSetSetting(`account.${instanceName}.agent`, agentId);
      nats.emit("ravi.config.changed", {}).catch(() => {});
    }

    const mappedAgent = dbGetSetting(`account.${instanceName}.agent`);
    const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
    const modeLabel = agentConfig?.mode === "sentinel" ? " (sentinel)" : "";
    console.log(
      `Connecting: ${instanceName}${
        mappedAgent ? ` → agent ${mappedAgent}${modeLabel}` : " → default agent"
      }`
    );

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
    @Option({ flags: "--name <name>", description: "Instance name in omni" }) name?: string
  ) {
    const omni = getOmniClient();

    // Resolve instance: explicit name or auto-detect first
    let instanceId: string | null = null;
    let instanceName = name ?? "";

    if (name) {
      instanceId = await resolveInstanceId(name);
    } else {
      try {
        const result = await omni.instances.list({ channel: "whatsapp-baileys" });
        const first = result.items[0] as { id?: string; name?: string } | undefined;
        if (first?.id && first?.name) {
          instanceId = first.id;
          instanceName = first.name;
        }
      } catch { /* */ }
    }

    if (!instanceId) {
      fail(`No WhatsApp instance found${name ? `: ${name}` : ""}. Run "ravi whatsapp connect --name <name>" first.`);
      return;
    }

    try {
      const status = await omni.instances.status(instanceId);

      const mappedAgent = dbGetSetting(`account.${instanceName}.agent`);
      const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
      const modeLabel = agentConfig?.mode ? ` (${agentConfig.mode})` : "";

      console.log(`\nWhatsApp: ${instanceName}\n`);
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

  @Command({ name: "set", description: "Set instance property (e.g., agent)" })
  async set(
    @Option({ flags: "--name <name>", description: "Instance name in omni" }) name?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to (use '-' to clear)" }) agent?: string
  ) {
    const instanceName = name ?? await this.autoDetectInstanceName();
    if (!instanceName) {
      fail("No WhatsApp instance found. Specify --name or connect one first.");
      return;
    }

    if (agent !== undefined) {
      if (agent === "-" || agent === "null") {
        dbDeleteSetting(`account.${instanceName}.agent`);
        console.log(`✓ ${instanceName}: agent mapping cleared`);
      } else {
        if (!dbGetAgent(agent)) {
          fail(`Agent not found: ${agent}`);
        }
        dbSetSetting(`account.${instanceName}.agent`, agent);
        console.log(`✓ ${instanceName}: agent → ${agent}`);
      }
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else {
      fail("Specify a property to set. Example: ravi whatsapp set --agent main");
    }
  }

  @Command({ name: "disconnect", description: "Disconnect a WhatsApp account" })
  async disconnect(
    @Option({ flags: "--name <name>", description: "Instance name in omni" }) name?: string
  ) {
    const instanceName = name ?? await this.autoDetectInstanceName();
    if (!instanceName) {
      fail("No WhatsApp instance found. Specify --name or connect one first.");
      return;
    }

    const instanceId = await resolveInstanceId(instanceName);
    if (!instanceId) {
      fail(`No WhatsApp instance found: ${instanceName}`);
      return;
    }

    try {
      const omni = getOmniClient();
      await omni.instances.disconnect(instanceId);
      console.log(`✓ Disconnected: ${instanceName}`);
    } catch (err) {
      fail(`Failed to disconnect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Auto-detect first WhatsApp instance name from omni */
  private async autoDetectInstanceName(): Promise<string | null> {
    try {
      const omni = getOmniClient();
      const result = await omni.instances.list({ channel: "whatsapp-baileys" });
      const first = result.items[0] as { name?: string } | undefined;
      return first?.name ?? null;
    } catch {
      return null;
    }
  }
}
