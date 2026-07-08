/**
 * Ravi Daemon
 *
 * Connects to external NATS and omni services (managed by PM2/omni CLI).
 * No child process spawning — all infrastructure is external.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { OmniSender, OmniConsumer } from "./omni/index.js";
import { loadConfig } from "./utils/config.js";
import { connectNats, closeNats } from "./nats.js";
import { configStore } from "./config-store.js";
import { logger } from "./utils/logger.js";
import {
  dbGetSetting,
  dbHasDaemonRestartResumeDelivery,
  dbListEligibleDaemonRestartSessionSnapshots,
  dbMarkDaemonRestartResumeDelivered,
  dbUpsertDaemonRestartEpoch,
  type DaemonRestartSessionSnapshotRecord,
} from "./router/router-db.js";
import { getMainSession, getSession, getSessionByName } from "./router/sessions.js";
import { closeAllRaviDbs } from "./db/close-all.js";
import { startHeartbeatRunner, stopHeartbeatRunner } from "./heartbeat/index.js";
import { startCronRunner, stopCronRunner } from "./cron/index.js";
import { startSessionFollowupRunner, stopSessionFollowupRunner } from "./session-followups/index.js";
import { startTriggerRunner, stopTriggerRunner } from "./triggers/index.js";
import { startEphemeralRunner, stopEphemeralRunner } from "./ephemeral/index.js";
import { startInboxRunner, stopInboxRunner } from "./inbox/index.js";
import { startHookRunner, stopHookRunner } from "./hooks-runtime/index.js";
import { startTaskCheckpointRunner, stopTaskCheckpointRunner } from "./tasks/index.js";
import { startSyncRunner, stopSyncRunner } from "./sync/index.js";
import { createSessionAdapterBus } from "./adapters/index.js";
import { resolveOmniConnection } from "./omni-config.js";
import { ensureSessionPromptsStream, publishSessionPrompt } from "./omni/session-stream.js";
import { ensureRaviEventsStream } from "./events/audit-stream.js";
import { startWebhookHttpServerFromEnv, type WebhookHttpServerHandle } from "./webhooks/http-server.js";
import type { MessageTarget } from "./runtime/message-types.js";
import { dbHasActiveAssignedTaskForSession } from "./tasks/task-db.js";
import { startWorkObjectNatsService, type WorkObjectNatsServiceHandle } from "./work-objects/index.js";
import {
  tryAcquireLeadership,
  startLeadershipRenewal,
  watchForLeadershipVacancy,
  releaseLeadership,
} from "./leader/index.js";

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

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  log.info("Loaded environment from ~/.ravi/.env");
}

loadEnvFile();

const RESTART_REASON_FILE = join(homedir(), ".ravi", "restart-reason.txt");
const RESTART_RESUME_WINDOW_MS = 60 * 60 * 1000;

type RestartReasonInfo = {
  reason: string;
  sessionName?: string;
  restartEpoch: string;
  createdAt: number;
};

type RestartReasonFile = {
  reason?: string;
  sessionName?: string;
  restartEpoch?: string;
  createdAt?: number;
};

function newRestartEpoch(createdAt = Date.now()): string {
  return `restart_${createdAt}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function readRestartReasonInfo(options: { consume?: boolean; ensureEpoch?: boolean } = {}): RestartReasonInfo | null {
  if (!existsSync(RESTART_REASON_FILE)) {
    return null;
  }

  try {
    const raw = readFileSync(RESTART_REASON_FILE, "utf-8").trim();
    if (options.consume) {
      unlinkSync(RESTART_REASON_FILE);
    }
    if (!raw) {
      return null;
    }

    let parsed: RestartReasonFile;
    try {
      parsed = JSON.parse(raw) as RestartReasonFile;
    } catch {
      parsed = { reason: raw };
    }

    if (!parsed.reason) {
      return null;
    }

    const createdAt = parsed.createdAt ?? Date.now();
    const restartEpoch = parsed.restartEpoch ?? newRestartEpoch(createdAt);
    const info: RestartReasonInfo = {
      reason: parsed.reason,
      sessionName: parsed.sessionName,
      restartEpoch,
      createdAt,
    };

    if (options.ensureEpoch && (!parsed.restartEpoch || !parsed.createdAt)) {
      const payload = {
        reason: info.reason,
        restartEpoch: info.restartEpoch,
        createdAt: info.createdAt,
        ...(info.sessionName ? { sessionName: info.sessionName } : {}),
      };
      writeRestartReasonInfo(payload);
    }

    return info;
  } catch (err) {
    log.error("Failed to read restart reason file", err);
    return null;
  }
}

function writeRestartReasonInfo(info: RestartReasonInfo): void {
  mkdirSync(join(homedir(), ".ravi"), { recursive: true });
  writeFileSync(RESTART_REASON_FILE, JSON.stringify(info));
}

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
let sessionAdapterBus: ReturnType<typeof createSessionAdapterBus> | null = null;
let shuttingDown = false;
let omniConsumer: OmniConsumer | null = null;
let webhookHttpServer: WebhookHttpServerHandle | null = null;
let workObjectNatsService: WorkObjectNatsServiceHandle | null = null;

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
    const restartInfo = readRestartReasonInfo({ ensureEpoch: true });
    if (restartInfo) {
      dbUpsertDaemonRestartEpoch({
        restartEpoch: restartInfo.restartEpoch,
        reason: restartInfo.reason,
        callerSessionName: restartInfo.sessionName,
        createdAt: restartInfo.createdAt,
        updatedAt: Date.now(),
      });
    }

    // Stop bot FIRST to abort SDK subprocesses
    if (bot) {
      log.info("Stopping bot (aborting SDK subprocesses)...");
      await bot.stop(
        restartInfo
          ? {
              restart: {
                restartEpoch: restartInfo.restartEpoch,
                reason: restartInfo.reason,
              },
            }
          : undefined,
      );
      log.info("Bot stopped");
    }

    // Stop runners and release leadership so another daemon can take over
    await stopInboxRunner();
    await stopSyncRunner();
    await stopEphemeralRunner();
    await stopHookRunner();
    await stopTriggerRunner();
    await stopHeartbeatRunner();
    await stopCronRunner();
    await stopSessionFollowupRunner();
    await stopTaskCheckpointRunner();
    await releaseLeadership("runners");

    // Stop gateway
    if (gateway) {
      await gateway.stop();
    }

    if (sessionAdapterBus) {
      await sessionAdapterBus.stop();
    }

    if (workObjectNatsService) {
      await workObjectNatsService.stop();
    }

    if (webhookHttpServer) {
      await webhookHttpServer.stop();
    }

    // Stop omni consumer
    if (omniConsumer) {
      await omniConsumer.stop();
    }

    // Stop config store refresh
    configStore.stop();

    // Close NATS connection
    await closeNats();

    // Close all SQLite handles AFTER bot/runners/gateway/omni have shut down,
    // so writes-in-flight have settled. Best-effort: failures are logged but
    // never block the shutdown sequence.
    closeAllRaviDbs();
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
  log.info("Ensuring RAVI_EVENTS JetStream stream...");
  await ensureRaviEventsStream();
  log.info("RAVI_EVENTS stream ready");

  // Step 5: Start bot
  bot = new RaviBot({ config });
  await bot.start();
  log.info("Bot started");

  // Step 6: Set up omni sender + consumer + gateway
  if (omniApiUrl && omniApiKey) {
    const sender = new OmniSender(omniApiUrl, omniApiKey);
    omniConsumer = new OmniConsumer(sender, omniApiUrl, omniApiKey, {
      isRuntimeSessionActive: (sessionName) => bot?.isRuntimeSessionActive(sessionName) ?? false,
      abortRuntimeSession: (sessionName, provenance) => bot?.abortSession(sessionName, provenance) ?? false,
    });

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
    log.warn("Creating gateway without omni — channel delivery will fail");
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
  // Trigger, ephemeral, and inbox are per-daemon (each daemon handles its own).
  const isLeader = await tryAcquireLeadership("runners");

  if (isLeader) {
    startLeadershipRenewal("runners");
    await startHeartbeatRunner();
    log.info("Heartbeat runner started (leader)");
    await startCronRunner();
    log.info("Cron runner started (leader)");
    await startSessionFollowupRunner();
    log.info("Session followup runner started (leader)");
    await startTaskCheckpointRunner({
      canPublishSessionPrompt: (sessionName) => bot?.canAcceptRuntimePrompt(sessionName) ?? true,
    });
    log.info("Task checkpoint runner started (leader)");
  } else {
    log.info("Not leader — heartbeat, cron, and task checkpoint runners skipped (another daemon is running them)");
    watchForLeadershipVacancy("runners", async () => {
      log.info("Leadership vacancy detected — starting heartbeat, cron, and task checkpoint runners");
      await startHeartbeatRunner();
      await startCronRunner();
      await startSessionFollowupRunner();
      await startTaskCheckpointRunner({
        canPublishSessionPrompt: (sessionName) => bot?.canAcceptRuntimePrompt(sessionName) ?? true,
      });
      log.info("Heartbeat, cron, session followup, and task checkpoint runners started (new leader)");
    }).catch((err) => log.error("Leadership watcher failed", err));
  }

  await startTriggerRunner();
  log.info("Trigger runner started");

  await startHookRunner();
  log.info("Hook runner started");

  await startEphemeralRunner();
  log.info("Ephemeral runner started");

  await startInboxRunner();
  log.info("Inbox runner started");

  await startSyncRunner();
  log.info("Sync runner started");

  sessionAdapterBus = createSessionAdapterBus();
  await sessionAdapterBus.start();
  log.info("Session adapter bus started");

  workObjectNatsService = startWorkObjectNatsService();
  log.info("Work Object NATS service started");

  webhookHttpServer = startWebhookHttpServerFromEnv();
  if (webhookHttpServer) {
    log.info("Webhook HTTP server ready", { url: webhookHttpServer.url });
  } else {
    log.info("Webhook HTTP server disabled (set RAVI_HTTP_PORT to enable)");
  }

  log.info("Daemon ready");

  // Notify restart reason after consumer is ready + delay to let sessions reconnect first.
  // The TUI sends "Continue from where you left off" on reconnect — we wait for that turn
  // to start before publishing the inform, so it arrives between turns (not concatenated).
  bot.consumerReady
    .then(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      await notifyRestartReason();
    })
    .catch((err) => {
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
    deleteMessage: async () => {},
    editMessage: async () => {},
    sendMedia: async () => {
      return {};
    },
    sendSticker: async () => {
      return {};
    },
    getClient: () => {
      throw new Error("Omni not configured");
    },
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
  const restartInfo = readRestartReasonInfo({ consume: true });
  if (!restartInfo) {
    return;
  }

  dbUpsertDaemonRestartEpoch({
    restartEpoch: restartInfo.restartEpoch,
    reason: restartInfo.reason,
    callerSessionName: restartInfo.sessionName,
    createdAt: restartInfo.createdAt,
    updatedAt: Date.now(),
  });

  const snapshots = dbListEligibleDaemonRestartSessionSnapshots({
    restartEpoch: restartInfo.restartEpoch,
    now: Date.now(),
    windowMs: RESTART_RESUME_WINDOW_MS,
  });

  const callerSessionName = restartInfo.sessionName ?? resolveFallbackRestartSessionName();
  const callerSnapshot = callerSessionName ? findRestartSnapshotForSession(snapshots, callerSessionName) : undefined;
  if (callerSessionName) {
    await publishRestartResumeEvent(callerSessionName, restartInfo, { kind: "caller", snapshot: callerSnapshot });
  }

  for (const snapshot of snapshots) {
    if (callerSnapshot?.sessionKey === snapshot.sessionKey) {
      continue;
    }
    await publishRestartResumeEvent(snapshot.sessionName, restartInfo, { kind: "active", snapshot });
  }
}

function resolveFallbackRestartSessionName(): string | undefined {
  const defaultAgent = dbGetSetting("defaultAgent") || "main";
  const fallbackSession = getMainSession(defaultAgent);
  return fallbackSession?.name ?? defaultAgent;
}

function resolveRestartSessionKey(sessionName: string): string {
  const session = getSessionByName(sessionName) ?? getSession(sessionName);
  return session?.sessionKey ?? sessionName;
}

function findRestartSnapshotForSession(
  snapshots: DaemonRestartSessionSnapshotRecord[],
  sessionName: string,
): DaemonRestartSessionSnapshotRecord | undefined {
  const sessionKey = resolveRestartSessionKey(sessionName);
  return snapshots.find((snapshot) => snapshot.sessionName === sessionName || snapshot.sessionKey === sessionKey);
}

async function publishRestartResumeEvent(
  sessionName: string,
  restartInfo: RestartReasonInfo,
  options: { kind: "caller" | "active"; snapshot?: DaemonRestartSessionSnapshotRecord } = { kind: "active" },
): Promise<boolean> {
  const sessionKey = options.snapshot?.sessionKey ?? resolveRestartSessionKey(sessionName);
  if (dbHasDaemonRestartResumeDelivery(restartInfo.restartEpoch, sessionKey)) {
    log.info("Restart resume event already delivered", {
      restartEpoch: restartInfo.restartEpoch,
      sessionKey,
      sessionName,
      kind: options.kind,
    });
    return false;
  }

  if (shouldSkipRestartResumeForTerminalTaskSession(sessionName, options.snapshot)) {
    log.info("Skipping restart resume event for terminal task session", {
      restartEpoch: restartInfo.restartEpoch,
      sessionName,
      sessionKey,
      kind: options.kind,
      taskBarrierTaskId: getRestartSnapshotTaskBarrierTaskId(options.snapshot) ?? null,
    });
    dbMarkDaemonRestartResumeDelivered({
      restartEpoch: restartInfo.restartEpoch,
      sessionKey,
      sessionName,
    });
    return false;
  }

  const payload: Record<string, unknown> = {
    prompt: `[System] Daemon reiniciou (${restartInfo.reason}). Continue de onde parou.`,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _daemonRestartResume: {
      restartEpoch: restartInfo.restartEpoch,
      sessionKey,
    },
  };
  const restartSource = resolveRestartResumeSource(options.snapshot);
  if (restartSource) {
    payload.source = restartSource;
  }

  try {
    log.info("Publishing restart resume event", {
      restartEpoch: restartInfo.restartEpoch,
      reason: restartInfo.reason,
      sessionName,
      sessionKey,
      kind: options.kind,
      sourceActorType: restartSource?.actorType ?? null,
      sourceContactId: restartSource?.contactId ?? null,
    });
    await publishSessionPrompt(sessionName, payload);
    dbMarkDaemonRestartResumeDelivered({
      restartEpoch: restartInfo.restartEpoch,
      sessionKey,
      sessionName,
    });
    log.info("Restart resume event published", { sessionName, sessionKey, kind: options.kind });
    return true;
  } catch (err) {
    log.error("Failed to publish restart resume event", { sessionName, sessionKey, error: err });
    return false;
  }
}

function resolveRestartResumeSource(snapshot?: DaemonRestartSessionSnapshotRecord): MessageTarget | undefined {
  const currentSource = asRecord(snapshot?.metadata?.currentSource);
  if (!currentSource) {
    return undefined;
  }
  return normalizeRestartResumeSource(currentSource);
}

function normalizeRestartResumeSource(source: Record<string, unknown>): MessageTarget | undefined {
  const channel = cleanString(source.channel);
  const accountId = cleanString(source.accountId);
  const chatId = cleanString(source.chatId);
  if (!channel || !accountId || !chatId) {
    return undefined;
  }

  const target: MessageTarget = { channel, accountId, chatId };
  copyStringField(target, "instanceId", source.instanceId);
  copyStringField(target, "threadId", source.threadId);
  copyStringField(target, "sourceMessageId", source.sourceMessageId);
  copyStringField(target, "canonicalChatId", source.canonicalChatId);
  copyStringField(target, "actorType", source.actorType);
  copyStringField(target, "contactId", source.contactId);
  copyStringField(target, "actorAgentId", source.actorAgentId);
  copyStringField(target, "automationId", source.automationId);
  copyStringField(target, "platformIdentityId", source.platformIdentityId);
  copyStringField(target, "rawSenderId", source.rawSenderId);
  copyStringField(target, "normalizedSenderId", source.normalizedSenderId);
  if (typeof source.identityConfidence === "number") {
    target.identityConfidence = source.identityConfidence;
  }
  const identityProvenance = asRecord(source.identityProvenance);
  if (identityProvenance) {
    target.identityProvenance = identityProvenance;
  }
  return target;
}

function copyStringField(target: object, key: string, value: unknown): void {
  const normalized = cleanString(value);
  if (normalized) {
    (target as Record<string, unknown>)[key] = normalized;
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function shouldSkipRestartResumeForTerminalTaskSession(
  sessionName: string,
  snapshot?: DaemonRestartSessionSnapshotRecord,
): boolean {
  const taskId = getRestartSnapshotTaskBarrierTaskId(snapshot) ?? inferTaskIdFromDedicatedTaskSessionName(sessionName);
  if (!taskId && !isDedicatedTaskSessionName(sessionName)) {
    return false;
  }
  return !dbHasActiveAssignedTaskForSession(sessionName, taskId);
}

function getRestartSnapshotTaskBarrierTaskId(snapshot?: DaemonRestartSessionSnapshotRecord): string | null {
  const value = snapshot?.metadata?.currentTaskBarrierTaskId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isDedicatedTaskSessionName(sessionName: string): boolean {
  return /^task-[A-Za-z0-9_-]+-work(?:$|[:/])/.test(sessionName);
}

function inferTaskIdFromDedicatedTaskSessionName(sessionName: string): string | null {
  if (!isDedicatedTaskSessionName(sessionName)) return null;
  const workIndex = sessionName.indexOf("-work");
  if (workIndex <= 0) return null;
  const taskId = sessionName.slice(0, workIndex);
  return taskId.startsWith("task-") ? taskId : null;
}

// Note: startDaemon() is called by CLI's "daemon run" command
