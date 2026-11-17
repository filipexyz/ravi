import { projectChannelRuntimeEvent } from "../channels/runtime-events.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import { recordRuntimeTraceEvent, recordTerminalTurnTrace } from "../session-trace/runtime-trace.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { completeRuntimeCredentialAttempt } from "./credential-store.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeMessageGeneratorOptions } from "./delivery-queue.js";
import type { RuntimeSafeEmit } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { reportRuntimeModelBrokerAttempt } from "./model-broker.js";
import { createModelBroker } from "./model-broker-registry.js";
import { formatUserFacingTurnFailure } from "./public-failure.js";
import { resolveRuntimePromptSource } from "./runtime-request-builder.js";
import { resolveSessionOutputTargetPreserving } from "./session-output-target.js";
import { isObserverRuntimeSessionName } from "./session-pool.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import type { RuntimeProviderId } from "./types.js";

/** Settle unused admission before the generator can prepare a successor. */
async function abandonCapacityRetryCredential(
  binding: RuntimeCredentialAttemptBinding | undefined,
  reason: string,
): Promise<void> {
  if (!binding?.attemptId) return;
  const attemptId = binding.attemptId;
  if (binding.authMethod !== "model-broker") {
    completeRuntimeCredentialAttempt(attemptId, {
      status: "abandoned",
      metadata: { phase: "runtime.capacity_retry", reason, providerDelivered: false },
    });
    binding.attemptId = undefined;
    return;
  }
  if (binding.modelBrokerAttemptTerminal) return;
  if (
    !binding.modelBrokerId ||
    !binding.modelBrokerLeaseId ||
    !binding.modelBrokerRuntimeId ||
    !binding.modelBrokerSessionKey ||
    !binding.modelBrokerTurnId
  ) {
    throw new Error("Capacity retry expiry cannot settle an incomplete model-broker binding");
  }
  // Failure must prevent successor admission; otherwise the next binding would
  // overwrite the lease whose terminal feedback has not been acknowledged.
  await reportRuntimeModelBrokerAttempt(createModelBroker(binding.modelBrokerId), {
    attemptId,
    turnId: binding.modelBrokerTurnId,
    leaseId: binding.modelBrokerLeaseId,
    runtimeId: binding.modelBrokerRuntimeId,
    sessionKey: binding.modelBrokerSessionKey,
    outcome: "abandoned",
    effectState: "none",
    failureKind: reason,
  });
  binding.modelBrokerAttemptTerminal = true;
}

interface CapacityRetryHandlerOptions {
  sessionName: string;
  session: SessionEntry;
  agent: Pick<AgentConfig, "id" | "mode">;
  runId: string;
  runtimeProviderId: RuntimeProviderId;
  instanceId: string;
  streamingSession: RuntimeHostStreamingSession;
  crashRecovery: RuntimeCrashRecoveryCoordinator;
  safeEmit: RuntimeSafeEmit;
}

export function createCapacityRetryExhaustionHandler(
  options: CapacityRetryHandlerOptions,
): NonNullable<RuntimeMessageGeneratorOptions["onCapacityRetryExhausted"]> {
  const {
    sessionName,
    session,
    agent,
    runId,
    runtimeProviderId,
    instanceId,
    streamingSession,
    crashRecovery,
    safeEmit,
  } = options;
  return async ({ deliverableMessages, reason, error }) => {
    const retryPrompt = [...deliverableMessages].reverse().find((message) => message.launchPrompt)?.launchPrompt;
    const source = retryPrompt ? resolveRuntimePromptSource(retryPrompt, session) : undefined;
    const completedAt = Date.now();
    // Slow preparation may already own a write-ahead attempt, but no provider
    // input was sent. Close that attempt without borrowing a successor's state.
    if (streamingSession.currentCrashRecoveryAttemptId) {
      const terminal = crashRecovery.terminalizeTurnAttempt({
        attemptId: streamingSession.currentCrashRecoveryAttemptId,
        status: "failed",
        completedAt,
      });
      if (terminal.status !== "failed" || terminal.completedAt !== completedAt) {
        throw new Error("Capacity retry expiry lost its durable terminal fence");
      }
      streamingSession.currentCrashRecoveryAttemptId = undefined;
      streamingSession.currentCrashRecoveryTerminal = {
        status: terminal.status,
        completedAt,
        startedTool: terminal.startedTool,
        materializedOutput: terminal.materializedOutput,
      };
      if (streamingSession.currentTraceTurnId) {
        recordTerminalTurnTrace({
          sessionKey: session.sessionKey,
          sessionName,
          agentId: agent.id,
          runId,
          turnId: streamingSession.currentTraceTurnId,
          provider: runtimeProviderId,
          model: streamingSession.currentModel,
          status: "failed",
          eventType: "turn.failed",
          abortReason: reason,
          error,
          startedAt: streamingSession.currentTraceTurnStartedAt,
          completedAt,
          payloadJson: { providerDelivered: false, capacityRetry: deliverableMessages[0]?.providerCapacityRetry },
        });
        streamingSession.currentTraceTurnTerminalRecorded = true;
      }
    }
    const expiredCredential = streamingSession.currentRuntimeCredential;
    try {
      recordRuntimeTraceEvent({
        sessionKey: session.sessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        provider: runtimeProviderId,
        model: streamingSession.currentModel,
        eventType: "runtime.capacity_retry_exhausted",
        eventGroup: "runtime",
        status: "failed",
        source,
        error,
        payloadJson: { reason, providerDelivered: false },
      });
      if (retryPrompt?._channelBackend) {
        await projectChannelRuntimeEvent({
          metadata: retryPrompt._channelBackend,
          event: { type: "turn.failed", error, recoverable: false },
        });
      }
      await safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "turn.failed",
        provider: runtimeProviderId,
        error,
        failureKind: "provider_capacity_exhausted",
        recoverable: false,
        ...(retryPrompt?._bridgeTurnId ? { _bridgeTurnId: retryPrompt._bridgeTurnId } : {}),
        _turnProvenance: classifyTurnProvenance({ prompt: retryPrompt }),
        ...(source ? { _source: source } : {}),
      });
      // Early expiry runs before beforeTurnStart: currentReplyTarget and the
      // suppression flags can still belong to the previous turn. Use this input.
      if (
        !retryPrompt ||
        retryPrompt._channelBackend ||
        retryPrompt._cliDestination ||
        retryPrompt._observation ||
        isObserverRuntimeSessionName(sessionName) ||
        agent.mode === "sentinel"
      ) {
        return;
      }
      const { target } = resolveSessionOutputTargetPreserving({
        sessionKey: session.sessionKey,
        fallback: source,
        previous: streamingSession.lastBoundReplyTarget ?? streamingSession.currentReplyTarget,
      });
      if (!target) return;
      await safeEmit(`ravi.session.${sessionName}.response`, {
        response: formatUserFacingTurnFailure(error),
        target,
        _emitId: Math.random().toString(36).slice(2, 8),
        _instanceId: instanceId,
        _pid: process.pid,
        _v: 2,
      });
    } finally {
      // Feedback failure must stop successor admission without suppressing
      // the terminal capacity error already owed to this logical request.
      await abandonCapacityRetryCredential(expiredCredential, reason);
    }
  };
}

/** No native turn exists during the wait to close its logical channel request. */
export function createCapacityRetryCancellationHandler(
  options: CapacityRetryHandlerOptions,
): NonNullable<RuntimeMessageGeneratorOptions["onCapacityRetryCancelled"]> {
  const { sessionName, session, agent, runId, runtimeProviderId, streamingSession, safeEmit } = options;
  return async ({ deliverableMessages }) => {
    const reason = "provider_capacity_retry_cancelled";
    const retryPrompt = [...deliverableMessages].reverse().find((message) => message.launchPrompt)?.launchPrompt;
    const source = retryPrompt ? resolveRuntimePromptSource(retryPrompt, session) : undefined;
    const snapshotOwnsRetry =
      streamingSession.internalAbortReason === "shutdown_all" &&
      streamingSession.capacityRetrySnapshotSaved === true &&
      !streamingSession.currentTurnSuperseded;
    if (snapshotOwnsRetry) {
      // A successful restart snapshot owns this pending logical request now.
      // Detach before awaited feedback: even a settlement error must not let
      // the event-loop finalizer seal the channel turn the snapshot will resume.
      streamingSession.currentChannelBackend = undefined;
    }
    await abandonCapacityRetryCredential(streamingSession.currentRuntimeCredential, reason);
    if (snapshotOwnsRetry) return;
    // Once preparation created a physical attempt, the event-loop finalizer
    // owns its canonical terminal and channel projection. Do not emit twice.
    if (streamingSession.currentCrashRecoveryAttemptId || streamingSession.currentTraceTurnId) return;
    recordRuntimeTraceEvent({
      sessionKey: session.sessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      provider: runtimeProviderId,
      model: streamingSession.currentModel,
      eventType: "runtime.capacity_retry_cancelled",
      eventGroup: "runtime",
      status: "interrupted",
      source,
      payloadJson: { reason, providerDelivered: false },
    });
    if (retryPrompt?._channelBackend) {
      await projectChannelRuntimeEvent({ metadata: retryPrompt._channelBackend, event: { type: "turn.interrupted" } });
    }
    await safeEmit(`ravi.session.${sessionName}.runtime`, {
      type: "turn.interrupted",
      provider: runtimeProviderId,
      reason,
      ...(retryPrompt?._bridgeTurnId ? { _bridgeTurnId: retryPrompt._bridgeTurnId } : {}),
      _turnProvenance: classifyTurnProvenance({ prompt: retryPrompt }),
      ...(source ? { _source: source } : {}),
    });
  };
}
