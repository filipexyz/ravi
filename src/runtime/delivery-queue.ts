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

/** Who a turn acts for: what turn-scoped authority is derived from, apart from `source`. */
export type RuntimeTurnAuthorityEnvelope = Pick<
  RuntimeLaunchPrompt,
  | "context"
  | "_bridgeTurnId"
  | "_approvalSource"
  | "_turnOrigin"
  | "_heartbeat"
  | "_cron"
  | "_jobId"
  | "_cronAuthority"
  | "_trigger"
  | "_triggerId"
  | "_sessionFollowup"
  | "_sessionFollowupCadenceId"
  | "_sessionFollowupRunId"
>;

/**
 * Copy the authority envelope of a turn so a host-made continuation of that
 * same turn (inactivity or context recovery) acts for the same actor. Without
 * it the continuation carries the chat surface but no actor, resolves as
 * `missing_contact` and runs with zero capabilities.
 */
export function pickRuntimeTurnAuthorityEnvelope(
  prompt: Partial<RuntimeLaunchPrompt> | null | undefined,
): RuntimeTurnAuthorityEnvelope {
  if (!prompt) return {};
  const envelope: RuntimeTurnAuthorityEnvelope = {};
  if (prompt._bridgeTurnId) envelope._bridgeTurnId = prompt._bridgeTurnId;
  if (prompt.context) envelope.context = { ...prompt.context };
  if (prompt._approvalSource) envelope._approvalSource = { ...prompt._approvalSource };
  if (prompt._turnOrigin) envelope._turnOrigin = prompt._turnOrigin;
  if (prompt._heartbeat) envelope._heartbeat = prompt._heartbeat;
  if (prompt._cron) {
    envelope._cron = prompt._cron;
    if (prompt._jobId) envelope._jobId = prompt._jobId;
    if (prompt._cronAuthority) envelope._cronAuthority = { ...prompt._cronAuthority };
  }
  if (prompt._trigger) {
    envelope._trigger = prompt._trigger;
    if (prompt._triggerId) envelope._triggerId = prompt._triggerId;
  }
  if (prompt._sessionFollowup) {
    envelope._sessionFollowup = prompt._sessionFollowup;
    if (prompt._sessionFollowupCadenceId) envelope._sessionFollowupCadenceId = prompt._sessionFollowupCadenceId;
    if (prompt._sessionFollowupRunId) envelope._sessionFollowupRunId = prompt._sessionFollowupRunId;
  }
  return envelope;
}

export function hasIsolatedRuntimeTurnEnvelope(
  prompt: Pick<RuntimeLaunchPrompt, "_channelBackend" | "_turnOrigin"> | null | undefined,
): boolean {
  return prompt?._channelBackend !== undefined || prompt?._turnOrigin !== undefined;
}

export interface RuntimeInterruptSuccessorPreparation {
  message: RuntimeUserMessage;
  coalescedMessages: RuntimeUserMessage[];
  continuation?: RuntimeUserMessage;
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
  if (session.currentTurnSuperseded || session.interrupted) return null;
  const activePendingIds = new Set(session.currentTurnPendingIds ?? []);
  if (activePendingIds.size === 0) return null;

  const successors = session.pendingMessages.filter(
    (message) => !message.pendingId || !activePendingIds.has(message.pendingId),
  );
  const activeSource =
    session.currentSource ??
    session.pendingMessages.find(
      (message) => message.pendingId !== undefined && activePendingIds.has(message.pendingId),
    )?.launchPrompt?.source ??
    (session.suppressChatEmit ? undefined : session.currentReplyTarget);
  const nextSource = successors[0]?.launchPrompt?.source;
  const yielding = !isSameRuntimeTurnSurface(activeSource, nextSource);
  // Source-less/CLI turns must not acquire a chat destination through a yield.
  if (yielding && (!activeSource || !nextSource || session.suppressChatEmit)) return null;
  const nextSurfaceIndex = successors.findIndex(
    (message) => !isSameRuntimeTurnSurface(nextSource, message.launchPrompt?.source),
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
  if (yielding && active.length === 0) return null;
  const remaining = session.pendingMessages.filter(
    (message) => !cohortSet.has(message) && (!message.pendingId || !activePendingIds.has(message.pendingId)),
  );
  const continuation = yielding ? createYieldContinuation(session, active, activeSource ?? undefined) : undefined;
  session.pendingMessages = [...active, merged, ...remaining, ...(continuation ? [continuation] : [])];

  return {
    message: merged,
    coalescedMessages: cohort.filter((message) => message !== interrupting),
    ...(continuation ? { continuation } : {}),
  };
}

function createYieldContinuation(
  session: RuntimeHostStreamingSession,
  active: RuntimeUserMessage[],
  source: RuntimeLaunchPrompt["source"],
): RuntimeUserMessage {
  const original = active[active.length - 1]?.launchPrompt;
  const request = active.map((message) => message.yieldedRequest ?? message.message.content).join("\n\n");
  const continuation = createQueuedRuntimeUserMessage({
    ...original,
    ...session.currentTurnAuthority,
    source,
    prompt: [
      "[System] Resume the unfinished request below after yielding to another chat or thread.",
      "Continue from the existing conversation and tool results. Do not repeat completed actions.",
      "If a command was interrupted, verify its outcome before retrying it.",
      "",
      request,
    ].join("\n"),
    _runtimePrompt: undefined,
    _modelBrokerTurnId: undefined,
    _resumeStashedMessages: undefined,
    _daemonRestartResume: undefined,
    commands: undefined,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "inferred",
  });
  continuation.yieldedRequest = request;
  return continuation;
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
  const firstIsolatedTurnIndex = deliverable.findIndex(
    (message) => message.yieldedRequest !== undefined || hasIsolatedRuntimeTurnEnvelope(message.launchPrompt),
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
  const surfaceBounded = nextSurfaceIndex < 0 ? replayBounded : replayBounded.slice(0, nextSurfaceIndex);

  // One physical provider turn also has one authority: the turn context is
  // built for a single actor, so a message from another sender waits for the
  // following turn instead of running under this one's identity.
  const firstActor = runtimeTurnActorKey(surfaceBounded[0]?.launchPrompt);
  if (firstActor === null) return surfaceBounded.slice(0, 1);
  const nextActorIndex = surfaceBounded.findIndex(
    (message, index) => index > 0 && runtimeTurnActorKey(message.launchPrompt) !== firstActor,
  );
  return nextActorIndex < 0 ? surfaceBounded : surfaceBounded.slice(0, nextActorIndex);
}

/**
 * The identity a turn's authority is built for. Two messages may share a
 * provider turn only when their keys are equal. An explicitly unknown sender
 * with no identifier at all (null) never shares a turn.
 */
export function runtimeTurnActorKey(
  prompt: Pick<RuntimeLaunchPrompt, "source" | "context"> | null | undefined,
): string | null {
  const source = steeringActorIdentity(prompt?.source ?? {});
  const context = steeringActorIdentity(prompt?.context ?? {});
  const actorType = source.actorType || context.actorType;
  const principal =
    source.contactId ||
    context.contactId ||
    source.actorAgentId ||
    context.actorAgentId ||
    source.automationId ||
    context.automationId ||
    source.platformIdentityId ||
    context.platformIdentityId ||
    source.normalizedSenderId ||
    context.normalizedSenderId ||
    source.rawSenderId ||
    context.rawSenderId ||
    prompt?.context?.senderId;
  if (actorType === "unknown" && !principal) return null;
  return JSON.stringify([actorType, principal]);
}

export function hasDeliverableRuntimeMessages(sessionName: string, session: RuntimeHostStreamingSession): boolean {
  return getDeliverableRuntimeMessages(sessionName, session).length > 0;
}

/**
 * A partir de quanto tempo uma tool em execução deixa de segurar a próxima mensagem.
 *
 * Antes disso, enfileirar é melhor UX: uma tool de 2s termina e a mensagem é
 * processada em seguida. Depois disso, a pessoa está esperando um comando que
 * talvez dure minutos, e a mensagem dela não pode ficar presa atrás disso.
 */
const DEFAULT_LONG_TOOL_INTERRUPT_MS = 15_000;

function resolveLongToolInterruptMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(String(env.RAVI_RUNTIME_LONG_TOOL_INTERRUPT_MS ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_LONG_TOOL_INTERRUPT_MS;
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
    // Interrupt explícito sempre vence. A restrição de tool "unsafe" saiu daqui: ela
    // existia quando abortar uma tool em execução não era possível, e desde que o
    // abort passou a matar o processo, a restrição só servia para deixar a mensagem
    // da pessoa presa atrás de um comando longo.
    if (barrier === "immediate_interrupt") {
      return { interrupt: true, reason: "explicit_interrupt" };
    }
    // Follow-ups wait for the turn to end, however long its tool runs.
    if (barrier === "after_response" || barrier === "after_task") {
      return { interrupt: false, reason: "tool" };
    }
    const toolAgeMs = typeof session.toolStartTime === "number" ? Date.now() - session.toolStartTime : 0;
    if (toolAgeMs >= resolveLongToolInterruptMs()) {
      return { interrupt: true, reason: "long_running_tool" };
    }
    return { interrupt: false, reason: "tool" };
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

/**
 * A prompt transform whose additions must be settled with the turn: `commit`
 * runs once the augmented prompt is handed to the provider, `release` when
 * the turn fails to start (signals/delivery: reserve, send, confirm).
 */
export interface RuntimeTurnPromptTransform {
  prompt: string;
  commit?: () => void;
  release?: (reason: string) => void;
}

export interface RuntimeMessageGeneratorOptions {
  sessionName: string;
  session: RuntimeHostStreamingSession;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  beforeTurnStart?: (input: { deliverableMessages: RuntimeUserMessage[]; combinedPrompt: string }) => void;
  transformTurnPrompt?: (input: {
    sessionName: string;
    deliverableMessages: RuntimeUserMessage[];
    combinedPrompt: string;
  }) => string | RuntimeTurnPromptTransform | Promise<string | RuntimeTurnPromptTransform>;
  traceTurnStart?: (input: {
    combinedPrompt: string;
    deliverableMessages: RuntimeUserMessage[];
  }) =>
    | Promise<(RuntimeTraceTurnStartResult & { crashRecoveryAttemptId?: string }) | null | undefined>
    | (RuntimeTraceTurnStartResult & { crashRecoveryAttemptId?: string })
    | null
    | undefined;
}

function settlePromptTransform(
  sessionName: string,
  transform: RuntimeTurnPromptTransform | undefined,
  outcome: "commit" | "release",
  reason = "",
): void {
  if (!transform) return;
  try {
    if (outcome === "commit") transform.commit?.();
    else transform.release?.(reason);
  } catch (error) {
    log.warn("Turn prompt transform settlement failed", { sessionName, outcome, error });
  }
}

export async function* createRuntimeMessageGenerator({
  sessionName,
  session,
  stashedMessages,
  beforeTurnStart,
  transformTurnPrompt,
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
    session.currentTurnYieldContinuationId = undefined;
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
    session.runtimeTerminalSseEmitted = false;

    let promptContent = combined;
    let promptTransform: RuntimeTurnPromptTransform | undefined;
    try {
      beforeTurnStart?.({
        combinedPrompt: combined,
        deliverableMessages: deliverable.map((message) => ({ ...message })),
      });

      if (transformTurnPrompt) {
        try {
          const transformed = await transformTurnPrompt({
            sessionName,
            deliverableMessages: deliverable.map((message) => ({ ...message })),
            combinedPrompt: combined,
          });
          if (typeof transformed === "string") {
            promptContent = transformed;
          } else {
            promptTransform = transformed;
            promptContent = transformed.prompt;
          }
        } catch (error) {
          log.warn("Turn prompt transform failed; continuing without it", { sessionName, error });
        }
      }

      if (traceTurnStart) {
        const traceTurn = await traceTurnStart({
          combinedPrompt: promptContent,
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
      settlePromptTransform(sessionName, promptTransform, "release", "turn preparation failed");
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

    settlePromptTransform(sessionName, promptTransform, "commit");
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: promptContent },
      session_id: "",
      parent_tool_use_id: null,
      clientMessageId,
      replay,
      terminalReplayAllowed,
      runtimeOptions: {
        model: session.currentModel,
        effort: session.currentEffort,
        thinking: session.currentThinking,
      },
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
    session.currentTurnYieldContinuationId = undefined;
  }
}
