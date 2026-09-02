import { configStore } from "../config-store.js";
import { projectChannelRuntimeEvent } from "../channels/runtime-events.js";
import { saveMessage } from "../db.js";
import {
  DEFAULT_DELIVERY_BARRIER,
  chooseMoreUrgentBarrier,
  describeDeliveryBarrier,
  type DeliveryBarrier,
  type DeliveryBarrierSource,
} from "../delivery-barriers.js";
import { nats } from "../nats.js";
import { getSession, getSessionByName, type SessionEntry } from "../router/index.js";
import {
  dbGetDaemonRestartPendingMessages,
  dbGetSetting,
  dbRecordDaemonRestartSessionSnapshot,
} from "../router/router-db.js";
import {
  createSessionTraceTurnId,
  recordRuntimeTraceEvent,
  recordTerminalTurnTrace,
} from "../session-trace/runtime-trace.js";
import { dbHasActiveAssignedTaskForSession, dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
import { revokeAgentRuntimeContextsForSession } from "./context-registry.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { hasRuntimeTurnAttemptInputMutation, type RuntimeTurnAttemptTerminalStatus } from "./crash-recovery-store.js";
import {
  createQueuedRuntimeUserMessage,
  getRuntimePromptDeliveryBarrier,
  hasIsolatedRuntimeTurnEnvelope,
  hasDeliverableRuntimeMessages,
  prepareRuntimeInterruptSuccessor,
  shouldInterruptRuntimeForIncoming,
  type RuntimeInterruptSuccessorPreparation,
  wakeRuntimeSessionIfDeliverable,
} from "./delivery-queue.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import {
  CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY,
  resolveCrashRecoveryRestartResumeMode,
} from "./daemon-restart-resume.js";
import {
  getCrashRecoveryReplayablePendingRuntimeMessages,
  getPendingRuntimeTurnSuccessors,
  getRuntimeTurnReplaySafety,
  runtimeTurnAttemptTerminalEventType,
  shutdownRuntimeStreamingSession,
  stashPendingRuntimeMessages,
  type RuntimeHostStreamingSession,
  type RuntimeMessageTarget,
  type RuntimeUserMessage,
} from "./host-session.js";
import { applyDirectRuntimeModelSwitch, resolveRuntimeModelSwitchStrategy } from "./model-switch.js";
import { resolveRequestedRuntimeProvider } from "./runtime-selection.js";
import {
  MODEL_BROKER_REQUIRED_SETTING,
  buildRuntimeModelBrokerPhysicalFingerprint,
  buildRuntimeModelBrokerSelectionCompatibilityKey,
  resolveRequiredRuntimeModelBrokerSelection,
} from "./model-broker.js";
import { planRuntimeModelBrokerRoute, type RuntimeModelBrokerPlan } from "./model-broker-planning.js";
import type { RuntimeProviderId } from "./types.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import { markRuntimeLiveIdle, updateRuntimeLiveState } from "./live-state.js";
import {
  startRuntimeSession,
  updateRuntimeSessionMetadata,
  type PendingRuntimeSessionStart,
} from "./session-launcher.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { isSameRuntimeTurnSurface } from "./turn-surface.js";
import type { RuntimeRecoveryExhaustedAlertInput } from "./runtime-recovery-alert.js";
import { resolvePersistedUserText, resolveRuntimePromptText, withSessionSurfaceHint } from "./session-surface-hint.js";
import { resolveRuntimeForPrompt, runtimePromptRequiresRestart } from "./task-runtime-context.js";
import {
  buildRuntimeSessionPoolSnapshot,
  classifyRuntimeSessionStartLane,
  resolveRuntimeStreamingSession,
  type RuntimeSessionPoolSnapshot,
  type RuntimeStreamingSessionIdentity,
} from "./session-pool.js";

const log = logger.child("runtime:session-dispatcher");
const RUNTIME_EVENT_LOOP_CLOSED_REASON = "runtime_event_loop_closed";
const PROVIDER_TURN_INACTIVE_REASON = "provider_turn_inactive";
const PROVIDER_TRANSPORT_FAILURE_REASON = "provider_transport_failure";
const MAX_RUNTIME_EVENT_LOOP_RESTARTS = 2;
const MAX_PROVIDER_TURN_INACTIVE_RESTARTS = 1;
const MAX_PROVIDER_TRANSPORT_FAILURE_RESTARTS = 2;
const RUNTIME_RECOVERY_RESTART_LIMITS: Readonly<Partial<Record<string, number>>> = {
  [RUNTIME_EVENT_LOOP_CLOSED_REASON]: MAX_RUNTIME_EVENT_LOOP_RESTARTS,
  [PROVIDER_TURN_INACTIVE_REASON]: MAX_PROVIDER_TURN_INACTIVE_RESTARTS,
  [PROVIDER_TRANSPORT_FAILURE_REASON]: MAX_PROVIDER_TRANSPORT_FAILURE_RESTARTS,
};
const RUNTIME_RESTART_EXHAUSTED_ERROR =
  "Runtime provider stream closed repeatedly. Automatic recovery was stopped; send a new message to retry.";
const NATIVE_STEER_ACTIVE_TURN_MAX_IDLE_MS = 30_000;
const IDLE_GAP_RECOVERY_MS = Math.max(1_000, Number(process.env.RAVI_RUNTIME_IDLE_GAP_RECOVERY_MS) || 5_000);

interface DebounceState {
  messages: RuntimeLaunchPrompt[];
  timer: ReturnType<typeof setTimeout>;
  debounceMs: number;
}

interface DaemonRestartSnapshotOptions {
  restartEpoch: string;
  reason: string;
  stoppedAt?: number;
}

interface RestartSnapshotAccumulator {
  sessionKey: string;
  sessionName: string;
  agentId?: string;
  runtimeProvider?: string;
  activity: string;
  nonIdle: boolean;
  lastActivityAt: number;
  stoppedAt: number;
  pendingMessages: RuntimeUserMessage[];
  metadata: Record<string, unknown>;
}

export interface RuntimeSessionDispatcherOptions {
  instanceId: string;
  maxConcurrentSessions: number;
  interactiveReservedSessions: number;
  safeEmit: RuntimeSafeEmit;
  notifyRuntimeRecoveryExhausted(input: RuntimeRecoveryExhaustedAlertInput): Promise<void>;
  getConfigModel(): string;
  crashRecovery: RuntimeCrashRecoveryCoordinator;
}

export interface RuntimeAbortProvenance {
  source?: string;
  action?: string;
  reason?: string;
  actor?: string;
  correlationId?: string;
  request?: unknown;
}

export class RuntimeSessionDispatcher {
  readonly streamingSessions = new Map<string, RuntimeHostStreamingSession>();
  readonly debounceStates = new Map<string, DebounceState>();
  readonly deferredAfterTaskStarts = new Map<string, RuntimeLaunchPrompt[]>();
  readonly pendingStarts: PendingRuntimeSessionStart[] = [];
  readonly startReservations = new Set<string>();
  readonly stashedMessages = new Map<string, RuntimeUserMessage[]>();
  readonly inFlightStartPrompts = new Map<string, RuntimeLaunchPrompt>();
  readonly pendingStartSessions = new Set<string>();
  readonly startingSessions = new Set<string>();
  private readonly runtimeRecoveryRestartAttempts = new Map<string, Readonly<Partial<Record<string, number>>>>();

  constructor(private readonly options: RuntimeSessionDispatcherOptions) {}

  getRuntimeSessionPoolSnapshot(): RuntimeSessionPoolSnapshot {
    return buildRuntimeSessionPoolSnapshot(this.streamingSessions, {
      limit: this.options.maxConcurrentSessions,
      pendingStarts: this.pendingStarts.length,
      interactiveReserved: this.options.interactiveReservedSessions,
    });
  }

  canAcceptRuntimePrompt(sessionName?: string): boolean {
    if (!this.options.crashRecovery.acceptingDeliveries) return false;
    if (sessionName) {
      const streaming = this.streamingSessions.get(sessionName);
      if (streaming && !streaming.done) return true;
      if (this.pendingStartSessions.has(sessionName)) return true;
      if (this.startingSessions.has(sessionName)) return true;
    }
    return this.hasRuntimeSessionPoolSlotForStart(sessionName);
  }

  recordDaemonRestartSnapshot(options: DaemonRestartSnapshotOptions): number {
    const stoppedAt = options.stoppedAt ?? Date.now();
    const snapshots = new Map<string, RestartSnapshotAccumulator>();

    const getAccumulator = (sessionName: string, overrides: Partial<RestartSnapshotAccumulator> = {}) => {
      const sessionEntry = getSessionByName(sessionName) ?? getSession(sessionName);
      const sessionKey = sessionEntry?.sessionKey ?? sessionName;
      const existing = snapshots.get(sessionKey);
      if (existing) {
        if (overrides.agentId) existing.agentId = overrides.agentId;
        if (overrides.runtimeProvider) existing.runtimeProvider = overrides.runtimeProvider;
        if (overrides.activity && existing.activity === "idle") existing.activity = overrides.activity;
        existing.nonIdle = existing.nonIdle || Boolean(overrides.nonIdle);
        existing.lastActivityAt = Math.max(
          existing.lastActivityAt,
          overrides.lastActivityAt ?? existing.lastActivityAt,
        );
        Object.assign(existing.metadata, overrides.metadata ?? {});
        return existing;
      }

      const next: RestartSnapshotAccumulator = {
        sessionKey,
        sessionName,
        agentId: overrides.agentId ?? sessionEntry?.agentId,
        runtimeProvider: overrides.runtimeProvider ?? sessionEntry?.runtimeProvider,
        activity: overrides.activity ?? "idle",
        nonIdle: Boolean(overrides.nonIdle),
        lastActivityAt: overrides.lastActivityAt ?? stoppedAt,
        stoppedAt,
        pendingMessages: [],
        metadata: {
          reason: options.reason,
          ...(overrides.metadata ?? {}),
        },
      };
      snapshots.set(sessionKey, next);
      return next;
    };

    const addPrompt = (sessionName: string, prompt: RuntimeLaunchPrompt, source: string) => {
      const queued = createQueuedRuntimeUserMessage(prompt);
      queued.queuedAt = prompt.context?.timestamp ?? queued.queuedAt;
      const snapshot = getAccumulator(sessionName, {
        activity: "queued",
        nonIdle: true,
        lastActivityAt: queued.queuedAt ?? stoppedAt,
        metadata: { [source]: true },
      });
      appendRestartPendingMessages(snapshot, [queued]);
    };

    for (const [sessionName, session] of this.streamingSessions) {
      if (shouldSkipDaemonRestartTaskSessionSnapshot(sessionName, session)) {
        log.info("Skipping daemon restart snapshot for terminal task session", {
          sessionName,
          taskBarrierTaskId: session.currentTaskBarrierTaskId ?? null,
        });
        continue;
      }
      const terminalTurnConsumed = session.currentCrashRecoveryTerminal !== undefined;
      const pendingMessages = (
        terminalTurnConsumed
          ? (session.currentTurnPendingIds?.length ?? 0) > 0
            ? getPendingRuntimeTurnSuccessors(session)
            : session.pendingMessages
          : getCrashRecoveryReplayablePendingRuntimeMessages(session, this.options.crashRecovery)
      ).map(cloneRuntimeUserMessage);
      const durableReplaySafety = getRuntimeTurnReplaySafety(session, this.options.crashRecovery);
      // A provider-terminal physical turn has already been consumed even when
      // it produced no external output or tool side effect. Explicit retry
      // paths may still use the global replay helper for interrupted/failed
      // turns, but a daemon restart must never resurrect any terminal turn.
      const replaySafety = terminalTurnConsumed
        ? { ...durableReplaySafety, replayable: false as const }
        : durableReplaySafety;
      const restartResumeMode = replaySafety.replayable
        ? "continue"
        : pendingMessages.length > 0
          ? "pending_only"
          : "skip";
      const nonIdle = !replaySafety.replayable || isDaemonRestartNonIdleSession(session) || pendingMessages.length > 0;
      const snapshot = getAccumulator(sessionName, {
        agentId: session.agentId,
        runtimeProvider: session.queryHandle.provider,
        activity: describeDaemonRestartActivity(session),
        nonIdle,
        lastActivityAt: session.lastActivity || stoppedAt,
        metadata: {
          live: true,
          turnActive: session.turnActive,
          starting: session.starting,
          compacting: session.compacting,
          toolRunning: session.toolRunning,
          pendingAbort: session.pendingAbort,
          pendingWake: session.pendingWake,
          currentSource: session.currentSource ? cloneRuntimeMessageTarget(session.currentSource) : null,
          currentToolName: session.currentToolName ?? null,
          currentTaskBarrierTaskId: session.currentTaskBarrierTaskId ?? null,
          currentTurnPendingIds: session.currentTurnPendingIds ?? [],
          currentTurnSuperseded: Boolean(session.currentTurnSuperseded),
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: restartResumeMode,
          crashRecoveryReplaySafety: replaySafety,
          crashRecoveryTerminalStatus: session.currentCrashRecoveryTerminal?.status ?? null,
        },
      });
      appendRestartPendingMessages(snapshot, pendingMessages);
    }

    for (const pendingStart of this.pendingStarts) {
      if (pendingStart.cancelled) continue;
      addPrompt(pendingStart.sessionName, pendingStart.prompt, "pendingStart");
    }

    for (const [sessionName, prompt] of this.inFlightStartPrompts) {
      if (this.streamingSessions.has(sessionName)) continue;
      addPrompt(sessionName, prompt, "inFlightStart");
    }

    for (const [sessionName, messages] of this.stashedMessages) {
      const snapshot = getAccumulator(sessionName, {
        activity: "queued",
        nonIdle: messages.length > 0,
        lastActivityAt: newestRuntimeMessageQueuedAt(messages, stoppedAt),
        metadata: { stashed: true },
      });
      appendRestartPendingMessages(snapshot, messages.map(cloneRuntimeUserMessage));
    }

    for (const [sessionName, state] of this.debounceStates) {
      for (const prompt of state.messages) {
        addPrompt(sessionName, prompt, "debounce");
      }
    }

    for (const [sessionName, prompts] of this.deferredAfterTaskStarts) {
      for (const prompt of prompts) {
        addPrompt(sessionName, prompt, "deferredAfterTask");
      }
    }

    let recorded = 0;
    for (const snapshot of snapshots.values()) {
      if (!snapshot.nonIdle) continue;
      if (resolveCrashRecoveryRestartResumeMode(snapshot.metadata) === "skip" && snapshot.pendingMessages.length > 0) {
        snapshot.metadata[CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY] = "pending_only";
      }
      dbRecordDaemonRestartSessionSnapshot({
        restartEpoch: options.restartEpoch,
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        agentId: snapshot.agentId,
        runtimeProvider: snapshot.runtimeProvider,
        activity: snapshot.activity,
        nonIdle: snapshot.nonIdle,
        lastActivityAt: snapshot.lastActivityAt,
        stoppedAt: snapshot.stoppedAt,
        pendingMessages: snapshot.pendingMessages,
        metadata: snapshot.metadata,
        recordedAt: stoppedAt,
      });
      recorded++;
    }

    if (recorded > 0) {
      log.info("Recorded daemon restart session snapshots", {
        restartEpoch: options.restartEpoch,
        count: recorded,
      });
    }
    return recorded;
  }

  shutdownAll(): void {
    if (this.pendingStarts.length > 0) {
      log.info("Clearing pending session starts", { count: this.pendingStarts.length });
      for (const pendingStart of this.pendingStarts.splice(0)) {
        pendingStart.cancelled = true;
        pendingStart.resolve();
      }
    }

    if (this.debounceStates.size > 0) {
      log.info("Clearing debounce timers", { count: this.debounceStates.size });
      for (const state of this.debounceStates.values()) {
        clearTimeout(state.timer);
      }
      this.debounceStates.clear();
    }

    if (this.deferredAfterTaskStarts.size > 0) {
      log.info("Clearing deferred after-task starts", { count: this.deferredAfterTaskStarts.size });
      this.deferredAfterTaskStarts.clear();
    }

    if (this.inFlightStartPrompts.size > 0) {
      log.info("Clearing in-flight session start prompts", { count: this.inFlightStartPrompts.size });
      this.inFlightStartPrompts.clear();
    }

    if (this.startingSessions.size > 0) {
      log.info("Clearing session cold starts", { count: this.startingSessions.size });
      this.startingSessions.clear();
    }
    if (this.pendingStartSessions.size > 0) {
      log.info("Clearing pending-start session index", { count: this.pendingStartSessions.size });
      this.pendingStartSessions.clear();
    }
    if (this.startReservations.size > 0) {
      log.info("Clearing session start reservations", { count: this.startReservations.size });
      this.startReservations.clear();
    }
    this.runtimeRecoveryRestartAttempts.clear();

    if (this.streamingSessions.size === 0) {
      return;
    }

    log.info("Aborting streaming sessions", {
      count: this.streamingSessions.size,
      sessions: [...this.streamingSessions.keys()],
    });
    let firstError: unknown;
    for (const [sessionName, session] of this.streamingSessions) {
      log.info("Aborting streaming session", { sessionName });
      try {
        recordStreamingAbortTrace(this.options.crashRecovery, sessionName, session, "shutdown_all");
      } catch (error) {
        firstError ??= error;
        log.error("Failed to terminalize streaming session during shutdown", {
          sessionName,
          error,
        });
      } finally {
        try {
          shutdownRuntimeStreamingSession(session, "shutdown_all");
        } catch (error) {
          firstError ??= error;
          log.error("Failed to close streaming session during shutdown", {
            sessionName,
            error,
          });
        }
      }
    }
    this.streamingSessions.clear();
    if (firstError) {
      throw firstError;
    }
  }

  abortSession(
    sessionNameOrIdentity: string | RuntimeStreamingSessionIdentity,
    provenance: RuntimeAbortProvenance = {},
  ): boolean {
    const abortReason = provenance.reason ?? "explicit_abort";
    const identity =
      typeof sessionNameOrIdentity === "string"
        ? { sessionName: sessionNameOrIdentity }
        : {
            sessionName: sessionNameOrIdentity.sessionName ?? undefined,
            sessionKey: sessionNameOrIdentity.sessionKey ?? undefined,
          };
    const requestedKey = identity.sessionName ?? identity.sessionKey ?? "(unknown)";
    const resolved = resolveRuntimeStreamingSession(this.streamingSessions, identity);
    const allNames = [...this.streamingSessions.keys()];
    log.info("abortSession called", {
      sessionName: identity.sessionName,
      sessionKey: identity.sessionKey,
      resolvedName: resolved?.name,
      requestedKey,
      allNames,
      found: Boolean(resolved),
      provenance,
    });
    if (!resolved) return false;

    const sessionName = resolved.name;
    const session = resolved.session;
    const sessionEntry =
      getSessionByName(sessionName) ?? (identity.sessionKey ? getSession(identity.sessionKey) : null);
    const sessionKey = sessionEntry?.sessionKey ?? identity.sessionKey ?? sessionName;

    if (session.toolResultDeliveryPending || (session.toolRunning && session.currentToolSafety === "unsafe")) {
      log.info("Deferring abort - tool barrier active", {
        sessionName,
        tool: session.currentToolName,
        toolResultDeliveryPending: Boolean(session.toolResultDeliveryPending),
        provenance,
      });
      session.internalAbortReason = `${abortReason}_deferred`;
      session.pendingAbort = true;
      recordRuntimeTraceEvent({
        sessionKey,
        sessionName,
        agentId: session.agentId,
        runId: session.traceRunId,
        turnId: session.currentTraceTurnId,
        provider: session.queryHandle.provider,
        model: session.currentModel,
        eventType: "session.abort",
        eventGroup: "session",
        status: "deferred",
        source: session.currentSource,
        payloadJson: {
          reason: session.internalAbortReason,
          provenance,
          tool: session.currentToolName ?? null,
          toolSafety: session.currentToolSafety,
          toolResultDeliveryPending: Boolean(session.toolResultDeliveryPending),
        },
      });
      return true;
    }

    if (session.pendingMessages.length > 0) {
      log.info("Stashing aborted messages", { sessionName, count: session.pendingMessages.length });
      stashPendingRuntimeMessages(sessionName, session, this.stashedMessages, {
        crashRecovery: this.options.crashRecovery,
      });
    }

    log.info("Aborting streaming session", { sessionName, done: session.done, provenance });
    recordStreamingAbortTrace(this.options.crashRecovery, sessionName, session, abortReason, sessionKey, provenance);
    if (sessionKey) {
      revokeAgentRuntimeContextsForSession(sessionKey, {
        reason: abortReason,
      });
    }
    this.options
      .safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "turn.interrupted",
        provider: session.queryHandle.provider,
        reason: abortReason,
        sessionName,
        ...(session.currentSource ? { _source: session.currentSource } : {}),
        timestamp: new Date().toISOString(),
      })
      .catch((error) => {
        log.warn("Failed to emit explicit abort runtime event", { sessionName, error });
      });
    shutdownRuntimeStreamingSession(session, abortReason);
    this.releaseRuntimeSessionSlot(sessionName);
    markRuntimeLiveIdle(sessionName, "turn interrupted");
    return true;
  }

  async applySessionModelChange(
    sessionName: string,
    model: string,
    options: {
      drainReleasedSlot?: boolean;
      restartStashedMessages?: boolean;
      modelSource?: string | null;
      modelPresetId?: string | null;
      modelPresetVersion?: number | null;
    } = {},
  ): Promise<"missing" | "unchanged" | "applied" | "restart-next-turn"> {
    const resolved = resolveRuntimeStreamingSession(this.streamingSessions, {
      sessionName,
      sessionKey: sessionName,
    });
    const streaming = resolved?.session;
    if (!streaming || streaming.done) {
      return "missing";
    }
    sessionName = resolved.name;
    if (streaming.currentModel === model) {
      return "unchanged";
    }

    const sessionEntry = getSessionByName(sessionName) ?? getSession(sessionName);
    const sessionKey = sessionEntry?.sessionKey ?? sessionName;
    const presetTrace = {
      ...(options.modelSource ? { modelSource: options.modelSource } : {}),
      ...(options.modelPresetId ? { modelPresetId: options.modelPresetId } : {}),
      ...(options.modelPresetVersion !== undefined && options.modelPresetVersion !== null
        ? { modelPresetVersion: options.modelPresetVersion }
        : {}),
    };

    if (resolveRuntimeModelSwitchStrategy(streaming.queryHandle) === "direct-set") {
      recordRuntimeTraceEvent({
        sessionKey,
        sessionName,
        agentId: streaming.agentId,
        runId: streaming.traceRunId,
        turnId: streaming.currentTraceTurnId,
        provider: streaming.queryHandle.provider,
        model,
        eventType: "session.model_changed",
        eventGroup: "session",
        status: "applied",
        source: streaming.currentSource,
        payloadJson: {
          previousModel: streaming.currentModel,
          nextModel: model,
          strategy: "direct-set",
          ...presetTrace,
        },
      });
      await applyDirectRuntimeModelSwitch(streaming.queryHandle, model);
      streaming.currentModel = model;
      return "applied";
    }

    const hasStashedMessages = streaming.pendingMessages.length > 0;
    if (hasStashedMessages) {
      stashPendingRuntimeMessages(sessionName, streaming, this.stashedMessages, {
        crashRecovery: this.options.crashRecovery,
      });
    }
    streaming.currentModel = model;
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName,
      agentId: streaming.agentId,
      runId: streaming.traceRunId,
      turnId: streaming.currentTraceTurnId,
      provider: streaming.queryHandle.provider,
      model,
      eventType: "dispatch.restart_requested",
      eventGroup: "dispatch",
      status: "requested",
      source: streaming.currentSource,
      payloadJson: {
        reason: "model_change_restart",
        nextModel: model,
        strategy: "restart-next-turn",
        ...presetTrace,
      },
    });
    recordStreamingTurnInterruptedTrace(
      this.options.crashRecovery,
      sessionName,
      streaming,
      "model_change_restart",
      sessionKey,
    );
    shutdownRuntimeStreamingSession(streaming, "model_change_restart");
    const shouldRestartStashedMessages = options.restartStashedMessages === true && hasStashedMessages;
    this.releaseRuntimeSessionSlot(sessionName, {
      drainPendingStarts: shouldRestartStashedMessages ? false : (options.drainReleasedSlot ?? true),
    });
    if (shouldRestartStashedMessages) {
      await this.restartStashedSession(sessionName, "model_change_restart");
      this.drainPendingStarts();
    }
    return "restart-next-turn";
  }

  async startDeferredAfterTaskSessionIfDeliverable(sessionName: string): Promise<void> {
    const queued = this.deferredAfterTaskStarts.get(sessionName);
    if (!queued || queued.length === 0) {
      return;
    }
    const first = queued[0];
    if (!first) {
      this.deferredAfterTaskStarts.delete(sessionName);
      return;
    }
    if (dbHasActiveTaskForSession(sessionName, first.taskBarrierTaskId)) {
      return;
    }

    if (!this.streamingSessions.has(sessionName) && !this.canAcceptRuntimePrompt(sessionName)) {
      const snapshot = this.getRuntimeSessionPoolSnapshot();
      log.warn("Deferred after-task session start delayed by runtime session pool backpressure", {
        sessionName,
        queued: queued.length,
        active: snapshot.active,
        limit: snapshot.limit,
        pendingStarts: snapshot.pendingStarts,
      });
      this.options
        .safeEmit(`ravi.session.${sessionName}.runtime`, {
          type: "dispatch.queued",
          reason: "runtime_session_pool_saturated",
          active: snapshot.active,
          limit: snapshot.limit,
          pendingStarts: snapshot.pendingStarts,
          queued: queued.length,
          timestamp: new Date().toISOString(),
        })
        .catch((error) => {
          log.warn("Failed to emit deferred start backpressure event", { sessionName, error });
        });
      return;
    }

    this.deferredAfterTaskStarts.delete(sessionName);

    if (this.streamingSessions.has(sessionName)) {
      for (const prompt of queued) {
        await this.handlePromptImmediate(sessionName, prompt);
      }
      return;
    }

    const [, ...rest] = queued;
    await this.startStreamingSession(sessionName, first);
    for (const prompt of rest) {
      await this.handlePromptImmediate(sessionName, prompt);
    }
  }

  wakeStreamingSessionIfDeliverable(sessionName: string): void {
    wakeRuntimeSessionIfDeliverable(sessionName, this.streamingSessions);
  }

  async handlePrompt(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const agentId = prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];
    if (!agent) {
      log.error("No agent found for prompt", { sessionName, agentId });
      return;
    }

    const isGroup = sessionEntry?.chatType === "group" || sessionName.includes(":group:");
    const debounceMs = isGroup && agent?.groupDebounceMs ? agent.groupDebounceMs : agent?.debounceMs;
    log.debug("handlePrompt", { sessionName, agentId, debounceMs, isGroup });

    if (debounceMs && debounceMs > 0) {
      this.handlePromptWithDebounce(sessionName, prompt, debounceMs);
      return;
    }

    await this.handlePromptImmediate(sessionName, prompt);
  }

  handlePromptWithDebounce(sessionName: string, prompt: RuntimeLaunchPrompt, debounceMs: number): void {
    const existing = this.debounceStates.get(sessionName);

    if (existing) {
      log.debug("Debounce: adding message", { sessionName, count: existing.messages.length + 1 });
      clearTimeout(existing.timer);
      existing.messages.push(prompt);
      existing.timer = this.scheduleDebounceFlush(sessionName, debounceMs);
    } else {
      log.debug("Debounce: starting", { sessionName, debounceMs });
      const state: DebounceState = {
        messages: [prompt],
        timer: this.scheduleDebounceFlush(sessionName, debounceMs),
        debounceMs,
      };
      this.debounceStates.set(sessionName, state);
    }
  }

  private scheduleDebounceFlush(sessionName: string, debounceMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.flushDebounce(sessionName).catch((error) => {
        log.error("Debounce flush failed", { sessionName, error });
      });
    }, debounceMs);
  }

  async flushDebounce(sessionName: string): Promise<void> {
    const state = this.debounceStates.get(sessionName);
    if (!state) return;

    this.debounceStates.delete(sessionName);
    clearTimeout(state.timer);

    const combinedPrompts = buildDebouncedRuntimePrompts(state.messages);

    log.info("Debounce: flushing", {
      sessionName,
      messageCount: state.messages.length,
      batchCount: combinedPrompts.length,
    });

    for (const combinedPrompt of combinedPrompts) {
      await this.handlePromptImmediate(sessionName, combinedPrompt);
    }
  }

  async handlePromptImmediate(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
    if (!prompt._resumeStashedMessages) {
      this.runtimeRecoveryRestartAttempts.delete(sessionName);
    }
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const existing = this.streamingSessions.get(sessionName);
    let daemonRestartMessages: RuntimeUserMessage[] | undefined;
    if (prompt._daemonRestartResume) {
      const needsColdStartStash =
        (!existing || existing.done) &&
        !this.pendingStartSessions.has(sessionName) &&
        !this.startingSessions.has(sessionName);
      const preparedRestart = this.prepareDaemonRestartResumePrompt(sessionName, prompt, sessionEntry);
      if (!preparedRestart) {
        log.warn("Skipping pending-only daemon restart resume because no durable pending messages remain", {
          sessionName,
          restartEpoch: prompt._daemonRestartResume.restartEpoch,
        });
        return;
      }
      prompt = preparedRestart.prompt;
      daemonRestartMessages = preparedRestart.messages;
      if (needsColdStartStash) {
        this.stashedMessages.set(sessionName, daemonRestartMessages.map(cloneRuntimeUserMessage));
      } else if (existing && !existing.done) {
        // Keep every persisted atom on the live queue before any model/provider
        // restart decision. If the runtime must be replaced, the normal stash
        // path carries these exact atoms into the replacement session.
        appendUniqueRuntimeMessages(existing.pendingMessages, daemonRestartMessages);
      }
    }
    if (!prompt._resumeStashedMessages) {
      prompt = withSessionSurfaceHint(prompt);
    }
    const agentId = prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];
    if (!agent) {
      log.error("No agent found for prompt", { sessionName, agentId });
      return;
    }
    const sessionRuntimeProviderOverride =
      prompt._observation && prompt._runtimeProviderId ? undefined : sessionEntry?.runtimeProviderOverride;
    if (existing && shouldQueuePromptOnLiveSession(sessionName, existing, prompt, agent.id)) {
      await this.enqueuePromptOnLiveSession(sessionName, existing, prompt, {
        sessionEntry,
        agentId: sessionEntry?.agentId ?? agent.id,
        daemonRestartMessages,
      });
      return;
    }
    let modelBrokerPlan: RuntimeModelBrokerPlan | undefined;
    const modelBrokerTurnId = prompt._modelBrokerTurnId ?? createSessionTraceTurnId();
    modelBrokerPlan = await planRuntimeModelBrokerRoute({
      agent,
      sessionKey: sessionEntry?.sessionKey ?? sessionName,
      turnId: modelBrokerTurnId,
      globalRequiredSetting: dbGetSetting(MODEL_BROKER_REQUIRED_SETTING) ?? undefined,
    });
    if (modelBrokerPlan && prompt._modelBrokerTurnId !== modelBrokerTurnId) {
      prompt = { ...prompt, _modelBrokerTurnId: modelBrokerTurnId };
    }
    const requestedProvider: RuntimeProviderId = modelBrokerPlan
      ? modelBrokerPlan.lease.runtimeProvider
      : resolveRequestedRuntimeProvider({
          observationProviderId:
            prompt._observation && prompt._runtimeProviderId ? prompt._runtimeProviderId : undefined,
          sessionProviderOverride: sessionRuntimeProviderOverride,
          lastUsedProvider: sessionEntry?.runtimeProvider,
          restartSnapshotProvider: prompt._daemonRestartResume?.runtimeProvider,
          agent,
        }).value;
    let retainReleasedSlot = false;

    if (existing && !existing.done) {
      if (existing.agentId !== agent.id || existing.queryHandle.provider !== requestedProvider) {
        const restartReason = existing.agentId !== agent.id ? "agent_change" : "provider_change";
        log.info("Streaming: restarting session after runtime identity change", {
          sessionName,
          reason: restartReason,
          activeAgentId: existing.agentId,
          requestedAgentId: agent.id,
          activeProvider: existing.queryHandle.provider,
          requestedProvider,
          queueSize: existing.pendingMessages.length,
        });

        if (existing.pendingMessages.length > 0) {
          stashPendingRuntimeMessages(sessionName, existing, this.stashedMessages, {
            crashRecovery: this.options.crashRecovery,
          });
        }

        recordRuntimeTraceEvent({
          sessionKey: sessionEntry?.sessionKey ?? sessionName,
          sessionName,
          agentId: existing.agentId,
          runId: existing.traceRunId,
          turnId: existing.currentTraceTurnId,
          provider: existing.queryHandle.provider,
          model: existing.currentModel,
          eventType: "dispatch.restart_requested",
          eventGroup: "dispatch",
          status: "requested",
          source: existing.currentSource,
          payloadJson: {
            reason: restartReason,
            activeAgentId: existing.agentId,
            requestedAgentId: agent.id,
            activeProvider: existing.queryHandle.provider,
            requestedProvider,
          },
        });
        recordStreamingTurnInterruptedTrace(
          this.options.crashRecovery,
          sessionName,
          existing,
          restartReason,
          sessionEntry?.sessionKey,
        );
        shutdownRuntimeStreamingSession(existing, restartReason);
        this.releaseRuntimeSessionSlot(sessionName, { drainPendingStarts: false });
        retainReleasedSlot = true;
      } else {
        const requestedRuntime = resolveRuntimeForPrompt({
          sessionName,
          prompt,
          session: sessionEntry,
          agent,
          configModel: this.options.getConfigModel(),
        });
        const requestedModel =
          modelBrokerPlan?.lease.model ?? requestedRuntime.options.model ?? this.options.getConfigModel();
        const modelBrokerConfigurationChanged = runtimeModelBrokerConfigurationRequiresRestart(existing, agent);
        const modelBrokerRouteChanged = runtimeModelBrokerRouteRequiresRestart(existing, modelBrokerPlan);
        if (
          modelBrokerConfigurationChanged ||
          modelBrokerRouteChanged ||
          runtimePromptRequiresRestart(existing, requestedRuntime, prompt)
        ) {
          log.info("Streaming: restarting session after runtime task settings change", {
            sessionName,
            modelBrokerConfigurationChanged,
            modelBrokerRouteChanged,
            currentTaskBarrierTaskId: existing.currentTaskBarrierTaskId ?? null,
            requestedTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? null,
            currentEffort: existing.currentEffort ?? null,
            requestedEffort: requestedRuntime.options.effort ?? null,
            currentThinking: existing.currentThinking ?? null,
            requestedThinking: requestedRuntime.options.thinking ?? null,
          });
          stashPendingRuntimeMessages(sessionName, existing, this.stashedMessages, {
            crashRecovery: this.options.crashRecovery,
          });
          recordRuntimeTraceEvent({
            sessionKey: sessionEntry?.sessionKey ?? sessionName,
            sessionName,
            agentId: existing.agentId,
            runId: existing.traceRunId,
            turnId: existing.currentTraceTurnId,
            provider: existing.queryHandle.provider,
            model: existing.currentModel,
            eventType: "dispatch.restart_requested",
            eventGroup: "dispatch",
            status: "requested",
            source: existing.currentSource,
            payloadJson: {
              reason: "runtime_task_settings_change",
              currentTaskBarrierTaskId: existing.currentTaskBarrierTaskId ?? null,
              requestedTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? null,
              currentEffort: existing.currentEffort ?? null,
              requestedEffort: requestedRuntime.options.effort ?? null,
              currentThinking: existing.currentThinking ?? null,
              requestedThinking: requestedRuntime.options.thinking ?? null,
            },
          });
          recordStreamingTurnInterruptedTrace(
            this.options.crashRecovery,
            sessionName,
            existing,
            "runtime_task_settings_change",
            sessionEntry?.sessionKey,
          );
          shutdownRuntimeStreamingSession(existing, "runtime_task_settings_change");
          this.releaseRuntimeSessionSlot(sessionName, { drainPendingStarts: false });
          await this.startStreamingSession(sessionName, prompt, { retainReleasedSlot: true });
          return;
        }
        if (!existing.currentModel) {
          existing.currentModel = requestedModel;
        } else if (existing.currentModel !== requestedModel) {
          const modelStatus = await this.applySessionModelChange(sessionName, requestedModel, {
            drainReleasedSlot: false,
            modelSource: requestedRuntime.sources.model,
            modelPresetId: requestedRuntime.modelPresetId ?? null,
            modelPresetVersion: requestedRuntime.modelPresetVersion ?? null,
          });
          if (modelStatus === "restart-next-turn") {
            await this.startStreamingSession(sessionName, prompt, { retainReleasedSlot: true });
            return;
          }
        }

        log.info("Streaming: pushing message to existing session", { sessionName });
        if (sessionEntry) {
          updateRuntimeSessionMetadata(sessionEntry.sessionKey, prompt);
        }
        const messageSource = prompt.source ?? existing.currentSource;
        if (!prompt._resumeStashedMessages) {
          saveMessage(
            sessionName,
            "user",
            resolvePersistedUserText(prompt),
            sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId,
            {
              agentId: sessionEntry?.agentId ?? existing.agentId,
              channel: messageSource?.channel ?? prompt.context?.channelId,
              accountId: messageSource?.accountId ?? prompt.context?.accountId,
              chatId: messageSource?.chatId ?? prompt.context?.chatId,
              sourceMessageId: messageSource?.sourceMessageId ?? prompt.context?.messageId,
              commands: prompt.commands,
            },
          );
        }

        const barrier = getRuntimePromptDeliveryBarrier(prompt);
        const nativeSteer = modelBrokerPlan
          ? "fallback"
          : await this.tryNativeRuntimeSteer(sessionName, existing, prompt, barrier, sessionEntry?.sessionKey);
        if (nativeSteer === "accepted") {
          updateRuntimeLiveState(sessionName, {
            activity: "thinking",
            summary: "runtime control accepted",
            agentId: existing.agentId,
            runId: existing.traceRunId,
            provider: existing.queryHandle.provider,
            model: existing.currentModel,
            source: prompt.source ?? existing.currentSource,
          });
          return;
        }

        const queuedMessages = daemonRestartMessages ?? [createQueuedRuntimeUserMessage(prompt)];
        appendUniqueRuntimeMessages(existing.pendingMessages, queuedMessages);
        updateRuntimeLiveState(sessionName, {
          activity: "thinking",
          summary: existing.turnActive ? `queued ${existing.pendingMessages.length}` : "prompt queued",
          agentId: existing.agentId,
          runId: existing.traceRunId,
          provider: existing.queryHandle.provider,
          model: existing.currentModel,
          source: prompt.source ?? existing.currentSource,
        });

        recordRuntimeTraceEvent({
          sessionKey: sessionEntry?.sessionKey ?? sessionName,
          sessionName,
          agentId: existing.agentId,
          runId: existing.traceRunId,
          turnId: existing.currentTraceTurnId,
          provider: existing.queryHandle.provider,
          model: existing.currentModel,
          eventType: "dispatch.push_existing",
          eventGroup: "dispatch",
          status: "queued",
          source: prompt.source ?? existing.currentSource,
          messageId: prompt.context?.messageId,
          payloadJson: {
            queueSize: existing.pendingMessages.length,
            barrier: describeDeliveryBarrier(barrier),
            barrierSource: prompt.deliveryBarrierSource ?? null,
            taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
          },
        });

        if (existing.pushMessage) {
          const deliverableNow = hasDeliverableRuntimeMessages(sessionName, existing);
          if (deliverableNow) {
            log.info("Streaming: waking generator", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
            });
            const resolver = existing.pushMessage;
            existing.pushMessage = null;
            resolver(null);
          } else {
            log.info("Streaming: queued without wake", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: "waiting_for_barrier",
            });
            recordRuntimeTraceEvent({
              sessionKey: sessionEntry?.sessionKey ?? sessionName,
              sessionName,
              agentId: existing.agentId,
              runId: existing.traceRunId,
              turnId: existing.currentTraceTurnId,
              provider: existing.queryHandle.provider,
              model: existing.currentModel,
              eventType: "dispatch.queued_busy",
              eventGroup: "dispatch",
              status: "queued",
              source: prompt.source ?? existing.currentSource,
              messageId: prompt.context?.messageId,
              payloadJson: {
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                reason: "waiting_for_barrier",
              },
            });
            this.options
              .safeEmit(`ravi.session.${sessionName}.runtime`, {
                type: "dispatch.queued",
                provider: existing.queryHandle.provider,
                reason: "waiting_for_barrier",
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                queueSize: existing.pendingMessages.length,
                sessionState: describeSessionState(existing),
                timestamp: new Date().toISOString(),
              })
              .catch((error) => {
                log.warn("Failed to emit dispatch.queued event", { sessionName, error });
              });
          }
        } else {
          const decision = shouldInterruptRuntimeForIncoming(sessionName, existing, barrier, prompt.taskBarrierTaskId);
          if (!decision.interrupt) {
            log.info("Streaming: queueing (busy)", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: decision.reason,
              tool: existing.currentToolName,
            });
            recordRuntimeTraceEvent({
              sessionKey: sessionEntry?.sessionKey ?? sessionName,
              sessionName,
              agentId: existing.agentId,
              runId: existing.traceRunId,
              turnId: existing.currentTraceTurnId,
              provider: existing.queryHandle.provider,
              model: existing.currentModel,
              eventType: "dispatch.queued_busy",
              eventGroup: "dispatch",
              status: "queued",
              source: prompt.source ?? existing.currentSource,
              messageId: prompt.context?.messageId,
              payloadJson: {
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                reason: decision.reason,
                tool: existing.currentToolName ?? null,
              },
            });
            this.options
              .safeEmit(`ravi.session.${sessionName}.runtime`, {
                type: "dispatch.queued",
                provider: existing.queryHandle.provider,
                reason: decision.reason,
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                queueSize: existing.pendingMessages.length,
                tool: existing.currentToolName ?? null,
                sessionState: describeSessionState(existing),
                timestamp: new Date().toISOString(),
              })
              .catch((error) => {
                log.warn("Failed to emit dispatch.queued event", { sessionName, error });
              });
            if (decision.reason === "idle_gap") {
              wakeRuntimeSessionIfDeliverable(sessionName, this.streamingSessions);
              this.scheduleIdleGapRecovery(sessionName, existing, sessionEntry?.sessionKey ?? sessionName);
            }
          } else {
            const successor = prepareRuntimeInterruptSuccessor(sessionName, existing);
            if (!successor) {
              log.info("Streaming: keeping successor queued behind the active turn", {
                sessionName,
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
                reason: "turn_surface_or_delivery_boundary",
              });
              return;
            }
            await this.interruptForRuntimeSuccessor(
              sessionName,
              existing,
              successor,
              decision.reason,
              prompt,
              sessionEntry?.sessionKey ?? sessionName,
            );
          }
        }
        return;
      }
    }

    if (existing?.done) {
      this.releaseRuntimeSessionSlot(sessionName);
    }

    if (!existing && this.pendingStartSessions.has(sessionName)) {
      log.info("Streaming: queueing while session start waits for runtime pool slot", { sessionName });
      if (sessionEntry) {
        updateRuntimeSessionMetadata(sessionEntry.sessionKey, prompt);
      }
      if (!prompt._resumeStashedMessages) {
        saveMessage(
          sessionName,
          "user",
          resolvePersistedUserText(prompt),
          sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId,
          {
            agentId: sessionEntry?.agentId ?? agent.id,
            channel: prompt.source?.channel ?? prompt.context?.channelId,
            accountId: prompt.source?.accountId ?? prompt.context?.accountId,
            chatId: prompt.source?.chatId ?? prompt.context?.chatId,
            sourceMessageId: prompt.source?.sourceMessageId ?? prompt.context?.messageId,
            commands: prompt.commands,
          },
        );
      }
      const queued = daemonRestartMessages
        ? appendUniqueRuntimeMessagesToStash(sessionName, daemonRestartMessages, this.stashedMessages)
        : stashPromptForStartingSession(sessionName, prompt, this.stashedMessages);
      const traceIdentity = this.resolvePendingStartTraceIdentity(sessionName, prompt);
      const lane = classifyRuntimeSessionStartLane(sessionName, prompt);
      recordRuntimeTraceEvent({
        sessionKey: traceIdentity.sessionKey,
        sessionName,
        agentId: traceIdentity.agentId ?? agent.id,
        provider: requestedProvider,
        eventType: "dispatch.queued_busy",
        eventGroup: "dispatch",
        status: "queued",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        payloadJson: {
          queueSize: queued.length,
          reason: "pending_start_backpressure",
          lane,
          active: this.streamingSessions.size,
          reserved: this.getStartReservationCount(),
          queued: this.pendingStarts.length,
          max: this.options.maxConcurrentSessions,
          interactiveReserved: this.options.interactiveReservedSessions,
          backgroundLimit: this.getBackgroundStartLimit(),
          deliveryBarrier: describeDeliveryBarrier(getRuntimePromptDeliveryBarrier(prompt)),
          deliveryBarrierSource: prompt.deliveryBarrierSource ?? null,
          taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        },
      });
      this.options
        .safeEmit(`ravi.session.${sessionName}.runtime`, {
          type: "dispatch.queued",
          provider: requestedProvider,
          reason: "pending_start_backpressure",
          lane,
          queueSize: queued.length,
          active: this.streamingSessions.size,
          reserved: this.getStartReservationCount(),
          queued: this.pendingStarts.length,
          max: this.options.maxConcurrentSessions,
          timestamp: new Date().toISOString(),
        })
        .catch((error) => {
          log.warn("Failed to emit dispatch.queued event", { sessionName, error });
        });
      return;
    }

    if (!existing && this.startingSessions.has(sessionName)) {
      log.info("Streaming: queueing during cold start", { sessionName });
      if (sessionEntry) {
        updateRuntimeSessionMetadata(sessionEntry.sessionKey, prompt);
      }
      if (!prompt._resumeStashedMessages) {
        saveMessage(
          sessionName,
          "user",
          resolvePersistedUserText(prompt),
          sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId,
          {
            agentId: sessionEntry?.agentId ?? agent.id,
            channel: prompt.source?.channel ?? prompt.context?.channelId,
            accountId: prompt.source?.accountId ?? prompt.context?.accountId,
            chatId: prompt.source?.chatId ?? prompt.context?.chatId,
            sourceMessageId: prompt.source?.sourceMessageId ?? prompt.context?.messageId,
            commands: prompt.commands,
          },
        );
      }
      const queued = daemonRestartMessages
        ? appendUniqueRuntimeMessagesToStash(sessionName, daemonRestartMessages, this.stashedMessages)
        : stashPromptForStartingSession(sessionName, prompt, this.stashedMessages);
      recordRuntimeTraceEvent({
        sessionKey: sessionEntry?.sessionKey ?? sessionName,
        sessionName,
        agentId: agent.id,
        provider: requestedProvider,
        eventType: "dispatch.queued_busy",
        eventGroup: "dispatch",
        status: "queued",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        payloadJson: {
          queueSize: queued.length,
          reason: "cold_start_inflight",
          deliveryBarrier: describeDeliveryBarrier(getRuntimePromptDeliveryBarrier(prompt)),
          deliveryBarrierSource: prompt.deliveryBarrierSource ?? null,
          taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        },
      });
      this.options
        .safeEmit(`ravi.session.${sessionName}.runtime`, {
          type: "dispatch.queued",
          provider: requestedProvider,
          reason: "cold_start_inflight",
          queueSize: queued.length,
          timestamp: new Date().toISOString(),
        })
        .catch((error) => {
          log.warn("Failed to emit dispatch.queued event", { sessionName, error });
        });
      return;
    }

    if (
      !existing &&
      getRuntimePromptDeliveryBarrier(prompt) === "after_task" &&
      dbHasActiveTaskForSession(sessionName, prompt.taskBarrierTaskId)
    ) {
      const queued = this.deferredAfterTaskStarts.get(sessionName) ?? [];
      queued.push(prompt);
      this.deferredAfterTaskStarts.set(sessionName, queued);
      log.info("Streaming: deferring cold start until task release", {
        sessionName,
        queued: queued.length,
      });
      recordRuntimeTraceEvent({
        sessionKey: sessionEntry?.sessionKey ?? sessionName,
        sessionName,
        agentId: agent.id,
        eventType: "dispatch.deferred_after_task",
        eventGroup: "dispatch",
        status: "deferred",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        payloadJson: {
          queued: queued.length,
          deliveryBarrier: describeDeliveryBarrier(getRuntimePromptDeliveryBarrier(prompt)),
          deliveryBarrierSource: prompt.deliveryBarrierSource ?? null,
          taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        },
      });
      return;
    }

    recordRuntimeTraceEvent({
      sessionKey: sessionEntry?.sessionKey ?? sessionName,
      sessionName,
      agentId: agent.id,
      provider: requestedProvider,
      eventType: "dispatch.cold_start",
      eventGroup: "dispatch",
      status: "starting",
      source: prompt.source,
      messageId: prompt.context?.messageId,
      payloadJson: {
        provider: requestedProvider,
        taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        deliveryBarrier: describeDeliveryBarrier(getRuntimePromptDeliveryBarrier(prompt)),
        deliveryBarrierSource: prompt.deliveryBarrierSource ?? null,
      },
    });
    await this.startStreamingSession(sessionName, prompt, { retainReleasedSlot });
  }

  private prepareDaemonRestartResumePrompt(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    sessionEntry: SessionEntry | null,
  ): { prompt: RuntimeLaunchPrompt; messages: RuntimeUserMessage[] } | null {
    const restartResume = prompt._daemonRestartResume;
    if (!restartResume) {
      const message = createQueuedRuntimeUserMessage(prompt);
      return { prompt, messages: [message] };
    }

    const sessionKey = restartResume.sessionKey ?? sessionEntry?.sessionKey ?? sessionName;
    const pendingMessages = normalizePersistedRuntimeMessages(
      dbGetDaemonRestartPendingMessages(restartResume.restartEpoch, sessionKey),
    );
    if (pendingMessages.length === 0 && restartResume.pendingOnly) {
      return null;
    }

    const combined = restartResume.pendingOnly
      ? pendingMessages
      : [...pendingMessages, createQueuedRuntimeUserMessage(prompt)];
    const restartPrompt = buildStashedRestartPrompt(combined);
    if (!restartPrompt) {
      return null;
    }

    log.info("Prepared daemon restart resume with persisted pending messages", {
      sessionName,
      sessionKey,
      restartEpoch: restartResume.restartEpoch,
      pendingMessages: pendingMessages.length,
    });
    return {
      prompt: {
        ...restartPrompt,
        _daemonRestartResume: restartResume,
      },
      messages: combined.map(cloneRuntimeUserMessage),
    };
  }

  async startStreamingSession(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    options: { retainReleasedSlot?: boolean } = {},
  ): Promise<void> {
    this.pendingStartSessions.add(sessionName);
    let reserved = false;
    try {
      reserved = await this.reserveRuntimeSessionStart(sessionName, prompt, options);
      if (!reserved) {
        return;
      }
      this.pendingStartSessions.delete(sessionName);
      this.startingSessions.add(sessionName);
      this.inFlightStartPrompts.set(sessionName, prompt);
      await startRuntimeSession({
        sessionName,
        prompt,
        configModel: this.options.getConfigModel(),
        instanceId: this.options.instanceId,
        streamingSessions: this.streamingSessions,
        stashedMessages: this.stashedMessages,
        safeEmit: this.options.safeEmit,
        drainPendingStarts: () => this.drainPendingStarts(),
        restartStashedSession: ({ sessionName: stashedSessionName, reason }) =>
          this.restartStashedSession(stashedSessionName, reason),
        onToolBarrierReleased: (releasedSessionName) => this.releaseQueuedPromptsAfterTool(releasedSessionName),
        crashRecovery: this.options.crashRecovery,
      });
    } finally {
      this.inFlightStartPrompts.delete(sessionName);
      this.startingSessions.delete(sessionName);
      this.pendingStartSessions.delete(sessionName);
      if (reserved) {
        this.releaseRuntimeSessionStartReservation(sessionName);
      }
    }
  }

  private getStartReservationCount(): number {
    let count = 0;
    for (const sessionName of this.startReservations) {
      if (!this.streamingSessions.has(sessionName)) {
        count++;
      }
    }
    return count;
  }

  private getRuntimeSessionPoolUsedSlots(): number {
    return this.streamingSessions.size + this.getStartReservationCount();
  }

  private getBackgroundStartLimit(): number {
    return Math.max(0, this.options.maxConcurrentSessions - this.options.interactiveReservedSessions);
  }

  private hasRuntimeSessionPoolSlotForStart(sessionName?: string, prompt?: RuntimeLaunchPrompt): boolean {
    const used = this.getRuntimeSessionPoolUsedSlots();
    if (used >= this.options.maxConcurrentSessions) {
      return false;
    }
    const lane = classifyRuntimeSessionStartLane(sessionName, prompt);
    if (lane === "interactive" || this.options.interactiveReservedSessions <= 0) {
      return true;
    }
    return used < this.getBackgroundStartLimit();
  }

  private getRuntimeSessionPoolNoSlotReason(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
  ): "concurrency_limit" | "interactive_reserved_capacity" | "pending_start_backpressure" {
    if (
      classifyRuntimeSessionStartLane(sessionName, prompt) === "background" &&
      this.getRuntimeSessionPoolUsedSlots() < this.options.maxConcurrentSessions &&
      this.getRuntimeSessionPoolUsedSlots() >= this.getBackgroundStartLimit()
    ) {
      return "interactive_reserved_capacity";
    }
    return this.pendingStarts.length > 0 ? "pending_start_backpressure" : "concurrency_limit";
  }

  private resolvePendingStartTraceIdentity(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
  ): { sessionKey: string; agentId?: string | null } {
    const entry = getSessionByName(sessionName) ?? getSession(sessionName);
    return {
      sessionKey: entry?.sessionKey ?? sessionName,
      agentId: entry?.agentId ?? prompt._agentId ?? null,
    };
  }

  private async reserveRuntimeSessionStart(
    sessionName: string,
    prompt: RuntimeLaunchPrompt,
    options: { retainReleasedSlot?: boolean } = {},
  ): Promise<boolean> {
    if (this.startReservations.has(sessionName)) {
      return true;
    }

    if (options.retainReleasedSlot) {
      this.startReservations.add(sessionName);
      return true;
    }

    if (!this.hasRuntimeSessionPoolSlotForStart(sessionName, prompt)) {
      const queued = this.pendingStarts.length + 1;
      const reason = this.getRuntimeSessionPoolNoSlotReason(sessionName, prompt);
      const reserved = this.getStartReservationCount();
      const lane = classifyRuntimeSessionStartLane(sessionName, prompt);
      const traceIdentity = this.resolvePendingStartTraceIdentity(sessionName, prompt);
      log.warn("Session start queued - runtime session pool busy", {
        sessionName,
        active: this.streamingSessions.size,
        reserved,
        queued,
        max: this.options.maxConcurrentSessions,
        interactiveReserved: this.options.interactiveReservedSessions,
        backgroundLimit: this.getBackgroundStartLimit(),
        lane,
        reason,
      });
      recordRuntimeTraceEvent({
        sessionKey: traceIdentity.sessionKey,
        sessionName,
        agentId: traceIdentity.agentId,
        eventType: "dispatch.queued_busy",
        eventGroup: "dispatch",
        status: "queued",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        payloadJson: {
          reason,
          active: this.streamingSessions.size,
          reserved,
          queued,
          max: this.options.maxConcurrentSessions,
          interactiveReserved: this.options.interactiveReservedSessions,
          backgroundLimit: this.getBackgroundStartLimit(),
          lane,
          taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
          deliveryBarrier: describeDeliveryBarrier(getRuntimePromptDeliveryBarrier(prompt)),
          deliveryBarrierSource: prompt.deliveryBarrierSource ?? null,
        },
      });
      this.options
        .safeEmit(`ravi.session.${sessionName}.runtime`, {
          type: "dispatch.queued",
          reason,
          active: this.streamingSessions.size,
          reserved,
          queued,
          max: this.options.maxConcurrentSessions,
          interactiveReserved: this.options.interactiveReservedSessions,
          backgroundLimit: this.getBackgroundStartLimit(),
          lane,
          timestamp: new Date().toISOString(),
        })
        .catch((error) => {
          log.warn("Failed to emit dispatch.queued event", { sessionName, error });
        });

      const pendingStart: PendingRuntimeSessionStart = {
        sessionName,
        prompt,
        resolve: () => {},
        cancelled: false,
      };
      await new Promise<void>((resolve) => {
        pendingStart.resolve = resolve;
        this.pendingStarts.push(pendingStart);
      });
      if (pendingStart.cancelled) {
        log.info("Pending session start cancelled", { sessionName });
        return false;
      }
      if (!this.startReservations.has(sessionName)) {
        this.startReservations.add(sessionName);
      }
      log.info("Pending session start resumed", {
        sessionName,
        active: this.streamingSessions.size,
        reserved: this.getStartReservationCount(),
        queued: this.pendingStarts.length,
        max: this.options.maxConcurrentSessions,
      });
      return true;
    }

    this.startReservations.add(sessionName);
    return true;
  }

  private releaseRuntimeSessionStartReservation(sessionName: string): void {
    const released = this.startReservations.delete(sessionName);
    if (released && !this.streamingSessions.has(sessionName)) {
      this.drainPendingStarts();
    }
  }

  private releaseRuntimeSessionSlot(sessionName: string, options: { drainPendingStarts?: boolean } = {}): boolean {
    const released = this.streamingSessions.delete(sessionName);
    if (released && (options.drainPendingStarts ?? true)) {
      this.drainPendingStarts();
    }
    return released;
  }

  private async restartStashedSession(sessionName: string, reason: string): Promise<void> {
    const stashed = this.stashedMessages.get(sessionName);
    if (!stashed || stashed.length === 0) {
      return;
    }

    const prompt = buildStashedRestartPrompt(stashed);
    if (!prompt) {
      return;
    }

    const traceIdentity = this.resolvePendingStartTraceIdentity(sessionName, prompt);
    const maxRestartAttempts = RUNTIME_RECOVERY_RESTART_LIMITS[reason];
    const previousRestarts = this.runtimeRecoveryRestartAttempts.get(sessionName);
    const restartAttempt = maxRestartAttempts === undefined ? undefined : (previousRestarts?.[reason] ?? 0) + 1;
    if (restartAttempt !== undefined && maxRestartAttempts !== undefined && restartAttempt > maxRestartAttempts) {
      recordRuntimeTraceEvent({
        sessionKey: traceIdentity.sessionKey,
        sessionName,
        agentId: traceIdentity.agentId ?? prompt._agentId,
        provider: prompt._runtimeProviderId,
        eventType: "dispatch.restart_suppressed",
        eventGroup: "dispatch",
        status: "blocked",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        error: RUNTIME_RESTART_EXHAUSTED_ERROR,
        payloadJson: {
          reason,
          restartAttempts: maxRestartAttempts,
          stashedQueueSize: stashed.length,
          resumeStashedMessages: true,
          userResponseSuppressed: true,
        },
      });
      updateRuntimeLiveState(sessionName, {
        activity: "blocked",
        summary: RUNTIME_RESTART_EXHAUSTED_ERROR,
        agentId: traceIdentity.agentId ?? prompt._agentId,
        provider: prompt._runtimeProviderId,
        source: prompt.source,
      });
      await this.options
        .safeEmit(`ravi.session.${sessionName}.runtime`, {
          type: "dispatch.restart_suppressed",
          reason,
          restartAttempts: maxRestartAttempts,
          stashedQueueSize: stashed.length,
          resumeStashedMessages: true,
          userResponseSuppressed: true,
          error: RUNTIME_RESTART_EXHAUSTED_ERROR,
          ...(prompt.source ? { _source: prompt.source } : {}),
          timestamp: new Date().toISOString(),
        })
        .catch((error) => {
          log.warn("Failed to emit suppressed runtime restart event", { sessionName, reason, error });
        });

      // This is an infrastructure failure, not an agent response. Keep the
      // stashed turn available for an explicit retry, but never publish the
      // technical failure onto the session's user-facing response subject.
      log.error("Runtime recovery exhausted; suppressed channel response", {
        sessionName,
        sessionKey: traceIdentity.sessionKey,
        agentId: traceIdentity.agentId ?? prompt._agentId,
        provider: prompt._runtimeProviderId,
        reason,
        restartAttempts: maxRestartAttempts,
        stashedQueueSize: stashed.length,
      });
      await this.options
        .notifyRuntimeRecoveryExhausted({
          sessionKey: traceIdentity.sessionKey,
          sessionName,
          ...((traceIdentity.agentId ?? prompt._agentId) ? { agentId: traceIdentity.agentId ?? prompt._agentId } : {}),
          ...(prompt._runtimeProviderId ? { provider: prompt._runtimeProviderId } : {}),
          reason,
          restartAttempts: maxRestartAttempts,
          stashedQueueSize: stashed.length,
          ...((prompt.context?.messageId ?? prompt.source?.sourceMessageId)
            ? { sourceMessageId: prompt.context?.messageId ?? prompt.source?.sourceMessageId }
            : {}),
        })
        .catch((error) => {
          log.warn("Failed to notify operator about exhausted runtime recovery", {
            sessionName,
            reason,
            error,
          });
        });
      return;
    }
    if (restartAttempt !== undefined) {
      this.runtimeRecoveryRestartAttempts.set(sessionName, {
        ...previousRestarts,
        [reason]: restartAttempt,
      });
    }

    recordRuntimeTraceEvent({
      sessionKey: traceIdentity.sessionKey,
      sessionName,
      agentId: traceIdentity.agentId ?? prompt._agentId,
      provider: prompt._runtimeProviderId,
      eventType: "dispatch.restart_requested",
      eventGroup: "dispatch",
      status: "requested",
      source: prompt.source,
      messageId: prompt.context?.messageId,
      payloadJson: {
        reason,
        ...(restartAttempt !== undefined
          ? {
              restartAttempt,
              maxRestartAttempts,
            }
          : {}),
        stashedQueueSize: stashed.length,
        resumeStashedMessages: true,
      },
    });

    await this.startStreamingSession(sessionName, prompt, { retainReleasedSlot: true });
  }

  drainPendingStarts(): void {
    while (this.pendingStarts.length > 0) {
      const nextIndex = this.pendingStarts.findIndex(
        (candidate) =>
          !candidate.cancelled && this.hasRuntimeSessionPoolSlotForStart(candidate.sessionName, candidate.prompt),
      );
      if (nextIndex < 0) {
        break;
      }
      const next = this.pendingStarts.splice(nextIndex, 1)[0];
      if (!next) {
        break;
      }
      if (next.cancelled) {
        continue;
      }
      this.startReservations.add(next.sessionName);
      log.info("Dequeuing pending session start", {
        sessionName: next.sessionName,
        active: this.streamingSessions.size,
        reserved: this.getStartReservationCount(),
        queued: this.pendingStarts.length,
        max: this.options.maxConcurrentSessions,
        lane: classifyRuntimeSessionStartLane(next.sessionName, next.prompt),
        interactiveReserved: this.options.interactiveReservedSessions,
        backgroundLimit: this.getBackgroundStartLimit(),
      });
      next.resolve();
    }
  }

  private scheduleIdleGapRecovery(
    sessionName: string,
    session: RuntimeHostStreamingSession,
    sessionKey = sessionName,
  ): void {
    if (session.idleGapRecoveryTimer) {
      return;
    }

    session.idleGapRecoveryTimer = setTimeout(() => {
      session.idleGapRecoveryTimer = undefined;
      void this.recoverIdleGapSession(sessionName, session, sessionKey).catch((error) => {
        log.warn("Failed to recover idle-gap runtime session", { sessionName, error });
      });
    }, IDLE_GAP_RECOVERY_MS);
    session.idleGapRecoveryTimer.unref?.();
  }

  private async recoverIdleGapSession(
    sessionName: string,
    session: RuntimeHostStreamingSession,
    sessionKey = sessionName,
  ): Promise<void> {
    const current = this.streamingSessions.get(sessionName);
    if (current !== session) {
      return;
    }
    if (
      current.done ||
      current.turnActive ||
      current.pushMessage ||
      current.starting ||
      current.compacting ||
      current.toolRunning ||
      !hasDeliverableRuntimeMessages(sessionName, current)
    ) {
      return;
    }

    const restartPrompt = buildStashedRestartPrompt(current.pendingMessages);
    if (!restartPrompt) {
      return;
    }

    log.warn("Recovering idle-gap runtime session", {
      sessionName,
      provider: current.queryHandle.provider,
      queueSize: current.pendingMessages.length,
      timeoutMs: IDLE_GAP_RECOVERY_MS,
    });

    recordRuntimeTraceEvent({
      sessionKey,
      sessionName,
      agentId: current.agentId,
      runId: current.traceRunId,
      turnId: current.currentTraceTurnId,
      provider: current.queryHandle.provider,
      model: current.currentModel,
      eventType: "dispatch.restart_requested",
      eventGroup: "dispatch",
      status: "requested",
      source: current.currentSource,
      payloadJson: {
        reason: "idle_gap_stuck",
        queueSize: current.pendingMessages.length,
        timeoutMs: IDLE_GAP_RECOVERY_MS,
      },
    });

    stashPendingRuntimeMessages(sessionName, current, this.stashedMessages, {
      crashRecovery: this.options.crashRecovery,
    });
    recordStreamingTurnInterruptedTrace(
      this.options.crashRecovery,
      sessionName,
      current,
      "idle_gap_stuck",
      sessionKey,
      "aborted",
    );
    shutdownRuntimeStreamingSession(current, "idle_gap_stuck");
    this.releaseRuntimeSessionSlot(sessionName, { drainPendingStarts: false });
    await this.restartStashedSession(sessionName, "idle_gap_stuck");
  }

  private async releaseQueuedPromptsAfterTool(sessionName: string): Promise<void> {
    const existing = this.streamingSessions.get(sessionName);
    if (
      !existing ||
      existing.done ||
      existing.starting ||
      existing.compacting ||
      existing.toolRunning ||
      !existing.turnActive ||
      existing.currentTurnSuperseded ||
      existing.interrupted
    ) {
      return;
    }

    const successor = prepareRuntimeInterruptSuccessor(sessionName, existing);
    if (!successor) return;

    const prompt = successor.message.launchPrompt;
    const sessionEntry = getSessionByName(sessionName);
    await this.interruptForRuntimeSuccessor(
      sessionName,
      existing,
      successor,
      "tool_barrier_released",
      prompt,
      sessionEntry?.sessionKey ?? sessionName,
    );
  }

  private async interruptForRuntimeSuccessor(
    sessionName: string,
    existing: RuntimeHostStreamingSession,
    successor: RuntimeInterruptSuccessorPreparation,
    reason: string,
    fallbackPrompt?: RuntimeLaunchPrompt,
    sessionKey = sessionName,
  ): Promise<void> {
    const prompt = successor.message.launchPrompt ?? fallbackPrompt;
    const source = prompt?.source ?? fallbackPrompt?.source ?? existing.currentSource;
    const barrier = successor.message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;
    existing.currentTurnSuperseded = true;
    existing.interrupted = true;
    nats
      .emit(`ravi.session.${sessionName}.runtime`, {
        type: "turn.interrupt.requested",
        sessionName,
        queueSize: existing.pendingMessages.length,
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: successor.message.deliveryBarrierSource ?? prompt?.deliveryBarrierSource ?? null,
        reason,
        source,
        context: prompt?.context ?? fallbackPrompt?.context,
        taskBarrierTaskId: successor.message.taskBarrierTaskId ?? prompt?.taskBarrierTaskId,
        timestamp: new Date().toISOString(),
      })
      .catch((error) => {
        log.warn("Failed to emit turn interrupt audit event", { sessionName, error });
      });
    log.info("Streaming: interrupting turn", {
      sessionName,
      queueSize: existing.pendingMessages.length,
      barrier: describeDeliveryBarrier(barrier),
      reason,
    });
    recordRuntimeTraceEvent({
      sessionKey,
      sessionName,
      agentId: existing.agentId,
      runId: existing.traceRunId,
      turnId: existing.currentTraceTurnId,
      provider: existing.queryHandle.provider,
      model: existing.currentModel,
      eventType: "dispatch.interrupt_requested",
      eventGroup: "dispatch",
      status: "requested",
      source,
      messageId: prompt?.context?.messageId ?? fallbackPrompt?.context?.messageId,
      payloadJson: {
        queueSize: existing.pendingMessages.length,
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: successor.message.deliveryBarrierSource ?? prompt?.deliveryBarrierSource ?? null,
        reason,
        taskBarrierTaskId: successor.message.taskBarrierTaskId ?? prompt?.taskBarrierTaskId ?? null,
        currentTurnReplay: false,
      },
    });
    if (successor.coalescedMessages.length > 0) {
      recordRuntimeTraceEvent({
        sessionKey,
        sessionName,
        agentId: existing.agentId,
        runId: existing.traceRunId,
        turnId: existing.currentTraceTurnId,
        provider: existing.queryHandle.provider,
        model: existing.currentModel,
        eventType: "dispatch.coalesced_steering",
        eventGroup: "dispatch",
        status: "queued",
        source,
        messageId: prompt?.context?.messageId ?? fallbackPrompt?.context?.messageId,
        payloadJson: {
          coalescedMessages: successor.coalescedMessages.length,
          queueSize: existing.pendingMessages.length,
          reason: "compatible_channel_backlog",
        },
      });
    }
    existing.queryHandle.interrupt().catch(() => {});
    await terminalizeCoalescedChannelMessages(sessionName, successor.coalescedMessages);
  }

  private async enqueuePromptOnLiveSession(
    sessionName: string,
    existing: RuntimeHostStreamingSession,
    prompt: RuntimeLaunchPrompt,
    options: {
      sessionEntry?: SessionEntry;
      agentId: string;
      daemonRestartMessages?: RuntimeUserMessage[];
    },
  ): Promise<void> {
    const { sessionEntry, agentId, daemonRestartMessages } = options;
    log.info("Streaming: pushing message to existing session", { sessionName, reason: "live_session_queue" });
    if (sessionEntry) {
      updateRuntimeSessionMetadata(sessionEntry.sessionKey, prompt);
    }
    const messageSource = prompt.source ?? existing.currentSource;
    if (!prompt._resumeStashedMessages) {
      saveMessage(
        sessionName,
        "user",
        resolvePersistedUserText(prompt),
        sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId,
        {
          agentId,
          channel: messageSource?.channel ?? prompt.context?.channelId,
          accountId: messageSource?.accountId ?? prompt.context?.accountId,
          chatId: messageSource?.chatId ?? prompt.context?.chatId,
          sourceMessageId: messageSource?.sourceMessageId ?? prompt.context?.messageId,
          commands: prompt.commands,
        },
      );
    }

    const barrier = getRuntimePromptDeliveryBarrier(prompt);
    const queuedMessages = daemonRestartMessages ?? [createQueuedRuntimeUserMessage(prompt)];
    appendUniqueRuntimeMessages(existing.pendingMessages, queuedMessages);
    updateRuntimeLiveState(sessionName, {
      activity: "thinking",
      summary: existing.turnActive ? `queued ${existing.pendingMessages.length}` : "prompt queued",
      agentId: existing.agentId,
      runId: existing.traceRunId,
      provider: existing.queryHandle.provider,
      model: existing.currentModel,
      source: prompt.source ?? existing.currentSource,
    });

    recordRuntimeTraceEvent({
      sessionKey: sessionEntry?.sessionKey ?? sessionName,
      sessionName,
      agentId: existing.agentId,
      runId: existing.traceRunId,
      turnId: existing.currentTraceTurnId,
      provider: existing.queryHandle.provider,
      model: existing.currentModel,
      eventType: "dispatch.push_existing",
      eventGroup: "dispatch",
      status: "queued",
      source: prompt.source ?? existing.currentSource,
      messageId: prompt.context?.messageId,
      payloadJson: {
        queueSize: existing.pendingMessages.length,
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: prompt.deliveryBarrierSource ?? null,
        taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        reason: "live_session_queue",
      },
    });

    if (existing.pushMessage) {
      const deliverableNow = hasDeliverableRuntimeMessages(sessionName, existing);
      if (deliverableNow) {
        log.info("Streaming: waking generator", {
          sessionName,
          queueSize: existing.pendingMessages.length,
          barrier: describeDeliveryBarrier(barrier),
        });
        const resolver = existing.pushMessage;
        existing.pushMessage = null;
        resolver(null);
      } else {
        log.info("Streaming: queued without wake", {
          sessionName,
          queueSize: existing.pendingMessages.length,
          barrier: describeDeliveryBarrier(barrier),
          reason: "waiting_for_barrier",
        });
        recordRuntimeTraceEvent({
          sessionKey: sessionEntry?.sessionKey ?? sessionName,
          sessionName,
          agentId: existing.agentId,
          runId: existing.traceRunId,
          turnId: existing.currentTraceTurnId,
          provider: existing.queryHandle.provider,
          model: existing.currentModel,
          eventType: "dispatch.queued_busy",
          eventGroup: "dispatch",
          status: "queued",
          source: prompt.source ?? existing.currentSource,
          messageId: prompt.context?.messageId,
          payloadJson: {
            queueSize: existing.pendingMessages.length,
            barrier: describeDeliveryBarrier(barrier),
            barrierSource: prompt.deliveryBarrierSource ?? null,
            reason: "waiting_for_barrier",
          },
        });
        this.options
          .safeEmit(`ravi.session.${sessionName}.runtime`, {
            type: "dispatch.queued",
            provider: existing.queryHandle.provider,
            reason: "waiting_for_barrier",
            barrier: describeDeliveryBarrier(barrier),
            barrierSource: prompt.deliveryBarrierSource ?? null,
            queueSize: existing.pendingMessages.length,
            sessionState: describeSessionState(existing),
            timestamp: new Date().toISOString(),
          })
          .catch((error) => {
            log.warn("Failed to emit dispatch.queued event", { sessionName, error });
          });
      }
      return;
    }

    const decision = shouldInterruptRuntimeForIncoming(sessionName, existing, barrier, prompt.taskBarrierTaskId);
    if (decision.interrupt) {
      return;
    }
    log.info("Streaming: queueing (busy)", {
      sessionName,
      queueSize: existing.pendingMessages.length,
      barrier: describeDeliveryBarrier(barrier),
      reason: decision.reason,
      tool: existing.currentToolName,
    });
    recordRuntimeTraceEvent({
      sessionKey: sessionEntry?.sessionKey ?? sessionName,
      sessionName,
      agentId: existing.agentId,
      runId: existing.traceRunId,
      turnId: existing.currentTraceTurnId,
      provider: existing.queryHandle.provider,
      model: existing.currentModel,
      eventType: "dispatch.queued_busy",
      eventGroup: "dispatch",
      status: "queued",
      source: prompt.source ?? existing.currentSource,
      messageId: prompt.context?.messageId,
      payloadJson: {
        queueSize: existing.pendingMessages.length,
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: prompt.deliveryBarrierSource ?? null,
        reason: decision.reason,
        tool: existing.currentToolName ?? null,
      },
    });
    this.options
      .safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "dispatch.queued",
        provider: existing.queryHandle.provider,
        reason: decision.reason,
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: prompt.deliveryBarrierSource ?? null,
        queueSize: existing.pendingMessages.length,
        tool: existing.currentToolName ?? null,
        sessionState: describeSessionState(existing),
        timestamp: new Date().toISOString(),
      })
      .catch((error) => {
        log.warn("Failed to emit dispatch.queued event", { sessionName, error });
      });
    if (decision.reason === "idle_gap") {
      wakeRuntimeSessionIfDeliverable(sessionName, this.streamingSessions);
      this.scheduleIdleGapRecovery(sessionName, existing, sessionEntry?.sessionKey ?? sessionName);
    }
  }

  private async tryNativeRuntimeSteer(
    sessionName: string,
    existing: RuntimeHostStreamingSession,
    prompt: RuntimeLaunchPrompt,
    barrier: DeliveryBarrier,
    sessionKey = sessionName,
  ): Promise<"accepted" | "fallback"> {
    if (!canUseNativeRuntimeSteer(existing, barrier, prompt)) {
      return "fallback";
    }

    if (!fenceRuntimeNativeSteerInput(existing, this.options.crashRecovery)) {
      return "fallback";
    }

    const result = await existing.queryHandle
      .control?.({
        operation: "turn.steer",
        text: resolveRuntimePromptText(prompt),
      })
      .catch((error) => ({
        ok: false,
        operation: "turn.steer" as const,
        error: error instanceof Error ? error.message : String(error),
        state: {
          provider: existing.queryHandle.provider,
          activeTurn: existing.turnActive,
        },
      }));

    if (!result?.ok) {
      recordRuntimeTraceEvent({
        sessionKey,
        sessionName,
        agentId: existing.agentId,
        runId: existing.traceRunId,
        turnId: existing.currentTraceTurnId,
        provider: existing.queryHandle.provider,
        model: existing.currentModel,
        eventType: "dispatch.native_steer",
        eventGroup: "dispatch",
        status: "failed",
        source: prompt.source ?? existing.currentSource,
        messageId: prompt.context?.messageId,
        payloadJson: {
          barrier: describeDeliveryBarrier(barrier),
          barrierSource: prompt.deliveryBarrierSource ?? null,
          error: result?.error ?? "runtime control did not return a result",
        },
      });
      return "fallback";
    }

    recordRuntimeTraceEvent({
      sessionKey,
      sessionName,
      agentId: existing.agentId,
      runId: existing.traceRunId,
      turnId: existing.currentTraceTurnId,
      provider: existing.queryHandle.provider,
      model: existing.currentModel,
      eventType: "dispatch.native_steer",
      eventGroup: "dispatch",
      status: "accepted",
      source: prompt.source ?? existing.currentSource,
      messageId: prompt.context?.messageId,
      payloadJson: {
        barrier: describeDeliveryBarrier(barrier),
        barrierSource: prompt.deliveryBarrierSource ?? null,
        operation: "turn.steer",
      },
    });

    await this.options
      .safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "runtime.control",
        provider: existing.queryHandle.provider,
        operation: "turn.steer",
        ok: true,
        state: result.state,
        source: prompt.source,
        timestamp: Date.now(),
      })
      .catch((error) => {
        log.warn("Failed to emit native steer runtime control event", { sessionName, error });
      });

    return "accepted";
  }
}

export function shouldQueuePromptOnLiveSession(
  sessionName: string,
  existing: RuntimeHostStreamingSession,
  prompt: RuntimeLaunchPrompt,
  agentId: string,
): boolean {
  if (existing.done || existing.agentId !== agentId) {
    return false;
  }
  if (prompt._resumeStashedMessages || prompt._daemonRestartResume || prompt._observation) {
    return false;
  }
  if (
    prompt._runtimeProviderId &&
    !prompt._observation &&
    existing.queryHandle.provider !== prompt._runtimeProviderId
  ) {
    return false;
  }
  const barrier = getRuntimePromptDeliveryBarrier(prompt);
  if (canUseNativeRuntimeSteer(existing, barrier, prompt)) {
    return false;
  }
  return !shouldInterruptRuntimeForIncoming(sessionName, existing, barrier, prompt.taskBarrierTaskId).interrupt;
}

export function runtimeModelBrokerConfigurationRequiresRestart(
  existing: Pick<RuntimeHostStreamingSession, "currentRuntimeCredential">,
  agent: Parameters<typeof resolveRequiredRuntimeModelBrokerSelection>[0],
  globalSetting = dbGetSetting(MODEL_BROKER_REQUIRED_SETTING) ?? undefined,
  environmentSetting?: string,
): boolean {
  const selection = resolveRequiredRuntimeModelBrokerSelection(agent, globalSetting, environmentSetting);
  const current = existing.currentRuntimeCredential;
  if (!selection) return current?.authMethod === "model-broker";
  if (current?.authMethod !== "model-broker") return true;
  return (
    current.modelBrokerSelectionCompatibilityKey !== buildRuntimeModelBrokerSelectionCompatibilityKey(selection) ||
    current.modelBrokerId !== selection.brokerId ||
    current.modelBrokerProfileRef !== selection.profileRef
  );
}

export function runtimeModelBrokerRouteRequiresRestart(
  existing: Pick<RuntimeHostStreamingSession, "currentRuntimeCredential" | "currentModel" | "queryHandle">,
  plan: RuntimeModelBrokerPlan | undefined,
): boolean {
  if (!plan) return false;
  const current = existing.currentRuntimeCredential;
  if (current?.authMethod !== "model-broker") return true;
  return (
    existing.queryHandle.provider !== plan.lease.runtimeProvider ||
    existing.currentModel !== plan.lease.model ||
    current.modelBrokerId !== plan.selection.brokerId ||
    current.modelBrokerProfileRef !== plan.selection.profileRef ||
    current.modelBrokerRouteRevision !== plan.lease.routeRevision ||
    current.modelBrokerCompatibilityRevision !== plan.lease.compatibilityRevision ||
    current.fingerprint !== buildRuntimeModelBrokerPhysicalFingerprint(plan.selection, plan.lease)
  );
}

export function fenceRuntimeNativeSteerInput(
  session: Pick<RuntimeHostStreamingSession, "currentCrashRecoveryAttemptId" | "currentTurnInputMutated">,
  crashRecovery: Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">,
): boolean {
  const attemptId = session.currentCrashRecoveryAttemptId;
  if (!attemptId) return false;

  crashRecovery.markTurnAttemptSafety({ attemptId, inputMutated: true });
  if (session.currentCrashRecoveryAttemptId !== attemptId) return false;

  session.currentTurnInputMutated = true;
  return true;
}

export function canUseNativeRuntimeSteer(
  session: RuntimeHostStreamingSession,
  barrier: DeliveryBarrier,
  prompt?: RuntimeLaunchPrompt,
): boolean {
  const supportsNativeSteer =
    session.queryHandle.concurrentInputStrategy === "native_steer" && Boolean(session.queryHandle.control);
  const activeTurnIsFresh = Date.now() - session.lastActivity <= NATIVE_STEER_ACTIVE_TURN_MAX_IDLE_MS;

  return (
    barrier === "after_tool" &&
    !hasIsolatedRuntimeTurnEnvelope(prompt) &&
    isSameRuntimeTurnSurface(session.currentSource, prompt?.source) &&
    supportsNativeSteer &&
    session.turnActive &&
    Boolean(session.currentCrashRecoveryAttemptId) &&
    activeTurnIsFresh &&
    !session.done &&
    !session.starting &&
    !session.compacting &&
    !session.toolRunning &&
    getPendingRuntimeTurnSuccessors(session).length === 0
  );
}

function buildDebouncedRuntimePrompts(messages: RuntimeLaunchPrompt[]): RuntimeLaunchPrompt[] {
  const batches: RuntimeLaunchPrompt[][] = [];
  let currentBatch: RuntimeLaunchPrompt[] = [];
  let currentKey: string | null = null;

  for (const message of messages) {
    if (hasIsolatedRuntimeTurnEnvelope(message)) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
      }
      batches.push([message]);
      currentKey = null;
      continue;
    }

    const key = getDebounceCompatibilityKey(message);
    if (currentBatch.length > 0 && currentKey !== key) {
      batches.push(currentBatch);
      currentBatch = [];
    }
    currentBatch.push(message);
    currentKey = key;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches.map(combineDebounceBatch);
}

function combineDebounceBatch(batch: RuntimeLaunchPrompt[]): RuntimeLaunchPrompt {
  const last = batch[batch.length - 1];
  const delivery = combineDeliveryBarrierMetadata(
    batch.map((prompt) => ({
      barrier: getRuntimePromptDeliveryBarrier(prompt),
      source: prompt.deliveryBarrierSource,
    })),
  );

  return {
    ...last,
    prompt: batch.map((entry) => entry.prompt).join("\n\n"),
    deliveryBarrier: delivery.barrier,
    deliveryBarrierSource: delivery.source,
    commands: batch.flatMap((entry) => entry.commands ?? []),
  };
}

function getDebounceCompatibilityKey(prompt: RuntimeLaunchPrompt): string {
  const barrier = getRuntimePromptDeliveryBarrier(prompt);
  const taskBarrierTaskId = normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? "";
  const deliveryClass = barrier === "after_task" || taskBarrierTaskId ? "task-gated" : "interactive";

  return JSON.stringify({
    agentId: prompt._agentId ?? "",
    taskBarrierTaskId,
    deliveryClass,
    source: prompt.source ? getMessageTargetKey(prompt.source) : "",
    approvalSource: prompt._approvalSource ? getMessageTargetKey(prompt._approvalSource) : "",
  });
}

function getMessageTargetKey(target: RuntimeMessageTarget): string {
  return [target.channel, target.accountId, target.chatId, target.threadId ?? ""].join(":");
}

export function stashPromptForStartingSession(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
  stashedMessages: Map<string, RuntimeUserMessage[]>,
): RuntimeUserMessage[] {
  const queued = stashedMessages.get(sessionName) ?? [];
  queued.push(createQueuedRuntimeUserMessage(prompt));
  stashedMessages.set(sessionName, queued);
  return queued;
}

function appendUniqueRuntimeMessages(
  queued: RuntimeUserMessage[],
  messages: RuntimeUserMessage[],
): RuntimeUserMessage[] {
  const seenPendingIds = new Set(queued.map((message) => message.pendingId).filter(Boolean));
  for (const message of messages) {
    if (message.pendingId && seenPendingIds.has(message.pendingId)) {
      continue;
    }
    queued.push(cloneRuntimeUserMessage(message));
    if (message.pendingId) {
      seenPendingIds.add(message.pendingId);
    }
  }
  return queued;
}

function appendUniqueRuntimeMessagesToStash(
  sessionName: string,
  messages: RuntimeUserMessage[],
  stashedMessages: Map<string, RuntimeUserMessage[]>,
): RuntimeUserMessage[] {
  const queued = stashedMessages.get(sessionName) ?? [];
  appendUniqueRuntimeMessages(queued, messages);
  stashedMessages.set(sessionName, queued);
  return queued;
}

export function buildStashedRestartPrompt(messages: RuntimeUserMessage[]): RuntimeLaunchPrompt | null {
  if (messages.length === 0) {
    return null;
  }

  const launchPrompts = messages
    .map((message) => message.launchPrompt)
    .filter((prompt): prompt is RuntimeLaunchPrompt => Boolean(prompt));
  const newestLaunchPrompt = selectStashedRestartPromptEnvelope(launchPrompts);
  const first = messages[0];
  if (!first) {
    return null;
  }

  const delivery = combineDeliveryBarrierMetadata(
    messages.map((message) => ({
      barrier: message.deliveryBarrier ?? "after_tool",
      source: message.deliveryBarrierSource ?? message.launchPrompt?.deliveryBarrierSource,
    })),
  );
  const combinedPrompt = messages
    .map((message) => message.message.content)
    .join("\n\n")
    .trim();

  return {
    ...(newestLaunchPrompt ?? {
      prompt: combinedPrompt,
      deliveryBarrier: delivery.barrier,
      deliveryBarrierSource: delivery.source,
      taskBarrierTaskId: first.taskBarrierTaskId,
      commands: messages.flatMap((message) => message.commands ?? []),
    }),
    prompt: combinedPrompt || newestLaunchPrompt?.prompt || first.message.content,
    deliveryBarrier: delivery.barrier,
    deliveryBarrierSource: delivery.source,
    commands:
      launchPrompts.length > 0
        ? messages.flatMap((message) => message.commands ?? message.launchPrompt?.commands ?? [])
        : messages.flatMap((message) => message.commands ?? []),
    _resumeStashedMessages: true,
  };
}

function selectStashedRestartPromptEnvelope(launchPrompts: RuntimeLaunchPrompt[]): RuntimeLaunchPrompt | undefined {
  const newest = launchPrompts[launchPrompts.length - 1];
  if (!newest?._daemonRestartResume || hasResolvedActorPromptMetadata(newest)) {
    return newest;
  }
  return [...launchPrompts].reverse().find(hasResolvedActorPromptMetadata) ?? newest;
}

function hasResolvedActorPromptMetadata(prompt: RuntimeLaunchPrompt): boolean {
  return hasResolvedActorMetadata(prompt.source) || hasResolvedActorMetadata(prompt.context);
}

function hasResolvedActorMetadata(
  metadata:
    | {
        actorType?: string;
        contactId?: string;
        actorAgentId?: string;
        automationId?: string;
      }
    | undefined,
): boolean {
  return Boolean(
    (metadata?.actorType === "contact" && metadata.contactId) ||
      (metadata?.actorType === "agent" && metadata.actorAgentId) ||
      (metadata?.actorType === "automation" && metadata.automationId),
  );
}

function combineDeliveryBarrierMetadata(entries: Array<{ barrier: DeliveryBarrier; source?: DeliveryBarrierSource }>): {
  barrier: DeliveryBarrier;
  source?: DeliveryBarrierSource;
} {
  const [first, ...rest] = entries;
  let selected: { barrier: DeliveryBarrier; source?: DeliveryBarrierSource } = first ?? { barrier: "after_tool" };

  for (const entry of rest) {
    const chosenBarrier = chooseMoreUrgentBarrier(selected.barrier, entry.barrier);
    if (chosenBarrier !== selected.barrier) {
      selected = entry;
      continue;
    }
    if (chosenBarrier === entry.barrier && compareDeliveryBarrierSource(entry.source, selected.source) < 0) {
      selected = entry;
    }
  }

  return selected;
}

function compareDeliveryBarrierSource(left?: DeliveryBarrierSource, right?: DeliveryBarrierSource): number {
  return deliveryBarrierSourceRank(left) - deliveryBarrierSourceRank(right);
}

function deliveryBarrierSourceRank(source?: DeliveryBarrierSource): number {
  switch (source) {
    case "explicit":
      return 0;
    case "default":
      return 1;
    case "inferred":
      return 2;
    default:
      return 3;
  }
}

function isDaemonRestartNonIdleSession(session: RuntimeHostStreamingSession): boolean {
  if (session.done) return false;
  return (
    session.starting ||
    session.turnActive ||
    session.compacting ||
    session.toolRunning ||
    session.pendingAbort ||
    session.pendingWake ||
    session.pendingMessages.length > 0 ||
    Boolean(session.currentTurnPendingIds?.length)
  );
}

function describeDaemonRestartActivity(session: RuntimeHostStreamingSession): string {
  if (session.done) return "idle";
  if (session.compacting) return "compacting";
  if (session.toolRunning) return "blocked";
  if (session.pendingAbort) return "blocked";
  if (session.starting) return "thinking";
  if (session.turnActive) return "thinking";
  if (session.pendingMessages.length > 0 || session.pendingWake) return "queued";
  return "idle";
}

function shouldSkipDaemonRestartTaskSessionSnapshot(
  sessionName: string,
  session: RuntimeHostStreamingSession,
): boolean {
  const taskId = session.currentTaskBarrierTaskId ?? inferTaskIdFromDedicatedTaskSessionName(sessionName);
  if (!taskId && !isDedicatedTaskSessionName(sessionName)) {
    return false;
  }
  return !dbHasActiveAssignedTaskForSession(sessionName, taskId);
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

function cloneRuntimeUserMessage(message: RuntimeUserMessage): RuntimeUserMessage {
  return JSON.parse(JSON.stringify(message)) as RuntimeUserMessage;
}

async function terminalizeCoalescedChannelMessages(sessionName: string, messages: RuntimeUserMessage[]): Promise<void> {
  for (const message of messages) {
    const metadata = message.launchPrompt?._channelBackend;
    if (!metadata) continue;
    try {
      await projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.interrupted" },
      });
    } catch (error) {
      log.warn("Failed to terminalize coalesced channel turn", {
        sessionName,
        turnId: metadata.binding.turnId,
        error,
      });
    }
  }
}

function cloneRuntimeMessageTarget(target: RuntimeMessageTarget): RuntimeMessageTarget {
  return JSON.parse(JSON.stringify(target)) as RuntimeMessageTarget;
}

function appendRestartPendingMessages(snapshot: RestartSnapshotAccumulator, messages: RuntimeUserMessage[]): void {
  const seen = new Set(snapshot.pendingMessages.map((message) => message.pendingId).filter(Boolean));
  for (const message of messages) {
    if (message.pendingId && seen.has(message.pendingId)) continue;
    snapshot.pendingMessages.push(message);
    if (message.pendingId) seen.add(message.pendingId);
    snapshot.lastActivityAt = Math.max(snapshot.lastActivityAt, message.queuedAt ?? snapshot.lastActivityAt);
  }
  if (messages.length > 0) {
    snapshot.nonIdle = true;
  }
}

function newestRuntimeMessageQueuedAt(messages: RuntimeUserMessage[], fallback: number): number {
  return messages.reduce((newest, message) => Math.max(newest, message.queuedAt ?? newest), fallback);
}

function normalizePersistedRuntimeMessages(messages: unknown[]): RuntimeUserMessage[] {
  return messages.filter(isRuntimeUserMessage).map((message) => cloneRuntimeUserMessage(message));
}

function isRuntimeUserMessage(value: unknown): value is RuntimeUserMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeUserMessage>;
  return (
    candidate.type === "user" &&
    candidate.message !== undefined &&
    typeof candidate.message === "object" &&
    (candidate.message as { role?: unknown; content?: unknown }).role === "user" &&
    typeof (candidate.message as { content?: unknown }).content === "string"
  );
}

function recordStreamingAbortTrace(
  crashRecovery: RuntimeCrashRecoveryCoordinator,
  sessionName: string,
  session: RuntimeHostStreamingSession,
  reason: string,
  sessionKey = sessionName,
  provenance: RuntimeAbortProvenance = {},
): void {
  recordRuntimeTraceEvent({
    sessionKey,
    sessionName,
    agentId: session.agentId,
    runId: session.traceRunId,
    turnId: session.currentTraceTurnId,
    provider: session.queryHandle.provider,
    model: session.currentModel,
    eventType: "session.abort",
    eventGroup: "session",
    status: "requested",
    source: session.currentSource,
    payloadJson: {
      reason,
      provenance,
      queueSize: session.pendingMessages.length,
      toolRunning: session.toolRunning,
      tool: session.currentToolName ?? null,
    },
  });
  recordStreamingTurnInterruptedTrace(crashRecovery, sessionName, session, reason, sessionKey, "aborted");
}

function recordStreamingTurnInterruptedTrace(
  crashRecovery: RuntimeCrashRecoveryCoordinator,
  sessionName: string,
  session: RuntimeHostStreamingSession,
  reason: string,
  sessionKey = sessionName,
  status: "interrupted" | "aborted" = "interrupted",
): void {
  const requestedCompletedAt = Date.now();
  const existingTerminal = session.currentCrashRecoveryTerminal;
  if (!existingTerminal && !session.currentTraceTurnId && !session.currentCrashRecoveryAttemptId) {
    return;
  }
  let terminal = existingTerminal;
  if (!terminal) {
    if (!session.currentCrashRecoveryAttemptId) {
      if (crashRecovery.ownershipFailure) {
        log.error("Skipping dispatcher terminal state after crash recovery ownership loss", {
          sessionName,
          reason,
          error: crashRecovery.ownershipFailure,
        });
        return;
      }
      throw new Error("Crash recovery attempt binding missing before dispatcher terminal state");
    }
    if (session.currentCrashRecoveryAttemptId) {
      const attemptId = session.currentCrashRecoveryAttemptId;
      try {
        const terminalAttempt = crashRecovery.terminalizeTurnAttempt({
          attemptId,
          status,
          completedAt: requestedCompletedAt,
          metadata: { terminalReason: reason },
        });
        if (terminalAttempt.status !== status || terminalAttempt.completedAt !== requestedCompletedAt) {
          throw new Error(`Crash recovery attempt ${attemptId} terminalized with an unexpected first-terminal state`);
        }
        session.currentCrashRecoveryAttemptId = undefined;
        terminal = {
          status,
          completedAt: requestedCompletedAt,
          startedTool: terminalAttempt.startedTool === true || session.currentTurnToolStarted === true,
          materializedOutput: terminalAttempt.materializedOutput === true,
          inputMutated: hasRuntimeTurnAttemptInputMutation(terminalAttempt) || session.currentTurnInputMutated === true,
        };
      } catch (error) {
        if (!crashRecovery.ownershipFailure) {
          throw error;
        }
        log.error("Lost crash recovery ownership while aborting runtime turn", {
          sessionName,
          attemptId,
          reason,
          error,
        });
        session.currentCrashRecoveryAttemptId = undefined;
        return;
      }
    }
    session.currentCrashRecoveryTerminal = terminal;
  }
  if (!terminal) {
    throw new Error("Crash recovery terminal state missing after durable dispatcher terminalization");
  }
  if (!session.currentTraceTurnId || session.currentTraceTurnTerminalRecorded) {
    return;
  }

  const terminalStatus: RuntimeTurnAttemptTerminalStatus = terminal.status;
  const dispatcherWonTerminal = existingTerminal === undefined;

  recordTerminalTurnTrace({
    sessionKey,
    sessionName,
    agentId: session.agentId,
    runId: session.traceRunId,
    turnId: session.currentTraceTurnId,
    provider: session.queryHandle.provider,
    model: session.currentModel,
    status: terminalStatus,
    eventType: runtimeTurnAttemptTerminalEventType(terminalStatus),
    abortReason: terminalStatus === "complete" || !dispatcherWonTerminal ? null : reason,
    startedAt: session.currentTraceTurnStartedAt,
    completedAt: terminal.completedAt,
    payloadJson: {
      reason: dispatcherWonTerminal ? reason : null,
      requestedAbortReason: reason,
      firstTerminalStatus: terminalStatus,
      source: session.currentSource ?? null,
    },
  });
  session.currentTraceTurnTerminalRecorded = true;
}

function describeSessionState(session: RuntimeHostStreamingSession): Record<string, unknown> {
  return {
    starting: session.starting,
    compacting: session.compacting,
    toolRunning: session.toolRunning,
    toolResultDeliveryPending: Boolean(session.toolResultDeliveryPending),
    turnActive: session.turnActive,
    tool: session.currentToolName ?? null,
    idleMs: session.lastActivity ? Date.now() - session.lastActivity : null,
  };
}
