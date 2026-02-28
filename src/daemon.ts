/**
 * Ravi Daemon
 *
 * Connects to external NATS and omni services (managed by PM2/omni CLI).
 * No child process spawning — all infrastructure is external.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { OmniSender, OmniConsumer } from "./omni/index.js";
import { loadConfig } from "./utils/config.js";
import { nats, connectNats, closeNats } from "./nats.js";
import { configStore } from "./config-store.js";
import { logger } from "./utils/logger.js";
import { dbGetSetting } from "./router/router-db.js";
import { getMainSession } from "./router/sessions.js";
import { startHeartbeatRunner, stopHeartbeatRunner } from "./heartbeat/index.js";
import { startCronRunner, stopCronRunner } from "./cron/index.js";
import { startOutboundRunner, stopOutboundRunner } from "./outbound/index.js";
import { startTriggerRunner, stopTriggerRunner } from "./triggers/index.js";
import { startEphemeralRunner, stopEphemeralRunner } from "./ephemeral/index.js";
import { startInboxWatcher, stopInboxWatcher } from "./copilot/inbox-watcher.js";
import { syncRelationsFromConfig } from "./permissions/relations.js";
import { resolveOmniConnection } from "./omni-config.js";
import { ensureSessionPromptsStream, publishSessionPrompt } from "./omni/session-stream.js";
import { tryAcquireLeadership, startLeadershipRenewal, watchForLeadershipVacancy, releaseLeadership } from "./leader/index.js";

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

const RESTART_REASON_FILE = join(homedir(), ".ravi", "restart-reason.txt");

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

    // Stop runners and release leadership so another daemon can take over
    stopInboxWatcher();
    await stopEphemeralRunner();
    await stopTriggerRunner();
    await stopOutboundRunner();
    await stopHeartbeatRunner();
    await stopCronRunner();
    await releaseLeadership("runners");

    // Stop gateway
    if (gateway) {
      await gateway.stop();
    }

    // Stop omni consumer
    if (omniConsumer) {
      await omniConsumer.stop();
    }

    // Stop config store refresh
    configStore.stop();

    // Close NATS connection
    await closeNats();
  } catch (err) {
    log.error("Error during shutdown", err);
  }

  clearTimeout(shutdownTimeout);
  log.info("Daemon stopped", { pid: process.pid });
  process.exit(0);
}

export async function startDaemon() {
  // Step 1: Connect to NATS (with retry for PM2 parallel startup)
  const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
  log.info("Connecting to NATS...", { natsUrl });
  await connectNats(natsUrl, { explicit: true });

  const config = loadConfig();
  logger.setLevel(config.logLevel);

  log.info("Starting Ravi daemon...");

  // Step 2: Start config store (NATS sub + periodic refresh)
  await configStore.startRefresh();

  // Step 3: Resolve omni connection
  let omniApiUrl: string | undefined;
  let omniApiKey: string | undefined;

  const omniConn = resolveOmniConnection();
  if (omniConn) {
    omniApiUrl = omniConn.apiUrl;
    omniApiKey = omniConn.apiKey;
    log.info("Omni connection resolved", { apiUrl: omniApiUrl, source: omniConn.source });
  } else {
    log.warn("Omni not configured — no channel support (install omni: bun add -g @automagik/omni)");
  }

  // Step 4: Ensure SESSION_PROMPTS JetStream stream exists
  // This stream replaces NATS core pub/sub for session routing,
  // enabling work queue semantics — each prompt delivered to exactly one daemon.
  log.info("Ensuring SESSION_PROMPTS JetStream stream...");
  await ensureSessionPromptsStream();
  log.info("SESSION_PROMPTS stream ready");

  // Step 5: Sync REBAC relations from agent configs
  syncRelationsFromConfig();

  // Step 6: Start bot
  bot = new RaviBot({ config });
  await bot.start();
  log.info("Bot started");

  // Step 6: Set up omni sender + consumer + gateway
  if (omniApiUrl && omniApiKey) {
    const sender = new OmniSender(omniApiUrl, omniApiKey);
    omniConsumer = new OmniConsumer(sender, omniApiUrl, omniApiKey);

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

  // Step 7: Start runners — leader election ensures only one daemon runs heartbeat/cron
  // Outbound, trigger, ephemeral, and inbox are per-daemon (each daemon handles its own).
  const isLeader = await tryAcquireLeadership("runners");

  if (isLeader) {
    startLeadershipRenewal("runners");
    await startHeartbeatRunner();
    log.info("Heartbeat runner started (leader)");
    await startCronRunner();
    log.info("Cron runner started (leader)");
  } else {
    log.info("Not leader — heartbeat and cron runners skipped (another daemon is running them)");
    watchForLeadershipVacancy("runners", async () => {
      log.info("Leadership vacancy detected — starting heartbeat and cron runners");
      await startHeartbeatRunner();
      await startCronRunner();
      log.info("Heartbeat and cron runners started (new leader)");
    }).catch(err => log.error("Leadership watcher failed", err));
  }

  await startOutboundRunner();
  log.info("Outbound runner started");

  await startTriggerRunner();
  log.info("Trigger runner started");

  await startEphemeralRunner();
  log.info("Ephemeral runner started");

  startInboxWatcher();
  log.info("Inbox watcher started");

  log.info("Daemon ready");

  // Notify restart reason after consumer is ready + delay to let sessions reconnect first.
  // The TUI sends "Continue from where you left off" on reconnect — we wait for that turn
  // to start before publishing the inform, so it arrives between turns (not concatenated).
  bot.consumerReady.then(async () => {
    await new Promise(r => setTimeout(r, 3000));
    await notifyRestartReason();
  }).catch(err => {
    log.error("Failed to notify restart reason", err);
  });
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

  // Resolve target session.
  if (!sessionName) {
    const defaultAgent = dbGetSetting("defaultAgent") || "main";
    const fallbackSession = getMainSession(defaultAgent);
    sessionName = fallbackSession?.name ?? defaultAgent;
  }

  const payload: Record<string, unknown> = {
    prompt: `[System] Inform: Daemon reiniciou. Motivo: ${reason}`,
  };

  try {
    log.info("Publishing restart reason", { reason, sessionName });
    await publishSessionPrompt(sessionName, payload);
    log.info("Restart reason prompt published", { sessionName });
  } catch (err) {
    log.error("Failed to publish restart reason", { error: err });
  }
}

// Note: startDaemon() is called by CLI's "daemon run" command
