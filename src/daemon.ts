/**
 * Ravi Daemon
 *
 * Runs both the bot server and WhatsApp gateway in a single process.
 */

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { createWhatsAppPlugin } from "./channels/whatsapp/index.js";
import { createMatrixPlugin } from "./channels/matrix/index.js";
import { isMatrixConfigured } from "./channels/matrix/config.js";
import { loadAllCredentials as loadMatrixCredentials } from "./channels/matrix/credentials.js";
import { loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const log = logger.child("daemon");

// Load environment from ~/.ravi/.env
function loadEnvFile() {
  const envFile = join(homedir(), ".ravi", ".env");
  if (!existsSync(envFile)) {
    return;
  }

  const content = readFileSync(envFile, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  log.info("Loaded environment from ~/.ravi/.env");
}

loadEnvFile();

// Ensure log directory exists
const LOG_DIR = join(homedir(), ".ravi", "logs");
mkdirSync(LOG_DIR, { recursive: true });

// Handle signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Handle uncaught errors - log but don't crash for transient errors
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", err);
  // Don't exit - let the daemon continue running
});

process.on("unhandledRejection", (reason, promise) => {
  log.error("Unhandled rejection", { reason, promise });
  // Don't exit - let the daemon continue running
});

let bot: RaviBot | null = null;
let gateway: ReturnType<typeof createGateway> | null = null;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down...`);

  try {
    if (gateway) {
      await gateway.stop();
    }
    if (bot) {
      await bot.stop();
    }
  } catch (err) {
    log.error("Error during shutdown", err);
  }

  log.info("Daemon stopped");
  process.exit(0);
}

export async function startDaemon() {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting Ravi daemon...");

  // Start bot
  bot = new RaviBot({ config });
  await bot.start();
  log.info("Bot started");

  // Start gateway with channel plugins
  gateway = createGateway({ logLevel: config.logLevel });

  // WhatsApp plugin
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
  gateway.use(whatsappPlugin);
  log.info("WhatsApp plugin registered");

  // Matrix plugin (only if configured via env or credentials)
  const matrixCredentials = loadMatrixCredentials();
  if (isMatrixConfigured() || matrixCredentials) {
    const matrixPlugin = createMatrixPlugin();
    gateway.use(matrixPlugin);
    log.info("Matrix plugin registered");
  } else {
    log.info("Matrix not configured, skipping");
  }

  await gateway.start();
  log.info("Gateway started");

  log.info("Daemon ready");
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("daemon.ts") ||
  process.argv[1]?.endsWith("daemon.js");

if (isMainModule) {
  startDaemon().catch((err) => {
    log.error("Fatal error", err);
    process.exit(1);
  });
}
