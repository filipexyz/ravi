/**
 * Trigger System Types
 *
 * Event-driven triggers that subscribe to notif topics
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
  topic: string;
  message: string;
  session: SessionTarget;
  replySession?: string;
  enabled: boolean;
  cooldownMs: number;

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
  topic: string;
  message: string;
  session?: SessionTarget;
  replySession?: string;
  enabled?: boolean;
  cooldownMs?: number;
}
