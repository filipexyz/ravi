/**
 * Trigger System Types
 *
 * Event-driven triggers that subscribe to NATS topics
 * and proactively fire agent prompts when events occur.
 */

export type SessionTarget = "main" | "isolated";

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
  session: SessionTarget;
  replySession?: string;
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
  session?: SessionTarget;
  replySession?: string;
  enabled?: boolean;
  cooldownMs?: number;
  /** Optional filter expression. If set, trigger only fires when event data matches. */
  filter?: string;
}
