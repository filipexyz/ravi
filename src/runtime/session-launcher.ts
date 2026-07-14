import { runWithContext } from "../cli/context.js";
import { saveMessage } from "../db.js";
import { nats } from "../nats.js";
import {
  getSessionByName,
  updateRuntimeProviderState,
  updateSessionContext,
  updateSessionDisplayName,
  updateSessionSource,
} from "../router/index.js";
import {
  createSessionTraceRunId,
  recordRuntimeSafetyTraceEvent,
  recordRuntimeTraceEvent,
} from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNTIME_PROVIDER_ID, assertRuntimeCompatibility } from "./provider-registry.js";
import { completeRuntimeCredentialAttempt, markRuntimeCredentialAttemptStarted } from "./credential-store.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { refreshRuntimeCredential } from "./credential-refresh.js";
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
import { shouldUseTurnScopedAuthorityForPrompt } from "./runtime-request-context.js";
import {
  buildRuntimeStartRequest,
  resolveRuntimePromptSource,
  RuntimeStartFailure,
} from "./runtime-request-builder.js";
import {
  applyRuntimeTargetResolutionToPrompt,
  tryResolveRuntimeSession,
  type RuntimeSessionResolutionResult,
} from "./session-resolver.js";
import { markRuntimeTaskAcceptedForPrompt, resolveRuntimeForPrompt } from "./task-runtime-context.js";
import { updateRuntimeLiveState } from "./live-state.js";
import { ensureObserverBindingsForSession } from "./observation-plane.js";
import { resolveSessionOutputTarget } from "./session-output-target.js";
import {
  classifyRuntimeTargetFailure,
  decideRuntimeTargetFailure,
  getRuntimeTargetCredentialRecoveryCount,
  recordRuntimeTargetCredentialRecovery,
} from "./target-policy.js";

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
  runtimeResolution?: RuntimeSessionResolutionResult;
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
    runtimeResolution: providedRuntimeResolution,
  } = options;
  const runId = createSessionTraceRunId();
  const resumeStashedMessages = prompt._resumeStashedMessages === true;

  const sessionResolutionResult =
    providedRuntimeResolution ??
    tryResolveRuntimeSession({
      sessionName,
      prompt,
      defaultRuntimeProviderId: DEFAULT_RUNTIME_PROVIDER_ID,
    });
  if (!sessionResolutionResult.ok) {
    const error = sessionResolutionResult.error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const exhaustedTurnState = prompt._runtimeTargetState;
    const exhaustedPolicy = prompt._runtimeTargetPolicy;
    let discardedStashedMessages = 0;
    if (resumeStashedMessages && exhaustedTurnState) {
      exhaustedTurnState.terminal = true;
      discardedStashedMessages = discardStashedLogicalTurnMessages(
        stashedMessages,
        sessionName,
        exhaustedTurnState.logicalTurnId,
      );
    }
    log.warn("Runtime target resolution failed", { sessionName, error: errorMessage });
    const failedSession = getSessionByName(sessionName);
    if (failedSession && exhaustedPolicy && exhaustedTurnState) {
      recordRuntimeTraceEvent({
        sessionKey: failedSession.sessionKey,
        sessionName,
        agentId: failedSession.agentId ?? prompt._agentId,
        provider: prompt._runtimeProviderId,
        eventType: "runtime.target.exhausted",
        eventGroup: "runtime",
        status: "failed",
        source: prompt.source,
        messageId: prompt.context?.messageId,
        error: errorMessage,
        payloadJson: {
          policyId: exhaustedPolicy.id,
          logicalTurnId: exhaustedTurnState.logicalTurnId,
          attempts: exhaustedTurnState.attempts.length,
          discardedStashedMessages,
        },
      });
    }
    await safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "turn.failed",
      error: errorMessage,
      recoverable: false,
      ...(prompt.source ? { _source: prompt.source } : {}),
    });
    const failureTarget = failedSession
      ? resolveSessionOutputTarget({ sessionKey: failedSession.sessionKey, fallback: prompt.source }).target
      : prompt.source;
    if (failureTarget) {
      await nats.emit(`ravi.session.${sessionName}.response`, {
        response: formatUserFacingTurnFailure(errorMessage),
        target: failureTarget,
        _emitId: Math.random().toString(36).slice(2, 8),
        _instanceId: instanceId,
        _pid: process.pid,
        _v: 2,
      });
    }
    drainPendingStarts();
    if ((stashedMessages.get(sessionName)?.length ?? 0) > 0 && restartStashedSession) {
      await restartStashedSession({ sessionName, reason: "runtime_target_exhausted" });
    }
    return;
  }
  const resolvedSession = sessionResolutionResult.resolution;
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
    runtimeTargetPolicy,
    runtimeTarget,
    runtimeTargetRejected,
    runtimeTargetState,
    runtimeTargetPolicySource,
    runtimeTargetPolicyProvenance,
    taskProfileId,
  } = resolvedSession;

  applyRuntimeTargetResolutionToPrompt(prompt, resolvedSession);

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

  const baseRuntimeResolution = resolveRuntimeForPrompt({
    sessionName,
    prompt,
    session,
    agent,
    configModel,
  });
  const runtimeResolution = runtimeTarget
    ? {
        ...baseRuntimeResolution,
        options: {
          ...baseRuntimeResolution.options,
          model: runtimeTarget.model,
          ...(runtimeTarget.effort ? { effort: runtimeTarget.effort } : {}),
          ...(runtimeTarget.thinking ? { thinking: runtimeTarget.thinking } : {}),
        },
        sources: {
          ...baseRuntimeResolution.sources,
          model: "prompt_override" as const,
          ...(runtimeTarget.effort ? { effort: "prompt_override" as const } : {}),
          ...(runtimeTarget.thinking ? { thinking: "prompt_override" as const } : {}),
        },
      }
    : baseRuntimeResolution;
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
    runtimeTargetPolicy,
    runtimeTarget,
    runtimeTargetState,
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
    if (runtimeTargetPolicy && runtimeTarget && runtimeTargetState) {
      const rejectedById = new Map((runtimeTargetRejected ?? []).map((item) => [item.targetId, item]));
      for (const target of runtimeTargetPolicy.targets) {
        const rejection = rejectedById.get(target.id);
        recordRuntimeTraceEvent({
          sessionKey: dbSessionKey,
          sessionName,
          agentId: agent.id,
          runId,
          provider: target.runtimeProvider,
          model: target.model,
          eventType: "runtime.target.considered",
          eventGroup: "runtime",
          status: rejection ? "rejected" : target.id === runtimeTarget.id ? "selected" : "eligible",
          source: resolvedSource,
          payloadJson: {
            policyId: runtimeTargetPolicy.id,
            targetId: target.id,
            logicalTurnId: runtimeTargetState.logicalTurnId,
            reason: rejection?.reason ?? null,
            detail: rejection?.detail ?? null,
          },
        });
        if (rejection) {
          recordRuntimeTraceEvent({
            sessionKey: dbSessionKey,
            sessionName,
            agentId: agent.id,
            runId,
            provider: target.runtimeProvider,
            model: target.model,
            eventType: "runtime.target.rejected",
            eventGroup: "runtime",
            status: "rejected",
            source: resolvedSource,
            payloadJson: {
              policyId: runtimeTargetPolicy.id,
              targetId: target.id,
              logicalTurnId: runtimeTargetState.logicalTurnId,
              reason: rejection.reason,
              detail: rejection.detail ?? null,
            },
          });
        }
      }
      recordRuntimeTraceEvent({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeTarget.runtimeProvider,
        model: runtimeTarget.model,
        eventType: "runtime.target.selected",
        eventGroup: "runtime",
        status: "selected",
        source: resolvedSource,
        payloadJson: {
          policyId: runtimeTargetPolicy.id,
          targetId: runtimeTarget.id,
          logicalTurnId: runtimeTargetState.logicalTurnId,
          modelPresetId: runtimeTarget.modelPreset?.id ?? null,
          modelPresetVersion: runtimeTarget.modelPreset?.version ?? null,
        },
      });
    }
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
        runtimeTargetPolicyId: runtimeTargetPolicy?.id ?? null,
        runtimeTargetPolicySource: runtimeTargetPolicySource ?? null,
        runtimeTargetPolicyProvenance: runtimeTargetPolicyProvenance ?? null,
        runtimeTargetId: runtimeTarget?.id ?? null,
        logicalTurnId: runtimeTargetState?.logicalTurnId ?? null,
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
      runtimeTarget,
      taskProfileId,
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
    const errorName = err instanceof Error ? err.name : undefined;
    const errorRecord = asRuntimeFailureRecord(err);
    const responseRecord = asRuntimeFailureRecord(errorRecord?.response);
    const causeRecord = asRuntimeFailureRecord(errorRecord?.cause);
    const failureStatus = firstRuntimeFailureNumber(
      errorRecord?.status,
      errorRecord?.statusCode,
      responseRecord?.status,
      responseRecord?.statusCode,
      causeRecord?.status,
      causeRecord?.statusCode,
    );
    const normalizedFailureScope = err instanceof RuntimeStartFailure ? err.failureScope : undefined;
    const credentialSignal = classifyRuntimeCredentialFailure({
      runtimeProvider: runtimeProviderId,
      upstreamProvider: runtimeCredentialAttempt?.upstreamProvider,
      model,
      credentialId: runtimeCredentialAttempt?.credentialId,
      httpStatus: failureStatus,
      providerCode: firstRuntimeFailureString(errorRecord?.code, responseRecord?.code, causeRecord?.code),
      providerType: firstRuntimeFailureString(errorRecord?.type, responseRecord?.type, causeRecord?.type),
      message: errorMessage,
      source: "sdk-error",
    });
    const structuredCredentialFailure =
      credentialSignal.retryableByCredential === true || normalizedFailureScope === "credential";
    const structuredTargetFailure =
      normalizedFailureScope === "target" || (failureStatus !== undefined && failureStatus >= 500);
    completeRuntimeCredentialAttempt(runtimeCredentialAttempt?.attemptId, {
      status: structuredCredentialFailure ? "failed" : "abandoned",
      ...(structuredCredentialFailure ? { signal: credentialSignal } : {}),
      metadata: { phase: "runtime.start" },
    });

    const classifiedStartFailure =
      runtimeTargetPolicy && runtimeTargetState && runtimeTarget
        ? classifyRuntimeTargetFailure({
            error: errorMessage,
            errorName,
            caughtException: true,
            recoverable: true,
            credentialFailure: structuredCredentialFailure,
            targetFailure: structuredTargetFailure,
          })
        : null;
    let startFailureAction =
      classifiedStartFailure && runtimeTargetPolicy && runtimeTargetState && runtimeTarget
        ? decideRuntimeTargetFailure({
            recoverable: classifiedStartFailure.recoverable,
            replayEligible: true,
            scope: classifiedStartFailure.scope,
            sideEffectBoundaryCrossed: false,
            attemptsOnTarget: runtimeTargetState.attempts.filter((item) => item.targetId === runtimeTarget.id).length,
            maxAttemptsPerTarget: runtimeTargetPolicy.maxAttemptsPerTarget,
            credentialRecoveriesOnTarget: getRuntimeTargetCredentialRecoveryCount(runtimeTargetState, runtimeTarget.id),
            maxCredentialRecoveryAttemptsPerTarget: runtimeTargetPolicy.maxCredentialRecoveryAttemptsPerTarget,
          })
        : "terminate";
    let credentialRecoveryAttempt: number | undefined;
    let credentialRefreshAction: string | undefined;
    if (startFailureAction === "recover_credential" && runtimeTargetPolicy && runtimeTargetState && runtimeTarget) {
      credentialRecoveryAttempt = recordRuntimeTargetCredentialRecovery(runtimeTargetState, runtimeTarget.id);
      if (runtimeCredentialAttempt?.credentialId) {
        try {
          const refresh = await refreshRuntimeCredential(runtimeCredentialAttempt.credentialId, {
            reason: "retryable_failure",
          });
          credentialRefreshAction = refresh.action;
          if (refresh.action === "failed") startFailureAction = "switch_target";
        } catch (refreshError) {
          startFailureAction = "switch_target";
          log.warn("Runtime credential refresh failed during startup recovery", {
            sessionName,
            provider: runtimeProviderId,
            targetId: runtimeTarget.id,
            refreshFailureType: refreshError instanceof Error ? refreshError.name : "unknown",
          });
        }
      }
    }
    const canReplayStartFailure =
      startFailureAction !== "terminate" &&
      Boolean(restartStashedSession) &&
      runtimeTargetPolicy &&
      runtimeTargetState &&
      runtimeTarget;
    if (
      classifiedStartFailure &&
      canReplayStartFailure &&
      runtimeTargetPolicy &&
      runtimeTargetState &&
      runtimeTarget &&
      restartStashedSession
    ) {
      const attempt = [...runtimeTargetState.attempts]
        .reverse()
        .find((item) => item.targetId === runtimeTarget.id && item.completedAt === undefined);
      const retrySameTarget = startFailureAction === "recover_credential" || startFailureAction === "retry_same_target";
      if (attempt && retrySameTarget) {
        runtimeTargetState.attempts.splice(runtimeTargetState.attempts.indexOf(attempt), 1);
      } else if (attempt) {
        attempt.completedAt = Date.now();
        attempt.outcome = "recoverable_failure";
        attempt.failureKind = classifiedStartFailure.scope;
      }
      const replayMessages = resumeStashedMessages
        ? (stashedMessages.get(sessionName) ?? [])
        : streamingSession.pendingMessages.length > 0
          ? [...streamingSession.pendingMessages]
          : [createQueuedRuntimeUserMessage(prompt)];
      recordRuntimeTraceEvent({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeProviderId,
        model,
        eventType: "runtime.target.start_failed",
        eventGroup: "runtime",
        status: "failed",
        source: resolvedSource,
        error: errorMessage,
        payloadJson: {
          provider: runtimeProviderId,
          recoverable: true,
          failureScope: classifiedStartFailure.scope,
          failureAction: startFailureAction,
          policyId: runtimeTargetPolicy.id,
          targetId: runtimeTarget.id,
          logicalTurnId: runtimeTargetState.logicalTurnId,
          credentialRecoveryAttempt: credentialRecoveryAttempt ?? null,
          credentialRefreshAction: credentialRefreshAction ?? null,
        },
      });
      recordRuntimeSafetyTraceEvent({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeProviderId,
        model,
        eventType: retrySameTarget ? "runtime.target.credential_recovery" : "runtime.target.switch_requested",
        eventGroup: "runtime",
        status: "recovering",
        source: resolvedSource,
        error: errorMessage,
        payloadJson: {
          policyId: runtimeTargetPolicy.id,
          targetId: runtimeTarget.id,
          logicalTurnId: runtimeTargetState.logicalTurnId,
          failureScope: classifiedStartFailure.scope,
          failureAction: startFailureAction,
          credentialRecoveryAttempt: credentialRecoveryAttempt ?? null,
          credentialRefreshAction: credentialRefreshAction ?? null,
          phase: "runtime.start",
        },
      });
      for (const message of replayMessages) {
        if (!message.launchPrompt) continue;
        message.launchPrompt._runtimeTargetPolicy = runtimeTargetPolicy;
        message.launchPrompt._runtimeTargetPolicyResolution = {
          source: runtimeTargetPolicySource ?? "none",
          provenance: runtimeTargetPolicyProvenance ?? null,
        };
        message.launchPrompt._runtimeTargetState = runtimeTargetState;
        message.launchPrompt._runtimeProviderId = undefined;
        message.launchPrompt._runtimeModel = undefined;
      }
      stashedMessages.set(sessionName, replayMessages);
      log.warn("Recovering runtime target after start failure", {
        sessionName,
        provider: runtimeProviderId,
        targetId: runtimeTarget.id,
        failureScope: classifiedStartFailure.scope,
        failureAction: startFailureAction,
      });
      streamingSession.done = true;
      streamingSession.starting = false;
      if (!streamingSession.abortController.signal.aborted) streamingSession.abortController.abort();
      streamingSessions.delete(sessionName);
      drainPendingStarts();
      await restartStashedSession({
        sessionName,
        reason: retrySameTarget ? "runtime_target_start_credential_recovery" : "runtime_target_start_failure",
      });
      return;
    }

    if (runtimeTargetPolicy && runtimeTargetState && runtimeTarget && classifiedStartFailure) {
      const attempt = [...runtimeTargetState.attempts]
        .reverse()
        .find((item) => item.targetId === runtimeTarget.id && item.completedAt === undefined);
      if (attempt) {
        attempt.completedAt = Date.now();
        attempt.outcome = "terminal_failure";
        attempt.failureKind = classifiedStartFailure.scope;
      }
      runtimeTargetState.terminal = true;
      recordRuntimeTraceEvent({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeProviderId,
        model,
        eventType: "runtime.target.replay_blocked",
        eventGroup: "runtime",
        status: "blocked",
        source: resolvedSource,
        error: errorMessage,
        payloadJson: {
          policyId: runtimeTargetPolicy.id,
          targetId: runtimeTarget.id,
          logicalTurnId: runtimeTargetState.logicalTurnId,
          failureScope: classifiedStartFailure.scope,
          failureAction: startFailureAction,
          phase: "runtime.start",
        },
      });
    }

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

function discardStashedLogicalTurnMessages(
  stashedMessages: Map<string, RuntimeUserMessage[]>,
  sessionName: string,
  logicalTurnId: string,
): number {
  const stashed = stashedMessages.get(sessionName);
  if (!stashed?.length) return 0;
  const remaining = stashed.filter(
    (message) => message.launchPrompt?._runtimeTargetState?.logicalTurnId !== logicalTurnId,
  );
  const discarded = stashed.length - remaining.length;
  if (remaining.length > 0) stashedMessages.set(sessionName, remaining);
  else stashedMessages.delete(sessionName);
  return discarded;
}

function asRuntimeFailureRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstRuntimeFailureNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstRuntimeFailureString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
