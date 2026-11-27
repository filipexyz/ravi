import { assertRuntimeMaintenanceInactive } from "./runtime-maintenance.js";
import { stopRuntimeComponents } from "./runtime/shutdown.js";
import { reportErrorDiagnostic } from "./utils/error-reporting.js";
/**
 * Ravi Daemon
 *
 * Connects to external NATS and omni services (managed by PM2/omni CLI).
 * No child process spawning — all infrastructure is external.
 *
 * This process must never block on stdin. Session dispatch, delivery, and the
 * host CLI gateway share the daemon event loop. Under PM2, fd 0 is often an
 * idle socketpair; a synchronous `read(0)` wedges every agent and CLI call.
 * Interactive stdin consumers belong in a real TTY CLI, not this process.
 *
 * #539 stopped audit TTY probes from instantiating `process.stdin`. Bun can
 * still read fd 0 without that getter, so boot also replaces fd 0 with
 * `/dev/null` (`maybeNeuterDaemonStdin`). PM2 registration launches through
 * the inert-stdin wrapper so `ravi update --next` keeps the same story.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { maybeNeuterDaemonStdin } from "./daemon-stdin.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { RaviBot } from "./bot.js";
import { createGateway } from "./gateway.js";
import { OmniSender, OmniConsumer, createStubOmniConsumer } from "./omni/index.js";

import { loadConfig } from "./utils/config.js";
import { connectNats, closeNats } from "./nats.js";
import { configStore } from "./config-store.js";
import { logger } from "./utils/logger.js";
import {
  dbGetSetting,
  dbGetDaemonRestartSessionSnapshot,
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
import { revokeOrphanedShellCronContexts } from "./cron/shell-context.js";
import { startLocalWatchRunner, stopLocalWatchRunner } from "./watch/local-runner.js";
import { startGhFollowMaintenanceRunner, stopGhFollowMaintenanceRunner } from "./hooks/gh-follow-sweep.js";
import { repairThreadBoundPageCommentFollows } from "./pages/comment-follow.js";
import { repairOrphanContactChatGrants } from "./permissions/contact-merge-grants.js";
import { startJobsRunner, stopJobsRunner } from "./jobs/index.js";
import { startSessionFollowupRunner, stopSessionFollowupRunner } from "./session-followups/index.js";
import { startTriggerRunner, stopTriggerRunner } from "./triggers/index.js";
import { registerSlackAutomationSurface } from "./channels/slack/automation-surface.js";
import { startEphemeralRunner, stopEphemeralRunner } from "./ephemeral/index.js";
import { startInboxRunner, stopInboxRunner } from "./inbox/index.js";
import { startLinkRequestWatcher, stopLinkRequestWatcher } from "./identity-link/link-watcher.js";
import { startSlackApprovalClickFeedback, stopSlackApprovalClickFeedback } from "./approval/slack-click-feedback.js";
import { startSlackGrantRequestRunner, stopSlackGrantRequestRunner } from "./channels/slack/grant-request-adapter.js";
import { createSlackOmieConversationAuthority } from "./channels/slack/omie-conversation-authority.js";
import { registerOmieConversationAuthority } from "./apps/omie-orders/conversation-authority.js";
import { registerHandoffDeliveryPorts } from "./handoffs/reconcile.js";
import { registerDefaultHandoffOwnerPort } from "./handoffs/service.js";
import { startHandoffPullRequestListener } from "./handoffs/pr-events.js";
import { createSlackThreadHandoffParentNotifier } from "./channels/slack/thread-lifecycle.js";
import { registerOmieProviderReads } from "./apps/omie-orders/provider-reads.js";
import {
  startWhatsAppGrantRequestRunner,
  stopWhatsAppGrantRequestRunner,
} from "./channels/whatsapp/grant-request-adapter.js";
import { startGrantRequestSweeper, stopGrantRequestSweeper } from "./permissions/grant-requests/runner.js";
import { startHookRunner, stopHookRunner } from "./hooks-runtime/index.js";
import { startTaskCheckpointRunner, stopTaskCheckpointRunner } from "./tasks/index.js";
import { startSignalsRunner, stopSignalsRunner } from "./signals/index.js";
import { startKnowledgeLeaderRunners, stopKnowledgeLeaderRunners } from "./knowledge/runners.js";
import { startSyncRunner, stopSyncRunner } from "./sync/index.js";
import { startLibraryPinRunner, stopLibraryPinRunner } from "./library/pin-runner.js";
import { startAppStoreRunner, stopAppStoreRunner } from "./apps/store/runner.js";
import { startLibraryRequestRunner, stopLibraryRequestRunner } from "./library/request-runner.js";
import { startCloudTaskWatcher, stopCloudTaskWatcher } from "./cloud-agents/task-watcher.js";
import { startCloudWorkerRunner, stopCloudWorkerRunner } from "./cloud-agents/worker-runner.js";
import { startCloudApprovalClicks, stopCloudApprovalClicks } from "./cloud-agents/chat-routing.js";
import { startSlackCommandConsumer, stopSlackCommandConsumer } from "./channels/slack/slash-command-handler.js";
import { startSlackThreadControls, stopSlackThreadControls } from "./channels/slack/thread-controls.js";
import { startSlackDecisionAnswers, stopSlackDecisionAnswers } from "./channels/slack/decision-answer.js";
import { startSlackThreadShortcuts, stopSlackThreadShortcuts } from "./channels/slack/thread-shortcuts.js";
import { startVoiceDoor, stopVoiceDoor } from "./voice/door.js";
import { startCloudDeliveryRunner, stopCloudDeliveryRunner } from "./cloud-agents/delivery-runner.js";
import { startCalendarAssistantRunner, stopCalendarAssistantRunner } from "./calendar/assistant-runner.js";
import { createSessionAdapterBus } from "./adapters/index.js";
import { resolveOmniConnection } from "./omni-config.js";
import { ensureSessionPromptsStream, publishSessionPrompt } from "./omni/session-stream.js";
import { ensureRaviEventsStream } from "./events/audit-stream.js";
import { startWebhookHttpServerFromEnv, type WebhookHttpServerHandle } from "./webhooks/http-server.js";
import { startHostCliGateway, type HostCliGatewayHandle } from "./cli/host-cli-gateway.js";
import type { MessageTarget } from "./runtime/message-types.js";
import { deliverDaemonRestartSessionEvent, normalizeRestartResumeSource } from "./runtime/daemon-restart-resume.js";
import { getRuntimeTurnAttempt, hasLaterRuntimeTurnAttempt } from "./runtime/crash-recovery-store.js";
import {
  buildOrphanedRestartTurnInput,
  createLedgerOrphanedRestartTurnDeps,
  hasOrphanedRestartTurns,
  resolveOrphanedTurnSessionNameFromStore,
  judgeRestartInterruptedAttempt,
  type OrphanedRestartTurnDeps,
  type OrphanedRestartTurnOutcome,
  recoverOrphanedRestartTurns,
} from "./runtime/restart-turn-recovery.js";
import { dbHasActiveAssignedTaskForSession } from "./tasks/task-db.js";
import { startWorkObjectNatsService, type WorkObjectNatsServiceHandle } from "./work-objects/index.js";
import { createChannelBackendEgressRequester } from "./channels/backend-egress.js";
import { setChannelBackendEgressRequesterForRuntime } from "./channels/runtime-events.js";
import {
  tryAcquireLeadership,
  startLeadershipRenewal,
  watchForLeadershipVacancy,
  releaseLeadership,
} from "./leader/index.js";
import { scheduleChannelRunnerLivenessReport } from "./channels/runner-liveness.js";
import {
  decideNatsExposureBootAction,
  isPrivateNatsRequired,
  natsExposureLogData,
  probeNatsExposure,
  redactNatsUrl,
  REQUIRE_PRIVATE_NATS_ENV,
  type NatsExposureReport,
} from "./security/nats-exposure.js";
import { tightenStateDirPermissions } from "./security/state-dir-permissions.js";
import { anchorStateDirEnv, getRestartReasonPath, resolveBootRestartReason } from "./runtime/restart-reason.js";
import { getRaviStateDir } from "./utils/paths.js";

import { recordManagedRuntimeBoot } from "./runtime-process-identity.js";
import { acquireDaemonSchemaOwnership, markDaemonSchemaReady } from "./db/daemon-schema-owner.js";

const log = logger.child("daemon");

// Pin a relative RAVI_STATE_DIR to this process cwd before anything reads it or starts a child.
anchorStateDirEnv(process.env, process.cwd());

// Load environment from ~/.ravi/.env
function loadEnvFile() {
  const envFile = join(getRaviStateDir(), ".env");
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
// The state dir .env can carry a relative RAVI_STATE_DIR and the loader overwrites the pinned value: pin the final environment again.
anchorStateDirEnv(process.env, process.cwd());

const RESTART_REASON_FILE = getRestartReasonPath();
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
  mkdirSync(dirname(RESTART_REASON_FILE), { recursive: true });
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

let humanBridge: { stop(): Promise<void> } | null = null;
let bot: RaviBot | null = null;
let gateway: ReturnType<typeof createGateway> | null = null;
let handoffPullRequestListener: { stop(): Promise<void> } | null = null;
let sessionAdapterBus: ReturnType<typeof createSessionAdapterBus> | null = null;
let shuttingDown = false;
let omniConsumer: OmniConsumer | null = null;
let webhookHttpServer: WebhookHttpServerHandle | null = null;
let hostCliGateway: HostCliGatewayHandle | null = null;
let workObjectNatsService: WorkObjectNatsServiceHandle | null = null;

/** Get the bot instance (for in-process access like /reset) */
export function getBotInstance(): RaviBot | null {
  return bot;
}

async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down...`, { pid: process.pid });

  // Global shutdown guard — force exit if graceful shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    log.error("Shutdown timeout — forcing exit");
    process.exit(1);
  }, 15_000);

  let restartInfo: RestartReasonInfo | undefined;
  const result = await stopRuntimeComponents(
    [
      {
        name: "restart-checkpoint",
        stop: () => {
          // Preserve restart intent for interrupted turns; this is not proof
          // that accepted work completed for a schema transition.
          restartInfo =
            readRestartReasonInfo({ ensureEpoch: true }) ??
            (() => {
              const info: RestartReasonInfo = {
                reason: "supervised_restart",
                restartEpoch: newRestartEpoch(),
                createdAt: Date.now(),
              };
              writeRestartReasonInfo(info);
              return info;
            })();
          dbUpsertDaemonRestartEpoch({
            restartEpoch: restartInfo.restartEpoch,
            reason: restartInfo.reason,
            callerSessionName: restartInfo.sessionName,
            createdAt: restartInfo.createdAt,
            updatedAt: Date.now(),
          });
        },
      },
      { name: "human-bridge", stop: () => humanBridge?.stop() },
      {
        name: "bot",
        stop: async () => {
          if (!bot) return;
          log.info("Stopping bot (aborting SDK subprocesses)...");
          await bot.stop(
            restartInfo
              ? {
                  restart: { restartEpoch: restartInfo.restartEpoch, reason: restartInfo.reason },
                }
              : undefined,
          );
          log.info("Bot stopped");
        },
      },
      { name: "inbox", stop: stopInboxRunner },
      { name: "link-request", stop: stopLinkRequestWatcher },
      { name: "slack-approval-feedback", stop: stopSlackApprovalClickFeedback },
      { name: "grant-request-sweeper", stop: stopGrantRequestSweeper },
      { name: "slack-grant-request", stop: stopSlackGrantRequestRunner },
      { name: "whatsapp-grant-request", stop: stopWhatsAppGrantRequestRunner },
      { name: "sync", stop: stopSyncRunner },
      { name: "library-pin", stop: stopLibraryPinRunner },
      { name: "app-store", stop: stopAppStoreRunner },
      { name: "library-request", stop: stopLibraryRequestRunner },
      { name: "cloud-task", stop: stopCloudTaskWatcher },
      { name: "cloud-worker", stop: stopCloudWorkerRunner },
      { name: "cloud-delivery", stop: stopCloudDeliveryRunner },
      { name: "cloud-approval", stop: stopCloudApprovalClicks },
      { name: "slack-commands", stop: stopSlackCommandConsumer },
      { name: "slack-thread-controls", stop: stopSlackThreadControls },
      { name: "slack-decision-answers", stop: stopSlackDecisionAnswers },
      { name: "slack-thread-shortcuts", stop: stopSlackThreadShortcuts },
      { name: "voice-door", stop: stopVoiceDoor },
      { name: "calendar-assistant", stop: stopCalendarAssistantRunner },
      { name: "ephemeral", stop: stopEphemeralRunner },
      { name: "hook", stop: stopHookRunner },
      { name: "trigger", stop: stopTriggerRunner },
      { name: "heartbeat", stop: stopHeartbeatRunner },
      { name: "cron", stop: stopCronRunner },
      { name: "session-followup", stop: stopSessionFollowupRunner },
      { name: "local-watch", stop: stopLocalWatchRunner },
      { name: "github-follow", stop: stopGhFollowMaintenanceRunner },
      { name: "jobs", stop: stopJobsRunner },
      { name: "task-checkpoint", stop: stopTaskCheckpointRunner },
      { name: "signals", stop: stopSignalsRunner },
      { name: "knowledge", stop: stopKnowledgeLeaderRunners },
      { name: "leadership", stop: () => releaseLeadership("runners") },
      { name: "gateway", stop: () => gateway?.stop() },
      { name: "handoff-pr-events", stop: () => handoffPullRequestListener?.stop() },
      { name: "session-adapters", stop: () => sessionAdapterBus?.stop() },
      { name: "work-objects", stop: () => workObjectNatsService?.stop() },
      { name: "webhook-http", stop: () => webhookHttpServer?.stop() },
      {
        name: "host-cli",
        stop: async () => {
          await hostCliGateway?.stop();
          hostCliGateway = null;
        },
      },
      { name: "omni-consumer", stop: () => omniConsumer?.stop() },
      { name: "config-store", stop: () => configStore.stop() },
      { name: "backend-egress", stop: () => setChannelBackendEgressRequesterForRuntime() },
    ],
    [
      { name: "nats", stop: closeNats },
      { name: "sqlite", stop: closeAllRaviDbs },
    ],
    exitCode,
    (failure) => {
      reportErrorDiagnostic(log, "Daemon shutdown component failed", failure.cause, {
        operation: `shutdown.${failure.name}`,
      });
    },
  );

  clearTimeout(shutdownTimeout);
  log.info("Daemon stopped", {
    pid: process.pid,
    exitCode: result.exitCode,
    unproven: result.failures.length,
    drain: result.drain.phase,
  });
  process.exit(result.exitCode);
}

function restartAfterFatalRuntimeError(error: Error): void {
  log.error("Fatal runtime ownership error; exiting for supervised restart", {
    pid: process.pid,
    error,
  });
  void shutdown("fatal runtime ownership error", 1);
}

/** Best-effort: keep the state dir (credentials, DBs) private to the owner. */
function tightenStateDirAtBoot(): void {
  const result = tightenStateDirPermissions(getRaviStateDir());
  if (result.action === "tightened") {
    log.info("Tightened state dir permissions", result);
  } else if (result.action === "error") {
    log.warn("Could not tighten state dir permissions", result);
  }
}

/**
 * Warn when NATS is reachable from the network or remote in plaintext. The
 * probe runs in the background unless RAVI_REQUIRE_PRIVATE_NATS=1, in which
 * case boot waits for it and refuses to continue on a risky result.
 */
async function checkNatsExposureAtBoot(natsUrl: string): Promise<void> {
  const requirePrivate = isPrivateNatsRequired();
  const evaluate = (report: NatsExposureReport) => {
    const action = decideNatsExposureBootAction(report, { requirePrivate });
    if (action === "warn") log.warn(`NATS exposure: ${report.message}`, natsExposureLogData(report));
    return action;
  };

  if (!requirePrivate) {
    void probeNatsExposure(natsUrl)
      .then(evaluate)
      .catch((err) => log.debug("NATS exposure probe failed", { err }));
    return;
  }

  const report = await probeNatsExposure(natsUrl);
  if (evaluate(report) === "refuse") {
    log.error(`Refusing to start: ${REQUIRE_PRIVATE_NATS_ENV}=1 and ${report.message}`, natsExposureLogData(report));
    await closeNats();
    throw new Error(`Refusing to start: ${REQUIRE_PRIVATE_NATS_ENV}=1 and NATS is ${report.status}`);
  }
}

function revokeOrphanedShellCronKeysAtBoot(): void {
  try {
    const revoked = revokeOrphanedShellCronContexts();
    if (revoked > 0) log.info("Revoked shell cron keys whose run is over", { count: revoked });
  } catch (error) {
    // Boot continues: the keys still expire at their TTL and with their command.
    log.error("Failed to revoke orphaned shell cron keys at boot", { error });
  }
}

function repairThreadBoundPageCommentFollowsAtBoot(): void {
  try {
    const { repaired, failures } = repairThreadBoundPageCommentFollows();
    if (repaired > 0) log.info("Moved page comment triggers from Slack threads to their durable parent", { repaired });
    for (const failure of failures) {
      // Left as they were: a trigger whose thread cannot be resolved is not moved on a guess.
      log.warn("Could not move a page comment trigger off its Slack thread", {
        triggerId: failure.triggerId,
        error: failure.error,
      });
    }
  } catch (error) {
    // Boot continues: a trigger left on a thread only blocks closing that thread.
    log.error("Failed to repair page comment triggers at boot", { error });
  }
}

function repairOrphanContactChatGrantsAtBoot(): void {
  try {
    for (const result of repairOrphanContactChatGrants()) {
      log.info("Repaired chat grants left on a merged contact", {
        sourceContactId: result.sourceContactId,
        targetContactId: result.targetContactId,
        outcomes: result.grants.map((grant) => `${grant.grantId}:${grant.outcome}`),
      });
    }
  } catch (error) {
    // Boot continues: an orphan grant names a contact id nothing resolves to.
    log.error("Failed to repair orphan contact chat grants at boot", { error });
  }
}

export async function startDaemon() {
  assertRuntimeMaintenanceInactive();
  acquireDaemonSchemaOwnership();
  maybeNeuterDaemonStdin();
  if (!recordManagedRuntimeBoot("ravi"))
    log.warn("Could not record process boot identity; runtime alignment will remain unverified");
  tightenStateDirAtBoot();
  await (await import("./db/runtime-state.js")).initializeRuntimeState();
  // Before any gateway listens: a shell cron key whose issuing process is gone
  // must not be usable against this daemon.
  revokeOrphanedShellCronKeysAtBoot();
  // Before the trigger runner loads: its subscriptions read the repaired owners.
  repairThreadBoundPageCommentFollowsAtBoot();
  repairOrphanContactChatGrantsAtBoot();

  // Step 1: Connect to NATS (with retry for PM2 parallel startup)
  const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
  log.info("Connecting to NATS...", { natsUrl: redactNatsUrl(natsUrl) });
  await connectNats(natsUrl, { explicit: true, role: "daemon" });
  await checkNatsExposureAtBoot(natsUrl);
  setChannelBackendEgressRequesterForRuntime(createChannelBackendEgressRequester());

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
  bot = new RaviBot({ config, onFatalRuntimeError: restartAfterFatalRuntimeError });
  await bot.start();
  log.info("Bot started");
  if (process.env.RAVI_HUMAN_BRIDGE === "1") {
    const { startHumanBridge } = await import("./bridge/socket.js");
    const { nativeBridgeRuntime } = await import("./bridge/native.js");
    humanBridge = await startHumanBridge(nativeBridgeRuntime(bot));
    log.info("Human bridge listening on its local socket");
  }

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
    const stubConsumer = createStubOmniConsumer();
    gateway = createGateway({
      logLevel: config.logLevel,
      omniSender: stubSender,
      omniConsumer: stubConsumer,
    });
  }

  await gateway.start();
  log.info("Gateway started");
  // Report-only: a ravi-only restart can leave `ravi-channels` PM2-online with
  // a dead Slack Socket Mode loop. Surface it instead of staying silent.
  scheduleChannelRunnerLivenessReport({
    isStopping: () => shuttingDown,
    report: (decision) => {
      log.error("Channel runner is PM2-online but its health is not confirmed; run `ravi channels start`", decision);
    },
    onError: (error) => log.warn("Channel runner liveness check failed", { error }),
  });

  // Automation runs whose parent answers in Slack show as Slack threads (the core knows no channel).
  registerSlackAutomationSurface();

  // Step 7: Start runners — leader election ensures only one daemon runs heartbeat/cron
  // Trigger, ephemeral, and inbox are per-daemon (each daemon handles its own).
  const isLeader = await tryAcquireLeadership("runners");

  if (isLeader) {
    startLeadershipRenewal("runners");
    await startHeartbeatRunner();
    log.info("Heartbeat runner started (leader)");
    await startCronRunner();
    log.info("Cron runner started (leader)");
    await startLocalWatchRunner();
    log.info("Local watch runner started (leader)");
    await startGhFollowMaintenanceRunner();
    log.info("gh follow maintenance runner started (leader)");
    await startJobsRunner();
    log.info("Jobs runner started (leader)");
    await startSessionFollowupRunner();
    log.info("Session followup runner started (leader)");
    await startTaskCheckpointRunner({
      canPublishSessionPrompt: (sessionName) => bot?.canAcceptRuntimePrompt(sessionName) ?? true,
      getSessionRuntimeState: (sessionName) => bot?.getSessionRuntimeState(sessionName) ?? null,
    });
    log.info("Task checkpoint runner started (leader)");
    await startSignalsRunner();
    log.info("Signals runner started (leader)");
    startKnowledgeLeaderRunners();
    log.info("Knowledge runners started (leader)");
    await startCalendarAssistantRunner();
    log.info("Meeting assistant runner started (leader)");
  } else {
    log.info("Not leader — heartbeat, cron, and task checkpoint runners skipped (another daemon is running them)");
    watchForLeadershipVacancy("runners", async () => {
      log.info("Leadership vacancy detected — starting heartbeat, cron, and task checkpoint runners");
      await startHeartbeatRunner();
      await startCronRunner();
      await startSessionFollowupRunner();
      await startLocalWatchRunner();
      await startGhFollowMaintenanceRunner();
      await startJobsRunner();
      await startTaskCheckpointRunner({
        canPublishSessionPrompt: (sessionName) => bot?.canAcceptRuntimePrompt(sessionName) ?? true,
        getSessionRuntimeState: (sessionName) => bot?.getSessionRuntimeState(sessionName) ?? null,
      });
      await startSignalsRunner();
      startKnowledgeLeaderRunners();
      await startCalendarAssistantRunner();
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

  await startLinkRequestWatcher();
  log.info("Link request watcher started");

  await startSlackApprovalClickFeedback();
  log.info("Slack approval click feedback started");

  startGrantRequestSweeper();
  await startSlackGrantRequestRunner();
  await startWhatsAppGrantRequestRunner();
  log.info("Grant request runners started");

  // Composition knows channels; the Omie executor does not. It asks the adapter of its configured channel type.
  registerOmieConversationAuthority(createSlackOmieConversationAuthority());
  registerHandoffDeliveryPorts({ notifyParent: createSlackThreadHandoffParentNotifier() });
  registerDefaultHandoffOwnerPort();
  handoffPullRequestListener = startHandoffPullRequestListener();
  // The broker must know the executor's reads before any query has loaded the executor (spec credentials/broker).
  registerOmieProviderReads();

  await startSyncRunner();
  log.info("Sync runner started");

  await startLibraryPinRunner();
  log.info("Library pin runner started");

  await startAppStoreRunner();
  log.info("App store runner started");

  await startLibraryRequestRunner();
  log.info("Library request runner started");

  await startCloudTaskWatcher();
  log.info("Cloud task watcher started");

  // Idle until `ravi cloud worker enable --execute` (F4 self-hosted environments).
  await startCloudWorkerRunner();
  log.info("Cloud worker runner started");
  await startCloudDeliveryRunner();
  await startCloudApprovalClicks();
  log.info("Cloud delivery runner started");
  await startSlackCommandConsumer();
  log.info("Slack command consumer started");
  await startSlackThreadControls();
  await startSlackDecisionAnswers();
  log.info("Slack thread controls started");
  await startSlackThreadShortcuts();
  log.info("Slack thread shortcuts started");
  // Voice is optional: a failure here must never keep the daemon from serving chats.
  try {
    await startVoiceDoor();
    log.info("Voice door started");
  } catch (error) {
    log.error("Voice door failed to start; voice calls are unavailable", { error });
  }

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

  try {
    hostCliGateway = await startHostCliGateway();
    if (hostCliGateway) {
      log.info("Host CLI gateway ready", { socketPath: hostCliGateway.socketPath });
    }
  } catch (error) {
    log.error("Host CLI gateway failed to start", error);
    hostCliGateway = null;
  }

  await bot.consumerReady;
  markDaemonSchemaReady();
  log.info("Daemon ready");
  // A channel runner an upgrade stopped comes back only now, against a ready daemon on a fenced database.
  const { resumeChannelsAfterUpgradeLive } = await import("./threads/fence-adoption-live.js");
  const channelsAfterUpgrade = resumeChannelsAfterUpgradeLive();
  if (channelsAfterUpgrade === "started") log.info("Channel runner started again after the upgrade");
  else if (channelsAfterUpgrade === "failed")
    log.warn("The channel runner stopped for the upgrade did not start; run 'ravi channels start'");

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
 * Check if there's a restart reason file and notify the originating session.
 *
 * A plain `pm2 restart` (deploy, supervised bounce, crash) never writes
 * `restart-reason.txt`, so this used to return early and the sessions were
 * never told the daemon had restarted. Synthesize a boot reason instead and
 * let the notice path run, but only when the fallback session exists: without a
 * snapshot the delivery fences into a `Daemon reiniciou` notice, which is
 * exactly what the operator needs to see. On a first boot (no reason file and
 * no session to tell) nothing was restarted, so the boot returns quietly.
 */
async function notifyRestartReason() {
  let restartInfo = resolveBootRestartReason<RestartReasonInfo>({
    fromFile: readRestartReasonInfo({ consume: true }),
    fallbackSessionExists: Boolean(getMainSession(dbGetSetting("defaultAgent") || "main")),
    synthesize: () => ({
      reason: "supervised_restart",
      restartEpoch: newRestartEpoch(),
      createdAt: Date.now(),
    }),
  });
  // Without a reason file and a main session there is nobody to notify, but a
  // hard stop may still have left turns running in the crash-recovery ledger.
  const recoverOnly = !restartInfo;
  if (!restartInfo) {
    if (!hasOrphanedRestartTurns(orphanedTurnScope(), orphanedTurnDeps(undefined))) {
      log.info("First boot: no restart reason, no main session and no interrupted turns; skipping the restart notice");
      return;
    }
    restartInfo = { reason: "supervised_restart", restartEpoch: newRestartEpoch(), createdAt: Date.now() };
  }

  dbUpsertDaemonRestartEpoch({
    restartEpoch: restartInfo.restartEpoch,
    reason: restartInfo.reason,
    callerSessionName: restartInfo.sessionName,
    createdAt: restartInfo.createdAt,
    updatedAt: Date.now(),
  });

  // Turns cut off without a graceful snapshot (SIGKILL, exit, crash) are only
  // in the crash-recovery ledger. Resume them first, so the caller notice below
  // can say which sessions resume on their own and skip a session it resumed.
  const orphaned = await recoverOrphanedRestartTurnsNow(restartInfo);
  if (recoverOnly) {
    scheduleDeferredOrphanedTurnRecovery(restartInfo, orphaned, undefined);
    return;
  }

  const snapshots = dbListEligibleDaemonRestartSessionSnapshots({
    restartEpoch: restartInfo.restartEpoch,
    now: Date.now(),
    windowMs: RESTART_RESUME_WINDOW_MS,
  });

  const callerSessionName = restartInfo.sessionName ?? resolveFallbackRestartSessionName();
  log.info("Delivering daemon restart events", {
    restartEpoch: restartInfo.restartEpoch,
    restartReason: restartInfo.reason,
    callerSessionName: callerSessionName ?? null,
    eligibleSnapshots: snapshots.length,
  });
  const eligibleCallerSnapshot = callerSessionName
    ? findRestartSnapshotForSession(snapshots, callerSessionName)
    : undefined;
  const callerSessionKey = callerSessionName ? resolveRestartSessionKey(callerSessionName) : undefined;
  const callerSnapshot =
    eligibleCallerSnapshot ??
    (callerSessionKey ? dbGetDaemonRestartSessionSnapshot(restartInfo.restartEpoch, callerSessionKey) : null) ??
    undefined;
  const callerEvent = callerSessionName
    ? {
        sessionName: callerSessionName,
        snapshot: callerSnapshot,
        snapshotEligible: !callerSnapshot || Boolean(eligibleCallerSnapshot),
      }
    : undefined;
  // A caller whose own interrupted turn waits for the previous boot's lease is
  // resumed by the deferred pass; a notice now would record a delivery for it
  // and tell it to stop, so its notice waits for that pass instead.
  const callerAwaitsRecovery = Boolean(callerSessionKey && orphaned.pendingSessionKeys.includes(callerSessionKey));
  if (callerEvent && !callerAwaitsRecovery) {
    await publishRestartResumeEvent(callerEvent.sessionName, restartInfo, {
      kind: "caller",
      snapshot: callerEvent.snapshot,
      snapshotEligible: callerEvent.snapshotEligible,
      resumedSessionNames: [...orphaned.resumed, ...orphaned.pending],
    });
  }

  for (const snapshot of snapshots) {
    if (eligibleCallerSnapshot?.sessionKey === snapshot.sessionKey) {
      continue;
    }
    await publishRestartResumeEvent(snapshot.sessionName, restartInfo, { kind: "active", snapshot });
  }

  scheduleDeferredOrphanedTurnRecovery(restartInfo, orphaned, callerAwaitsRecovery ? callerEvent : undefined);
}

const ORPHANED_TURN_RETRY_MARGIN_MS = 2_000;

/**
 * A previous boot still inside its lease cannot be fenced yet. Look again once
 * the lease runs out (once: a boot that keeps renewing is alive), then send any
 * caller notice that was held back for it, unless that pass already delivered
 * a restart event to the caller.
 */
function scheduleDeferredOrphanedTurnRecovery(
  restartInfo: RestartReasonInfo,
  orphaned: OrphanedRestartTurnOutcome,
  deferredCaller:
    | { sessionName: string; snapshot?: DaemonRestartSessionSnapshotRecord; snapshotEligible: boolean }
    | undefined,
): void {
  if (orphaned.retryAt === null) return;
  const delayMs = Math.max(0, orphaned.retryAt - Date.now()) + ORPHANED_TURN_RETRY_MARGIN_MS;
  log.info("Deferring orphaned turn recovery until the previous boot lease expires", {
    delayMs,
    pending: orphaned.pending,
    callerDeferred: deferredCaller?.sessionName ?? null,
  });
  setTimeout(() => {
    void (async () => {
      const later = await recoverOrphanedRestartTurnsNow(restartInfo);
      if (deferredCaller) {
        await publishRestartResumeEvent(deferredCaller.sessionName, restartInfo, {
          kind: "caller",
          snapshot: deferredCaller.snapshot,
          snapshotEligible: deferredCaller.snapshotEligible,
          resumedSessionNames: later.resumed,
        });
      }
    })().catch((error) => log.error("Deferred orphaned turn recovery failed", { error }));
  }, delayMs).unref?.();
}

function orphanedTurnScope() {
  return { currentBootEpoch: bot?.crashRecoveryBootEpoch ?? null, windowMs: RESTART_RESUME_WINDOW_MS };
}

function orphanedTurnDeps(restartInfo: RestartReasonInfo | undefined): OrphanedRestartTurnDeps {
  return {
    ...createLedgerOrphanedRestartTurnDeps(bot?.crashRecoveryBootEpoch ?? "", {
      runMetadata: { restartEpoch: restartInfo?.restartEpoch ?? null },
    }),
    hasDelivery: dbHasDaemonRestartResumeDelivery,
    resolveSessionName: resolveOrphanedTurnSessionNameFromStore,
    isTerminalTaskSession: (sessionName, taskId) =>
      shouldSkipRestartResumeForTerminalTaskSession(
        sessionName,
        taskId
          ? ({ metadata: { currentTaskBarrierTaskId: taskId } } as unknown as DaemonRestartSessionSnapshotRecord)
          : undefined,
      ),
    deliver: (input) => (restartInfo ? deliverOrphanedRestartTurn(restartInfo, input) : Promise.resolve(false)),
  };
}

async function recoverOrphanedRestartTurnsNow(restartInfo: RestartReasonInfo): Promise<OrphanedRestartTurnOutcome> {
  try {
    const outcome = await recoverOrphanedRestartTurns(
      { restartEpoch: restartInfo.restartEpoch, ...orphanedTurnScope() },
      orphanedTurnDeps(restartInfo),
    );
    log.info("Orphaned turn recovery finished", {
      restartEpoch: restartInfo.restartEpoch,
      recoveryRunId: outcome.recoveryRunId,
      resumed: outcome.resumed,
      noticed: outcome.noticed,
      skipped: outcome.skipped,
      pending: outcome.pending,
      retryAt: outcome.retryAt,
    });
    return outcome;
  } catch (error) {
    log.error("Orphaned turn recovery failed", { restartEpoch: restartInfo.restartEpoch, error });
    return {
      recoveryRunId: null,
      resumed: [],
      noticed: [],
      skipped: [],
      retryAt: null,
      pending: [],
      pendingSessionKeys: [],
    };
  }
}

async function deliverOrphanedRestartTurn(
  restartInfo: RestartReasonInfo,
  input: Parameters<OrphanedRestartTurnDeps["deliver"]>[0],
): Promise<boolean> {
  const { verdict, sessionName } = input;
  const attempt = verdict.attempt;
  const payload = buildOrphanedRestartTurnInput({
    restartEpoch: restartInfo.restartEpoch,
    reason: restartInfo.reason,
    verdict,
  });
  const deliveryKind = verdict.kind === "resume" ? "resume" : "notice";
  const decisionReason = verdict.kind === "resume" ? "verify_continue" : verdict.fenceReason;
  const context = {
    restartEpoch: restartInfo.restartEpoch,
    sessionName,
    sessionKey: attempt.sessionKey,
    attemptId: attempt.attemptId,
    deliveryKind,
    decisionReason,
  };
  // Record the delivery before publishing: the attempt is already claimed, so
  // this event is at most once; marking first also keeps the snapshot path from
  // publishing a second event for the session when the record could not be
  // written after a publish.
  try {
    dbMarkDaemonRestartResumeDelivered({
      restartEpoch: restartInfo.restartEpoch,
      sessionKey: attempt.sessionKey,
      sessionName,
      deliveryKind,
      decisionReason,
    });
  } catch (error) {
    log.error("Could not record the orphaned turn restart event; not publishing it", { ...context, error });
    return false;
  }
  try {
    log.info("Publishing orphaned turn restart event", context);
    await publishSessionPrompt(sessionName, payload);
  } catch (error) {
    log.error("Failed to publish orphaned turn restart event", { ...context, error });
    return false;
  }
  return true;
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
  options: {
    kind: "caller" | "active";
    snapshot?: DaemonRestartSessionSnapshotRecord;
    snapshotEligible?: boolean;
    resumedSessionNames?: string[];
  } = { kind: "active" },
): Promise<boolean> {
  const outcome = await deliverDaemonRestartSessionEvent(
    {
      restartEpoch: restartInfo.restartEpoch,
      reason: restartInfo.reason,
      sessionName,
      sessionKey: options.snapshot?.sessionKey ?? resolveRestartSessionKey(sessionName),
      kind: options.kind,
      snapshot: options.snapshot,
      snapshotEligible: options.snapshotEligible,
      resumedSessionNames: options.resumedSessionNames,
    },
    {
      hasDelivery: dbHasDaemonRestartResumeDelivery,
      markDelivered: dbMarkDaemonRestartResumeDelivered,
      publish: publishSessionPrompt,
      isTerminalTaskSession: shouldSkipRestartResumeForTerminalTaskSession,
      resolveSource: resolveRestartResumeSource,
      judgeInterruptedAttempt: ({ attemptId }) =>
        judgeRestartInterruptedAttempt(getRuntimeTurnAttempt(attemptId), {
          hasLaterAttempt: hasLaterRuntimeTurnAttempt,
        }),
    },
  );
  return outcome.status === "delivered";
}

function resolveRestartResumeSource(snapshot?: DaemonRestartSessionSnapshotRecord): MessageTarget | undefined {
  const currentSource = asRecord(snapshot?.metadata?.currentSource);
  if (!currentSource) {
    return undefined;
  }
  return normalizeRestartResumeSource(currentSource);
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
