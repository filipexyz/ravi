/**
 * Durable world conditions. Spec: `runtime/signals`.
 */

export const SIGNAL_KINDS = ["fact", "judgment"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_SEVERITIES = ["ambient", "piggyback", "nudge", "interrupt", "page"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_STATES = ["open", "surfaced", "acknowledged", "muted", "resolved", "expired"] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

export const SIGNAL_SCOPE_TYPES = ["person", "chat", "project", "agent", "fleet"] as const;
export type SignalScopeType = (typeof SIGNAL_SCOPE_TYPES)[number];

export const SIGNAL_PRODUCER_TYPES = ["code", "agent"] as const;
export type SignalProducerType = (typeof SIGNAL_PRODUCER_TYPES)[number];

export const SIGNAL_PRODUCER_CLASSES = ["code", "agent", "observer", "task-observer", "operator-assistant"] as const;
export type SignalProducerClass = (typeof SIGNAL_PRODUCER_CLASSES)[number];

export const SIGNAL_SUBJECT_TYPES = ["task", "session", "agent", "contact", "project"] as const;
export type SignalSubjectType = (typeof SIGNAL_SUBJECT_TYPES)[number];

export const SIGNAL_SURFACE_ROUTES = ["piggyback", "oob", "page"] as const;
export type SignalSurfaceRoute = (typeof SIGNAL_SURFACE_ROUTES)[number];

export type ClearWhen =
  | {
      type: "probe";
      probe: string;
      expr: string;
      recheck_ms: number;
      grace_ms: number;
    }
  | {
      type: "metric";
      field: string;
      op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
      value: number;
      recheck_ms: number;
    }
  | { type: "producer_resolve"; ttl_ms: number }
  | { type: "decay"; after_ms: number }
  | { type: "manual"; owner?: string };

export interface SignalRecord {
  id: string;
  key: string;
  schemaVersion: number;
  kind: SignalKind;
  producerType: SignalProducerType;
  producerClass: SignalProducerClass;
  producerId: string;
  scopeType: SignalScopeType;
  scopeId: string;
  targetSessions?: string[];
  subjectType?: SignalSubjectType;
  subjectId?: string;
  severity: SignalSeverity;
  title: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  clearWhen: ClearWhen;
  state: SignalState;
  previousState?: Exclude<SignalState, "muted">;
  dedupeKey?: string;
  cooldownMs: number;
  renotifyAfterMs: number;
  escalateAfterMs?: number | null;
  maxSurfaces: number;
  ttlMs: number;
  reopenAfterMs: number;
  mutedUntil?: number | null;
  muteReason?: string;
  surfaceCount: number;
  escalationCount: number;
  openedAt: number;
  lastSeenAt: number;
  lastEvalAt?: number | null;
  lastEvalError?: string | null;
  clearSince?: number | null;
  surfacedAt?: number | null;
  acknowledgedAt?: number | null;
  acknowledgedBy?: string | null;
  closedAt?: number | null;
  closeReason?: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface SignalEventRecord {
  id: number;
  signalId: string;
  type: string;
  actorType?: string;
  actorId?: string;
  message?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface RaiseSignalInput {
  key: string;
  kind: SignalKind;
  producerId: string;
  producerType?: SignalProducerType;
  producerClass?: SignalProducerClass;
  scopeType: SignalScopeType;
  scopeId: string;
  targetSessions?: string[];
  subjectType?: SignalSubjectType;
  subjectId?: string;
  severity?: SignalSeverity;
  title: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  clearWhen: ClearWhen;
  dedupeKey?: string;
  cooldownMs?: number;
  renotifyAfterMs?: number;
  escalateAfterMs?: number | null;
  maxSurfaces?: number;
  ttlMs?: number;
  reopenAfterMs?: number;
  now?: number;
}

export interface RaiseSignalResult {
  signal: SignalRecord;
  created: boolean;
  updated: boolean;
  suppressed?: "reopen" | "terminal_subject" | "muted_key";
}

export interface ListSignalsOptions {
  state?: SignalState | "non_terminal";
  scopeType?: SignalScopeType;
  scopeId?: string;
  key?: string;
  limit?: number;
  offset?: number;
  now?: number;
}

export interface SignalEvaluation {
  signal: SignalRecord;
  cleared: boolean;
  error?: string;
  observedFields?: Record<string, unknown>;
}

export interface SignalSessionContext {
  sessionName: string;
  sessionKey?: string;
  agentId?: string;
  chatId?: string;
  contactIds?: string[];
  projectId?: string;
}

export interface SignalSkipped {
  id: string;
  reason:
    | "cooldown"
    | "budget"
    | "muted"
    | "acked"
    | "cleared"
    | "out_of_scope"
    | "probe_error"
    | "ceiling"
    | "subject_terminal"
    | "ambiguous"
    | "held"
    | "ignored";
}

export interface RenderSignalsResult {
  suffix: string;
  surfacedIds: string[];
  skipped: SignalSkipped[];
  budget: { used: number; limit: number; held: number };
}

export interface TickSignalsResult {
  executed: boolean;
  evaluated: number;
  resolved: number;
  expired: number;
  escalated: number;
  errors: Array<{ id: string; error: string }>;
  candidates: Array<{ id: string; route: SignalSurfaceRoute; severity: SignalSeverity; sessionName: string }>;
  watchers: Array<{ id: string; raised: boolean; resolved: boolean; error?: string }>;
}

export interface SignalTickDependencies {
  now?: number;
  execute?: boolean;
  publishPrompt?: (sessionName: string, payload: Record<string, unknown>) => Promise<void>;
  sendPage?: (signal: SignalRecord, sessionName: string) => Promise<"sent" | "skipped_no_binding" | "failed">;
  runWatchers?: boolean;
  probe?: typeof import("./probes.js").probeSignal;
}

export interface SignalBudget {
  day: string;
  used: number;
  limit: number;
  held: number;
}
