import { getDb, getRaviDbPath } from "../router/router-db.js";
import type {
  ClearWhen,
  ListSignalsOptions,
  SignalEventRecord,
  SignalKind,
  SignalProducerClass,
  SignalProducerType,
  SignalRecord,
  SignalScopeType,
  SignalSeverity,
  SignalState,
  SignalSubjectType,
  SignalSurfaceRoute,
} from "./types.js";

let schemaPath: string | null = null;

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
    escalateAfterMs:
      row.escalate_after_ms === null || row.escalate_after_ms === undefined ? null : Number(row.escalate_after_ms),
    maxSurfaces: Number(row.max_surfaces),
    ttlMs: Number(row.ttl_ms),
    reopenAfterMs: Number(row.reopen_after_ms),
    mutedUntil: row.muted_until === null || row.muted_until === undefined ? null : Number(row.muted_until),
    muteReason: (row.mute_reason as string | null) ?? undefined,
    surfaceCount: Number(row.surface_count),
    escalationCount: Number(row.escalation_count),
    openedAt: Number(row.opened_at),
    lastSeenAt: Number(row.last_seen_at),
    lastEvalAt: row.last_eval_at === null || row.last_eval_at === undefined ? null : Number(row.last_eval_at),
    lastEvalError: (row.last_eval_error as string | null) ?? null,
    clearSince: row.clear_since === null || row.clear_since === undefined ? null : Number(row.clear_since),
    surfacedAt: row.surfaced_at === null || row.surfaced_at === undefined ? null : Number(row.surfaced_at),
    acknowledgedAt:
      row.acknowledged_at === null || row.acknowledged_at === undefined ? null : Number(row.acknowledged_at),
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
    closeReason: (row.close_reason as string | null) ?? null,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_surfaces_bucket
      ON signal_surfaces(signal_id, route, budget_day, COALESCE(turn_id, ''));
    CREATE INDEX IF NOT EXISTS idx_signal_surfaces_day
      ON signal_surfaces(budget_day, route);
    CREATE INDEX IF NOT EXISTS idx_signal_surfaces_signal
      ON signal_surfaces(signal_id, created_at DESC);

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
  schemaPath = path;
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
        opened_at, last_seen_at, last_eval_at, last_eval_error, clear_since, surfaced_at,
        acknowledged_at, acknowledged_by, closed_at, close_reason, version, created_at, updated_at
      ) VALUES (
        $id, $key, $schema_version, $kind, $producer_type, $producer_class, $producer_id,
        $scope_type, $scope_id, $target_sessions_json, $subject_type, $subject_id,
        $severity, $title, $detail, $evidence_json, $clear_when_json, $state, $previous_state,
        $dedupe_key, $cooldown_ms, $renotify_after_ms, $escalate_after_ms, $max_surfaces,
        $ttl_ms, $reopen_after_ms, $muted_until, $mute_reason, $surface_count, $escalation_count,
        $opened_at, $last_seen_at, $last_eval_at, $last_eval_error, $clear_since, $surfaced_at,
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
      $surface_count: signal.surfaceCount,
      $escalation_count: signal.escalationCount,
      $opened_at: signal.openedAt,
      $last_seen_at: signal.lastSeenAt,
      $last_eval_at: signal.lastEvalAt ?? null,
      $last_eval_error: signal.lastEvalError ?? null,
      $clear_since: signal.clearSince ?? null,
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

export function dbUpdateSignal(signal: SignalRecord): void {
  ensureSignalSchema();
  getDb()
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
        surface_count = $surface_count,
        escalation_count = $escalation_count,
        last_seen_at = $last_seen_at,
        last_eval_at = $last_eval_at,
        last_eval_error = $last_eval_error,
        clear_since = $clear_since,
        surfaced_at = $surfaced_at,
        acknowledged_at = $acknowledged_at,
        acknowledged_by = $acknowledged_by,
        closed_at = $closed_at,
        close_reason = $close_reason,
        version = $version,
        updated_at = $updated_at
      WHERE id = $id
    `,
    )
    .run({
      $id: signal.id,
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
      $surface_count: signal.surfaceCount,
      $escalation_count: signal.escalationCount,
      $last_seen_at: signal.lastSeenAt,
      $last_eval_at: signal.lastEvalAt ?? null,
      $last_eval_error: signal.lastEvalError ?? null,
      $clear_since: signal.clearSince ?? null,
      $surfaced_at: signal.surfacedAt ?? null,
      $acknowledged_at: signal.acknowledgedAt ?? null,
      $acknowledged_by: signal.acknowledgedBy ?? null,
      $closed_at: signal.closedAt ?? null,
      $close_reason: signal.closeReason ?? null,
      $version: signal.version,
      $updated_at: signal.updatedAt,
    });
}

export function dbGetSignalById(id: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSignal(row) : null;
}

export function dbGetNonTerminalSignalByKey(key: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb()
    .prepare(
      "SELECT * FROM signals WHERE key = ? AND state NOT IN ('resolved','expired') ORDER BY opened_at DESC LIMIT 1",
    )
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToSignal(row) : null;
}

export function dbGetLatestSignalByKey(key: string): SignalRecord | null {
  ensureSignalSchema();
  const row = getDb().prepare("SELECT * FROM signals WHERE key = ? ORDER BY opened_at DESC LIMIT 1").get(key) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSignal(row) : null;
}

export function dbListSignals(options: ListSignalsOptions = {}): SignalRecord[] {
  ensureSignalSchema();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (options.state === "non_terminal") {
    filters.push("state NOT IN ('resolved','expired')");
  } else if (options.state) {
    filters.push("state = ?");
    params.push(options.state);
  }
  if (options.scopeType) {
    filters.push("scope_type = ?");
    params.push(options.scopeType);
  }
  if (options.scopeId) {
    filters.push("scope_id = ?");
    params.push(options.scopeId);
  }
  if (options.key) {
    filters.push("key = ?");
    params.push(options.key);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM signals ${where} ORDER BY opened_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSignal);
}

export function dbListNonTerminalSignals(): SignalRecord[] {
  return dbListSignals({ state: "non_terminal", limit: 500 });
}

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
  getDb()
    .prepare(
      `INSERT INTO signal_events (signal_id, type, actor_type, actor_id, message, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.signalId,
      input.type,
      input.actorType ?? null,
      input.actorId ?? null,
      input.message ?? null,
      json(input.payload) ?? null,
      input.now ?? Date.now(),
    );
}

export function dbListSignalEvents(signalId: string, limit = 50): SignalEventRecord[] {
  ensureSignalSchema();
  const rows = getDb()
    .prepare("SELECT * FROM signal_events WHERE signal_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(signalId, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    signalId: String(row.signal_id),
    type: String(row.type),
    actorType: (row.actor_type as string | null) ?? undefined,
    actorId: (row.actor_id as string | null) ?? undefined,
    message: (row.message as string | null) ?? undefined,
    payload: parseJson<Record<string, unknown>>(row.payload_json as string | null),
    createdAt: Number(row.created_at),
  }));
}

export function budgetDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function dbRecordSignalSurface(input: {
  signalId: string;
  route: SignalSurfaceRoute;
  sessionName?: string;
  turnId?: string;
  channel?: string;
  now?: number;
  bucket?: string;
}): boolean {
  ensureSignalSchema();
  const now = input.now ?? Date.now();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO signal_surfaces
        (signal_id, route, session_name, turn_id, channel, budget_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.signalId,
      input.route,
      input.sessionName ?? null,
      input.bucket ?? input.turnId ?? null,
      input.channel ?? null,
      budgetDay(now),
      now,
    );
  return result.changes > 0;
}

export function dbCountBudgetSurfaces(day: string, sessionName?: string): number {
  ensureSignalSchema();
  const row = sessionName
    ? (getDb()
        .prepare(
          "SELECT COUNT(*) AS total FROM signal_surfaces WHERE budget_day = ? AND route != 'page' AND session_name = ?",
        )
        .get(day, sessionName) as { total: number })
    : (getDb()
        .prepare("SELECT COUNT(*) AS total FROM signal_surfaces WHERE budget_day = ? AND route != 'page'")
        .get(day) as { total: number });
  return Number(row.total);
}

export function dbGetLastSurfaceAt(signalId: string, route?: SignalSurfaceRoute): number | null {
  ensureSignalSchema();
  const row = route
    ? (getDb()
        .prepare("SELECT MAX(created_at) AS last FROM signal_surfaces WHERE signal_id = ? AND route = ?")
        .get(signalId, route) as { last: number | null })
    : (getDb().prepare("SELECT MAX(created_at) AS last FROM signal_surfaces WHERE signal_id = ?").get(signalId) as {
        last: number | null;
      });
  return row.last === null ? null : Number(row.last);
}

export function dbGetLastOobAt(signalId: string): number | null {
  ensureSignalSchema();
  const row = getDb()
    .prepare("SELECT MAX(created_at) AS last FROM signal_surfaces WHERE signal_id = ? AND route IN ('oob','page')")
    .get(signalId) as { last: number | null };
  return row.last === null ? null : Number(row.last);
}

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
  const db = getDb();
  const row = db.prepare("SELECT value FROM signal_meta WHERE key = 'tick_lock'").get() as
    | { value: string }
    | undefined;
  if (row) {
    const parsed = parseJson<{ holder: string; acquiredAt: number }>(row.value);
    if (parsed && now - parsed.acquiredAt < staleMs && parsed.holder !== holder) {
      return false;
    }
  }
  db.prepare(
    `INSERT INTO signal_meta (key, value, updated_at) VALUES ('tick_lock', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify({ holder, acquiredAt: now }), now);
  return true;
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
  db.prepare("DELETE FROM signal_surfaces WHERE created_at < ?").run(cutoff);
  db.prepare("DELETE FROM signal_events WHERE created_at < ?").run(cutoff);
  return result.changes;
}
