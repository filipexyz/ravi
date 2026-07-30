import type { DeliveryBarrier, DeliveryBarrierSource } from "../delivery-barriers.js";
import type { NativeLocalAgentActionTurnMetadata } from "../channels/native/agent-action-turn.js";
import type { ThreadHandoffPromptMetadata } from "../threads/types.js";
import type { RuntimeEventMetadata } from "./types.js";
import type { RuntimeProviderId } from "./types.js";

export type { ChannelContext } from "../channels/context.js";

export interface MessageActorMetadata {
  /** Canonical chat id from the Ravi chat model. Raw chat ids remain in chatId as provenance. */
  canonicalChatId?: string;
  actorType?: "contact" | "agent" | "system" | "unknown" | (string & {});
  contactId?: string;
  actorAgentId?: string;
  automationId?: string;
  platformIdentityId?: string;
  rawSenderId?: string;
  normalizedSenderId?: string;
  identityConfidence?: number;
  identityProvenance?: Record<string, unknown>;
}

export interface MentionedContactPromptContext {
  /** Safe display label only. Do not put raw contact/platform ids here. */
  displayName: string;
  /** Natural-language CRM/contact facts ready to render into the runtime prompt. */
  summaryLines: string[];
}

/** Message context for structured prompts */
export interface MessageContext extends MessageActorMetadata {
  channelId: string;
  channelName: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  mentionedContactsContext?: MentionedContactPromptContext[];
  isEditedMessage?: boolean;
  editedMessageId?: string;
  editedAt?: number;
  editEventId?: string;
  isMentioned?: boolean;
  botTag?: string;
  timestamp: number;
}

/** Message routing target */
export interface MessageTarget extends MessageActorMetadata {
  channel: string;
  accountId: string;
  instanceId?: string;
  chatId: string;
  /** Thread/topic ID for platforms that support it (Telegram topics, Slack threads, Discord threads) */
  threadId?: string;
  /** Original inbound channel message ID, used for session trace correlation. */
  sourceMessageId?: string;
  /** Preferred user-visible runtime status anchor message for this session/chat/thread. */
  statusAnchorMessageId?: string;
  /** Canonical status anchor kind, following the channels model spec. */
  statusAnchorKind?: "last_outbound_message" | "chat_thread_transient" | "draft_outbound_message" | "none";
  /**
   * Internal routing hint: deliver responses to this target, but do not expose
   * typing/presence while background automation is working.
   */
  suppressPresence?: boolean;
}

export interface RaviCommandPromptMetadata {
  id: string;
  scope: "agent" | "global";
  sourcePath: string;
  originalText: string;
  arguments: string;
  renderedPromptSha256: string;
}

export interface ObservationPromptMetadata {
  sourceSessionKey: string;
  sourceSessionName: string;
  bindingId: string;
  ruleId: string;
  role: string;
  mode: string;
  profileId?: string;
  profileVersion?: string;
  permissionGrants?: string[];
  eventIds: string[];
  /** Source trace turns used to derive durable reaction idempotency. */
  sourceTurnIds?: string[];
}

export interface DaemonRestartResumePromptMetadata {
  restartEpoch: string;
  sessionKey?: string;
}

export interface ChannelBackendPromptMetadata {
  protocol: "ravi.channel.backend";
  schemaVersion: 1;
  ingressRequestId: string;
  correlationId: string;
  binding: {
    channelInstanceId: string;
    agentId: string;
    chatId: string;
    messageId: string;
    sessionId: string;
    turnId: string;
  };
  target: {
    channelKind: string;
    connectionId: string;
    conversationId: string;
  };
  localAgentActions?: NativeLocalAgentActionTurnMetadata;
}

export type SessionRelayAction = "send" | "ask" | "answer" | "execute" | "inform";

export interface RuntimeTurnOriginPrincipal {
  type: "agent" | "automation";
  id: string;
}

interface RuntimeTurnOriginEnvelope {
  protocol: "ravi.runtime.turn-origin";
  schemaVersion: 1;
  principal: RuntimeTurnOriginPrincipal;
}

export interface SessionRelayTurnOriginMetadata extends RuntimeTurnOriginEnvelope {
  producer: "session-relay";
  action: SessionRelayAction;
  session?: {
    key?: string;
    name?: string;
  };
}

export type ChannelTurnAction = "session.bootstrap" | "session.return";

export interface ChannelTurnOriginMetadata extends RuntimeTurnOriginEnvelope {
  producer: "channel";
  action: ChannelTurnAction;
}

/**
 * Validated cause asserted by a trusted internal prompt producer. This is not
 * a credential: access to the internal prompt bus is the trust boundary.
 * `source` and `context` continue to describe the reply surface.
 */
export type RuntimeTurnOriginMetadata = SessionRelayTurnOriginMetadata | ChannelTurnOriginMetadata;

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
  /** Ravi Commands that produced this prompt, when a user invoked #command. */
  commands?: RaviCommandPromptMetadata[];
  /**
   * Message delivery barrier:
   * - immediate_interrupt: interrupt current turn as soon as it is safe
   * - after_tool: wait for tool/compaction startup barriers, then preempt text response
   * - after_response: wait until the current turn completes
   * - after_task: wait until the session has no active task assignment
   */
  deliveryBarrier?: DeliveryBarrier;
  /** Whether the barrier came from caller intent, a producer default, or runtime inference. */
  deliveryBarrierSource?: DeliveryBarrierSource;
  /** Task ID exempted from after_task blocking (used by task dispatch to avoid self-deadlock) */
  taskBarrierTaskId?: string;
  source?: MessageTarget;
  context?: MessageContext;
  /** Approval routing: channel to send approval requests when agent has no direct channel */
  _approvalSource?: MessageTarget;
  /** Explicit agent override injected by router/task dispatch paths */
  _agentId?: string;
  /** Explicit runtime provider override for internal dispatch paths such as observers. */
  _runtimeProviderId?: RuntimeProviderId;
  /** Explicit runtime model override for internal dispatch paths such as observers. */
  _runtimeModel?: string;
  /** Observation Plane metadata for observer-session prompts. */
  _observation?: ObservationPromptMetadata;
  /** Heartbeat runner prompt marker. */
  _heartbeat?: boolean;
  /** Cron runner prompt marker. */
  _cron?: boolean;
  /** Cron job id when `_cron` is true. */
  _jobId?: string;
  /** Trigger runner prompt marker. */
  _trigger?: boolean;
  /** Trigger id when `_trigger` is true. */
  _triggerId?: string;
  /** Session followup runner prompt marker. */
  _sessionFollowup?: boolean;
  /** Session followup cadence id when `_sessionFollowup` is true. */
  _sessionFollowupCadenceId?: string;
  /** Session followup run id when `_sessionFollowup` is true. */
  _sessionFollowupRunId?: string;
  /** Ravi thread metadata. Distinct from provider-native thread/topic IDs. */
  _thread?: ThreadHandoffPromptMetadata;
  /**
   * Internal restart envelope: start a fresh runtime only to drain messages that
   * were already persisted and stashed by the previous runtime session.
   */
  _resumeStashedMessages?: boolean;
  /** Internal daemon restart resume envelope used for idempotent fan-out. */
  _daemonRestartResume?: DaemonRestartResumePromptMetadata;
  /** Provider-neutral identity for prompts accepted through a channel backend. */
  _channelBackend?: ChannelBackendPromptMetadata;
  /** Validated provenance asserted by a trusted internal producer; not a credential. */
  _turnOrigin?: RuntimeTurnOriginMetadata;
}

export type RuntimeLaunchPrompt = PromptMessage;

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
  target?: MessageTarget;
  metadata?: RuntimeEventMetadata | null;
  /** Unique emit ID to detect ghost/duplicate responses */
  _emitId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
