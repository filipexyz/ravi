import { randomUUID } from "node:crypto";
import { DEFAULT_DELIVERY_BARRIER, type DeliveryBarrier } from "../delivery-barriers.js";
import type { RuntimeTraceTurnStartResult } from "../session-trace/runtime-trace.js";
import { dbHasActiveTaskForSession } from "../tasks/task-db.js";
import { logger } from "../utils/logger.js";
import {
  getReplayablePendingRuntimeMessages,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { MessageActorMetadata, RaviCommandPromptMetadata, RuntimeLaunchPrompt } from "./message-types.js";
import { combineSessionSurfacePromptContents, resolveRuntimePromptText } from "./session-surface-hint.js";
import type { RuntimePromptMessage } from "./types.js";
import { isSameRuntimeTurnSurface, runtimeTurnSurfaceKey } from "./turn-surface.js";

const log = logger.child("runtime:delivery-queue");

export interface RuntimePromptDeliveryMessage extends Partial<Omit<RuntimeLaunchPrompt, "prompt">> {
  prompt: string;
  deliveryBarrier?: DeliveryBarrier;
  taskBarrierTaskId?: string;
  commands?: RaviCommandPromptMetadata[];
}

export function getRuntimePromptDeliveryBarrier(prompt: RuntimePromptDeliveryMessage): DeliveryBarrier {
  return prompt.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;
}

export function createQueuedRuntimeUserMessage(prompt: RuntimePromptDeliveryMessage): RuntimeUserMessage {
  return {
    type: "user",
    message: { role: "user", content: resolveRuntimePromptText(prompt) },
    session_id: "",
    parent_tool_use_id: null,
    deliveryBarrier: getRuntimePromptDeliveryBarrier(prompt),
    deliveryBarrierSource: prompt.deliveryBarrierSource,
    taskBarrierTaskId: prompt.taskBarrierTaskId,
    commands: prompt.commands,
    launchPrompt: cloneRuntimeLaunchPrompt(prompt),
    pendingId: Math.random().toString(36).slice(2, 10),
    queuedAt: Date.now(),
  };
}

export function hasIsolatedRuntimeTurnEnvelope(
  prompt: Pick<RuntimeLaunchPrompt, "_channelBackend" | "_turnOrigin"> | null | undefined,
): boolean {
  return prompt?._channelBackend !== undefined || prompt?._turnOrigin !== undefined;
}

export interface RuntimeInterruptSuccessorPreparation {
  message: RuntimeUserMessage;
  coalescedMessages: RuntimeUserMessage[];
}

/**
 * Prepare the first releasable successor for an intentional interrupt.
 * Compatible human channel prompts at the front of that lane are folded into
 * one input in their original order so they are neither lost nor replayed
 * later as stale work.
 */
export function prepareRuntimeInterruptSuccessor(
  sessionName: string,
  session: RuntimeHostStreamingSession,
): RuntimeInterruptSuccessorPreparation | null {
  const activePendingIds = new Set(session.currentTurnPendingIds ?? []);
  if (activePendingIds.size === 0) return null;

  const successors = session.pendingMessages.filter(
    (message) => !message.pendingId || !activePendingIds.has(message.pendingId),
  );
  const activeSource =
    session.currentSource ??
    session.pendingMessages.find(
      (message) => message.pendingId !== undefined && activePendingIds.has(message.pendingId),
    )?.launchPrompt?.source;
  const nextSurfaceIndex = successors.findIndex(
    (message) => !isSameRuntimeTurnSurface(activeSource, message.launchPrompt?.source),
  );
  const sameSurfaceSuccessors = nextSurfaceIndex < 0 ? successors : successors.slice(0, nextSurfaceIndex);
  const eligible = sameSurfaceSuccessors.filter(
    (message) =>
      shouldInterruptRuntimeForIncoming(
        sessionName,
        session,
        message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER,
        message.taskBarrierTaskId,
      ).interrupt,
  );
  if (eligible.length === 0) return null;

  // Preserve FIFO across different actors and authority envelopes. A burst of
  // compatible channel messages at the front of the releasable lane can share
  // one physical provider turn, with the newest envelope owning that turn.
  const firstEligible = eligible[0];
  if (!firstEligible) return null;
  const compatibilityKey = channelSteeringCompatibilityKey(firstEligible);
  const cohort = [firstEligible];
  if (compatibilityKey) {
    for (const candidate of eligible.slice(1)) {
      if (channelSteeringCompatibilityKey(candidate) !== compatibilityKey) break;
      cohort.push(candidate);
    }
  }

  const interrupting = cohort[cohort.length - 1];
  if (!interrupting?.pendingId) return null;

  const merged = mergeRuntimeSteeringCohort(cohort, interrupting);
  const cohortSet = new Set(cohort);
  const active = session.pendingMessages.filter(
    (message) => message.pendingId !== undefined && activePendingIds.has(message.pendingId),
  );
  const remaining = session.pendingMessages.filter(
    (message) => !cohortSet.has(message) && (!message.pendingId || !activePendingIds.has(message.pendingId)),
  );
  session.pendingMessages = [...active, merged, ...remaining];

  return {
    message: merged,
    coalescedMessages: cohort.filter((message) => message !== interrupting),
  };
}

function cloneRuntimeLaunchPrompt(prompt: RuntimePromptDeliveryMessage): RuntimeLaunchPrompt {
  return {
    ...prompt,
    source: prompt.source ? { ...prompt.source } : undefined,
    context: prompt.context ? { ...prompt.context } : undefined,
    _approvalSource: prompt._approvalSource ? { ...prompt._approvalSource } : undefined,
    commands: prompt.commands ? prompt.commands.map((command) => ({ ...command })) : undefined,
  };
}

function mergeRuntimeSteeringCohort(
  cohort: RuntimeUserMessage[],
  interrupting: RuntimeUserMessage,
): RuntimeUserMessage {
  if (cohort.length <= 1) return interrupting;

  const content = cohort.map((message) => message.message.content).join("\n\n");
  return {
    ...interrupting,
    message: {
      ...interrupting.message,
      content,
    },
    launchPrompt: interrupting.launchPrompt
      ? {
          ...interrupting.launchPrompt,
          prompt: content,
        }
      : undefined,
  };
}

function steeringActorIdentity(metadata: MessageActorMetadata) {
  return {
    actorType: metadata.actorType ?? "",
    contactId: metadata.contactId ?? "",
    actorAgentId: metadata.actorAgentId ?? "",
    automationId: metadata.automationId ?? "",
    platformIdentityId: metadata.platformIdentityId ?? "",
    normalizedSenderId: metadata.normalizedSenderId ?? "",
    rawSenderId: metadata.rawSenderId ?? "",
  };
}

function channelSteeringCompatibilityKey(message: RuntimeUserMessage): string | null {
  const prompt = message.launchPrompt;
  const backend = prompt?._channelBackend;
  const source = prompt?.source;
  const context = prompt?.context;
  const barrier = message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;
  if (
    !backend ||
    !source ||
    !context ||
    prompt._turnOrigin ||
    message.replay === true ||
    message.clientMessageId ||
    (message.commands?.length ?? 0) > 0 ||
    (prompt.commands?.length ?? 0) > 0 ||
    context.isEditedMessage === true ||
    context.editedMessageId ||
    context.editEventId ||
    (barrier !== "after_tool" && barrier !== "immediate_interrupt") ||
    message.taskBarrierTaskId ||
    prompt._observation ||
    prompt._heartbeat ||
    prompt._cron ||
    prompt._trigger ||
    prompt._sessionFollowup ||
    prompt._thread ||
    prompt._resumeStashedMessages ||
    prompt._daemonRestartResume
  ) {
    return null;
  }

  const sourceActor = steeringActorIdentity(source);
  const contextActor = steeringActorIdentity(context);
  if (sourceActor.actorType && contextActor.actorType && sourceActor.actorType !== contextActor.actorType) return null;
  const actorType = sourceActor.actorType || contextActor.actorType || "unknown";
  if (actorType !== "contact" && actorType !== "unknown") return null;
  const principal =
    sourceActor.contactId ||
    contextActor.contactId ||
    sourceActor.platformIdentityId ||
    contextActor.platformIdentityId ||
    sourceActor.normalizedSenderId ||
    contextActor.normalizedSenderId ||
    sourceActor.rawSenderId ||
    contextActor.rawSenderId ||
    context.senderId;
  if (!principal) return null;

  return JSON.stringify({
    barrier,
    agentId: prompt._agentId ?? backend.binding.agentId,
    runtimeProviderId: prompt._runtimeProviderId ?? "",
    runtimeModel: prompt._runtimeModel ?? "",
    backend: {
      protocol: backend.protocol,
      schemaVersion: backend.schemaVersion,
      channelInstanceId: backend.binding.channelInstanceId,
      agentId: backend.binding.agentId,
      chatId: backend.binding.chatId,
      sessionId: backend.binding.sessionId,
      target: backend.target,
    },
    source: {
      channel: source.channel,
      accountId: source.accountId,
      instanceId: source.instanceId ?? "",
      chatId: source.chatId,
      threadId: source.threadId ?? "",
      canonicalChatId: source.canonicalChatId ?? "",
      statusAnchorKind: source.statusAnchorKind ?? "",
      suppressPresence: source.suppressPresence ?? false,
      actor: sourceActor,
    },
    context: {
      channelId: context.channelId,
      accountId: context.accountId,
      instanceId: context.instanceId ?? "",
      chatId: context.chatId,
      canonicalChatId: context.canonicalChatId ?? "",
      senderId: context.senderId,
      isGroup: context.isGroup,
      groupId: context.groupId ?? "",
      actor: contextActor,
    },
    principal,
    approvalSource: prompt._approvalSource
      ? {
          channel: prompt._approvalSource.channel,
          accountId: prompt._approvalSource.accountId,
          instanceId: prompt._approvalSource.instanceId ?? "",
          chatId: prompt._approvalSource.chatId,
          threadId: prompt._approvalSource.threadId ?? "",
          actor: steeringActorIdentity(prompt._approvalSource),
        }
      : null,
  });
}

function isGeneratingText(session: RuntimeHostStreamingSession): boolean {
  return !session.done && session.turnActive && !session.compacting && !session.toolRunning;
}

export function canReleaseRuntimeDeliveryBarrier(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  barrier: DeliveryBarrier,
  taskBarrierTaskId?: string,
  hasActiveTask = dbHasActiveTaskForSession(sessionName, taskBarrierTaskId),
): boolean {
  if (session.toolResultDeliveryPending) return false;

  switch (barrier) {
    case "immediate_interrupt":
      if (session.starting || session.compacting) return false;
      if (session.toolRunning && session.currentToolSafety === "unsafe") return false;
      return true;
    case "after_tool":
      return !session.starting && !session.compacting && !session.toolRunning;
    case "after_response":
      return !session.starting && !session.compacting && !session.toolRunning && !isGeneratingText(session);
    case "after_task":
      return (
        !hasActiveTask && !session.starting && !session.compacting && !session.toolRunning && !isGeneratingText(session)
      );
  }
}

export function getDeliverableRuntimeMessages(
  sessionName: string,
  session: RuntimeHostStreamingSession,
): RuntimeUserMessage[] {
  if (session.pendingMessages.length === 0) {
    return [];
  }

  const activeTaskByExemption = new Map<string, boolean>();
  const deliverable = session.pendingMessages.filter((message) =>
    canReleaseRuntimeDeliveryBarrier(
      sessionName,
      session,
      message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER,
      message.taskBarrierTaskId,
      (() => {
        const key = message.taskBarrierTaskId ?? "__default__";
        if (!activeTaskByExemption.has(key)) {
          activeTaskByExemption.set(key, dbHasActiveTaskForSession(sessionName, message.taskBarrierTaskId));
        }
        return activeTaskByExemption.get(key) ?? false;
      })(),
    ),
  );
  // These envelopes bind authority to one logical turn. Never let adjacent
  // messages borrow their channel binding or validated internal origin.
  const firstIsolatedTurnIndex = deliverable.findIndex((message) =>
    hasIsolatedRuntimeTurnEnvelope(message.launchPrompt),
  );
  const envelopeBounded =
    firstIsolatedTurnIndex === 0
      ? deliverable.slice(0, 1)
      : firstIsolatedTurnIndex > 0
        ? deliverable.slice(0, firstIsolatedTurnIndex)
        : deliverable;

  if (envelopeBounded.length <= 1) return envelopeBounded;

  // An ambiguously stashed turn keeps its original delivery identity. Messages
  // that arrived later must wait for that turn to reconcile instead of being
  // folded into a different prompt and accidentally acknowledged with it.
  const firstIsReplay = envelopeBounded[0]?.replay === true;
  let replayBounded: RuntimeUserMessage[];
  if (!firstIsReplay) {
    const firstReplayIndex = envelopeBounded.findIndex((message) => message.replay === true);
    replayBounded = firstReplayIndex < 0 ? envelopeBounded : envelopeBounded.slice(0, firstReplayIndex);
  } else {
    const firstReplayId = envelopeBounded[0]?.clientMessageId;
    const nextAttemptIndex = envelopeBounded.findIndex(
      (message) =>
        message.replay !== true || (firstReplayId !== undefined && message.clientMessageId !== firstReplayId),
    );
    replayBounded = nextAttemptIndex < 0 ? envelopeBounded : envelopeBounded.slice(0, nextAttemptIndex);
  }

  // One physical provider turn has one immutable reply surface. Adjacent
  // messages from another chat or thread wait for the following turn.
  const firstSurface = runtimeTurnSurfaceKey(replayBounded[0]?.launchPrompt?.source);
  const nextSurfaceIndex = replayBounded.findIndex(
    (message, index) => index > 0 && runtimeTurnSurfaceKey(message.launchPrompt?.source) !== firstSurface,
  );
  return nextSurfaceIndex < 0 ? replayBounded : replayBounded.slice(0, nextSurfaceIndex);
}

export function hasDeliverableRuntimeMessages(sessionName: string, session: RuntimeHostStreamingSession): boolean {
  return getDeliverableRuntimeMessages(sessionName, session).length > 0;
}

export function shouldInterruptRuntimeForIncoming(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  barrier: DeliveryBarrier,
  taskBarrierTaskId?: string,
): { interrupt: boolean; reason: string } {
  if (session.pushMessage) {
    return { interrupt: false, reason: "waiting" };
  }
  if (session.starting) {
    return { interrupt: false, reason: "starting" };
  }
  if (session.compacting) {
    return { interrupt: false, reason: "compacting" };
  }
  if (!session.turnActive) {
    return { interrupt: false, reason: "idle_gap" };
  }
  if (barrier === "after_task" && dbHasActiveTaskForSession(sessionName, taskBarrierTaskId)) {
    return { interrupt: false, reason: "active_task" };
  }
  if (session.toolResultDeliveryPending) {
    return { interrupt: false, reason: "tool_result_delivery" };
  }
  if (session.toolRunning) {
    if (barrier !== "immediate_interrupt") {
      return { interrupt: false, reason: "tool" };
    }
    if (session.currentToolSafety === "unsafe") {
      return { interrupt: false, reason: "unsafe_tool" };
    }
    return { interrupt: true, reason: "safe_tool" };
  }
  if (barrier === "after_response" || barrier === "after_task") {
    return { interrupt: false, reason: "response" };
  }
  return { interrupt: true, reason: "response" };
}

export function wakeRuntimeSessionIfDeliverable(
  sessionName: string,
  streamingSessions: Map<string, RuntimeHostStreamingSession>,
): void {
  const session = streamingSessions.get(sessionName);
  if (!session || !session.pushMessage) {
    if (session) {
      session.pendingWake = true;
    }
    return;
  }
  if (!hasDeliverableRuntimeMessages(sessionName, session)) {
    return;
  }
  const resolver = session.pushMessage;
  session.pushMessage = null;
  session.pendingWake = false;
  resolver(null);
}

export interface RuntimeMessageGeneratorOptions {
  sessionName: string;
  session: RuntimeHostStreamingSession;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  beforeTurnStart?: (input: { deliverableMessages: RuntimeUserMessage[]; combinedPrompt: string }) => void;
  traceTurnStart?: (input: {
    combinedPrompt: string;
    deliverableMessages: RuntimeUserMessage[];
  }) =>
    | Promise<(RuntimeTraceTurnStartResult & { crashRecoveryAttemptId?: string }) | null | undefined>
    | (RuntimeTraceTurnStartResult & { crashRecoveryAttemptId?: string })
    | null
    | undefined;
}

export async function* createRuntimeMessageGenerator({
  sessionName,
  session,
  stashedMessages,
  beforeTurnStart,
  traceTurnStart,
}: RuntimeMessageGeneratorOptions): AsyncGenerator<RuntimePromptMessage> {
  const stashed = stashedMessages.get(sessionName);
  if (stashed && stashed.length > 0) {
    log.info("Re-injecting stashed messages", { sessionName, count: stashed.length });
    for (const message of [...stashed].reverse()) {
      session.pendingMessages.unshift({ ...message });
    }
    stashedMessages.delete(sessionName);
  }

  while (!session.done) {
    const deliverable = getDeliverableRuntimeMessages(sessionName, session);

    if (deliverable.length === 0) {
      if (session.pendingWake) {
        session.pendingWake = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        session.pushMessage = () => {
          session.pendingWake = false;
          resolve();
        };
      });
      if (session.pendingMessages.length === 0 && session.done) break;
      continue;
    }

    const yieldedIds = new Set(
      deliverable.map((message) => message.pendingId).filter((pendingId): pendingId is string => Boolean(pendingId)),
    );
    // Retain the previous physical turn's terminal latch across its queue drain
    // and the following idle gap. A restart snapshot must keep treating that
    // delivery as consumed until this next handoff actually begins.
    session.currentCrashRecoveryTerminal = undefined;
    const replay = deliverable.every((message) => message.replay === true && Boolean(message.clientMessageId));
    const clientMessageId = replay
      ? (deliverable[0]?.clientMessageId ?? `ravi:${randomUUID()}`)
      : `ravi:${randomUUID()}`;
    const terminalReplayAllowed = deliverable.every((message) => message.terminalReplayAllowed !== false);
    for (const message of deliverable) {
      message.clientMessageId = clientMessageId;
    }
    session.currentTurnPendingIds = [...yieldedIds];
    session.currentTurnSuperseded = false;
    const combined = combineSessionSurfacePromptContents(deliverable.map((message) => message.message.content));
    log.info("Generator: yielding", {
      sessionName,
      count: deliverable.length,
      queued: session.pendingMessages.length,
    });

    const turnCompleted = new Promise<void>((resolve) => {
      session.onTurnComplete = resolve;
    });
    session.turnActive = true;
    session.currentTurnToolStarted = false;
    session.currentTurnInputMutated = false;
    session.durableTurnPreparationFailed = false;
    if (session.idleSessionEvictionTimer) {
      clearTimeout(session.idleSessionEvictionTimer);
      session.idleSessionEvictionTimer = undefined;
    }
    if (session.idleGapRecoveryTimer) {
      clearTimeout(session.idleGapRecoveryTimer);
      session.idleGapRecoveryTimer = undefined;
    }
    session.lastActivity = Date.now();
    session.currentTraceTurnTerminalRecorded = false;

    try {
      beforeTurnStart?.({
        combinedPrompt: combined,
        deliverableMessages: deliverable.map((message) => ({ ...message })),
      });

      if (traceTurnStart) {
        const traceTurn = await traceTurnStart({
          combinedPrompt: combined,
          deliverableMessages: deliverable.map((message) => ({ ...message })),
        });
        if (traceTurn) {
          session.currentTraceTurnId = traceTurn.turnId;
          session.currentTraceTurnStartedAt = traceTurn.startedAt;
          session.currentTraceUserPromptSha256 = traceTurn.userPromptSha256;
          session.currentTraceSystemPromptSha256 = traceTurn.systemPromptSha256;
          session.currentTraceRequestBlobSha256 = traceTurn.requestBlobSha256;
          session.currentCrashRecoveryAttemptId = traceTurn.crashRecoveryAttemptId;
        }
      }
    } catch (error) {
      session.durableTurnPreparationFailed = true;
      session.turnActive = false;
      session.currentTurnPendingIds = undefined;
      session.currentTurnSuperseded = false;
      session.currentTurnToolStarted = false;
      session.currentTurnInputMutated = false;
      session.currentTraceTurnId = undefined;
      session.currentTraceTurnStartedAt = undefined;
      session.currentTraceUserPromptSha256 = undefined;
      session.currentTraceSystemPromptSha256 = undefined;
      session.currentTraceRequestBlobSha256 = undefined;
      session.currentTraceTurnTerminalRecorded = false;
      session.currentCrashRecoveryAttemptId = undefined;
      session.onTurnComplete = null;
      log.error("Generator: failed to prepare durable turn", { sessionName, error });
      throw error;
    }

    yield {
      type: "user" as const,
      message: { role: "user" as const, content: combined },
      session_id: "",
      parent_tool_use_id: null,
      clientMessageId,
      replay,
      terminalReplayAllowed,
    };

    await turnCompleted;

    if (session.interrupted && session.currentTurnSuperseded) {
      const queuedBefore = session.pendingMessages.length;
      session.pendingMessages = getReplayablePendingRuntimeMessages(session);
      log.info("Generator: superseded turn interrupted, releasing successor", {
        sessionName,
        cleared: queuedBefore - session.pendingMessages.length,
        remaining: session.pendingMessages.length,
      });
      session.interrupted = false;
    } else if (session.interrupted) {
      log.info("Generator: provider interrupted unexpectedly, keeping queue for replay", {
        sessionName,
        count: session.pendingMessages.length,
      });
      session.interrupted = false;
    } else {
      session.pendingMessages = session.pendingMessages.filter(
        (message) => !message.pendingId || !yieldedIds.has(message.pendingId),
      );
      log.info("Generator: turn complete", {
        sessionName,
        cleared: deliverable.length,
        remaining: session.pendingMessages.length,
      });
    }
    session.currentTurnPendingIds = undefined;
    session.currentTurnSuperseded = false;
  }
}
