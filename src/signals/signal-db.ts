import { dbGetSetting, dbSetSetting, getDb, getRaviDbPath } from "../router/router-db.js";
import type {
  ClearWhen,
  ListSignalsOptions,
  SignalEventRecord,
  SignalKind,
  SignalObservation,
  SignalOutboxRecord,
  SignalProducerClass,
  SignalProducerType,
  SignalRecord,
  SignalScopeType,
  SignalSeverity,
  SignalState,
  SignalSubjectType,
  SignalSurfaceRecord,
  SignalSurfaceRoute,
  SignalSurfaceStatus,
  SignalTickState,
} from "./types.js";

let schemaPath: string | null = null;

/** Default tick interval (the daemon's signals runner). */
export const SIGNALS_TICK_INTERVAL_MS = 5 * 60_000;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Signal rows are read with the cached observation joined in and the surface
 * and escalation counts derived from the ledger: no stored counter can drift
 * from the `sent` rows (invariants 12 and 30). Counts are per episode, from
 * `opened_at`, so a reopened record starts with a fresh `max_surfaces`.
 */
const SIGNAL_SELECT = `
  SELECT s.*,
    o.observed_at AS obs_observed_at,
    o.error AS obs_error,
    o.clear_since AS obs_clear_since,
    o.fields_json AS obs_fields_json,
    (SELECT COUNT(*) FROM signal_surfaces ss
      WHERE ss.signal_id = s.id AND ss.status = 'sent' AND COALESCE(ss.sent_at, ss.created_at) >= s.opened_at
    ) AS derived_surface_count,
    (SELECT COUNT(*) FROM signal_surfaces ss
      WHERE ss.signal_id = s.id AND ss.status = 'sent' AND ss.route IN ('oob','page')
        AND COALESCE(ss.sent_at, ss.created_at) >= s.opened_at
    ) AS derived_escalation_count
  FROM signals s
  LEFT JOIN signal_observations o ON o.signal_id = s.id
`;

function rowToSignal(row: Record<string, unknown>): SignalRecord {
  return {
    id: String(row.id),
    key: String(row.key),
    schemaVersion: Number(row.schema_version),
    kind: row.kind as SignalKind,
    producerType: row.producer_type as SignalProducerType,
    producerClass: row.producer_class as SignalProducerClass,
    producerId: String(row.producer_id),
    scopeType: row.scope_type as SignalScopeType,
    scopeId: String(row.scope_id),
    targetSessions: parseJson<string[]>(row.target_sessions_json as string | null),
    subjectType: (row.subject_type as SignalSubjectType | null) ?? undefined,
    subjectId: (row.subject_id as string | null) ?? undefined,
    severity: row.severity as SignalSeverity,
    title: String(row.title),
    detail: (row.detail as string | null) ?? undefined,
    evidence: parseJson<Record<string, unknown>>(row.evidence_json as string | null),
    clearWhen: parseJson<ClearWhen>(row.clear_when_json as string | null) as ClearWhen,
    state: row.state as SignalState,
    previousState:
      row.previous_state && row.previous_state !== "muted"
        ? (row.previous_state as Exclude<SignalState, "muted">)
        : undefined,
    dedupeKey: (row.dedupe_key as string | null) ?? undefined,
    cooldownMs: Number(row.cooldown_ms),
    renotifyAfterMs: Number(row.renotify_after_ms),
    escalateAfterMs: optionalNumber(row.escalate_after_ms),
    maxSurfaces: Number(row.max_surfaces),
    ttlMs: Number(row.ttl_ms),
    reopenAfterMs: Number(row.reopen_after_ms),
    mutedUntil: optionalNumber(row.muted_until),
    muteReason: (row.mute_reason as string | null) ?? undefined,
    surfaceCount: Number(row.derived_surface_count ?? 0),
    escalationCount: Number(row.derived_escalation_count ?? 0),
    openedAt: Number(row.opened_at),
    lastSeenAt: Number(row.last_seen_at),
    lastEvalAt: optionalNumber(row.obs_observed_at),
    lastEvalError: (row.obs_error as string | null) ?? null,
    clearSince: optionalNumber(row.obs_clear_since),
    surfacedAt: optionalNumber(row.surfaced_at),
    acknowledgedAt: optionalNumber(row.acknowledged_at),
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
    closedAt: optionalNumber(row.closed_at),
    closeReason: (row.close_reason as string | null) ?? null,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function addColumn(table: string, column: string, definition: string): void {
  try {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // column already exists
  }
}

export function ensureSignalSchema(): void {
  const path = getRaviDbPath();
  if (schemaPath === path) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      producer_type TEXT NOT NULL,
      producer_class TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      target_sessions_json TEXT,
      subject_type TEXT,
      subject_id TEXT,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      evidence_json TEXT,
      clear_when_json TEXT NOT NULL,
      state TEXT NOT NULL,
      previous_state TEXT,
      dedupe_key TEXT,
      cooldown_ms INTEGER NOT NULL,
      renotify_after_ms INTEGER NOT NULL,
      escalate_after_ms INTEGER,
      max_surfaces INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      reopen_after_ms INTEGER NOT NULL,
      muted_until INTEGER,
      mute_reason TEXT,
      surface_count INTEGER NOT NULL DEFAULT 0,
      escalation_count INTEGER NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_eval_at INTEGER,
      last_eval_error TEXT,
      clear_since INTEGER,
      surfaced_at INTEGER,
      acknowledged_at INTEGER,
      acknowledged_by TEXT,
      closed_at INTEGER,
      close_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_open_key
      ON signals(key) WHERE state NOT IN ('resolved','expired');
    CREATE INDEX IF NOT EXISTS idx_signals_state_scope
      ON signals(state, scope_type, scope_id, opened_at);
    CREATE INDEX IF NOT EXISTS idx_signals_opened
      ON signals(opened_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signals_sweep
      ON signals(opened_at, id);

    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_type TEXT,
      actor_id TEXT,
      message TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_events_signal
      ON signal_events(signal_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS signal_surfaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      route TEXT NOT NULL,
      session_name TEXT,
      turn_id TEXT,
      channel TEXT,
      budget_day TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_surfaces_day
      ON signal_surfaces(budget_day, route);
    CREATE INDEX IF NOT EXISTS idx_signal_surfaces_signal
      ON signal_surfaces(signal_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS signal_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface_id INTEGER NOT NULL,
      signal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      route TEXT NOT NULL,
      session_name TEXT,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      page_status TEXT,
      last_error TEXT,
      reserved_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_outbox_pending
      ON signal_outbox(status, id);

    CREATE TABLE IF NOT EXISTS signal_observations (
      signal_id TEXT PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      error TEXT,
      fields_json TEXT,
      clear_since INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signals_tick_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_successful_tick_at INTEGER,
      last_tick_at INTEGER,
      last_tick_error TEXT,
      tick_interval_ms INTEGER NOT NULL,
      stale_after_ms INTEGER NOT NULL,
      stale_after_source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_key_mutes (
      key TEXT PRIMARY KEY,
      muted_until INTEGER NOT NULL,
      reason TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // The ledger carries its status. Rows written before the status existed
  // were confirmed deliveries, so they default to `sent`.
  addColumn("signal_surfaces", "status", "TEXT NOT NULL DEFAULT 'sent'");
  addColumn("signal_surfaces", "idempotency_key", "TEXT");
  addColumn("signal_surfaces", "budget_bypass", "INTEGER NOT NULL DEFAULT 0");
  addColumn("signal_surfaces", "sent_at", "INTEGER");
  addColumn("signal_surfaces", "failed_at", "INTEGER");
  addColumn("signal_surfaces", "error", "TEXT");
  addColumn("signal_events", "version", "INTEGER");
  addColumn("signal_events", "from_state", "TEXT");
  addColumn("signal_events", "to_state", "TEXT");
  db.exec(`
    DROP INDEX IF EXISTS idx_signal_surfaces_bucket;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_surfaces_idempotency
      ON signal_surfaces(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_signal_surfaces_status
      ON signal_surfaces(budget_day, status, session_name);
  `);
  migrateFleetScopeToInstall();
  schemaPath = path;
}

/** Forget that the schema was checked, as a new process would. */
export function resetSignalSchemaCacheForTests(): void {
  schemaPath = null;
}

/**
 * `fleet` now names the set of Ravis of an organization, so the single-install
 * scope is `install`. Nobody enabled signals before the rename; rows and the
 * session setting are converted in place.
 */
function migrateFleetScopeToInstall(): void {
  getDb()
    .prepare(
      `UPDATE signals
       SET scope_type = 'install', scope_id = CASE WHEN scope_id = 'fleet' THEN 'install' ELSE scope_id END
       WHERE scope_type = 'fleet'`,
    )
    .run();
  const legacy = dbGetSetting("signals.fleet_session")?.trim();
  if (legacy && !dbGetSetting("signals.install_session")?.trim()) {
    dbSetSetting("signals.install_session", legacy);
  }
}

/** Insert a new record (version 1) and its `signal.raised` audit row in one transaction. */
export function dbInsertRaisedSignal(signal: SignalRecord, audit: SignalAudit, now: number): void {
  ensureSignalSchema();
  getDb()
    .transaction(() => {
      dbInsertSignal(signal);
      insertSignalEvent({ signalId: signal.id, ...audit, version: signal.version, toState: signal.state, now });
    })
    .immediate();
}

export function dbInsertSignal(signal: SignalRecord): void {
  ensureSignalSchema();
  getDb()
    .prepare(
      `
      INSERT INTO signals (
        id, key, schema_version, kind, producer_type, producer_class, producer_id,
        scope_type, scope_id, target_sessions_json, subject_type, subject_id,
        severity, title, detail, evidence_json, clear_when_json, state, previous_state,
        dedupe_key, cooldown_ms, renotify_after_ms, escalate_after_ms, max_surfaces,
        ttl_ms, reopen_after_ms, muted_until, mute_reason, surface_count, escalation_count,
        opened_at, last_seen_at, surfaced_at,
        acknowledged_at, acknowledged_by, closed_at, close_reason, version, created_at, updated_at
      ) VALUES (
        $id, $key, $schema_version, $kind, $producer_type, $producer_class, $producer_id,
        $scope_type, $scope_id, $target_sessions_json, $subject_type, $subject_id,
        $severity, $title, $detail, $evidence_json, $clear_when_json, $state, $previous_state,
        $dedupe_key, $cooldown_ms, $renotify_after_ms, $escalate_after_ms, $max_surfaces,
        $ttl_ms, $reopen_after_ms, $muted_until, $mute_reason, 0, 0,
        $opened_at, $last_seen_at, $surfaced_at,
        $acknowledged_at, $acknowledged_by, $closed_at, $close_reason, $version, $created_at, $updated_at
      )
    `,
    )
    .run({
      $id: signal.id,
      $key: signal.key,
      $schema_version: signal.schemaVersion,
      $kind: signal.kind,
      $producer_type: signal.producerType,
      $producer_class: signal.producerClass,
      $producer_id: signal.producerId,
      $scope_type: signal.scopeType,
      $scope_id: signal.scopeId,
      $target_sessions_json: json(signal.targetSessions),
      $subject_type: signal.subjectType ?? null,
      $subject_id: signal.subjectId ?? null,
      $severity: signal.severity,
      $title: signal.title,
      $detail: signal.detail ?? null,
      $evidence_json: json(signal.evidence),
      $clear_when_json: json(signal.clearWhen),
      $state: signal.state,
      $previous_state: signal.previousState ?? null,
      $dedupe_key: signal.dedupeKey ?? null,
      $cooldown_ms: signal.cooldownMs,
      $renotify_after_ms: signal.renotifyAfterMs,
      $escalate_after_ms: signal.escalateAfterMs ?? null,
      $max_surfaces: signal.maxSurfaces,
      $ttl_ms: signal.ttlMs,
      $reopen_after_ms: signal.reopenAfterMs,
      $muted_until: signal.mutedUntil ?? null,
      $mute_reason: signal.muteReason ?? null,
      $opened_at: signal.openedAt,
      $last_seen_at: signal.lastSeenAt,
      $surfaced_at: signal.surfacedAt ?? null,
      $acknowledged_at: signal.acknowledgedAt ?? null,
      $acknowledged_by: signal.acknowledgedBy ?? null,
      $closed_at: signal.closedAt ?? null,
      $close_reason: signal.closeReason ?? null,
      $version: signal.version,
      $created_at: signal.createdAt,
      $updated_at: signal.updatedAt,
    });
}

/**
 * Compare-and-swap write of the mutable record fields: applies only when the
 * stored version still equals `expectedVersion`, and stores `signal.version`.
 * Returns false when another writer moved the version first.
 */
function casUpdateSignal(signal: SignalRecord, expectedVersion: number): boolean {
  const result = getDb()
    .prepare(
      `
      UPDATE signals SET
        severity = $severity,
        title = $title,
        detail = $detail,
        evidence_json = $evidence_json,
        clear_when_json = $clear_when_json,
        state = $state,
        previous_state = $previous_state,
        target_sessions_json = $target_sessions_json,
        subject_type = $subject_type,
        subject_id = $subject_id,
        dedupe_key = $dedupe_key,
        cooldown_ms = $cooldown_ms,
        renotify_after_ms = $renotify_after_ms,
        escalate_after_ms = $escalate_after_ms,
        max_surfaces = $max_surfaces,
        ttl_ms = $ttl_ms,
        reopen_after_ms = $reopen_after_ms,
        muted_until = $muted_until,
        mute_reason = $mute_reason,
        opened_at = $opened_at,
        last_seen_at = $last_seen_at,
        surfaced_at = $surfaced_at,
        acknowledged_at = $acknowledged_at,
        acknowledged_by = $acknowledged_by,
        closed_at = $closed_at,
        close_reason = $close_reason,
        version = $version,
        updated_at = $updated_at
      WHERE id = $id AND version = $expected_version
    `,
    )
    .run({
      $id: signal.id,
      $expected_version: expectedVersion,
      $severity: signal.severity,
      $title: signal.title,
      $detail: signal.detail ?? null,
      $evidence_json: json(signal.evidence),
      $clear_when_json: json(signal.clearWhen),
      $state: signal.state,
      $previous_state: signal.previousState ?? null,
      $target_sessions_json: json(signal.targetSessions),
      $subject_type: signal.subjectType ?? null,
      $subject_id: signal.subjectId ?? null,
      $dedupe_key: signal.dedupeKey ?? null,
      $cooldown_ms: signal.cooldownMs,
      $renotify_after_ms: signal.renotifyAfterMs,
      $escalate_after_ms: signal.escalateAfterMs ?? null,
      $max_surfaces: signal.maxSurfaces,
      $ttl_ms: signal.ttlMs,
      $reopen_after_ms: signal.reopenAfterMs,
      $muted_until: signal.mutedUntil ?? null,
      $mute_reason: signal.muteReason ?? null,
      $opened_at: signal.openedAt,
      $last_seen_at: signal.lastSeenAt,
      $surfaced_at: signal.surfacedAt ?? null,
      $acknowledged_at: signal.acknowledgedAt ?? null,
      $acknowledged_by: signal.acknowledgedBy ?? null,
      $closed_at: signal.closedAt ?? null,
      $close_reason: signal.closeReason ?? null,
      $version: signal.version,
      $updated_at: signal.updatedAt,
    });
  return result.changes > 0;
}

/**
 * Raw overwrite that bypasses versioning and audit. Production code never
 * calls it: it exists so tests can plant legacy or corrupted rows.
 */
export function dbOverwriteSignalForTests(signal: SignalRecord): void {
  ensureSignalSchema();
  const stored = getDb().prepare("SELECT version FROM signals WHERE id = ?").get(signal.id) as
    | { version: number }
    | undefined;
  if (stored) casUpdateSignal(signal, Number(stored.version));
}

export interface SignalAudit {
  type: string;
  actorType: string;
  actorId?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

/**
 * Persist one named transition: the record moves from `before.version` to
 * `before.version + 1` and one audit row records actor, time, reason and both
 * states. The write is a compare-and-swap; `false` means the version moved and
 * the caller must re-read and re-validate before trying again.
 */
export function dbCommitSignalTransition(
  before: Pick<SignalRecord, "id" | "version" | "state">,
  next: SignalRecord,
  audit: SignalAudit,
  now: number,
): boolean {
  ensureSignalSchema();
  const db = getDb();
  const apply = db.transaction(() => {
    next.version = before.version + 1;
    next.updatedAt = now;
    if (!casUpdateSignal(next, before.version)) return false;
    insertSignalEvent({
      signalId: next.id,
      ...audit,
      version: next.version,
      fromState: before.state,
      toState: next.state,
      now,
    });
    return true;
  });
  const committed = apply.immediate() as boolean;
  if (!committed) next.version = before.version;
  return committed;
}

export function dbGetSignalById(id: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare(`${SIGNAL_SELECT} WHERE s.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToSignal(row) : null;
}

export function dbGetNonTerminalSignalByKey(key: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb()
    .prepare(
      `${SIGNAL_SELECT} WHERE s.key = ? AND s.state NOT IN ('resolved','expired') ORDER BY s.opened_at DESC LIMIT 1`,
    )
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToSignal(row) : null;
}

export function dbGetLatestSignalByKey(key: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare(`${SIGNAL_SELECT} WHERE s.key = ? ORDER BY s.updated_at DESC LIMIT 1`).get(key) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSignal(row) : null;
}

function listFilters(options: ListSignalsOptions): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.state === "non_terminal") {
    where.push("s.state NOT IN ('resolved','expired')");
  } else if (options.state) {
    where.push("s.state = ?");
    params.push(options.state);
  }
  if (options.scopeType) {
    where.push("s.scope_type = ?");
    params.push(options.scopeType);
  }
  if (options.scopeId) {
    where.push("s.scope_id = ?");
    params.push(options.scopeId);
  }
  if (options.key) {
    where.push("s.key = ?");
    params.push(options.key);
  }
  return { where, params };
}

export function dbListSignals(options: ListSignalsOptions = {}): SignalRecord[] {
  ensureSignalSchema();
  const { where, params } = listFilters(options);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`${SIGNAL_SELECT} ${clause} ORDER BY s.opened_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSignal);
}

/**
 * Every matching record, in pages of `pageSize` by `(opened_at, id)` (keyset
 * pagination). A sweep visits all open records; it never stops at "newest N".
 */
export function* dbIterateSignals(
  options: Omit<ListSignalsOptions, "limit" | "offset"> = {},
  pageSize = 200,
): Generator<SignalRecord> {
  ensureSignalSchema();
  const { where, params } = listFilters(options);
  let cursor: { openedAt: number; id: string } | null = null;
  while (true) {
    const pageWhere = [...where];
    const pageParams = [...params];
    if (cursor) {
      pageWhere.push("(s.opened_at > ? OR (s.opened_at = ? AND s.id > ?))");
      pageParams.push(cursor.openedAt, cursor.openedAt, cursor.id);
    }
    const clause = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";
    const rows = getDb()
      .prepare(`${SIGNAL_SELECT} ${clause} ORDER BY s.opened_at ASC, s.id ASC LIMIT ?`)
      .all(...pageParams, pageSize) as Record<string, unknown>[];
    for (const row of rows) yield rowToSignal(row);
    if (rows.length < pageSize) return;
    const last = rows[rows.length - 1]!;
    cursor = { openedAt: Number(last.opened_at), id: String(last.id) };
  }
}

export function dbListNonTerminalSignals(): SignalRecord[] {
  return [...dbIterateSignals({ state: "non_terminal" })];
}

function insertSignalEvent(input: {
  signalId: string;
  type: string;
  actorType?: string;
  actorId?: string;
  message?: string;
  payload?: Record<string, unknown>;
  version?: number;
  fromState?: string;
  toState?: string;
  now?: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO signal_events
        (signal_id, type, actor_type, actor_id, message, payload_json, version, from_state, to_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.signalId,
      input.type,
      input.actorType ?? null,
      input.actorId ?? null,
      input.message ?? null,
      json(input.payload) ?? null,
      input.version ?? null,
      input.fromState ?? null,
      input.toState ?? null,
      input.now ?? Date.now(),
    );
}

/**
 * An audit note that is not a transition (an evaluation failure, a skipped
 * delivery). It carries no version and does not move the record.
 */
export function dbAppendSignalEvent(input: {
  signalId: string;
  type: string;
  actorType?: string;
  actorId?: string;
  message?: string;
  payload?: Record<string, unknown>;
  now?: number;
}): void {
  ensureSignalSchema();
  insertSignalEvent(input);
}

export function dbListSignalEvents(signalId: string, limit = 50): SignalEventRecord[] {
  ensureSignalSchema();
  const rows = getDb()
    .prepare("SELECT * FROM signal_events WHERE signal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(signalId, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    signalId: String(row.signal_id),
    type: String(row.type),
    actorType: (row.actor_type as string | null) ?? undefined,
    actorId: (row.actor_id as string | null) ?? undefined,
    message: (row.message as string | null) ?? undefined,
    payload: parseJson<Record<string, unknown>>(row.payload_json as string | null),
    ...(row.version === null || row.version === undefined ? {} : { version: Number(row.version) }),
    ...(row.from_state ? { fromState: String(row.from_state) } : {}),
    ...(row.to_state ? { toState: String(row.to_state) } : {}),
    createdAt: Number(row.created_at),
  }));
}

export function budgetDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Observation cache (written by the tick, read by render)
// ---------------------------------------------------------------------------

export function dbWriteSignalObservation(observation: SignalObservation, now = Date.now()): void {
  ensureSignalSchema();
  getDb()
    .prepare(
      `INSERT INTO signal_observations (signal_id, observed_at, error, fields_json, clear_since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET
         observed_at = excluded.observed_at,
         error = excluded.error,
         fields_json = excluded.fields_json,
         clear_since = excluded.clear_since,
         updated_at = excluded.updated_at`,
    )
    .run(
      observation.signalId,
      observation.observedAt,
      observation.error ?? null,
      json(observation.fields),
      observation.clearSince ?? null,
      now,
    );
}

export function dbGetSignalObservation(signalId: string): SignalObservation | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signal_observations WHERE signal_id = ?").get(signalId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    signalId,
    observedAt: Number(row.observed_at),
    error: (row.error as string | null) ?? null,
    fields: parseJson<Record<string, unknown>>(row.fields_json as string | null),
    clearSince: optionalNumber(row.clear_since),
  };
}

export function dbClearSignalObservation(signalId: string): void {
  ensureSignalSchema();
  getDb().prepare("DELETE FROM signal_observations WHERE signal_id = ?").run(signalId);
}

// ---------------------------------------------------------------------------
// Tick freshness anchor
// ---------------------------------------------------------------------------

function resolveStaleAfter(tickIntervalMs: number): { staleAfterMs: number; source: "setting" | "default" } {
  const raw = dbGetSetting("signals.stale_after_ms")?.trim();
  const configured = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(configured) && configured > 0) {
    return { staleAfterMs: Math.floor(configured), source: "setting" };
  }
  return { staleAfterMs: 2 * tickIntervalMs, source: "default" };
}

function rowToTickState(row: Record<string, unknown>): SignalTickState {
  return {
    lastSuccessfulTickAt: optionalNumber(row.last_successful_tick_at),
    lastTickAt: optionalNumber(row.last_tick_at),
    lastTickError: (row.last_tick_error as string | null) ?? null,
    tickIntervalMs: Number(row.tick_interval_ms),
    staleAfterMs: Number(row.stale_after_ms),
    staleAfterSource: row.stale_after_source === "setting" ? "setting" : "default",
  };
}

/**
 * The durable freshness anchor. Without a stored row the effective values are
 * still explicit: the default interval and `2 × interval` (or the setting).
 */
export function dbGetTickState(): SignalTickState {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signals_tick_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (row) {
    const state = rowToTickState(row);
    // An operator override applies as soon as it is set; the next tick persists it.
    const stale = resolveStaleAfter(state.tickIntervalMs);
    return { ...state, staleAfterMs: stale.staleAfterMs, staleAfterSource: stale.source };
  }
  const stale = resolveStaleAfter(SIGNALS_TICK_INTERVAL_MS);
  return {
    lastSuccessfulTickAt: null,
    lastTickAt: null,
    lastTickError: null,
    tickIntervalMs: SIGNALS_TICK_INTERVAL_MS,
    staleAfterMs: stale.staleAfterMs,
    staleAfterSource: stale.source,
  };
}

/**
 * Record one executed tick. Only a tick that completed without error advances
 * `last_successful_tick_at`; the effective `stale_after_ms` is persisted with it.
 */
export function dbRecordTickRun(input: {
  now: number;
  tickIntervalMs: number;
  error?: string | null;
}): SignalTickState {
  ensureSignalSchema();
  const stale = resolveStaleAfter(input.tickIntervalMs);
  const success = !input.error;
  getDb()
    .prepare(
      `INSERT INTO signals_tick_state
        (id, last_successful_tick_at, last_tick_at, last_tick_error, tick_interval_ms, stale_after_ms, stale_after_source, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_successful_tick_at = CASE WHEN ? THEN excluded.last_successful_tick_at ELSE signals_tick_state.last_successful_tick_at END,
         last_tick_at = excluded.last_tick_at,
         last_tick_error = excluded.last_tick_error,
         tick_interval_ms = excluded.tick_interval_ms,
         stale_after_ms = excluded.stale_after_ms,
         stale_after_source = excluded.stale_after_source,
         updated_at = excluded.updated_at`,
    )
    .run(
      success ? input.now : null,
      input.now,
      input.error ?? null,
      input.tickIntervalMs,
      stale.staleAfterMs,
      stale.source,
      input.now,
      success ? 1 : 0,
    );
  return dbGetTickState();
}

// ---------------------------------------------------------------------------
// Surface ledger and outbox
// ---------------------------------------------------------------------------

function rowToSurface(row: Record<string, unknown>): SignalSurfaceRecord {
  return {
    id: Number(row.id),
    signalId: String(row.signal_id),
    route: row.route as SignalSurfaceRoute,
    status: (row.status as SignalSurfaceStatus) ?? "sent",
    sessionName: (row.session_name as string | null) ?? undefined,
    turnId: (row.turn_id as string | null) ?? undefined,
    idempotencyKey: (row.idempotency_key as string | null) ?? undefined,
    budgetDay: String(row.budget_day),
    budgetBypass: Number(row.budget_bypass ?? 0) === 1,
    error: (row.error as string | null) ?? undefined,
    createdAt: Number(row.created_at),
    sentAt: optionalNumber(row.sent_at),
    failedAt: optionalNumber(row.failed_at),
  };
}

function rowToOutbox(row: Record<string, unknown>): SignalOutboxRecord {
  return {
    id: Number(row.id),
    surfaceId: Number(row.surface_id),
    signalId: String(row.signal_id),
    idempotencyKey: String(row.idempotency_key),
    route: row.route as SignalSurfaceRoute,
    sessionName: (row.session_name as string | null) ?? undefined,
    severity: row.severity as SignalSeverity,
    status: row.status as SignalSurfaceStatus,
    attempts: Number(row.attempts),
    pageStatus: (row.page_status as SignalOutboxRecord["pageStatus"]) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    reservedVersion: Number(row.reserved_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Budget units taken today: `pending` reserves and `sent` consumes; `failed` and audited bypasses count zero. */
export function dbCountBudgetUnits(day: string, sessionName?: string): number {
  ensureSignalSchema();
  const row = sessionName
    ? (getDb()
        .prepare(
          `SELECT COUNT(*) AS total FROM signal_surfaces
           WHERE budget_day = ? AND status IN ('pending','sent') AND budget_bypass = 0 AND session_name = ?`,
        )
        .get(day, sessionName) as { total: number })
    : (getDb()
        .prepare(
          `SELECT COUNT(*) AS total FROM signal_surfaces
           WHERE budget_day = ? AND status IN ('pending','sent') AND budget_bypass = 0`,
        )
        .get(day) as { total: number });
  return Number(row.total);
}

/** Daily OOB slots taken (pending + sent), across sessions. */
export function dbCountOobSlots(day: string): number {
  ensureSignalSchema();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total FROM signal_surfaces
       WHERE budget_day = ? AND route IN ('oob','page') AND status IN ('pending','sent') AND budget_bypass = 0`,
    )
    .get(day) as { total: number };
  return Number(row.total);
}

/** Surfaces of one signal in one day by status, the ledger the totals derive from. */
export function dbCountSignalSurfaces(signalId: string, day: string, status: SignalSurfaceStatus): number {
  ensureSignalSchema();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM signal_surfaces WHERE signal_id = ? AND budget_day = ? AND status = ?")
    .get(signalId, day, status) as { total: number };
  return Number(row.total);
}

export function dbListSignalSurfaces(signalId: string): SignalSurfaceRecord[] {
  ensureSignalSchema();
  const rows = getDb()
    .prepare("SELECT * FROM signal_surfaces WHERE signal_id = ? ORDER BY id ASC")
    .all(signalId) as Record<string, unknown>[];
  return rows.map(rowToSurface);
}

export function dbGetSignalSurface(id: number): SignalSurfaceRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signal_surfaces WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSurface(row) : null;
}

/** Last confirmed surface: only a `sent` row starts a cooldown. */
export function dbGetLastSurfaceAt(signalId: string, route?: SignalSurfaceRoute): number | null {
  ensureSignalSchema();
  const row = route
    ? (getDb()
        .prepare(
          "SELECT MAX(COALESCE(sent_at, created_at)) AS last FROM signal_surfaces WHERE signal_id = ? AND route = ? AND status = 'sent'",
        )
        .get(signalId, route) as { last: number | null })
    : (getDb()
        .prepare(
          "SELECT MAX(COALESCE(sent_at, created_at)) AS last FROM signal_surfaces WHERE signal_id = ? AND status = 'sent'",
        )
        .get(signalId) as { last: number | null });
  return row.last === null ? null : Number(row.last);
}

export function dbGetLastOobAt(signalId: string): number | null {
  ensureSignalSchema();
  const row = getDb()
    .prepare(
      "SELECT MAX(COALESCE(sent_at, created_at)) AS last FROM signal_surfaces WHERE signal_id = ? AND route IN ('oob','page') AND status = 'sent'",
    )
    .get(signalId) as { last: number | null };
  return row.last === null ? null : Number(row.last);
}

export function dbHasPendingSurface(signalId: string, routes: SignalSurfaceRoute[]): boolean {
  ensureSignalSchema();
  const placeholders = routes.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT 1 AS found FROM signal_surfaces WHERE signal_id = ? AND status = 'pending' AND route IN (${placeholders}) LIMIT 1`,
    )
    .get(signalId, ...routes) as { found: number } | undefined;
  return Boolean(row);
}

export type SignalReserveDecision =
  | { ok: true; budgetBypass?: boolean }
  | { ok: false; reason: "budget" | "oob_budget" | "pending" | "ineligible" | "stale_version" };

export interface SignalReservation {
  surfaceId: number;
  outboxId: number;
  idempotencyKey: string;
  signal: SignalRecord;
  budgetBypass: boolean;
}

/**
 * Reserve one logical surface: in a single immediate transaction, check the
 * budget against the ledger, insert the `pending` ledger row and its outbox row
 * under one idempotency key, and move the record by one version. Two workers
 * can never spend the same unit; a `pending` row consumes nothing and starts
 * no cooldown.
 */
export function dbReserveSignalSurface(input: {
  signalId: string;
  expectedVersion: number;
  route: SignalSurfaceRoute;
  severity: SignalSeverity;
  sessionName: string;
  turnId?: string;
  idempotencyKey: (sequence: number) => string;
  decide: (ledger: {
    day: string;
    budgetUnits: number;
    oobSlots: number;
    signal: SignalRecord;
  }) => SignalReserveDecision;
  actorId: string;
  now: number;
}): { reserved: SignalReservation } | { skipped: Exclude<SignalReserveDecision, { ok: true }>["reason"] } {
  ensureSignalSchema();
  const db = getDb();
  const day = budgetDay(input.now);
  const run = db.transaction(() => {
    const signal = dbGetSignalById(input.signalId);
    if (!signal || signal.state === "resolved" || signal.state === "expired") {
      return { skipped: "ineligible" as const };
    }
    if (signal.version !== input.expectedVersion) return { skipped: "stale_version" as const };
    if (dbHasPendingSurface(signal.id, input.route === "piggyback" ? ["piggyback"] : ["oob", "page"])) {
      return { skipped: "pending" as const };
    }
    const decision = input.decide({
      day,
      budgetUnits: dbCountBudgetUnits(day, input.sessionName),
      oobSlots: dbCountOobSlots(day),
      signal,
    });
    if (!decision.ok) return { skipped: decision.reason };
    const sequence =
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS total FROM signal_surfaces WHERE signal_id = ? AND route = ? AND budget_day = ?",
            )
            .get(signal.id, input.route, day) as { total: number }
        ).total,
      ) + 1;
    const idempotencyKey = input.idempotencyKey(sequence);
    const budgetBypass = decision.budgetBypass === true;
    const surface = db
      .prepare(
        `INSERT INTO signal_surfaces
          (signal_id, route, session_name, turn_id, budget_day, status, idempotency_key, budget_bypass, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        signal.id,
        input.route,
        input.sessionName,
        input.turnId ?? null,
        day,
        idempotencyKey,
        budgetBypass ? 1 : 0,
        input.now,
      );
    const surfaceId = Number(surface.lastInsertRowid);
    const before = { id: signal.id, version: signal.version, state: signal.state };
    const next = { ...signal };
    next.version = signal.version + 1;
    next.updatedAt = input.now;
    if (!casUpdateSignal(next, before.version)) {
      throw new Error("signal version moved during reservation");
    }
    insertSignalEvent({
      signalId: signal.id,
      type: "signal.reserved",
      actorType: "system",
      actorId: input.actorId,
      payload: {
        route: input.route,
        sessionName: input.sessionName,
        surfaceId,
        idempotencyKey,
        ...(budgetBypass ? { budgetBypass: true } : {}),
      },
      version: next.version,
      fromState: before.state,
      toState: next.state,
      now: input.now,
    });
    if (budgetBypass) {
      insertSignalEvent({
        signalId: signal.id,
        type: "signal.budget_bypass",
        actorType: "system",
        actorId: input.actorId,
        message: "page on a fact with a fresh, successful evaluation bypasses the daily budget",
        payload: { surfaceId, route: input.route },
        now: input.now,
      });
    }
    const outbox = db
      .prepare(
        `INSERT INTO signal_outbox
          (surface_id, signal_id, idempotency_key, route, session_name, severity, status, attempts, reserved_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        surfaceId,
        signal.id,
        idempotencyKey,
        input.route,
        input.sessionName,
        input.severity,
        next.version,
        input.now,
        input.now,
      );
    return {
      reserved: {
        surfaceId,
        outboxId: Number(outbox.lastInsertRowid),
        idempotencyKey,
        signal: next,
        budgetBypass,
      },
    };
  });
  return run.immediate() as ReturnType<typeof dbReserveSignalSurface>;
}

/**
 * Confirm a reserved surface after the send succeeded: the ledger row and the
 * outbox row become `sent` and the record moves to `surfaced` by one version.
 * Keyed by the surface id, so a repeated confirm is a no-op.
 */
export function dbConfirmSignalSurface(input: {
  surfaceId: number;
  actorId: string;
  now: number;
  pageStatus?: SignalOutboxRecord["pageStatus"];
  payload?: Record<string, unknown>;
}): SignalRecord | null {
  ensureSignalSchema();
  const db = getDb();
  const run = db.transaction(() => {
    const surface = dbGetSignalSurface(input.surfaceId);
    if (!surface || surface.status !== "pending") return null;
    db.prepare("UPDATE signal_surfaces SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'pending'").run(
      input.now,
      input.surfaceId,
    );
    db.prepare(
      `UPDATE signal_outbox SET status = 'sent', page_status = COALESCE(?, page_status), updated_at = ?
       WHERE surface_id = ?`,
    ).run(input.pageStatus ?? null, input.now, input.surfaceId);
    const signal = dbGetSignalById(surface.signalId);
    if (!signal) return null;
    const next = { ...signal };
    if (next.state === "open" || next.state === "acknowledged") next.state = "surfaced";
    next.surfacedAt = input.now;
    next.version = signal.version + 1;
    next.updatedAt = input.now;
    casUpdateSignal(next, signal.version);
    insertSignalEvent({
      signalId: signal.id,
      type: surface.route === "piggyback" ? "signal.surfaced" : "signal.escalated",
      actorType: "system",
      actorId: input.actorId,
      payload: {
        route: surface.route,
        sessionName: surface.sessionName ?? null,
        surfaceId: surface.id,
        idempotencyKey: surface.idempotencyKey ?? null,
        ...(input.pageStatus ? { pageLine: input.pageStatus } : {}),
        ...(input.payload ?? {}),
      },
      version: next.version,
      fromState: signal.state,
      toState: next.state,
      now: input.now,
    });
    return next;
  });
  return run.immediate() as SignalRecord | null;
}

/**
 * Release a reservation: the ledger row becomes `failed` (it counts zero and
 * returns the unit and the OOB slot) and the outbox row stops retrying.
 */
export function dbReleaseSignalSurface(input: {
  surfaceId: number;
  reason: string;
  actorId: string;
  now: number;
}): boolean {
  ensureSignalSchema();
  const db = getDb();
  const run = db.transaction(() => {
    const surface = dbGetSignalSurface(input.surfaceId);
    if (!surface || surface.status !== "pending") return false;
    db.prepare(
      "UPDATE signal_surfaces SET status = 'failed', failed_at = ?, error = ? WHERE id = ? AND status = 'pending'",
    ).run(input.now, input.reason, input.surfaceId);
    db.prepare(
      "UPDATE signal_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE surface_id = ? AND status = 'pending'",
    ).run(input.reason, input.now, input.surfaceId);
    insertSignalEvent({
      signalId: surface.signalId,
      type: "signal.reservation_released",
      actorType: "system",
      actorId: input.actorId,
      message: input.reason,
      payload: { route: surface.route, surfaceId: surface.id, sessionName: surface.sessionName ?? null },
      now: input.now,
    });
    return true;
  });
  return run.immediate() as boolean;
}

/** Record a retryable send failure: the row stays `pending` under the same key. */
export function dbRecordOutboxAttempt(input: {
  outboxId: number;
  error?: string | null;
  pageStatus?: SignalOutboxRecord["pageStatus"];
  reservedVersion?: number;
  now: number;
}): void {
  ensureSignalSchema();
  getDb()
    .prepare(
      `UPDATE signal_outbox SET
         attempts = attempts + 1,
         last_error = ?,
         page_status = COALESCE(?, page_status),
         reserved_version = COALESCE(?, reserved_version),
         updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(input.error ?? null, input.pageStatus ?? null, input.reservedVersion ?? null, input.now, input.outboxId);
}

export function dbGetOutboxRow(id: number): SignalOutboxRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signal_outbox WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOutbox(row) : null;
}

export function dbListPendingOutbox(routes: SignalSurfaceRoute[] = ["oob", "page"]): SignalOutboxRecord[] {
  ensureSignalSchema();
  const placeholders = routes.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(`SELECT * FROM signal_outbox WHERE status = 'pending' AND route IN (${placeholders}) ORDER BY id ASC`)
    .all(...routes) as Record<string, unknown>[];
  return rows.map(rowToOutbox);
}

// ---------------------------------------------------------------------------
// Key mutes, tick lock, retention
// ---------------------------------------------------------------------------

export function dbSetKeyMute(key: string, mutedUntil: number, reason: string | undefined, now = Date.now()): void {
  ensureSignalSchema();
  getDb()
    .prepare(
      `INSERT INTO signal_key_mutes (key, muted_until, reason, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET muted_until = excluded.muted_until, reason = excluded.reason, updated_at = excluded.updated_at`,
    )
    .run(key, mutedUntil, reason ?? null, now);
}

export function dbGetKeyMute(key: string, now = Date.now()): { mutedUntil: number; reason?: string } | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signal_key_mutes WHERE key = ?").get(key) as
    | { muted_until: number; reason: string | null }
    | undefined;
  if (!row || Number(row.muted_until) <= now) return null;
  return { mutedUntil: Number(row.muted_until), reason: row.reason ?? undefined };
}

export function dbClearKeyMute(key: string): void {
  ensureSignalSchema();
  getDb().prepare("DELETE FROM signal_key_mutes WHERE key = ?").run(key);
}

export function dbAcquireTickLock(holder: string, now = Date.now(), staleMs = 10 * 60_000): boolean {
  ensureSignalSchema();
  // One conditional write: two processes that both saw a free or stale lock
  // cannot both take it. An unreadable lock value counts as free.
  const result = getDb()
    .prepare(
      `INSERT INTO signal_meta (key, value, updated_at) VALUES ('tick_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CASE
         WHEN json_valid(signal_meta.value) THEN
           json_extract(signal_meta.value, '$.holder') IS ?
           OR json_extract(signal_meta.value, '$.acquiredAt') IS NULL
           OR json_extract(signal_meta.value, '$.acquiredAt') <= ?
         ELSE 1
       END`,
    )
    .run(JSON.stringify({ holder, acquiredAt: now }), now, holder, now - staleMs);
  return result.changes > 0;
}

export function dbReleaseTickLock(holder: string): void {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT value FROM signal_meta WHERE key = 'tick_lock'").get() as
    | { value: string }
    | undefined;
  const parsed = row ? parseJson<{ holder: string }>(row.value) : undefined;
  if (parsed?.holder === holder) {
    getDb().prepare("DELETE FROM signal_meta WHERE key = 'tick_lock'").run();
  }
}

export function dbPruneSignals(now = Date.now(), retentionMs = 30 * 86_400_000): number {
  ensureSignalSchema();
  const cutoff = now - retentionMs;
  const db = getDb();
  const result = db
    .prepare("DELETE FROM signals WHERE state IN ('resolved','expired') AND COALESCE(closed_at, updated_at) < ?")
    .run(cutoff);
  db.prepare("DELETE FROM signal_surfaces WHERE created_at < ? AND status != 'pending'").run(cutoff);
  db.prepare("DELETE FROM signal_outbox WHERE created_at < ? AND status != 'pending'").run(cutoff);
  db.prepare("DELETE FROM signal_events WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM signal_observations WHERE signal_id NOT IN (SELECT id FROM signals)").run();
  return result.changes;
}
