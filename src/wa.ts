/**
 * WhatsApp Bridge Entry Point
 *
 * Connects WhatsApp messages to RaviBot via NATS using the channel plugin architecture.
 */

import { createGateway } from "./gateway.js";
import { createWhatsAppPlugin } from "./channels/whatsapp/index.js";
import { loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const log = logger.child("wa");

// Capture Ctrl+C via stdin
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    if (data[0] === 0x03 || data[0] === 0x04 || data[0] === 0x1b) {
      console.log("\nBye!");
      process.exit(0);
    }
  });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function main() {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting WhatsApp bridge...");

  const whatsappPlugin = createWhatsAppPlugin({
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

  const gateway = createGateway({ logLevel: config.logLevel });
  gateway.use(whatsappPlugin);

  await gateway.start();

  log.info("WhatsApp bridge started");
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
