import { configStore } from "../config-store.js";
import { saveMessage } from "../db.js";
import { chooseMoreUrgentBarrier, describeDeliveryBarrier, type DeliveryBarrier } from "../delivery-barriers.js";
import { nats } from "../nats.js";
import { getSessionByName } from "../router/index.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import { dbHasActiveTaskForSession } from "../tasks/task-db.js";
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
import {
  startRuntimeSession,
  updateRuntimeSessionMetadata,
  type PendingRuntimeSessionStart,
} from "./session-launcher.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeForPrompt, runtimePromptRequiresRestart } from "./task-runtime-context.js";

const log = logger.child("runtime:session-dispatcher");

interface DebounceState {
  messages: RuntimeLaunchPrompt[];
  timer: ReturnType<typeof setTimeout>;
  debounceMs: number;
}

export interface RuntimeSessionDispatcherOptions {
  instanceId: string;
  maxConcurrentSessions: number;
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
  readonly stashedMessages = new Map<string, RuntimeUserMessage[]>();
  readonly startingSessions = new Set<string>();

  constructor(private readonly options: RuntimeSessionDispatcherOptions) {}

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

    if (this.startingSessions.size > 0) {
      log.info("Clearing session cold starts", { count: this.startingSessions.size });
      this.startingSessions.clear();
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

  abortSession(sessionName: string, provenance: RuntimeAbortProvenance = {}): boolean {
    const abortReason = provenance.reason ?? "explicit_abort";
    const allNames = [...this.streamingSessions.keys()];
    log.info("abortSession called", {
      sessionName,
      allNames,
      found: this.streamingSessions.has(sessionName),
      provenance,
    });
    const session = this.streamingSessions.get(sessionName);
    if (!session) return false;
    const sessionEntry = getSessionByName(sessionName);

    if (session.toolRunning && session.currentToolSafety === "unsafe") {
      log.info("Deferring abort - unsafe tool running", {
        sessionName,
        tool: session.currentToolName,
        provenance,
      });
      session.internalAbortReason = `${abortReason}_deferred`;
      session.pendingAbort = true;
      recordRuntimeTraceEvent({
        sessionKey: sessionEntry?.sessionKey ?? sessionName,
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
    recordStreamingAbortTrace(sessionName, session, abortReason, sessionEntry?.sessionKey, provenance);
    if (sessionEntry?.sessionKey) {
      revokeAgentRuntimeContextsForSession(sessionEntry.sessionKey, {
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
    this.streamingSessions.delete(sessionName);
    return true;
  }

  async applySessionModelChange(
    sessionName: string,
    model: string,
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
    this.streamingSessions.delete(sessionName);
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
    const agentId = prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];
    if (!agent) {
      log.error("No agent found for prompt", { sessionName, agentId });
      return;
    }
    const requestedProvider: RuntimeProviderId = agent.provider ?? DEFAULT_RUNTIME_PROVIDER_ID;
    const existing = this.streamingSessions.get(sessionName);

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
        this.streamingSessions.delete(sessionName);
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
          this.streamingSessions.delete(sessionName);
          await this.startStreamingSession(sessionName, prompt);
          return;
        }
        if (!existing.currentModel) {
          existing.currentModel = requestedModel;
        } else if (existing.currentModel !== requestedModel) {
          const modelStatus = await this.applySessionModelChange(sessionName, requestedModel);
          if (modelStatus === "restart-next-turn") {
            await this.startStreamingSession(sessionName, prompt);
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
        });

        if (prompt.source) {
          existing.currentSource = prompt.source;
        }

        const barrier = getRuntimePromptDeliveryBarrier(prompt);
        const nativeSteer = await this.tryNativeRuntimeSteer(
          sessionName,
          existing,
          prompt,
          barrier,
          sessionEntry?.sessionKey,
        );
        if (nativeSteer === "accepted") {
          return;
        }

        const userMsg: RuntimeUserMessage = {
          ...createQueuedRuntimeUserMessage(prompt),
        };
        existing.pendingMessages.push(userMsg);

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
                reason: "waiting_for_barrier",
              },
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
                reason: decision.reason,
                tool: existing.currentToolName ?? null,
              },
            });
          } else {
            nats
              .emit(`ravi.session.${sessionName}.runtime`, {
                type: "turn.interrupt.requested",
                sessionName,
                queueSize: existing.pendingMessages.length,
                barrier: describeDeliveryBarrier(barrier),
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
      this.streamingSessions.delete(sessionName);
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
          taskBarrierTaskId: prompt.taskBarrierTaskId ?? null,
        },
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
      },
    });
    await this.startStreamingSession(sessionName, prompt);
  }

  async startStreamingSession(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
    this.startingSessions.add(sessionName);
    try {
      await startRuntimeSession({
        sessionName,
        prompt,
        configModel: this.options.getConfigModel(),
        instanceId: this.options.instanceId,
        maxConcurrentSessions: this.options.maxConcurrentSessions,
        streamingSessions: this.streamingSessions,
        stashedMessages: this.stashedMessages,
        pendingStarts: this.pendingStarts,
        safeEmit: this.options.safeEmit,
        drainPendingStarts: () => this.drainPendingStarts(),
      });
    } finally {
      this.startingSessions.delete(sessionName);
    }
  }

  drainPendingStarts(): void {
    if (this.pendingStarts.length > 0 && this.streamingSessions.size < this.options.maxConcurrentSessions) {
      const next = this.pendingStarts.shift()!;
      log.info("Dequeuing pending session start", {
        sessionName: next.sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length,
        max: this.options.maxConcurrentSessions,
      });
      next.resolve();
    }
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
  const piPreTurnQueue =
    session.queryHandle.provider === "pi" &&
    !session.turnActive &&
    !session.pushMessage &&
    session.pendingMessages.length > 0 &&
    !session.currentTurnPendingIds?.length;

  return (
    barrier === "after_tool" &&
    Boolean(session.queryHandle.control) &&
    (session.turnActive || piPreTurnQueue) &&
    !session.done &&
    !session.starting &&
    !session.compacting
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
  const [first, ...rest] = batch;
  const deliveryBarrier = rest.reduce<DeliveryBarrier>(
    (current, prompt) => chooseMoreUrgentBarrier(current, getRuntimePromptDeliveryBarrier(prompt)),
    getRuntimePromptDeliveryBarrier(first),
  );

  return {
    ...last,
    prompt: batch.map((entry) => entry.prompt).join("\n\n"),
    deliveryBarrier,
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
