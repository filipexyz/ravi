import { runWithContext } from "../cli/context.js";
import { saveMessage } from "../db.js";
import { nats } from "../nats.js";
import {
  updateRuntimeProviderState,
  updateSessionContext,
  updateSessionDisplayName,
  updateSessionSource,
} from "../router/index.js";
import { createSessionTraceRunId, recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNTIME_PROVIDER_ID, assertRuntimeCompatibility } from "./provider-registry.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import { formatUserFacingTurnFailure, runRuntimeEventLoop, type RuntimeSafeEmit } from "./host-event-loop.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  createPendingRuntimeHandle,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { ChannelContext, RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeStartRequest, resolveRuntimePromptSource } from "./runtime-request-builder.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { markRuntimeTaskAcceptedForPrompt, resolveRuntimeForPrompt } from "./task-runtime-context.js";
import { updateRuntimeLiveState } from "./live-state.js";
import { ensureObserverBindingsForSession } from "./observation-plane.js";

const log = logger.child("runtime:session-launcher");

export interface PendingRuntimeSessionStart {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  resolve: () => void;
  cancelled?: boolean;
}

export interface StartRuntimeSessionOptions {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  configModel: string;
  instanceId: string;
  maxConcurrentSessions: number;
  streamingSessions: Map<string, RuntimeHostStreamingSession>;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  pendingStarts: PendingRuntimeSessionStart[];
  safeEmit: RuntimeSafeEmit;
  drainPendingStarts(): void;
}

export function updateRuntimeSessionMetadata(sessionKey: string, prompt: RuntimeLaunchPrompt): void {
  if (prompt.source) {
    updateSessionSource(sessionKey, prompt.source);
  }

  if (prompt.context?.senderId) {
    const channelCtx: ChannelContext = {
      channelId: prompt.context.channelId,
      channelName: prompt.context.channelName,
      isGroup: prompt.context.isGroup,
      groupName: prompt.context.groupName,
      groupId: prompt.context.groupId,
      groupMembers: prompt.context.groupMembers,
    };
    updateSessionContext(sessionKey, JSON.stringify(channelCtx));
    if (prompt.context.groupName) {
      updateSessionDisplayName(sessionKey, prompt.context.groupName);
    }
  }
}

export async function startRuntimeSession(options: StartRuntimeSessionOptions): Promise<void> {
  const {
    sessionName,
    prompt,
    configModel,
    instanceId,
    maxConcurrentSessions,
    streamingSessions,
    stashedMessages,
    pendingStarts,
    safeEmit,
    drainPendingStarts,
  } = options;
  const runId = createSessionTraceRunId();

  if (streamingSessions.size >= maxConcurrentSessions) {
    log.warn("Session start queued - concurrency limit reached", {
      sessionName,
      active: streamingSessions.size,
      queued: pendingStarts.length + 1,
      max: maxConcurrentSessions,
    });
    recordRuntimeTraceEvent({
      sessionKey: sessionName,
      sessionName,
      runId,
      eventType: "dispatch.queued_busy",
      eventGroup: "dispatch",
      status: "queued",
      payloadJson: {
        reason: "concurrency_limit",
        active: streamingSessions.size,
        queued: pendingStarts.length + 1,
        max: maxConcurrentSessions,
      },
    });
    safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "dispatch.queued",
      reason: "concurrency_limit",
      active: streamingSessions.size,
      queued: pendingStarts.length + 1,
      max: maxConcurrentSessions,
      timestamp: new Date().toISOString(),
    }).catch((error) => {
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
      pendingStarts.push(pendingStart);
    });
    if (pendingStart.cancelled) {
      log.info("Pending session start cancelled", { sessionName });
      return;
    }
    log.info("Pending session start resumed", {
      sessionName,
      active: streamingSessions.size,
      queued: pendingStarts.length,
      max: maxConcurrentSessions,
    });
  }

  const resolvedSession = resolveRuntimeSession({
    sessionName,
    prompt,
    defaultRuntimeProviderId: DEFAULT_RUNTIME_PROVIDER_ID,
  });
  if (!resolvedSession) {
    return;
  }

  const {
    agent,
    runtimeProviderId,
    runtimeProvider,
    runtimeCapabilities,
    session,
    sessionCwd,
    dbSessionKey,
    storedRuntimeSessionParams,
    storedProviderSessionId,
    canResumeStoredSession,
    resumeDecision,
  } = resolvedSession;

  log.info("startRuntimeSession", {
    sessionName,
    dbSessionKey,
    provider: runtimeProviderId,
    providerSessionId: canResumeStoredSession ? storedProviderSessionId : undefined,
    willResume: canResumeStoredSession,
    resumeDecision,
  });

  const resolvedSource = resolveRuntimePromptSource(prompt, session);
  const approvalSource = prompt._approvalSource;

  updateRuntimeSessionMetadata(dbSessionKey, prompt);
  saveMessage(sessionName, "user", prompt.prompt, canResumeStoredSession ? storedProviderSessionId : undefined, {
    agentId: agent.id,
    channel: resolvedSource?.channel ?? prompt.context?.channelId,
    accountId: resolvedSource?.accountId ?? prompt.context?.accountId,
    chatId: resolvedSource?.chatId ?? prompt.context?.chatId,
    sourceMessageId: resolvedSource?.sourceMessageId ?? prompt.context?.messageId,
    commands: prompt.commands,
  });

  const runtimeResolution = resolveRuntimeForPrompt({
    sessionName,
    prompt,
    session,
    agent,
    configModel,
  });
  const model = runtimeResolution.options.model ?? configModel;
  try {
    const observation = ensureObserverBindingsForSession({
      sessionName,
      session,
      agent,
      prompt,
    });
    if (observation.source && (observation.bindings.length > 0 || observation.created.length > 0)) {
      recordRuntimeTraceEvent({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeProviderId,
        model,
        eventType: "observation.bindings",
        eventGroup: "observation",
        status: "ready",
        source: resolvedSource,
        payloadJson: {
          bindingIds: observation.bindings.map((binding) => binding.id),
          createdBindingIds: observation.created.map((binding) => binding.id),
          skipped: observation.skipped.slice(0, 20),
        },
      });
    }
  } catch (error) {
    log.warn("Failed to ensure observer bindings", { sessionName, error });
  }
  const abortController = new AbortController();

  const streamingSession: RuntimeHostStreamingSession = {
    agentId: agent.id,
    queryHandle: createPendingRuntimeHandle(runtimeProviderId),
    starting: true,
    abortController,
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage(prompt)],
    currentSource: resolvedSource,
    currentModel: model,
    currentEffort: runtimeResolution.options.effort,
    currentThinking: runtimeResolution.options.thinking,
    currentTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId),
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: agent.mode,
    traceRunId: runId,
  };
  streamingSessions.set(sessionName, streamingSession);
  updateRuntimeLiveState(sessionName, {
    activity: "thinking",
    summary: "starting runtime",
    agentId: agent.id,
    runId,
    provider: runtimeProviderId,
    model,
    source: resolvedSource,
  });

  try {
    recordRuntimeTraceEvent({
      sessionKey: dbSessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      provider: runtimeProviderId,
      model,
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "starting",
      source: resolvedSource,
      payloadJson: {
        provider: runtimeProviderId,
        model,
        effort: runtimeResolution.options.effort ?? null,
        thinking: runtimeResolution.options.thinking ?? null,
        cwd: sessionCwd,
        canResumeStoredSession,
        storedProviderSessionId: canResumeStoredSession ? storedProviderSessionId : null,
        resumeDecision,
        taskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? null,
      },
    });

    assertRuntimeCompatibility(runtimeProvider, {
      requiresMcpServers: !!agent.specMode,
      requiresRemoteSpawn: !!agent.remote,
      toolAccessMode: getRuntimeToolAccessMode(runtimeCapabilities, agent.id),
    });

    const resumableProviderSessionId = canResumeStoredSession ? storedProviderSessionId : undefined;

    log.info("Starting streaming session", {
      runId,
      sessionName,
      agentId: agent.id,
      provider: runtimeProviderId,
      model,
      effort: runtimeResolution.options.effort ?? null,
      thinking: runtimeResolution.options.thinking ?? null,
      modelSource: runtimeResolution.sources.model,
      providerSessionId: resumableProviderSessionId ?? null,
      resuming: !!resumableProviderSessionId,
    });

    const { runtimeRequest, toolContext } = await buildRuntimeStartRequest({
      runId,
      sessionName,
      prompt,
      session,
      agent,
      runtimeProviderId,
      runtimeProvider,
      runtimeCapabilities,
      sessionCwd,
      dbSessionKey,
      model,
      runtimeResolution,
      storedRuntimeSessionParams,
      storedProviderSessionId,
      canResumeStoredSession,
      resolvedSource,
      approvalSource,
      streamingSession,
      stashedMessages,
      defaultRuntimeProviderId: DEFAULT_RUNTIME_PROVIDER_ID,
    });

    const runtimeSession = runtimeProvider.startSession(runtimeRequest);
    const persistedRuntimeProviderSessionId = canResumeStoredSession ? storedProviderSessionId : undefined;
    updateRuntimeProviderState(session.sessionKey, runtimeProviderId, {
      ...(persistedRuntimeProviderSessionId ? { providerSessionId: persistedRuntimeProviderSessionId } : {}),
      ...(canResumeStoredSession && storedRuntimeSessionParams
        ? { runtimeSessionParams: storedRuntimeSessionParams }
        : {}),
      ...(canResumeStoredSession && (session.runtimeSessionDisplayId ?? storedProviderSessionId)
        ? {
            runtimeSessionDisplayId: session.runtimeSessionDisplayId ?? storedProviderSessionId,
          }
        : {}),
    });
    session.runtimeProvider = runtimeProviderId;
    if (persistedRuntimeProviderSessionId) {
      session.runtimeSessionParams = storedRuntimeSessionParams;
      session.runtimeSessionDisplayId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
      session.providerSessionId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
      session.sdkSessionId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
    }

    await markRuntimeTaskAcceptedForPrompt(sessionName, prompt);

    streamingSession.queryHandle = runtimeSession;
    streamingSession.starting = false;

    runWithContext(toolContext, () =>
      runRuntimeEventLoop({
        runId,
        sessionName,
        session,
        agent,
        streaming: streamingSession,
        runtimeSession,
        runtimeCapabilities,
        model,
        instanceId,
        defaultRuntimeProviderId: DEFAULT_RUNTIME_PROVIDER_ID,
        streamingSessions,
        stashedMessages,
        safeEmit,
        drainPendingStarts,
      }),
    ).catch((err) => {
      const isAbort = err instanceof Error && /abort/i.test(err.message);
      if (isAbort) {
        log.info("Streaming session aborted", { sessionName });
      } else {
        log.error("Streaming session failed", { sessionName, error: err });
      }
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    log.error("Failed to start streaming session", {
      sessionName,
      provider: runtimeProviderId,
      error: err,
    });

    streamingSession.done = true;
    streamingSession.starting = false;
    if (!streamingSession.abortController.signal.aborted) {
      streamingSession.abortController.abort();
    }
    streamingSessions.delete(sessionName);
    drainPendingStarts();
    updateRuntimeLiveState(sessionName, {
      activity: "blocked",
      summary: errorMessage,
      agentId: agent.id,
      runId,
      provider: runtimeProviderId,
      model,
      source: resolvedSource,
    });

    recordRuntimeTraceEvent({
      sessionKey: dbSessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      provider: runtimeProviderId,
      model,
      eventType: "runtime.start",
      eventGroup: "runtime",
      status: "failed",
      source: resolvedSource,
      error: errorMessage,
      payloadJson: {
        provider: runtimeProviderId,
        recoverable: false,
      },
    });

    await safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "turn.failed",
      provider: runtimeProviderId,
      error: errorMessage,
      recoverable: false,
      ...(resolvedSource ? { _source: resolvedSource } : {}),
    });

    if (resolvedSource && agent.mode !== "sentinel") {
      await nats.emit(`ravi.session.${sessionName}.response`, {
        response: formatUserFacingTurnFailure(errorMessage),
        target: resolvedSource,
        _emitId: Math.random().toString(36).slice(2, 8),
        _instanceId: instanceId,
        _pid: process.pid,
        _v: 2,
      });
    }
  }
}
