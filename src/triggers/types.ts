/**
 * Trigger System Types
 *
 * Event-driven triggers that subscribe to NATS topics
 * and proactively fire agent prompts when events occur.
 */

/**
 * Session the trigger runs in: a session name, optionally a template resolved
 * against each event with the message syntax (`{{topic}}`, `{{data.<path>}}`),
 * e.g. `issue-{{data.payload.row.values.topic_id.0}}` for one session per
 * issue. An existing session with that name is reused; otherwise it is created.
 *
 * `main` and `isolated` are legacy values still stored by older triggers and
 * internal producers (watches, Pages comment follows): `main` is the agent's
 * main session, `isolated` one session per trigger.
 */
export type SessionTarget = string;

export const LEGACY_SESSION_TARGETS = new Set(["main", "isolated"]);

export function isLegacySessionTarget(value: SessionTarget): value is "main" | "isolated" {
  return LEGACY_SESSION_TARGETS.has(value);
}

/** Validates a `--session` value; returns an error message or null. */
export function sessionTargetError(value: string): string | null {
  if (!value.trim()) return "Invalid session: give a session name, e.g. issue-{{data.payload.rowId}}";
  // A stray `{{` or `}}` would be kept as literal text, sending every event
  // to the same session; only well-formed `{{...}}` placeholders are allowed.
  const literal = value.replace(/\{\{[^{}]+\}\}/g, "");
  if (literal.includes("{") || literal.includes("}")) {
    return `Invalid session: ${value} has an unmatched {{ or }}; placeholders look like {{data.<path>}}`;
  }
  return null;
}
export type TriggerExecutionType = "agent" | "shell";
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
  executionType?: TriggerExecutionType;
  shellCommand?: string;
  shellTimeoutMs?: number;
  shellEnvFile?: string;
  onError?: string;
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
  /** Events on the topic that the filter rejected since the filter/topic last changed. */
  filterRejectCount?: number;
  lastFilterRejectAt?: number;

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
  executionType?: TriggerExecutionType;
  shellCommand?: string;
  shellTimeoutMs?: number;
  shellEnvFile?: string;
  onError?: string;
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
