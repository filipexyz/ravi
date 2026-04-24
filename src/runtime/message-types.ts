import type { DeliveryBarrier } from "../delivery-barriers.js";
import type { RuntimeEventMetadata } from "./types.js";

export interface MessageActorMetadata {
  /** Canonical chat id from the Ravi chat model. Raw chat ids remain in chatId as provenance. */
  canonicalChatId?: string;
  actorType?: "contact" | "agent" | "system" | "unknown" | (string & {});
  contactId?: string;
  actorAgentId?: string;
  platformIdentityId?: string;
  rawSenderId?: string;
  normalizedSenderId?: string;
  identityConfidence?: number;
  identityProvenance?: Record<string, unknown>;
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
  isMentioned?: boolean;
  botTag?: string;
  timestamp: number;
}

/** Stable channel/group metadata persisted in session for cross-send reuse */
export interface ChannelContext {
  channelId: string;
  channelName: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  botTag?: string;
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
}

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
  /**
   * Message delivery barrier:
   * - immediate_interrupt: interrupt current turn as soon as it is safe
   * - after_tool: wait for tool/compaction startup barriers, then preempt text response
   * - after_response: wait until the current turn completes
   * - after_task: wait until the session has no active task assignment
   */
  deliveryBarrier?: DeliveryBarrier;
  /** Task ID exempted from after_task blocking (used by task dispatch to avoid self-deadlock) */
  taskBarrierTaskId?: string;
  source?: MessageTarget;
  context?: MessageContext;
  /** Approval routing: channel to send approval requests when agent has no direct channel */
  _approvalSource?: MessageTarget;
  /** Explicit agent override injected by router/task dispatch paths */
  _agentId?: string;
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
