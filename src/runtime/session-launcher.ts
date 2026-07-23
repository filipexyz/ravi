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
import { completeRuntimeCredentialAttempt, markRuntimeCredentialAttemptStarted } from "./credential-store.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import { runRuntimeEventLoop, type RuntimeSafeEmit } from "./host-event-loop.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  createPendingRuntimeHandle,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { ChannelContext, RuntimeLaunchPrompt } from "./message-types.js";
import { shouldUseTurnScopedAuthorityForPrompt } from "./runtime-request-context.js";
import { buildRuntimeStartRequest, resolveRuntimePromptSource } from "./runtime-request-builder.js";
import { resolveRuntimeSession } from "./session-resolver.js";
import { markRuntimeTaskAcceptedForPrompt, resolveRuntimeForPrompt } from "./task-runtime-context.js";
import { updateRuntimeLiveState } from "./live-state.js";
import { ensureObserverBindingsForSession } from "./observation-plane.js";
import { formatUserFacingTurnFailure, publicRuntimeFailureDetail } from "./public-failure.js";
import {
  applyProviderContinuityTargetToPrompt,
  handleProviderContinuityFailure,
  markProviderContinuityDelivery,
} from "./provider-continuity/coordinator.js";
import { PROVIDER_CONTINUITY_SNAPSHOT, PROVIDER_CONTINUITY_SPEC_VERSION } from "./provider-continuity/types.js";
import { refreshRuntimeCredential } from "./credential-refresh.js";

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
  streamingSessions: Map<string, RuntimeHostStreamingSession>;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  safeEmit: RuntimeSafeEmit;
  drainPendingStarts(): void;
  restartStashedSession?(input: { sessionName: string; reason: string }): void | Promise<void>;
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
    streamingSessions,
    stashedMessages,
    safeEmit,
    drainPendingStarts,
    restartStashedSession,
  } = options;
  const runId = createSessionTraceRunId();
  const resumeStashedMessages = prompt._resumeStashedMessages === true;

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
  if (!resumeStashedMessages) {
    saveMessage(sessionName, "user", prompt.prompt, canResumeStoredSession ? storedProviderSessionId : undefined, {
      agentId: agent.id,
      channel: resolvedSource?.channel ?? prompt.context?.channelId,
      accountId: resolvedSource?.accountId ?? prompt.context?.accountId,
      chatId: resolvedSource?.chatId ?? prompt.context?.chatId,
      sourceMessageId: resolvedSource?.sourceMessageId ?? prompt.context?.messageId,
      commands: prompt.commands,
    });
  }

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
  let runtimeCredentialAttempt: Awaited<ReturnType<typeof buildRuntimeStartRequest>>["runtimeCredentialAttempt"];

  const streamingSession: RuntimeHostStreamingSession = {
    agentId: agent.id,
    queryHandle: createPendingRuntimeHandle(runtimeProviderId),
    starting: true,
    abortController,
    pushMessage: null,
    pendingWake: false,
    pendingMessages: resumeStashedMessages ? [] : [createQueuedRuntimeUserMessage(prompt)],
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
        modelSource: runtimeResolution.sources.model,
        effortSource: runtimeResolution.sources.effort,
        thinkingSource: runtimeResolution.sources.thinking,
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
      toolAccessMode: shouldUseTurnScopedAuthorityForPrompt(prompt, resolvedSource)
        ? "restricted"
        : getRuntimeToolAccessMode(runtimeCapabilities, agent.id),
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
      effortSource: runtimeResolution.sources.effort,
      thinkingSource: runtimeResolution.sources.thinking,
      providerSessionId: resumableProviderSessionId ?? null,
      resuming: !!resumableProviderSessionId,
    });

    const builtRuntimeRequest = await buildRuntimeStartRequest({
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
    runtimeCredentialAttempt = builtRuntimeRequest.runtimeCredentialAttempt;
    const { runtimeRequest, toolContext } = builtRuntimeRequest;

    const runtimeSession = runtimeProvider.startSession(runtimeRequest);
    markRuntimeCredentialAttemptStarted(runtimeCredentialAttempt?.attemptId);
    streamingSession.currentRuntimeCredential = runtimeCredentialAttempt;
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
        restartStashedSession,
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
    const continuityFailure = handleProviderContinuityFailure({
      metadata: prompt._continuity,
      sessionName,
      runtimeProvider: runtimeProviderId,
      model,
      error: err,
    });
    completeRuntimeCredentialAttempt(runtimeCredentialAttempt?.attemptId, {
      status: "abandoned",
      metadata: { phase: "runtime.start", error: errorMessage },
    });

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

    if (
      (continuityFailure.action === "recover_credential" || continuityFailure.action === "switch_target") &&
      continuityFailure.metadata
    ) {
      if (continuityFailure.action === "recover_credential" && runtimeCredentialAttempt?.credentialId) {
        try {
          await refreshRuntimeCredential(runtimeCredentialAttempt.credentialId, {
            reason: "retryable_failure",
          });
        } catch (error) {
          log.warn("Continuity credential recovery refresh failed", {
            sessionName,
            error: publicRuntimeFailureDetail(error),
          });
        }
      }
      const restartPrompt = applyProviderContinuityTargetToPrompt(
        { ...prompt, _resumeStashedMessages: true },
        continuityFailure.metadata,
      );
      stashedMessages.set(sessionName, [createQueuedRuntimeUserMessage(restartPrompt)]);
      await safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: `continuity.${continuityFailure.action}`,
        logicalRequestId: continuityFailure.metadata.logicalRequestId,
        fromProvider: runtimeProviderId,
        toProvider: continuityFailure.metadata.target.provider,
        toModel: continuityFailure.metadata.target.model,
        reason: continuityFailure.reason,
        specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
        compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
      });
      if (restartStashedSession) {
        await restartStashedSession({
          sessionName,
          reason: `provider_continuity_${continuityFailure.action}`,
        });
      }
      return;
    }

    updateRuntimeLiveState(sessionName, {
      activity: "blocked",
      summary:
        continuityFailure.active && continuityFailure.reason
          ? continuityFailure.reason
          : publicRuntimeFailureDetail(err),
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
      error: continuityFailure.active ? continuityFailure.reason : errorMessage,
      recoverable: false,
      ...(continuityFailure.journal
        ? {
            logicalRequestId: continuityFailure.journal.logicalRequestId,
            continuityState: continuityFailure.journal.state,
            specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
            compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
          }
        : {}),
      ...(resolvedSource ? { _source: resolvedSource } : {}),
    });

    if (resolvedSource && agent.mode !== "sentinel") {
      if (continuityFailure.journal) {
        markProviderContinuityDelivery({
          logicalRequestId: continuityFailure.journal.logicalRequestId,
          state: "started",
        });
      }
      try {
        await nats.emit(`ravi.session.${sessionName}.response`, {
          response: continuityFailure.active
            ? `Provider continuity stopped: ${continuityFailure.reason}.`
            : formatUserFacingTurnFailure(err),
          target: resolvedSource,
          _emitId: continuityFailure.journal?.deliveryId ?? Math.random().toString(36).slice(2, 8),
          _instanceId: instanceId,
          _pid: process.pid,
          _v: 2,
        });
        if (continuityFailure.journal) {
          markProviderContinuityDelivery({
            logicalRequestId: continuityFailure.journal.logicalRequestId,
            state: "delivered",
          });
        }
      } catch (error) {
        if (continuityFailure.journal) {
          markProviderContinuityDelivery({
            logicalRequestId: continuityFailure.journal.logicalRequestId,
            state: "ambiguous",
          });
        }
        throw error;
      }
    }
  }
}
