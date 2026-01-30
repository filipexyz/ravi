/**
 * WhatsApp Bridge Entry Point
 *
 * Connects WhatsApp messages to RaviBot via notif.sh using the channel plugin architecture.
 * Run alongside the main bot server.
 *
 * Usage:
 *   npm run wa
 */

import { createGateway } from "./gateway.js";
import { createWhatsAppPlugin } from "./channels/whatsapp/index.js";
import { loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const log = logger.child("wa");

// Capture Ctrl+C via stdin (in case SIGINT is blocked)
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    // Ctrl+C = 0x03, Ctrl+D = 0x04, ESC = 0x1b
    if (data[0] === 0x03 || data[0] === 0x04 || data[0] === 0x1b) {
      console.log("\nBye!");
      process.exit(0);
    }
  });
}

// Also handle SIGINT/SIGTERM as backup
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function main() {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting WhatsApp bridge...");

  // Create WhatsApp plugin with default account
  const whatsappPlugin = createWhatsAppPlugin({
    accounts: {
      default: {
        name: "Ravi WhatsApp",
        enabled: true,
        dmPolicy: "pairing",
        groupPolicy: "closed",
        sendReadReceipts: true,
        debounceMs: 500,
      },
    },
  });

  // Create and configure gateway
  const gateway = createGateway({
    logLevel: config.logLevel,
  });

  gateway.use(whatsappPlugin);

  // Log events
  gateway.on("message", (message) => {
    log.info("Message routed", {
      channel: message.channelId,
      sender: message.senderId,
      isGroup: message.isGroup,
    });
  });

  gateway.on("stateChange", (channelId, accountId, state) => {
    log.info("Channel state changed", { channelId, accountId, state });
  });

  // Start gateway
  await gateway.start();

  log.info("WhatsApp bridge started successfully");
}

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
