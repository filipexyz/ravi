/**
 * WhatsApp Commands - Account management (connect, disconnect, status)
 */

import "reflect-metadata";
import { randomUUID } from "node:crypto";
import qrcode from "qrcode-terminal";
import { Group, Command, Option } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";
import { requestReply } from "../../utils/request-reply.js";

@Group({
  name: "whatsapp",
  description: "WhatsApp account management",
  scope: "admin",
})
export class WhatsAppCommands {
  @Command({ name: "connect", description: "Connect a WhatsApp account (scan QR code)" })
  async connect(
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string
  ) {
    const accountId = account ?? "default";
    const replyTopic = `ravi._reply.${randomUUID()}`;
    const TIMEOUT_MS = 120_000;

    console.log(`Connecting WhatsApp account: ${accountId}`);
    console.log("Waiting for QR code...\n");

    // Subscribe to reply topic BEFORE emitting request
    const stream = notif.subscribe(replyTopic);

    // Emit connect request
    await notif.emit("ravi.whatsapp.account.connect", {
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
        reject(new Error("Connection timeout"));
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
                return;
              }

              case "disconnected":
                // Could be a transient state during connection, ignore
                break;

              case "error":
                clearTimeout(timer);
                cleanup();
                console.error(`\n✗ ${data.error}`);
                reject(new Error(data.error as string));
                return;

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

      console.log(`\nWhatsApp Account: ${result.accountId}\n`);
      console.log(`  State:    ${result.state}`);
      if (result.phone) {
        console.log(`  Phone:    +${result.phone}`);
      }
      if (result.name) {
        console.log(`  Name:     ${result.name}`);
      }
      console.log(`  Enabled:  ${result.enabled}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout")) {
        fail("Daemon not responding. Is it running? (ravi daemon status)");
      }
      fail(msg);
    }
  }

  @Command({ name: "disconnect", description: "Disconnect a WhatsApp account" })
  async disconnect(
    @Option({ flags: "--account <id>", description: "Account ID (default: \"default\")" }) account?: string
  ) {
    const accountId = account ?? "default";

    await notif.emit("ravi.whatsapp.account.disconnect", { accountId });
    console.log(`✓ Disconnect signal sent for account: ${accountId}`);
  }
}
