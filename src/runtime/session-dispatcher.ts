import { configStore } from "../config-store.js";
import { saveMessage } from "../db.js";
import {
  DEFAULT_DELIVERY_BARRIER,
  chooseMoreUrgentBarrier,
  describeDeliveryBarrier,
  type DeliveryBarrier,
} from "../delivery-barriers.js";
import { getSessionByName } from "../router/index.js";
import { dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
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

export class RuntimeSessionDispatcher {
  readonly streamingSessions = new Map<string, RuntimeHostStreamingSession>();
  readonly debounceStates = new Map<string, DebounceState>();
  readonly deferredAfterTaskStarts = new Map<string, RuntimeLaunchPrompt[]>();
  readonly pendingStarts: PendingRuntimeSessionStart[] = [];
  readonly stashedMessages = new Map<string, RuntimeUserMessage[]>();

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

    if (this.streamingSessions.size === 0) {
      return;
    }

    log.info("Aborting streaming sessions", {
      count: this.streamingSessions.size,
      sessions: [...this.streamingSessions.keys()],
    });
    for (const [sessionName, session] of this.streamingSessions) {
      log.info("Aborting streaming session", { sessionName });
      shutdownRuntimeStreamingSession(session);
    }
    this.streamingSessions.clear();
  }

  abortSession(sessionName: string): boolean {
    const allNames = [...this.streamingSessions.keys()];
    log.info("abortSession called", {
      sessionName,
      allNames,
      found: this.streamingSessions.has(sessionName),
    });
    const session = this.streamingSessions.get(sessionName);
    if (!session) return false;

    if (session.toolRunning && session.currentToolSafety === "unsafe") {
      log.info("Deferring abort - unsafe tool running", {
        sessionName,
        tool: session.currentToolName,
      });
      session.pendingAbort = true;
      return true;
    }

    if (session.pendingMessages.length > 0) {
      log.info("Stashing aborted messages", { sessionName, count: session.pendingMessages.length });
      stashPendingRuntimeMessages(sessionName, session, this.stashedMessages);
    }

    log.info("Aborting streaming session", { sessionName, done: session.done });
    shutdownRuntimeStreamingSession(session);
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
      await applyDirectRuntimeModelSwitch(streaming.queryHandle, model);
      streaming.currentModel = model;
      return "applied";
    }

    if (streaming.pendingMessages.length > 0) {
      stashPendingRuntimeMessages(sessionName, streaming, this.stashedMessages);
    }
    streaming.currentModel = model;
    shutdownRuntimeStreamingSession(streaming);
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

        shutdownRuntimeStreamingSession(existing);
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
          shutdownRuntimeStreamingSession(existing);
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
        saveMessage(sessionName, "user", prompt.prompt, sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId);

        if (prompt.source) {
          existing.currentSource = prompt.source;
        }

        const userMsg: RuntimeUserMessage = {
          ...createQueuedRuntimeUserMessage(prompt),
        };
        existing.pendingMessages.push(userMsg);

        const barrier = userMsg.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;

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
          } else {
            log.info("Streaming: interrupting turn", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: decision.reason,
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
      return;
    }

    await this.startStreamingSession(sessionName, prompt);
  }

  async startStreamingSession(sessionName: string, prompt: RuntimeLaunchPrompt): Promise<void> {
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
