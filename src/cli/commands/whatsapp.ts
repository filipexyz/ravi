/**
 * WhatsApp Commands - Account management (connect, disconnect, status)
 */

import "reflect-metadata";
import { randomUUID } from "node:crypto";
import qrcode from "qrcode-terminal";
import { Group, Command, Option } from "../decorators.js";
import { fail } from "../context.js";
import { nats } from "../../nats.js";
import { requestReply } from "../../utils/request-reply.js";
import { dbGetSetting, dbSetSetting, dbDeleteSetting, dbGetAgent, dbCreateAgent, dbUpdateAgent } from "../../router/router-db.js";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

@Group({
  name: "whatsapp",
  description: "WhatsApp account management",
  scope: "admin",
})
export class WhatsAppCommands {
  @Command({ name: "connect", description: "Connect a WhatsApp account (scan QR code)" })
  async connect(
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to" }) agent?: string,
    @Option({ flags: "--mode <mode>", description: "Agent mode: active or sentinel (auto-creates agent if needed)" }) mode?: string
  ) {
    const accountId = account ?? "default";
    const replyTopic = `ravi._reply.${randomUUID()}`;
    const TIMEOUT_MS = 120_000;

    // Resolve agent: explicit --agent > accountId-as-agent (if exists) > no binding
    const agentId = agent ?? (accountId !== "default" && dbGetAgent(accountId) ? accountId : undefined);

    // Auto-create agent if --mode provided and agent doesn't exist
    if (mode && (mode === "sentinel" || mode === "active")) {
      const targetAgent = agentId ?? accountId;
      if (!dbGetAgent(targetAgent)) {
        const cwd = `${homedir()}/ravi/${targetAgent}`;
        mkdirSync(cwd, { recursive: true });
        dbCreateAgent({ id: targetAgent, cwd, mode: mode as "active" | "sentinel" });
        console.log(`✓ Created agent "${targetAgent}" (${mode}) at ${cwd}`);
      } else {
        // Update mode on existing agent
        dbUpdateAgent(targetAgent, { mode: mode as "active" | "sentinel" });
      }
      // Bind account → agent
      if (accountId !== "default") {
        dbSetSetting(`account.${accountId}.agent`, targetAgent);
      }
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else if (agentId) {
      // Bind account → agent (explicit or auto-detected)
      dbSetSetting(`account.${accountId}.agent`, agentId);
      nats.emit("ravi.config.changed", {}).catch(() => {});
    }

    const mappedAgent = dbGetSetting(`account.${accountId}.agent`);
    const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
    const modeLabel = agentConfig?.mode === "sentinel" ? " (sentinel)" : "";
    console.log(`Connecting WhatsApp account: ${accountId}${mappedAgent ? ` → agent ${mappedAgent}${modeLabel}` : " → default agent"}`);
    console.log("Waiting for QR code...\n");

    // Subscribe to reply topic BEFORE emitting request
    const stream = nats.subscribe(replyTopic);

    // Emit connect request
    await nats.emit("ravi.whatsapp.account.connect", {
      accountId,
      replyTopic,
    });

    // Stream events from daemon
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (!settled) {
          settled = true;
          stream.return?.();
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        console.error("\n✗ Timeout waiting for connection (120s)");
        process.exit(1);
      }, TIMEOUT_MS);

      (async () => {
        try {
          for await (const event of stream) {
            if (settled) break;
            const data = event.data as Record<string, unknown>;

            switch (data.type) {
              case "qr":
                // Clear previous QR and render new one
                console.log("Scan this QR code in WhatsApp > Linked Devices:\n");
                qrcode.generate(data.qr as string, { small: true });
                break;

              case "connected": {
                clearTimeout(timer);
                cleanup();
                const phone = data.phone ? ` as +${data.phone}` : "";
                console.log(`\n✓ Connected${phone}`);
                resolve();
                process.exit(0);
              }

              case "disconnected":
                // Could be a transient state during connection, ignore
                break;

              case "error":
                clearTimeout(timer);
                cleanup();
                console.error(`\n✗ ${data.error}`);
                process.exit(1);

              default:
                // Unknown event type, log for debugging
                break;
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
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string
  ) {
    const accountId = account ?? "default";

    try {
      const result = await requestReply<{
        accountId: string;
        state: string;
        phone?: string;
        name?: string;
        enabled: boolean;
      }>("ravi.whatsapp.account.status", { accountId });

      const mappedAgent = dbGetSetting(`account.${accountId}.agent`);
      const agentConfig = mappedAgent ? dbGetAgent(mappedAgent) : null;
      const modeLabel = agentConfig?.mode ? ` (${agentConfig.mode})` : "";
      console.log(`\nWhatsApp Account: ${result.accountId}\n`);
      console.log(`  State:    ${result.state}`);
      if (result.phone) {
        console.log(`  Phone:    +${result.phone}`);
      }
      if (result.name) {
        console.log(`  Name:     ${result.name}`);
      }
      console.log(`  Agent:    ${mappedAgent ?? "(default)"}${modeLabel}`);
      console.log(`  Enabled:  ${result.enabled}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout")) {
        fail("Daemon not responding. Is it running? (ravi daemon status)");
      }
      fail(msg);
    }
  }

  @Command({ name: "set", description: "Set account property (e.g., agent)" })
  set(
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string,
    @Option({ flags: "--agent <id>", description: "Agent to route messages to (use '-' to clear)" }) agent?: string
  ) {
    const accountId = account ?? "default";

    if (agent !== undefined) {
      if (agent === "-" || agent === "null") {
        dbDeleteSetting(`account.${accountId}.agent`);
        console.log(`✓ Account ${accountId}: agent mapping cleared (will use default)`);
      } else {
        if (!dbGetAgent(agent)) {
          fail(`Agent not found: ${agent}`);
        }
        dbSetSetting(`account.${accountId}.agent`, agent);
        console.log(`✓ Account ${accountId}: agent → ${agent}`);
      }
      nats.emit("ravi.config.changed", {}).catch(() => {});
    } else {
      fail("Specify a property to set. Example: ravi whatsapp set --agent main");
    }
  }

  @Command({ name: "disconnect", description: "Disconnect a WhatsApp account" })
  async disconnect(
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string
  ) {
    const accountId = account ?? "default";

    await nats.emit("ravi.whatsapp.account.disconnect", { accountId });
    console.log(`✓ Disconnect signal sent for account: ${accountId}`);
  }
}
