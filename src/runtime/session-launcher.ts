import { runWithContext } from "../cli/context.js";
import { saveMessage } from "../db.js";
import { nats } from "../nats.js";
import {
  updateRuntimeProviderState,
  updateSessionContext,
  updateSessionDisplayName,
  updateSessionSource,
} from "../router/index.js";
import { dbGetSetting } from "../router/router-db.js";
import { createSessionTraceRunId, recordRuntimeTraceEvent } from "../session-trace/runtime-trace.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_RUNTIME_PROVIDER_ID, assertRuntimeCompatibility } from "./provider-registry.js";
import { completeRuntimeCredentialAttempt, markRuntimeCredentialAttemptStarted } from "./credential-store.js";
import { createModelBroker } from "./model-broker-registry.js";
import {
  abandonClaimedRuntimeModelBrokerPlan,
  buildRuntimeModelBrokerPlanIdentity,
  claimRuntimeModelBrokerPlan,
  planRuntimeModelBrokerRoute,
  type ClaimedRuntimeModelBrokerPlan,
} from "./model-broker-planning.js";
import {
  MODEL_BROKER_REQUIRED_SETTING,
  reportRuntimeModelBrokerAttempt,
  resolveRequiredRuntimeModelBrokerSelection,
} from "./model-broker.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import { resolvePersistedUserText } from "./session-surface-hint.js";
import { normalizePromptTaskBarrierTaskId } from "./host-env.js";
import { runRuntimeEventLoop, type RuntimeSafeEmit } from "./host-event-loop.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  createPendingRuntimeHandle,
  resolveRuntimeToolEffectFence,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { shouldUseTurnScopedAuthorityForPrompt } from "./runtime-request-context.js";
import { buildRuntimeStartRequest, resolveRuntimePromptSource } from "./runtime-request-builder.js";
import { resolveRuntimeSession, resolveRuntimeSessionIdentity } from "./session-resolver.js";
import { markRuntimeTaskAcceptedForPrompt, resolveRuntimeForPrompt } from "./task-runtime-context.js";
import { updateRuntimeLiveState } from "./live-state.js";
import { ensureObserverBindingsForSession } from "./observation-plane.js";
import { formatUserFacingTurnFailure, publicRuntimeFailureDetail } from "./public-failure.js";

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
  onToolBarrierReleased?(sessionName: string): void | Promise<void>;
  crashRecovery: RuntimeCrashRecoveryCoordinator;
}

export function updateRuntimeSessionMetadata(sessionKey: string, prompt: RuntimeLaunchPrompt): void {
  if (prompt.source) {
    updateSessionSource(sessionKey, prompt.source);
  }

  if (prompt.context?.senderId) {
    updateSessionContext(sessionKey, prompt.context);
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
    onToolBarrierReleased,
    crashRecovery,
  } = options;
  const runId = createSessionTraceRunId();
  const resumeStashedMessages = prompt._resumeStashedMessages === true;

  const sessionIdentity = resolveRuntimeSessionIdentity({ sessionName, prompt });
  if (!sessionIdentity) return;
  let modelBrokerPlanClaim: ClaimedRuntimeModelBrokerPlan | undefined;
  if (prompt._modelBrokerTurnId) {
    const selection = resolveRequiredRuntimeModelBrokerSelection(
      sessionIdentity.agent,
      dbGetSetting(MODEL_BROKER_REQUIRED_SETTING) ?? undefined,
    );
    const runtimeId = process.env.RAVI_RUNTIME_ID?.trim();
    if (!selection || !runtimeId) throw new Error("The model-broker preflight identity is no longer valid.");
    const planIdentity = buildRuntimeModelBrokerPlanIdentity({
      selection,
      runtimeId,
      agentId: sessionIdentity.agent.id,
      sessionKey: sessionIdentity.dbSessionKey,
      turnId: prompt._modelBrokerTurnId,
    });
    modelBrokerPlanClaim = claimRuntimeModelBrokerPlan(planIdentity);
    if (!modelBrokerPlanClaim) {
      await planRuntimeModelBrokerRoute({
        agent: sessionIdentity.agent,
        sessionKey: sessionIdentity.dbSessionKey,
        turnId: prompt._modelBrokerTurnId,
        globalRequiredSetting: dbGetSetting(MODEL_BROKER_REQUIRED_SETTING) ?? undefined,
      });
      modelBrokerPlanClaim = claimRuntimeModelBrokerPlan(planIdentity);
    }
    if (!modelBrokerPlanClaim) throw new Error("Could not claim the model-broker route plan.");
  }
  let resolvedSession;
  try {
    resolvedSession = resolveRuntimeSession({
      sessionName,
      prompt,
      defaultRuntimeProviderId: DEFAULT_RUNTIME_PROVIDER_ID,
      identity: sessionIdentity,
      ...(modelBrokerPlanClaim ? { runtimeProviderIdOverride: modelBrokerPlanClaim.plan.lease.runtimeProvider } : {}),
    });
  } catch (error) {
    if (modelBrokerPlanClaim) {
      await abandonClaimedRuntimeModelBrokerPlan(modelBrokerPlanClaim, "provider_resolution_failed");
    }
    throw error;
  }
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
    saveMessage(
      sessionName,
      "user",
      resolvePersistedUserText(prompt),
      canResumeStoredSession ? storedProviderSessionId : undefined,
      {
        agentId: agent.id,
        channel: resolvedSource?.channel ?? prompt.context?.channelId,
        accountId: resolvedSource?.accountId ?? prompt.context?.accountId,
        chatId: resolvedSource?.chatId ?? prompt.context?.chatId,
        sourceMessageId: resolvedSource?.sourceMessageId ?? prompt.context?.messageId,
        commands: prompt.commands,
      },
    );
  }

  const runtimeResolution = resolveRuntimeForPrompt({
    sessionName,
    prompt,
    session,
    agent,
    configModel,
  });
  const model = modelBrokerPlanClaim?.plan.lease.model ?? runtimeResolution.options.model ?? configModel;
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
  let modelBrokerPlanHandedToBuilder = false;

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
    toolResultDeliveryPending: false,
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
    toolEffectFence: resolveRuntimeToolEffectFence(runtimeProviderId, runtimeCapabilities.tools.permissionMode),
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

    modelBrokerPlanHandedToBuilder = true;
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
      crashRecovery,
      modelBrokerPlanClaim,
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
        onToolBarrierReleased,
        crashRecovery,
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
    if (modelBrokerPlanClaim && !modelBrokerPlanHandedToBuilder) {
      await abandonClaimedRuntimeModelBrokerPlan(modelBrokerPlanClaim, "runtime_preparation_failed").catch(
        () => undefined,
      );
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    await abandonRuntimeStartAttempt(runtimeCredentialAttempt, errorMessage);

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
      summary: publicRuntimeFailureDetail(err),
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
        response: formatUserFacingTurnFailure(err),
        target: resolvedSource,
        _emitId: Math.random().toString(36).slice(2, 8),
        _instanceId: instanceId,
        _pid: process.pid,
        _v: 2,
      });
    }
  }
}

async function abandonRuntimeStartAttempt(
  binding: RuntimeCredentialAttemptBinding | undefined,
  errorMessage: string,
): Promise<void> {
  if (binding?.authMethod !== "model-broker") {
    completeRuntimeCredentialAttempt(binding?.attemptId, {
      status: "abandoned",
      metadata: { phase: "runtime.start", error: errorMessage },
    });
    return;
  }
  if (
    !binding.attemptId ||
    !binding.modelBrokerId ||
    !binding.modelBrokerLeaseId ||
    !binding.modelBrokerRuntimeId ||
    !binding.modelBrokerSessionKey ||
    !binding.modelBrokerTurnId
  ) {
    return;
  }
  try {
    await reportRuntimeModelBrokerAttempt(createModelBroker(binding.modelBrokerId), {
      attemptId: binding.attemptId,
      turnId: binding.modelBrokerTurnId,
      leaseId: binding.modelBrokerLeaseId,
      runtimeId: binding.modelBrokerRuntimeId,
      sessionKey: binding.modelBrokerSessionKey,
      outcome: "abandoned",
      effectState: "none",
      failureKind: "runtime_start_failed",
    });
    binding.modelBrokerAttemptTerminal = true;
  } catch (error) {
    log.warn("Failed to abandon model-broker attempt after runtime start failure", { error });
  }
}
