/**
 * Ravi Daemon
 *
 * Runs the bot server, omni API, and gateway in a single process.
 */

import { mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { OmniSender, OmniConsumer } from "./omni/index.js";
import { loadConfig } from "./utils/config.js";
import { nats, connectNats } from "./nats.js";
import { logger } from "./utils/logger.js";
import { dbGetSetting } from "./router/router-db.js";
import { getMainSession } from "./router/sessions.js";
import { startHeartbeatRunner, stopHeartbeatRunner } from "./heartbeat/index.js";
import { startCronRunner, stopCronRunner } from "./cron/index.js";
import { startOutboundRunner, stopOutboundRunner } from "./outbound/index.js";
import { startTriggerRunner, stopTriggerRunner } from "./triggers/index.js";
import { startEphemeralRunner, stopEphemeralRunner } from "./ephemeral/index.js";
import { syncRelationsFromConfig } from "./permissions/relations.js";
import { startLocalServer, startOmniServer, getOrCreateOmniApiKey, type LocalServer, type OmniServer } from "./local/index.js";

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

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", err);
});

process.on("unhandledRejection", (reason, promise) => {
  const stack = reason instanceof Error ? reason.stack : undefined;
  log.error("Unhandled rejection", { reason, stack, promise });
});

let bot: RaviBot | null = null;
let gateway: ReturnType<typeof createGateway> | null = null;
let shuttingDown = false;
let localServer: LocalServer | null = null;
let omniServer: OmniServer | null = null;
let omniConsumer: OmniConsumer | null = null;

/** Get the bot instance (for in-process access like /reset) */
export function getBotInstance(): RaviBot | null {
  return bot;
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down...`, { pid: process.pid });

  // Global shutdown guard — force exit if graceful shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    log.error("Shutdown timeout — forcing exit");
    process.exit(1);
  }, 15_000);

  try {
    // Stop bot FIRST to abort SDK subprocesses
    if (bot) {
      log.info("Stopping bot (aborting SDK subprocesses)...");
      await bot.stop();
      log.info("Bot stopped");
    }

    // Stop runners
    await stopEphemeralRunner();
    await stopTriggerRunner();
    await stopOutboundRunner();
    await stopHeartbeatRunner();
    await stopCronRunner();

    // Stop gateway
    if (gateway) {
      await gateway.stop();
    }

    // Stop omni consumer
    if (omniConsumer) {
      await omniConsumer.stop();
    }

    // Stop omni server
    if (omniServer) {
      log.info("Stopping omni server...");
      await omniServer.stop();
      log.info("Omni server stopped");
    }

    // Stop local infrastructure last
    if (localServer) {
      log.info("Stopping local server...");
      await localServer.stop();
      log.info("Local server stopped");
    }
  } catch (err) {
    log.error("Error during shutdown", err);
  }

  clearTimeout(shutdownTimeout);
  log.info("Daemon stopped", { pid: process.pid });
  process.exit(0);
}

export async function startDaemon() {
  // Step 1: Start local infrastructure (nats-server with JetStream)
  // Skip if OMNI_API_URL is set (external omni manages its own NATS)
  if (process.env.OMNI_API_URL && !process.env.OMNI_DIR) {
    const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
    log.info("Connecting to external NATS", { natsUrl });
    await connectNats(natsUrl, { explicit: true });
  } else {
    if (process.env.OMNI_API_URL && process.env.OMNI_DIR) {
      log.warn("Both OMNI_API_URL and OMNI_DIR set — using embedded omni (OMNI_DIR takes precedence)");
    }
    localServer = await startLocalServer();
  }

  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting Ravi daemon...");

  // Step 2: Start omni API server (embedded) or connect to external
  let omniApiUrl: string | undefined;
  let omniApiKey: string | undefined;
  if (process.env.OMNI_DIR) {
    try {
      omniServer = await startOmniServer();
      omniApiUrl = omniServer.apiUrl;
      omniApiKey = omniServer.apiKey;
      log.info("Omni server started (embedded)", { apiUrl: omniApiUrl });
    } catch (err) {
      log.error("Failed to start omni server — continuing without channel support", err);
    }
  } else if (process.env.OMNI_API_URL) {
    omniApiUrl = process.env.OMNI_API_URL;
    omniApiKey = getOrCreateOmniApiKey();
    log.info("Using external omni server", { apiUrl: omniApiUrl });
  } else {
    log.warn("Neither OMNI_DIR nor OMNI_API_URL set — no channel support");
  }

  // Step 3: Sync REBAC relations from agent configs
  syncRelationsFromConfig();

  // Step 4: Start bot
  bot = new RaviBot({ config });
  await bot.start();
  log.info("Bot started");

  // Step 5: Set up omni sender + consumer + gateway
  if (omniApiUrl && omniApiKey) {
    const sender = new OmniSender(omniApiUrl, omniApiKey);
    omniConsumer = new OmniConsumer(sender);

    try {
      await omniConsumer.start();
      log.info("Omni consumer started");
    } catch (err) {
      log.error("Failed to start omni consumer", err);
    }

    gateway = createGateway({
      logLevel: config.logLevel,
      omniSender: sender,
      omniConsumer,
    });
  } else {
    // No omni — create a stub gateway that handles internal routing only
    log.warn("Creating gateway without omni — outbound messages will fail");
    const stubSender = createStubSender();
    const stubConsumer = createStubConsumer();
    gateway = createGateway({
      logLevel: config.logLevel,
      omniSender: stubSender,
      omniConsumer: stubConsumer,
    });
  }

  await gateway.start();
  log.info("Gateway started");

  // Step 6: Start runners
  await startHeartbeatRunner();
  log.info("Heartbeat runner started");

  await startCronRunner();
  log.info("Cron runner started");

  await startOutboundRunner();
  log.info("Outbound runner started");

  await startTriggerRunner();
  log.info("Trigger runner started");

  await startEphemeralRunner();
  log.info("Ephemeral runner started");

  log.info("Daemon ready");

  // Notify restart reason
  setTimeout(() => notifyRestartReason(), 5000);
}

/**
 * Stub OmniSender for when omni is not configured.
 * Logs warnings but doesn't throw.
 */
function createStubSender(): OmniSender {
  return {
    send: async (instanceId: string, to: string, _text: string) => {
      log.warn("OmniSender stub: send called but omni not configured", { instanceId, to });
      return {};
    },
    sendTyping: async () => {},
    sendReaction: async () => {},
    sendMedia: async () => { return {}; },
    getClient: () => { throw new Error("Omni not configured"); },
  } as unknown as OmniSender;
}

/**
 * Stub OmniConsumer for when omni is not configured.
 */
function createStubConsumer(): OmniConsumer {
  return {
    start: async () => {},
    stop: async () => {},
    getActiveTarget: () => undefined,
    clearActiveTarget: () => {},
  } as unknown as OmniConsumer;
}

/**
 * Check if there's a restart reason file and notify the originating session.
 */
async function notifyRestartReason() {
  if (!existsSync(RESTART_REASON_FILE)) {
    return;
  }

  let reason: string;
  let sessionName: string | undefined;
  try {
    const raw = readFileSync(RESTART_REASON_FILE, "utf-8").trim();
    unlinkSync(RESTART_REASON_FILE);

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

  if (!sessionName) {
    const defaultAgent = dbGetSetting("defaultAgent") || "main";
    const fallbackSession = getMainSession(defaultAgent);
    sessionName = fallbackSession?.name ?? defaultAgent;
  }

  const topic = `ravi.session.${sessionName}.prompt`;
  const payload = {
    prompt: `[System] Inform: Daemon reiniciou. Motivo: ${reason}`,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info("Emitting restart reason", { reason, topic, sessionName, attempt });
      await nats.emit(topic, payload);
      log.info("Restart reason prompt emitted", { topic, attempt });
      return;
    } catch (err) {
      log.warn("Restart reason emit failed, retrying", { attempt, error: err });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  log.error("Failed to emit restart reason after 3 attempts");
}

// Note: startDaemon() is called by CLI's "daemon run" command
