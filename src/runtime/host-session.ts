import type { DeliveryBarrier, DeliveryBarrierSource } from "../delivery-barriers.js";
import type { SessionEntry } from "../router/index.js";
import type { TurnProvenance } from "./turn-provenance.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import type { RuntimeTurnAttemptTerminalStatus } from "./crash-recovery-store.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type {
  ChannelBackendPromptMetadata,
  MessageActorMetadata,
  RaviCommandPromptMetadata,
  RuntimeLaunchPrompt,
} from "./message-types.js";
import type {
  RuntimeEventMetadata,
  RuntimeEffort,
  RuntimePromptMessage,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeThinking,
  RuntimeToolPermissionMode,
} from "./types.js";

export type RuntimeToolEffectFence = "host_write_ahead" | "provider_event_only";

/**
 * A Ravi-host permission callback is the only current provider contract that
 * runs before a tool may execute. Provider-native/unrestricted adapters report
 * tool activity asynchronously, so absence of `tool.started` is not evidence
 * that no effect happened.
 */
export function resolveRuntimeToolEffectFence(
  provider: RuntimeProviderId,
  permissionMode: RuntimeToolPermissionMode,
): RuntimeToolEffectFence {
  // Codex currently advertises ravi-host permissions, but normal threads run
  // with approvalPolicy=never and its provider hook has no durable attempt ACK.
  // Pi likewise reports tool start only after its in-process loop may execute.
  if (provider === "codex" || provider === "pi") {
    return "provider_event_only";
  }
  return permissionMode === "ravi-host" ? "host_write_ahead" : "provider_event_only";
}

export interface RuntimeMessageTarget extends MessageActorMetadata {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  /** Thread/topic ID for platforms that support it (Telegram topics, Slack threads, Discord threads) */
  threadId?: string;
  /** Original inbound channel message ID, used for session trace correlation. */
  sourceMessageId?: string;
  /**
   * Internal routing hint: deliver responses to this target, but do not expose
   * typing/presence while background automation is working.
   */
  suppressPresence?: boolean;
}

export interface RuntimeUserMessage extends RuntimePromptMessage {
  deliveryBarrier?: DeliveryBarrier;
  deliveryBarrierSource?: DeliveryBarrierSource;
  taskBarrierTaskId?: string;
  commands?: RaviCommandPromptMetadata[];
  /** Original launch envelope used to recreate session metadata after an interrupt restart. */
  launchPrompt?: RuntimeLaunchPrompt;
  pendingId?: string;
  queuedAt?: number;
}

export function runtimeTurnAttemptTerminalEventType(
  status: RuntimeTurnAttemptTerminalStatus,
): "turn.complete" | "turn.failed" | "turn.interrupted" {
  if (status === "complete") return "turn.complete";
  if (status === "failed" || status === "timeout") return "turn.failed";
  return "turn.interrupted";
}

/** Streaming session - persistent runtime process that accepts messages via AsyncGenerator */
export interface RuntimeHostStreamingSession {
  /** Agent config used to start this runtime process. Changing it requires restart. */
  agentId: string;
  /** The runtime query handle */
  queryHandle: RuntimeSessionHandle;
  /** True while the runtime provider is still bootstrapping */
  starting: boolean;
  /** Abort controller to kill the subprocess */
  abortController: AbortController;
  /** Resolve function to unblock the generator when waiting between turns */
  pushMessage: ((msg: RuntimeUserMessage | null) => void) | null;
  /** Sticky wake-up flag for queue releases that happen between generator loops */
  pendingWake: boolean;
  /** Queue of messages - stays in queue until turn completes without interrupt */
  pendingMessages: RuntimeUserMessage[];
  /** Current response source for routing */
  currentSource?: RuntimeMessageTarget;
  /** Provider-neutral channel backend identity for the currently executing turn. */
  currentChannelBackend?: ChannelBackendPromptMetadata;
  /** Runtime model currently assigned to this live stream */
  currentModel: string;
  /** Runtime effort currently assigned to this live stream */
  currentEffort?: RuntimeEffort;
  /** Runtime thinking mode currently assigned to this live stream */
  currentThinking?: RuntimeThinking;
  /** Explicit task context used to start this runtime process, if any. */
  currentTaskBarrierTaskId?: string;
  /** Tool tracking */
  toolRunning: boolean;
  currentToolId?: string;
  currentToolName?: string;
  currentToolInput?: unknown;
  toolStartTime?: number;
  lastToolFailure?: {
    at: number;
    toolId?: string;
    toolName?: string;
    output?: unknown;
    metadata?: RuntimeEventMetadata;
  };
  /** Activity tracking */
  lastActivity: number;
  /** Whether the event loop is done (session ended) */
  done: boolean;
  /** Whether the current turn was interrupted (discard response, keep queue) */
  interrupted: boolean;
  /** Internal cancellation reason; suppresses provider abort noise from user-facing output. */
  internalAbortReason?: string;
  /** Whether a provider turn is currently active until a terminal event arrives */
  turnActive: boolean;
  /** Signal from result handler to unblock generator after turn completes */
  onTurnComplete: (() => void) | null;
  /** Flag: SDK returned "Prompt is too long" - session needs reset */
  _promptTooLong?: boolean;
  /** Whether the SDK is currently compacting (do not interrupt during compaction) */
  compacting: boolean;
  /**
   * Whether external compaction announcements may be externalized for the turn
   * effectively executing. Snapshotted per turn from the turn's origin so that
   * automation-originated turns compact silently while human/channel turns keep
   * announcements. Internal compaction observability is unaffected.
   */
  currentTurnProvenance?: TurnProvenance;
  /** Tool safety classification - "safe" tools can be interrupted, "unsafe" cannot */
  currentToolSafety: "safe" | "unsafe" | null;
  /** Pending abort - set when abort is requested during an unsafe tool call */
  pendingAbort: boolean;
  /** Agent mode (e.g. "sentinel") - controls compaction announcements and system commands */
  agentMode?: string;
  /** Session trace run ID for this live runtime process. */
  traceRunId?: string;
  /** Pending message ids yielded to the currently active provider turn. */
  currentTurnPendingIds?: string[];
  /** Whether a newer prompt intentionally preempted the active provider turn. */
  currentTurnSuperseded?: boolean;
  /** Whether the current provider turn has started at least one tool. Used to block unsafe replay. */
  currentTurnToolStarted?: boolean;
  /** Whether tool effects are fenced durably before execution or only observed asynchronously. */
  toolEffectFence?: RuntimeToolEffectFence;
  /** Current Session Trace turn ID while a provider turn is active. */
  currentTraceTurnId?: string;
  currentTraceTurnStartedAt?: number;
  currentTraceUserPromptSha256?: string;
  currentTraceSystemPromptSha256?: string;
  currentTraceRequestBlobSha256?: string;
  currentTraceTurnTerminalRecorded?: boolean;
  /** Durable crash-recovery attempt currently owning the provider turn. */
  currentCrashRecoveryAttemptId?: string;
  /** First durable terminal fence for the current provider delivery. */
  currentCrashRecoveryTerminal?: {
    status: RuntimeTurnAttemptTerminalStatus;
    completedAt: number;
    startedTool: boolean;
    materializedOutput: boolean;
  };
  /** Durable handoff failed before the prompt reached the provider. */
  durableTurnPreparationFailed?: boolean;
  /** Managed runtime credential selected for this provider process, if any. */
  currentRuntimeCredential?: RuntimeCredentialAttemptBinding;
  /** Recovery timer for the narrow state where a provider is alive but not accepting queued input. */
  idleGapRecoveryTimer?: ReturnType<typeof setTimeout>;
  /** Timer that evicts an idle provider process from the runtime pool. */
  idleSessionEvictionTimer?: ReturnType<typeof setTimeout>;
}

async function* emptyRuntimeEvents(): AsyncGenerator<never> {}

export function createPendingRuntimeHandle(provider: RuntimeProviderId): RuntimeSessionHandle {
  return {
    provider,
    events: emptyRuntimeEvents(),
    interrupt: async () => {},
  };
}

export function stashPendingRuntimeMessages(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  stashedMessages: Map<string, RuntimeUserMessage[]>,
  crashRecovery?: RuntimeCrashRecoveryCoordinator,
): number {
  const replayableMessages = getCrashRecoveryReplayablePendingRuntimeMessages(session, crashRecovery);
  if (replayableMessages.length === 0) {
    return 0;
  }

  stashedMessages.set(
    sessionName,
    replayableMessages.map((message) => ({ ...message })),
  );
  return replayableMessages.length;
}

export function stashCurrentTurnRuntimeMessages(
  sessionName: string,
  session: RuntimeHostStreamingSession,
  stashedMessages: Map<string, RuntimeUserMessage[]>,
  crashRecovery?: RuntimeCrashRecoveryCoordinator,
): number {
  const currentTurnPendingIds = new Set(session.currentTurnPendingIds ?? []);
  if (currentTurnPendingIds.size === 0) {
    return 0;
  }

  const safety = getRuntimeTurnReplaySafety(session, crashRecovery);
  const messages = (
    safety.replayable
      ? session.currentTurnSuperseded
        ? getReplayablePendingRuntimeMessages(session)
        : session.pendingMessages.filter((message) => message.pendingId && currentTurnPendingIds.has(message.pendingId))
      : getPendingRuntimeTurnSuccessors(session)
  ).map((message) => ({ ...message }));

  if (messages.length === 0) {
    return 0;
  }

  stashedMessages.set(sessionName, messages);
  return messages.length;
}

export function getReplayablePendingRuntimeMessages(session: RuntimeHostStreamingSession): RuntimeUserMessage[] {
  if (!session.currentTurnSuperseded) {
    return session.pendingMessages;
  }

  const currentTurnPendingIds = new Set(session.currentTurnPendingIds ?? []);
  if (currentTurnPendingIds.size === 0) {
    return session.pendingMessages;
  }

  return session.pendingMessages.filter(
    (message) => !message.pendingId || !currentTurnPendingIds.has(message.pendingId),
  );
}

export interface RuntimeTurnReplaySafety {
  replayable: boolean;
  startedTool: boolean;
  materializedOutput: boolean;
  durableBinding: "none" | "active" | "terminal" | "missing";
}

/**
 * Resolve the durable replay fence for the physical turn currently bound to a
 * streaming session. Missing durable ownership is fail-closed once a trace has
 * started; a pre-handoff preparation failure remains replayable because the
 * provider never received the prompt.
 */
export function getRuntimeTurnReplaySafety(
  session: RuntimeHostStreamingSession,
  crashRecovery?: RuntimeCrashRecoveryCoordinator,
): RuntimeTurnReplaySafety {
  // Attempt creation happens before the generator yields to the provider. A
  // failure at that boundary proves this physical turn was never delivered,
  // even when the coordinator entered fail-closed while persisting it.
  if (session.durableTurnPreparationFailed) {
    return {
      replayable: true,
      startedTool: false,
      materializedOutput: false,
      durableBinding: "none",
    };
  }

  const terminal = session.currentCrashRecoveryTerminal;
  if (crashRecovery && !crashRecovery.acceptingDeliveries) {
    return {
      replayable: false,
      startedTool: terminal?.startedTool === true || session.currentTurnToolStarted === true,
      materializedOutput: terminal?.materializedOutput === true,
      durableBinding: "missing",
    };
  }
  if (terminal) {
    const startedTool = terminal.startedTool || session.currentTurnToolStarted === true;
    return {
      replayable:
        terminal.status !== "complete" &&
        session.toolEffectFence === "host_write_ahead" &&
        !startedTool &&
        !terminal.materializedOutput,
      startedTool,
      materializedOutput: terminal.materializedOutput,
      durableBinding: "terminal",
    };
  }

  const attemptId = session.currentCrashRecoveryAttemptId;
  if (attemptId) {
    const attempt = crashRecovery?.getActiveTurnAttempt?.(attemptId);
    if (!attempt) {
      return {
        replayable: false,
        startedTool: session.currentTurnToolStarted === true,
        materializedOutput: false,
        durableBinding: "missing",
      };
    }
    const startedTool = attempt.startedTool || session.currentTurnToolStarted === true;
    return {
      replayable: session.toolEffectFence === "host_write_ahead" && !startedTool && !attempt.materializedOutput,
      startedTool,
      materializedOutput: attempt.materializedOutput,
      durableBinding: "active",
    };
  }

  if (
    session.currentTraceTurnId &&
    !session.currentTraceTurnTerminalRecorded &&
    !session.durableTurnPreparationFailed
  ) {
    return {
      replayable: false,
      startedTool: session.currentTurnToolStarted === true,
      materializedOutput: false,
      durableBinding: "missing",
    };
  }

  if (session.currentTurnToolStarted) {
    return {
      replayable: false,
      startedTool: true,
      materializedOutput: false,
      durableBinding: "missing",
    };
  }

  return {
    replayable: true,
    startedTool: false,
    materializedOutput: false,
    durableBinding: "none",
  };
}

/**
 * Return messages safe to carry into a replacement runtime. If the physical
 * turn has durable side-effect/output evidence, its own pending ids are
 * excluded while independently queued successors remain eligible.
 */
export function getCrashRecoveryReplayablePendingRuntimeMessages(
  session: RuntimeHostStreamingSession,
  crashRecovery?: RuntimeCrashRecoveryCoordinator,
): RuntimeUserMessage[] {
  const safety = getRuntimeTurnReplaySafety(session, crashRecovery);
  if (session.currentCrashRecoveryTerminal?.status === "complete") {
    return (session.currentTurnPendingIds?.length ?? 0) > 0
      ? getPendingRuntimeTurnSuccessors(session)
      : session.pendingMessages;
  }
  return safety.replayable ? getReplayablePendingRuntimeMessages(session) : getPendingRuntimeTurnSuccessors(session);
}

export function getPendingRuntimeTurnSuccessors(session: RuntimeHostStreamingSession): RuntimeUserMessage[] {
  const currentTurnPendingIds = new Set(session.currentTurnPendingIds ?? []);
  if (currentTurnPendingIds.size === 0) {
    return [];
  }
  return session.pendingMessages.filter(
    (message) => typeof message.pendingId === "string" && !currentTurnPendingIds.has(message.pendingId),
  );
}

export function shutdownRuntimeStreamingSession(session: RuntimeHostStreamingSession, reason?: string): void {
  if (reason) {
    session.internalAbortReason = reason;
  }
  session.done = true;
  session.starting = false;
  if (session.idleGapRecoveryTimer) {
    clearTimeout(session.idleGapRecoveryTimer);
    session.idleGapRecoveryTimer = undefined;
  }
  if (session.idleSessionEvictionTimer) {
    clearTimeout(session.idleSessionEvictionTimer);
    session.idleSessionEvictionTimer = undefined;
  }

  session.queryHandle.interrupt().catch(() => {});

  if (session.pushMessage) {
    session.pushMessage(null);
    session.pushMessage = null;
  }

  if (session.onTurnComplete) {
    session.onTurnComplete();
    session.onTurnComplete = null;
  }

  if (!session.abortController.signal.aborted) {
    session.abortController.abort();
  }
}

export function resolveStoredRuntimeProvider(
  session: Pick<SessionEntry, "runtimeProvider" | "providerSessionId" | "sdkSessionId">,
): RuntimeProviderId | undefined {
  if (session.runtimeProvider) {
    return session.runtimeProvider;
  }

  if (session.providerSessionId || session.sdkSessionId) {
    // Legacy sessions predate the runtime_provider column. Modern sessions always
    // record runtime_provider (session-launcher), so a stored session id with no
    // provider can only be a pre-multi-provider Claude session — not the current
    // default (which has since moved to codex).
    return LEGACY_RUNTIME_PROVIDER_ID;
  }

  return undefined;
}

/** Provider that owned sessions created before the runtime_provider column existed. */
export const LEGACY_RUNTIME_PROVIDER_ID: RuntimeProviderId = "claude";
