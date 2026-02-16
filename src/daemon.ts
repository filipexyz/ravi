/**
 * Ravi Daemon
 *
 * Runs both the bot server and WhatsApp gateway in a single process.
 */

import { mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { createWhatsAppPlugin } from "./channels/whatsapp/index.js";
import { createMatrixPlugin } from "./channels/matrix/index.js";
import { isMatrixConfigured } from "./channels/matrix/config.js";
import { loadAllCredentials as loadMatrixCredentials } from "./channels/matrix/credentials.js";
import { loadConfig } from "./utils/config.js";
import { notif } from "./notif.js";
import { logger } from "./utils/logger.js";
import { dbGetSetting } from "./router/router-db.js";
import { getMainSession } from "./router/sessions.js";
import { startHeartbeatRunner, stopHeartbeatRunner } from "./heartbeat/index.js";
import { startCronRunner, stopCronRunner } from "./cron/index.js";
import { startOutboundRunner, stopOutboundRunner } from "./outbound/index.js";
import { startTriggerRunner, stopTriggerRunner } from "./triggers/index.js";
import { startEphemeralRunner, stopEphemeralRunner } from "./ephemeral/index.js";
import { syncRelationsFromConfig } from "./permissions/relations.js";

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
const RESTART_REASON_FILE = join(homedir(), ".ravi", "restart-reason.txt");
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
  const stack = reason instanceof Error ? reason.stack : undefined;
  log.error("Unhandled rejection", { reason, stack, promise });
  // Don't exit - let the daemon continue running
});

let bot: RaviBot | null = null;
let gateway: ReturnType<typeof createGateway> | null = null;
let shuttingDown = false;

/** Get the bot instance (for in-process access like /reset) */
export function getBotInstance(): RaviBot | null {
  return bot;
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down...`, { pid: process.pid });

  try {
    // Stop bot FIRST to abort SDK subprocesses before anything else
    if (bot) {
      log.info("Stopping bot (aborting SDK subprocesses)...");
      await bot.stop();
      log.info("Bot stopped");
    }

    // Then stop runners
    await stopEphemeralRunner();
    await stopTriggerRunner();
    await stopOutboundRunner();
    await stopHeartbeatRunner();
    await stopCronRunner();

    if (gateway) {
      await gateway.stop();
    }
  } catch (err) {
    log.error("Error during shutdown", err);
  }

  log.info("Daemon stopped", { pid: process.pid });
  process.exit(0);
}

export async function startDaemon() {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting Ravi daemon...");

  // Sync REBAC relations from agent configs
  syncRelationsFromConfig();

  // Start bot
  bot = new RaviBot({ config });
  await bot.start();
  log.info("Bot started");

  // Start gateway with channel plugins
  gateway = createGateway({ logLevel: config.logLevel });

  // WhatsApp plugin - read policies from settings
  const waDmPolicy = (dbGetSetting("whatsapp.dmPolicy") || "pairing") as "open" | "pairing" | "closed";
  const waGroupPolicy = (dbGetSetting("whatsapp.groupPolicy") || "allowlist") as "open" | "allowlist" | "closed";

  log.info("WhatsApp policies", { dmPolicy: waDmPolicy, groupPolicy: waGroupPolicy });

  const whatsappPlugin = createWhatsAppPlugin({
    accounts: {
      default: {
        name: "Ravi WhatsApp",
        enabled: true,
        dmPolicy: waDmPolicy,
        groupPolicy: waGroupPolicy,
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

  // Start heartbeat runner
  await startHeartbeatRunner();
  log.info("Heartbeat runner started");

  // Start cron runner
  await startCronRunner();
  log.info("Cron runner started");

  // Start outbound runner
  await startOutboundRunner();
  log.info("Outbound runner started");

  // Start trigger runner
  await startTriggerRunner();
  log.info("Trigger runner started");

  // Start ephemeral session cleanup runner
  await startEphemeralRunner();
  log.info("Ephemeral runner started");


  log.info("Daemon ready");

  // Check for restart reason and notify main agent
  // Delay to ensure bot's notif subscription is fully established
  setTimeout(() => notifyRestartReason(), 5000);
}

/**
 * Check if there's a restart reason file and notify the originating session
 */
async function notifyRestartReason() {
  if (!existsSync(RESTART_REASON_FILE)) {
    return;
  }

  let reason: string;
  let sessionName: string | undefined;
  try {
    const raw = readFileSync(RESTART_REASON_FILE, "utf-8").trim();
    unlinkSync(RESTART_REASON_FILE); // Delete after reading

    // Try JSON format (new) first, fall back to plain text (legacy)
    try {
      const data = JSON.parse(raw);
      reason = data.reason;
      sessionName = data.sessionName;
    } catch {
      reason = raw;
    }
  } catch (err) {
    log.error("Failed to read restart reason file", err);
    return;
  }

  if (!reason) return;

  // Route to the session that requested the restart, or fall back to default agent's main session
  if (!sessionName) {
    const defaultAgent = dbGetSetting("defaultAgent") || "main";
    const fallbackSession = getMainSession(defaultAgent);
    sessionName = fallbackSession?.name ?? defaultAgent;
  }

  const topic = `ravi.session.${sessionName}.prompt`;
  const payload = {
    prompt: `[System] Inform: Daemon reiniciou. Motivo: ${reason}`,
  };

  // Retry emit — notif WebSocket may not be ready on first attempts
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info("Emitting restart reason", { reason, topic, sessionName, attempt });
      await notif.emit(topic, payload);
      log.info("Restart reason prompt emitted", { topic, attempt });
      return;
    } catch (err) {
      log.warn("Restart reason emit failed, retrying", { attempt, error: err });
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  log.error("Failed to emit restart reason after 3 attempts");
}

// Note: startDaemon() is called by CLI's "daemon run" command
// Do not auto-execute here to avoid double initialization
