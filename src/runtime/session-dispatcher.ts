import { configStore } from "../config-store.js";
import { saveMessage } from "../db.js";
import {
  chooseMoreUrgentBarrier,
  describeDeliveryBarrier,
  type DeliveryBarrier,
  type DeliveryBarrierSource,
} from "../delivery-barriers.js";
import { nats } from "../nats.js";
import { getSession, getSessionByName, type SessionEntry } from "../router/index.js";
import { dbGetDaemonRestartPendingMessages, dbRecordDaemonRestartSessionSnapshot } from "../router/router-db.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import { dbHasActiveAssignedTaskForSession, dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
import { revokeAgentRuntimeContextsForSession } from "./context-registry.js";
import {
  createQueuedRuntimeUserMessage,
  getRuntimePromptDeliveryBarrier,
  hasDeliverableRuntimeMessages,
  shouldInterruptRuntimeForIncoming,
  wakeRuntimeSessionIfDeliverable,
} from "./delivery-queue.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import {
  shutdownRuntimeStreamingSession,
  stashPendingRuntimeMessages,
  type RuntimeHostStreamingSession,
  type RuntimeMessageTarget,
  type RuntimeUserMessage,
} from "./host-session.js";
import { applyDirectRuntimeModelSwitch, resolveRuntimeModelSwitchStrategy } from "./model-switch.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "./provider-registry.js";
import type { RuntimeProviderId } from "./types.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import { markRuntimeLiveIdle, updateRuntimeLiveState } from "./live-state.js";
import {
  startRuntimeSession,
  updateRuntimeSessionMetadata,
  type PendingRuntimeSessionStart,
} from "./session-launcher.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeForPrompt, runtimePromptRequiresRestart } from "./task-runtime-context.js";
import {
  buildRuntimeSessionPoolSnapshot,
  classifyRuntimeSessionStartLane,
  resolveRuntimeStreamingSession,
  type RuntimeSessionPoolSnapshot,
  type RuntimeStreamingSessionIdentity,
} from "./session-pool.js";

const log = logger.child("runtime:session-dispatcher");
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
  getConfigModel(): string;
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

  constructor(private readonly options: RuntimeSessionDispatcherOptions) {}

  getRuntimeSessionPoolSnapshot(): RuntimeSessionPoolSnapshot {
    return buildRuntimeSessionPoolSnapshot(this.streamingSessions, {
      limit: this.options.maxConcurrentSessions,
      pendingStarts: this.pendingStarts.length,
      interactiveReserved: this.options.interactiveReservedSessions,
    });
  }

  canAcceptRuntimePrompt(sessionName?: string): boolean {
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
      const pendingMessages = session.pendingMessages.map(cloneRuntimeUserMessage);
      const nonIdle = isDaemonRestartNonIdleSession(session) || pendingMessages.length > 0;
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

    if (this.streamingSessions.size === 0) {
      return;
    }

    log.info("Aborting streaming sessions", {
      count: this.streamingSessions.size,
      sessions: [...this.streamingSessions.keys()],
    });
    for (const [sessionName, session] of this.streamingSessions) {
      log.info("Aborting streaming session", { sessionName });
      recordStreamingAbortTrace(sessionName, session, "shutdown_all");
      shutdownRuntimeStreamingSession(session, "shutdown_all");
    }
    this.streamingSessions.clear();
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

    if (session.toolRunning && session.currentToolSafety === "unsafe") {
      log.info("Deferring abort - unsafe tool running", {
        sessionName,
        tool: session.currentToolName,
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
        },
      });
      return true;
    }

    if (session.pendingMessages.length > 0) {
      log.info("Stashing aborted messages", { sessionName, count: session.pendingMessages.length });
      stashPendingRuntimeMessages(sessionName, session, this.stashedMessages);
    }

    log.info("Aborting streaming session", { sessionName, done: session.done, provenance });
    recordStreamingAbortTrace(sessionName, session, abortReason, sessionKey, provenance);
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
    options: { drainReleasedSlot?: boolean } = {},
  ): Promise<"missing" | "unchanged" | "applied" | "restart-next-turn"> {
    const streaming = this.streamingSessions.get(sessionName);
    if (!streaming || streaming.done) {
      return "missing";
    }
    if (streaming.currentModel === model) {
      return "unchanged";
    }

    if (resolveRuntimeModelSwitchStrategy(streaming.queryHandle) === "direct-set") {
      recordRuntimeTraceEvent({
        sessionKey: sessionName,
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
        },
      });
      await applyDirectRuntimeModelSwitch(streaming.queryHandle, model);
      streaming.currentModel = model;
      return "applied";
    }

    if (streaming.pendingMessages.length > 0) {
      stashPendingRuntimeMessages(sessionName, streaming, this.stashedMessages);
    }
    streaming.currentModel = model;
    recordRuntimeTraceEvent({
      sessionKey: sessionName,
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
      },
    });
    recordStreamingTurnInterruptedTrace(sessionName, streaming, "model_change_restart", sessionName);
    shutdownRuntimeStreamingSession(streaming, "model_change_restart");
    this.releaseRuntimeSessionSlot(sessionName, { drainPendingStarts: options.drainReleasedSlot ?? true });
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
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const existing = this.streamingSessions.get(sessionName);
    if (!existing && prompt._daemonRestartResume) {
      prompt = this.prepareDaemonRestartResumePrompt(sessionName, prompt, sessionEntry);
    }
    const agentId = prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];
    if (!agent) {
      log.error("No agent found for prompt", { sessionName, agentId });
      return;
    }
    const requestedProvider: RuntimeProviderId =
      prompt._observation && prompt._runtimeProviderId
        ? prompt._runtimeProviderId
        : (agent.provider ?? DEFAULT_RUNTIME_PROVIDER_ID);
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
          stashPendingRuntimeMessages(sessionName, existing, this.stashedMessages);
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
        recordStreamingTurnInterruptedTrace(sessionName, existing, restartReason, sessionEntry?.sessionKey);
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
        const requestedModel = requestedRuntime.options.model ?? this.options.getConfigModel();
        if (runtimePromptRequiresRestart(existing, requestedRuntime, prompt)) {
          log.info("Streaming: restarting session after runtime task settings change", {
            sessionName,
            currentTaskBarrierTaskId: existing.currentTaskBarrierTaskId ?? null,
            requestedTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? null,
            currentEffort: existing.currentEffort ?? null,
            requestedEffort: requestedRuntime.options.effort ?? null,
            currentThinking: existing.currentThinking ?? null,
            requestedThinking: requestedRuntime.options.thinking ?? null,
          });
          stashPendingRuntimeMessages(sessionName, existing, this.stashedMessages);
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
        saveMessage(sessionName, "user", prompt.prompt, sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId, {
          agentId: sessionEntry?.agentId ?? existing.agentId,
          channel: messageSource?.channel ?? prompt.context?.channelId,
          accountId: messageSource?.accountId ?? prompt.context?.accountId,
          chatId: messageSource?.chatId ?? prompt.context?.chatId,
          sourceMessageId: messageSource?.sourceMessageId ?? prompt.context?.messageId,
          commands: prompt.commands,
        });

        const barrier = getRuntimePromptDeliveryBarrier(prompt);
        const nativeSteer = await this.tryNativeRuntimeSteer(
          sessionName,
          existing,
          prompt,
          barrier,
          sessionEntry?.sessionKey,
        );
        if (nativeSteer === "accepted") {
          if (prompt.source) {
            existing.currentSource = prompt.source;
          }
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

        const userMsg: RuntimeUserMessage = {
          ...createQueuedRuntimeUserMessage(prompt),
        };
        existing.pendingMessages.push(userMsg);
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
          if (hasDeliverableRuntimeMessages(sessionName, existing)) {
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
            nats
              .emit(`ravi.session.${sessionName}.runtime`, {
                type: "turn.interrupt.requested",
                sessionName,
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                reason: decision.reason,
                source: prompt.source,
                context: prompt.context,
                taskBarrierTaskId: prompt.taskBarrierTaskId,
                timestamp: new Date().toISOString(),
              })
              .catch((error) => {
                log.warn("Failed to emit turn interrupt audit event", { sessionName, error });
              });
            log.info("Streaming: interrupting turn", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: decision.reason,
            });
            recordRuntimeTraceEvent({
              sessionKey: sessionEntry?.sessionKey ?? sessionName,
              sessionName,
              agentId: existing.agentId,
              runId: existing.traceRunId,
              turnId: existing.currentTraceTurnId,
              provider: existing.queryHandle.provider,
              model: existing.currentModel,
              eventType: "dispatch.interrupt_requested",
              eventGroup: "dispatch",
              status: "requested",
              source: prompt.source ?? existing.currentSource,
              messageId: prompt.context?.messageId,
              payloadJson: {
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
                barrierSource: prompt.deliveryBarrierSource ?? null,
                reason: decision.reason,
                taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
              },
            });
            existing.interrupted = true;
            existing.queryHandle.interrupt().catch(() => {});
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
      saveMessage(sessionName, "user", prompt.prompt, sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId, {
        agentId: sessionEntry?.agentId ?? agent.id,
        channel: prompt.source?.channel ?? prompt.context?.channelId,
        accountId: prompt.source?.accountId ?? prompt.context?.accountId,
        chatId: prompt.source?.chatId ?? prompt.context?.chatId,
        sourceMessageId: prompt.source?.sourceMessageId ?? prompt.context?.messageId,
        commands: prompt.commands,
      });
      const queued = stashPromptForStartingSession(sessionName, prompt, this.stashedMessages);
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
      saveMessage(sessionName, "user", prompt.prompt, sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId, {
        agentId: sessionEntry?.agentId ?? agent.id,
        channel: prompt.source?.channel ?? prompt.context?.channelId,
        accountId: prompt.source?.accountId ?? prompt.context?.accountId,
        chatId: prompt.source?.chatId ?? prompt.context?.chatId,
        sourceMessageId: prompt.source?.sourceMessageId ?? prompt.context?.messageId,
        commands: prompt.commands,
      });
      const queued = stashPromptForStartingSession(sessionName, prompt, this.stashedMessages);
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
  ): RuntimeLaunchPrompt {
    const restartResume = prompt._daemonRestartResume;
    if (!restartResume) {
      return prompt;
    }

    const sessionKey = restartResume.sessionKey ?? sessionEntry?.sessionKey ?? sessionName;
    const pendingMessages = normalizePersistedRuntimeMessages(
      dbGetDaemonRestartPendingMessages(restartResume.restartEpoch, sessionKey),
    );
    if (pendingMessages.length === 0) {
      return prompt;
    }

    const resumeMessage = createQueuedRuntimeUserMessage(prompt);
    const combined = [...pendingMessages, resumeMessage];
    const restartPrompt = buildStashedRestartPrompt(combined);
    if (!restartPrompt) {
      return prompt;
    }

    this.stashedMessages.set(sessionName, combined);
    log.info("Prepared daemon restart resume with persisted pending messages", {
      sessionName,
      sessionKey,
      restartEpoch: restartResume.restartEpoch,
      pendingMessages: pendingMessages.length,
    });
    return {
      ...restartPrompt,
      _daemonRestartResume: restartResume,
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

    stashPendingRuntimeMessages(sessionName, current, this.stashedMessages);
    recordStreamingTurnInterruptedTrace(sessionName, current, "idle_gap_stuck", sessionKey, "aborted");
    shutdownRuntimeStreamingSession(current, "idle_gap_stuck");
    this.releaseRuntimeSessionSlot(sessionName, { drainPendingStarts: false });
    await this.restartStashedSession(sessionName, "idle_gap_stuck");
  }

  private async tryNativeRuntimeSteer(
    sessionName: string,
    existing: RuntimeHostStreamingSession,
    prompt: RuntimeLaunchPrompt,
    barrier: DeliveryBarrier,
    sessionKey = sessionName,
  ): Promise<"accepted" | "fallback"> {
    if (!canUseNativeRuntimeSteer(existing, barrier)) {
      return "fallback";
    }

    const result = await existing.queryHandle
      .control?.({
        operation: "turn.steer",
        text: prompt.prompt,
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

export function canUseNativeRuntimeSteer(session: RuntimeHostStreamingSession, barrier: DeliveryBarrier): boolean {
  const supportsNativeSteer =
    session.queryHandle.concurrentInputStrategy === "native_steer" && Boolean(session.queryHandle.control);
  const nativeSteerPreTurnQueue =
    supportsNativeSteer &&
    session.queryHandle.provider !== "codex" &&
    !session.turnActive &&
    !session.pushMessage &&
    session.pendingMessages.length > 0 &&
    !session.currentTurnPendingIds?.length;
  const activeTurnIsFresh =
    !session.turnActive || Date.now() - session.lastActivity <= NATIVE_STEER_ACTIVE_TURN_MAX_IDLE_MS;

  return (
    barrier === "after_tool" &&
    supportsNativeSteer &&
    (session.turnActive || nativeSteerPreTurnQueue) &&
    activeTurnIsFresh &&
    !session.done &&
    !session.starting &&
    !session.compacting &&
    !session.toolRunning
  );
}

function buildDebouncedRuntimePrompts(messages: RuntimeLaunchPrompt[]): RuntimeLaunchPrompt[] {
  const batches: RuntimeLaunchPrompt[][] = [];
  let currentBatch: RuntimeLaunchPrompt[] = [];
  let currentKey: string | null = null;

  for (const message of messages) {
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
        automationId?: string;
      }
    | undefined,
): boolean {
  return Boolean(
    (metadata?.actorType === "contact" && metadata.contactId) ||
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
  recordStreamingTurnInterruptedTrace(sessionName, session, reason, sessionKey, "aborted");
}

function recordStreamingTurnInterruptedTrace(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  reason: string,
  sessionKey = sessionName,
  status: "interrupted" | "aborted" = "interrupted",
): void {
  if (!session.currentTraceTurnId || session.currentTraceTurnTerminalRecorded) {
    return;
  }

  recordTerminalTurnTrace({
    sessionKey,
    sessionName,
    agentId: session.agentId,
    runId: session.traceRunId,
    turnId: session.currentTraceTurnId,
    provider: session.queryHandle.provider,
    model: session.currentModel,
    status,
    eventType: "turn.interrupted",
    abortReason: reason,
    startedAt: session.currentTraceTurnStartedAt,
    payloadJson: {
      reason,
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
    turnActive: session.turnActive,
    tool: session.currentToolName ?? null,
    idleMs: session.lastActivity ? Date.now() - session.lastActivity : null,
  };
}
