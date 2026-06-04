/**
 * Trigger System Types
 *
 * Event-driven triggers that subscribe to NATS topics
 * and proactively fire agent prompts when events occur.
 */

export type SessionTarget = "main" | "isolated";
export type TriggerMessageSource = "manual" | "catalog";

/**
 * Outbound source captured at trigger creation time.
 * Frozen snapshot of where the trigger should reply when the live
 * session can no longer resolve a target (lastChannel/lastTo empty,
 * or routed through a non-deliverable channel like "tui").
 */
export interface TriggerReplySource {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

/**
 * Full trigger record as stored in database
 */
export interface Trigger {
  id: string;
  name: string;
  agentId?: string;
  /** Explicit account ID for outbound routing (overrides session.lastAccountId) */
  accountId?: string;
  topic: string;
  message: string;
  /** Provenance for prompt formatting. Catalog templates use standardized trigger prompts. */
  messageSource?: TriggerMessageSource;
  messageTemplateId?: string | null;
  session: SessionTarget;
  replySession?: string;
  /** Frozen outbound source captured from the creator's runtime context */
  replySource?: TriggerReplySource;
  enabled: boolean;
  cooldownMs: number;
  /** Optional filter expression. If set, trigger only fires when event data matches. */
  filter?: string;

  // State
  lastFiredAt?: number;
  fireCount: number;

  createdAt: number;
  updatedAt: number;
}

/**
 * Input for creating a new trigger
 */
export interface TriggerInput {
  name: string;
  agentId?: string;
  /** Explicit account ID for outbound routing */
  accountId?: string;
  topic: string;
  message: string;
  messageSource?: TriggerMessageSource;
  messageTemplateId?: string | null;
  session?: SessionTarget;
  replySession?: string;
  replySource?: TriggerReplySource;
  enabled?: boolean;
  cooldownMs?: number;
  /** Optional filter expression. If set, trigger only fires when event data matches. */
  filter?: string;
}
