/**
 * Durable world conditions. Spec: `runtime/signals`.
 */

export const SIGNAL_KINDS = ["fact", "judgment"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_SEVERITIES = ["ambient", "piggyback", "nudge", "interrupt", "page"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export const SIGNAL_STATES = ["open", "surfaced", "acknowledged", "muted", "resolved", "expired"] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

export const SIGNAL_SCOPE_TYPES = ["person", "chat", "project", "agent", "install"] as const;
export type SignalScopeType = (typeof SIGNAL_SCOPE_TYPES)[number];

export const SIGNAL_PRODUCER_TYPES = ["code", "agent"] as const;
export type SignalProducerType = (typeof SIGNAL_PRODUCER_TYPES)[number];

export const SIGNAL_PRODUCER_CLASSES = ["code", "agent", "observer", "task-observer", "operator-assistant"] as const;
export type SignalProducerClass = (typeof SIGNAL_PRODUCER_CLASSES)[number];

export const SIGNAL_SUBJECT_TYPES = ["task", "session", "agent", "contact", "project"] as const;
export type SignalSubjectType = (typeof SIGNAL_SUBJECT_TYPES)[number];

export const SIGNAL_SURFACE_ROUTES = ["piggyback", "oob", "page"] as const;
export type SignalSurfaceRoute = (typeof SIGNAL_SURFACE_ROUTES)[number];

/** One ledger row per logical surface: `pending` reserves, `sent` consumes, `failed` counts zero. */
export const SIGNAL_SURFACE_STATUSES = ["pending", "sent", "failed"] as const;
export type SignalSurfaceStatus = (typeof SIGNAL_SURFACE_STATUSES)[number];

/** How fresh the cached observation is, as rendered and as gated for OOB. */
export const SIGNAL_OBSERVATION_STATUSES = ["fresh", "stale", "unknown"] as const;
export type SignalObservationStatus = (typeof SIGNAL_OBSERVATION_STATUSES)[number];

/**
 * The caller as the invocation context (ToolContext) resolved it. Authority
 * to raise a fact, request `page`, ack a fact or resolve a fact comes from
 * here, never from the kind named in the request or the process environment.
 */
export interface SignalCaller {
  /** An agent turn (session-bound context), as opposed to the operator's CLI. */
  isAgent: boolean;
  agentId?: string | null;
  sessionName?: string | null;
}

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
  /** Record version after the transition this row audits; absent on non-transition notes. */
  version?: number;
  fromState?: string;
  toState?: string;
  createdAt: number;
}

export interface SignalSurfaceRecord {
  id: number;
  signalId: string;
  route: SignalSurfaceRoute;
  status: SignalSurfaceStatus;
  sessionName?: string;
  turnId?: string;
  idempotencyKey?: string;
  budgetDay: string;
  budgetBypass: boolean;
  error?: string;
  createdAt: number;
  sentAt?: number | null;
  failedAt?: number | null;
}

export interface SignalOutboxRecord {
  id: number;
  surfaceId: number;
  signalId: string;
  idempotencyKey: string;
  route: SignalSurfaceRoute;
  sessionName?: string;
  severity: SignalSeverity;
  status: SignalSurfaceStatus;
  attempts: number;
  pageStatus?: "sent" | "skipped_no_binding" | "failed" | null;
  lastError?: string | null;
  reservedVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** The cached observation the tick stores and render reads (never computed on the turn path). */
export interface SignalObservation {
  signalId: string;
  observedAt: number;
  error?: string | null;
  fields?: Record<string, unknown>;
  clearSince?: number | null;
}

export interface SignalTickState {
  lastSuccessfulTickAt: number | null;
  lastTickAt: number | null;
  lastTickError: string | null;
  tickIntervalMs: number;
  staleAfterMs: number;
  staleAfterSource: "setting" | "default";
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
  /** The resolved invocation context. Absent means a code producer in the daemon. */
  caller?: SignalCaller;
  now?: number;
}

export interface RaiseSignalResult {
  signal: SignalRecord;
  created: boolean;
  updated: boolean;
  suppressed?: "reopen" | "terminal_subject" | "muted_key";
  reopened?: boolean;
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
    | "ignored"
    | "expired"
    | "reserve_failed";
}

/** Why the tick did not escalate a signal that was otherwise due for OOB. */
export interface SignalOobSkipped {
  id: string;
  sessionName: string;
  reason:
    | "stale"
    | "unknown"
    | "oob_disabled"
    | "budget"
    | "oob_budget"
    | "cooldown"
    | "escalation_cap"
    | "pending"
    | "ineligible";
}

export interface SignalTurnBudget {
  /** Distinct ledger rows first written (reserved) by this turn, whatever their later outcome. */
  used: number;
  limit: number;
  held: number;
  /** Units of the daily budget taken (pending + sent) after this turn's reservations. */
  daily: number;
  /** Reservations of this turn released before the prompt went out. */
  released: number;
}

export interface RenderSignalsResult {
  suffix: string;
  surfacedIds: string[];
  skipped: SignalSkipped[];
  budget: SignalTurnBudget;
  /** Ledger rows reserved by this render; commit or release them with the turn. */
  reservations: number[];
}

export interface TickSignalsResult {
  executed: boolean;
  evaluated: number;
  resolved: number;
  expired: number;
  escalated: number;
  errors: Array<{ id: string; error: string }>;
  candidates: Array<{ id: string; route: SignalSurfaceRoute; severity: SignalSeverity; sessionName: string }>;
  skipped: SignalOobSkipped[];
  outbox: { sent: number; retried: number; failed: number };
  watchers: Array<{ id: string; raised: boolean; resolved: boolean; error?: string }>;
  tickState: SignalTickState;
}

export interface SignalTickDependencies {
  now?: number;
  execute?: boolean;
  tickIntervalMs?: number;
  publishPrompt?: (
    sessionName: string,
    payload: Record<string, unknown>,
    options?: { messageId?: string },
  ) => Promise<void>;
  sendPage?: (
    signal: SignalRecord,
    sessionName: string,
    idempotencyKey: string,
  ) => Promise<"sent" | "skipped_no_binding" | "failed">;
  runWatchers?: boolean;
  probe?: typeof import("./probes.js").probeSignal;
}

export interface SignalBudget {
  day: string;
  used: number;
  limit: number;
  held: number;
  /** OOB slots taken today (pending + sent), out of `oobLimit`. */
  oobUsed: number;
  oobLimit: number;
}
