import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import {
  isScheduledProviderCapacityRetry,
  PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
  PROVIDER_CAPACITY_EXHAUSTED_REASON,
  PROVIDER_CAPACITY_MAX_ELAPSED_MS,
} from "./provider-capacity-retry.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

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
  | "_cronRunId"
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
    if (prompt._cronRunId) envelope._cronRunId = prompt._cronRunId;
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
  prompt: Pick<RuntimeLaunchPrompt, "_channelBackend" | "_turnOrigin" | "_cronRunId"> | null | undefined,
): boolean {
  return prompt?._channelBackend !== undefined || prompt?._turnOrigin !== undefined || prompt?._cronRunId !== undefined;
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
  // An unfinished request must finish on its bound chat before another surface
  // enters the shared transcript. Switching turns early lets the provider answer
  // the old request under the next chat's reply target. Keep FIFO at this boundary;
  // later same-surface input must not jump past a different queued surface.
  if (!isSameRuntimeTurnSurface(activeSource, nextSource)) return null;
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
  const prioritized = prioritizeHumanRuntimeMessages(eligible);
  const firstEligible = prioritized[0];
  if (!firstEligible) return null;
  const compatibilityKey = channelSteeringCompatibilityKey(firstEligible);
  const cohort = [firstEligible];
  if (compatibilityKey) {
    for (const candidate of prioritized.slice(1)) {
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
  const releasable = session.pendingMessages.filter((message) =>
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
  const deliverable = prioritizeHumanRuntimeMessages(releasable);
  const reports = getCompatibleProgressReports(deliverable);
  if (reports.length > 1) return reports;
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
  // Known capacity retries retain their input cohort for the same reason,
  // while still receiving a fresh physical delivery id below.
  const retainsAttemptInput = (message: RuntimeUserMessage) =>
    message.replay === true || message.providerCapacityRetry !== undefined;
  const firstIsReplay = envelopeBounded[0] !== undefined && retainsAttemptInput(envelopeBounded[0]);
  let replayBounded: RuntimeUserMessage[];
  if (!firstIsReplay) {
    const firstReplayIndex = envelopeBounded.findIndex(retainsAttemptInput);
    replayBounded = firstReplayIndex < 0 ? envelopeBounded : envelopeBounded.slice(0, firstReplayIndex);
  } else {
    const firstReplayId = envelopeBounded[0]?.clientMessageId;
    const nextAttemptIndex = envelopeBounded.findIndex(
      (message) =>
        !retainsAttemptInput(message) || (firstReplayId !== undefined && message.clientMessageId !== firstReplayId),
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
 * Choose work before bounding its envelope. Only known background atoms may
 * be bypassed: unknown senders retain FIFO, and replay/capacity cohorts retain
 * their current logical turn. This never changes a message's authority or lane.
 */
function prioritizeHumanRuntimeMessages(messages: RuntimeUserMessage[]): RuntimeUserMessage[] {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.replay || message.providerCapacityRetry !== undefined || message.yieldedRequest) break;
    const provenance = classifyTurnProvenance({ prompt: message.launchPrompt });
    if (provenance.origin === "human") {
      // Leave the real pending queue intact: terminal accounting removes only
      // the ids actually yielded, even when the selected atom was not first.
      return index === 0 ? messages : messages.slice(index);
    }
    if (!provenance.background) break;
  }
  return messages;
}

const MAX_PROGRESS_BATCH_MESSAGES = 16;
const MAX_PROGRESS_BATCH_BYTES = 32 * 1024;

function progressReportEnvelope(message: RuntimeUserMessage): object | null {
  const prompt = message.launchPrompt;
  const lifecycle = prompt?._slackThreadLifecycle;
  const origin = resolveRuntimeTurnOrigin(prompt?._turnOrigin);
  const retainsAttemptInput = message.replay === true || message.providerCapacityRetry !== undefined;
  if (
    !prompt ||
    lifecycle?.eventType !== "thread.report" ||
    !lifecycle.requestId ||
    !lifecycle.childSessionKey ||
    !lifecycle.parentSessionKey ||
    origin?.producer !== "channel" ||
    origin.action !== "session.return" ||
    (retainsAttemptInput ? !message.clientMessageId : Boolean(message.clientMessageId)) ||
    message.yieldedRequest ||
    message.taskBarrierTaskId ||
    prompt._channelBackend ||
    prompt._bridgeTurnId ||
    prompt._decisionDeliveryId ||
    prompt._taskAssignmentId ||
    prompt._observation ||
    prompt._cron ||
    prompt._trigger ||
    prompt._heartbeat ||
    prompt._sessionFollowup ||
    (message.commands?.length ?? 0) > 0 ||
    (prompt.commands?.length ?? 0) > 0
  )
    return null;

  // Ignore only presentation text and the unique report id. Everything else,
  // including callerContextId, actor, target, approval route, model and thread,
  // must be identical. Different delegations never borrow each other's grants.
  const { prompt: _text, _runtimePrompt, _slackThreadLifecycle, ...envelope } = prompt;
  const { eventId: _eventId, ...thread } = lifecycle;
  return {
    envelope,
    thread,
    barrier: message.deliveryBarrier,
    taskBarrierTaskId: message.taskBarrierTaskId,
    // Recovery and capacity retries retain exactly the already handed-off
    // cohort, never a new report arriving under the same authority afterward.
    attemptDeliveryId: retainsAttemptInput ? message.clientMessageId : null,
    capacityRetry: message.providerCapacityRetry ?? null,
  };
}

function getCompatibleProgressReports(messages: RuntimeUserMessage[]): RuntimeUserMessage[] {
  const first = messages[0];
  if (!first) return [];
  const envelope = progressReportEnvelope(first);
  if (!envelope) return [];
  const batch = [first];
  let bytes = Buffer.byteLength(first.message.content);
  for (const message of messages.slice(1, MAX_PROGRESS_BATCH_MESSAGES)) {
    const next = progressReportEnvelope(message);
    bytes += Buffer.byteLength(message.message.content) + 2;
    if (!next || bytes > MAX_PROGRESS_BATCH_BYTES || !isDeepStrictEqual(envelope, next)) break;
    batch.push(message);
  }
  // Originals stay queued until the terminal acknowledgement. No latest-wins
  // overwrite, semantic summary or event-id substitution can lose a blocker.
  return batch;
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
  capacityRetryRuntime?: {
    now?: () => number;
    wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  };
  onCapacityRetryExhausted?: (input: {
    deliverableMessages: RuntimeUserMessage[];
    reason: typeof PROVIDER_CAPACITY_EXHAUSTED_REASON;
    error: string;
  }) => void | Promise<void>;
  onCapacityRetryCancelled?: (input: { deliverableMessages: RuntimeUserMessage[] }) => void | Promise<void>;
  beforeTurnStart?: (input: { deliverableMessages: RuntimeUserMessage[]; combinedPrompt: string }) => void;
  /** Release the host-owned authority when the physical turn settles or cannot start. */
  afterTurnEnd?: () => void;
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

function restoredCapacityRetryCancelled(session: RuntimeHostStreamingSession): boolean {
  return (
    session.done ||
    session.abortController.signal.aborted ||
    session.pendingAbort ||
    session.currentTurnSuperseded === true ||
    Boolean(session.internalAbortReason)
  );
}

/** Only a persisted, explicitly scheduled retry carries an absolute dispatch floor. */
async function waitForRestoredCapacityRetry(
  session: RuntimeHostStreamingSession,
  messages: RuntimeUserMessage[],
  runtime?: RuntimeMessageGeneratorOptions["capacityRetryRuntime"],
): Promise<"ready" | "cancelled" | "exhausted"> {
  const states = messages.map((message) => message.providerCapacityRetry);
  if (!states.some((state) => state?.notBefore !== undefined)) return "ready";
  if (!states.every(isScheduledProviderCapacityRetry)) return "exhausted";
  const notBefore = Math.max(...states.map((state) => state.notBefore));
  const deadline = Math.min(...states.map((state) => state.startedAt + PROVIDER_CAPACITY_MAX_ELAPSED_MS));
  const now = runtime?.now ?? Date.now;
  if (restoredCapacityRetryCancelled(session)) return "cancelled";
  if (now() >= deadline || notBefore >= deadline) return "exhausted";
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  session.abortController.signal.addEventListener("abort", onAbort, { once: true });
  const poll = setInterval(() => {
    if (restoredCapacityRetryCancelled(session)) controller.abort();
  }, 25);
  try {
    while (now() < notBefore) {
      if (restoredCapacityRetryCancelled(session)) return "cancelled";
      const delayMs = notBefore - now();
      if (runtime?.wait) {
        await runtime.wait(delayMs, controller.signal);
      } else {
        await new Promise<void>((resolve, reject) => {
          const onCancel = () => {
            clearTimeout(timer);
            reject(new Error("Restored capacity retry cancelled"));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onCancel);
            resolve();
          }, delayMs);
          controller.signal.addEventListener("abort", onCancel, { once: true });
        });
      }
    }
    if (restoredCapacityRetryCancelled(session)) return "cancelled";
    return now() >= deadline ? "exhausted" : "ready";
  } catch (error) {
    if (controller.signal.aborted) return "cancelled";
    throw error;
  } finally {
    clearInterval(poll);
    session.abortController.signal.removeEventListener("abort", onAbort);
  }
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

/**
 * Select the queue that survives a physical turn. The host uses this same
 * selection after its replay-safety filtering to decide whether a logical
 * request really continues; this helper does not grant replay permission.
 * Interrupted supersession consults the live current-turn IDs, while normal
 * completion removes only the IDs captured by that generator handoff.
 */
export function getRuntimeMessagesAfterTurn(
  session: RuntimeHostStreamingSession,
  yieldedIds: ReadonlySet<string>,
): RuntimeUserMessage[] {
  if (session.interrupted) return getReplayablePendingRuntimeMessages(session);
  return session.pendingMessages.filter((message) => !message.pendingId || !yieldedIds.has(message.pendingId));
}

export async function* createRuntimeMessageGenerator({
  sessionName,
  session,
  stashedMessages,
  capacityRetryRuntime,
  onCapacityRetryExhausted,
  onCapacityRetryCancelled,
  beforeTurnStart,
  afterTurnEnd,
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
    const restoredRetry = deliverable.some((message) => message.providerCapacityRetry?.notBefore !== undefined);
    if (restoredRetry) {
      // A restored wait still belongs to a logical request. Expose its exact
      // cohort so the dispatcher can supersede it, while keeping the old
      // physical attempt consumed and detached until a fresh handoff begins.
      session.currentCrashRecoveryTerminal = undefined;
      session.currentCrashRecoveryAttemptId = undefined;
      session.pendingCapacityRetry = undefined;
      session.currentTraceTurnId = undefined;
      session.currentTraceTurnStartedAt = undefined;
      session.currentTraceUserPromptSha256 = undefined;
      session.currentTraceSystemPromptSha256 = undefined;
      session.currentTraceRequestBlobSha256 = undefined;
      session.currentTraceTurnTerminalRecorded = false;
      session.currentTraceStatusRecorded = undefined;
      session.currentTurnPendingIds = [...yieldedIds];
      session.currentTurnSuperseded = false;
      session.currentTurnYieldContinuationId = undefined;
      session.currentTurnToolStarted = false;
      session.currentTurnInputMutated = false;
      session.durableTurnPreparationFailed = false;
      session.turnActive = true;
      session.interrupted = false;
      session.onTurnComplete = null;
      session.lastActivity = Date.now();
      const prompt = deliverable.at(-1)?.launchPrompt;
      session.currentSource = prompt?.source ? { ...prompt.source } : undefined;
      session.currentTurnAuthority = pickRuntimeTurnAuthorityEnvelope(prompt);
      session.currentChannelBackend = prompt?._channelBackend;
      if (session.idleSessionEvictionTimer) {
        clearTimeout(session.idleSessionEvictionTimer);
        session.idleSessionEvictionTimer = undefined;
      }
      if (session.idleGapRecoveryTimer) {
        clearTimeout(session.idleGapRecoveryTimer);
        session.idleGapRecoveryTimer = undefined;
      }
    }
    const discardRetryCohort = () => {
      session.pendingMessages = session.pendingMessages.filter((message) => !deliverable.includes(message));
      session.pendingCapacityRetry = undefined;
    };
    const reportCapacityRetryExhausted = async () => {
      discardRetryCohort();
      if (!onCapacityRetryExhausted) throw new Error(PROVIDER_CAPACITY_EXHAUSTED_MESSAGE);
      await onCapacityRetryExhausted({
        deliverableMessages: deliverable.map((message) => ({ ...message })),
        reason: PROVIDER_CAPACITY_EXHAUSTED_REASON,
        error: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
      });
    };
    const reportCapacityRetryCancelled = async () => {
      discardRetryCohort();
      await onCapacityRetryCancelled?.({
        deliverableMessages: deliverable.map((message) => ({ ...message })),
      });
    };
    const retryGate = restoredRetry
      ? await waitForRestoredCapacityRetry(session, deliverable, capacityRetryRuntime)
      : "ready";
    if (retryGate === "exhausted") {
      session.turnActive = false;
      session.currentTurnPendingIds = undefined;
      session.onTurnComplete = null;
      await reportCapacityRetryExhausted();
      continue;
    }
    if (retryGate === "cancelled") {
      session.turnActive = false;
      session.currentTurnPendingIds = undefined;
      session.onTurnComplete = null;
      await reportCapacityRetryCancelled();
      if (!session.currentTurnSuperseded) return;
      session.currentTurnSuperseded = false;
      session.interrupted = false;
      continue;
    }
    // Retain the previous physical turn's terminal latch across its queue drain
    // and the following idle gap. A restart snapshot must keep treating that
    // delivery as consumed until this next handoff actually begins.
    session.currentCrashRecoveryTerminal = undefined;
    const replay =
      !restoredRetry && deliverable.every((message) => message.replay === true && Boolean(message.clientMessageId));
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
      bypassed: session.pendingMessages.indexOf(deliverable[0]!),
      pendingIds: [...yieldedIds],
    });

    let turnEnded = false;
    const endTurn = () => {
      if (turnEnded) return;
      turnEnded = true;
      afterTurnEnd?.();
    };
    const turnCompleted = new Promise<void>((resolve) => {
      session.onTurnComplete = () => {
        endTurn();
        resolve();
      };
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
      endTurn();
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

    try {
      // Preparing a turn can itself await I/O. It must not extend the budget or
      // turn a cancellation during preparation into a provider delivery.
      const liveCapacityRetryExpired = deliverable.some(
        (message) =>
          message.providerCapacityRetry !== undefined &&
          (capacityRetryRuntime?.now?.() ?? Date.now()) - message.providerCapacityRetry.startedAt >=
            PROVIDER_CAPACITY_MAX_ELAPSED_MS,
      );
      if (restoredRetry || liveCapacityRetryExpired) {
        const finalGate = restoredRetry
          ? await waitForRestoredCapacityRetry(session, deliverable, capacityRetryRuntime)
          : "exhausted";
        if (finalGate !== "ready") {
          settlePromptTransform(sessionName, promptTransform, "release", `capacity retry ${finalGate}`);
          if (finalGate === "cancelled") {
            await reportCapacityRetryCancelled();
            // The event-loop finalizer still owns any attempt prepared above.
            // Do not replace its binding with a successor before terminalization.
            return;
          }
          await reportCapacityRetryExhausted();
          session.turnActive = false;
          session.currentTurnPendingIds = undefined;
          session.onTurnComplete = null;
          session.currentTurnSuperseded = false;
          continue;
        }
        for (const message of deliverable) {
          if (message.providerCapacityRetry) {
            const { startedAt, retries } = message.providerCapacityRetry;
            message.providerCapacityRetry = { startedAt, retries };
          }
          message.replay = false;
        }
      }
      session.pendingCapacityRetry = undefined;
      session.capacityRetrySnapshotSaved = false;
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
    } finally {
      endTurn();
    }

    const pendingAfterTurn = getRuntimeMessagesAfterTurn(session, yieldedIds);
    if (session.interrupted && session.currentTurnSuperseded) {
      const queuedBefore = session.pendingMessages.length;
      session.pendingMessages = pendingAfterTurn;
      log.info("Generator: superseded turn interrupted, releasing successor", {
        sessionName,
        cleared: queuedBefore - session.pendingMessages.length,
        remaining: session.pendingMessages.length,
      });
      session.interrupted = false;
    } else if (session.interrupted) {
      session.pendingMessages = pendingAfterTurn;
      log.info("Generator: provider interrupted unexpectedly, keeping queue for replay", {
        sessionName,
        count: session.pendingMessages.length,
      });
      session.interrupted = false;
    } else {
      session.pendingMessages = pendingAfterTurn;
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
