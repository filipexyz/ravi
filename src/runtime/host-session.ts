import type { DeliveryBarrier } from "../delivery-barriers.js";
import type { SessionEntry } from "../router/index.js";
import type { MessageActorMetadata } from "./message-types.js";
import type {
  RuntimeEventMetadata,
  RuntimeEffort,
  RuntimePromptMessage,
  RuntimeProviderId,
  RuntimeSessionHandle,
  RuntimeThinking,
} from "./types.js";

export interface RuntimeMessageTarget extends MessageActorMetadata {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  /** Thread/topic ID for platforms that support it (Telegram topics, Slack threads, Discord threads) */
  threadId?: string;
  /** Original inbound channel message ID, used for session trace correlation. */
  sourceMessageId?: string;
}

export interface RuntimeUserMessage extends RuntimePromptMessage {
  deliveryBarrier?: DeliveryBarrier;
  taskBarrierTaskId?: string;
  pendingId?: string;
  queuedAt?: number;
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
  /** Current Session Trace turn ID while a provider turn is active. */
  currentTraceTurnId?: string;
  currentTraceTurnStartedAt?: number;
  currentTraceUserPromptSha256?: string;
  currentTraceSystemPromptSha256?: string;
  currentTraceRequestBlobSha256?: string;
  currentTraceTurnTerminalRecorded?: boolean;
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
): void {
  if (session.pendingMessages.length === 0) {
    return;
  }

  stashedMessages.set(
    sessionName,
    session.pendingMessages.map((message) => ({ ...message })),
  );
}

export function shutdownRuntimeStreamingSession(session: RuntimeHostStreamingSession, reason?: string): void {
  if (reason) {
    session.internalAbortReason = reason;
  }
  session.done = true;
  session.starting = false;

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
  defaultRuntimeProviderId: RuntimeProviderId,
): RuntimeProviderId | undefined {
  if (session.runtimeProvider) {
    return session.runtimeProvider;
  }

  if (session.providerSessionId || session.sdkSessionId) {
    // Legacy sessions predate runtime_provider and belong to the default runtime.
    return defaultRuntimeProviderId;
  }

  return undefined;
}
