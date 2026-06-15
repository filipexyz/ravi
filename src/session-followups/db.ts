import { randomUUID } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../router/router-db.js";
import { calculateNextRun, isValidCronExpression } from "../cron/schedule.js";
import { requireDeliveryBarrier } from "../delivery-barriers.js";
import { countRows, normalizeLimitOffsetPage, type ListPage } from "../utils/pagination.js";
import type {
  SessionFollowupCadence,
  SessionFollowupCadenceInput,
  SessionFollowupCadenceStatus,
  SessionFollowupCadenceUpdateInput,
  SessionFollowupListInput,
  SessionFollowupRun,
  SessionFollowupRunInput,
  SessionFollowupRunListInput,
  SessionFollowupRunResult,
  SessionFollowupStatus,
  SessionFollowupTargetType,
} from "./types.js";

interface CadenceRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  owner_type: string;
  owner_id: string;
  target_type: string;
  target_ref: string;
  schedule_type: string;
  schedule_every_ms: number | null;
  schedule_cron: string | null;
  schedule_at: number | null;
  schedule_steps_json: string | null;
  timezone: string | null;
  delivery_barrier: string;
  message_template: string;
  metadata_json: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  cadence_id: string;
  target_type: string;
  target_ref: string;
  session_name: string | null;
  session_key: string | null;
  chat_id: string | null;
  status: string;
  due_at: number;
  leased_until: number | null;
  attempt_count: number;
  next_attempt_at: number | null;
  idempotency_key: string;
  prompt_text: string | null;
  event_payload_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

const CADENCE_TARGET_TYPES = new Set(["session", "chat", "reading_list"]);
const RUN_STATUSES = new Set(["pending", "leased", "sent", "skipped", "failed", "dead"]);

export function ensureSessionFollowupTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_followup_cadences (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      owner_type TEXT NOT NULL DEFAULT 'system',
      owner_id TEXT NOT NULL DEFAULT 'ravi',
      target_type TEXT NOT NULL CHECK(target_type IN ('session', 'chat', 'reading_list')),
      target_ref TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('at', 'every', 'cron')),
      schedule_every_ms INTEGER,
      schedule_cron TEXT,
      schedule_at INTEGER,
      schedule_steps_json TEXT,
      timezone TEXT,
      delivery_barrier TEXT NOT NULL DEFAULT 'after_response',
      message_template TEXT NOT NULL,
      metadata_json TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_followup_cadences_due
      ON session_followup_cadences(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_session_followup_cadences_target
      ON session_followup_cadences(target_type, target_ref);

    CREATE TABLE IF NOT EXISTS session_followup_runs (
      id TEXT PRIMARY KEY,
      cadence_id TEXT NOT NULL REFERENCES session_followup_cadences(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('session', 'chat', 'reading_list')),
      target_ref TEXT NOT NULL,
      session_name TEXT,
      session_key TEXT,
      chat_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'sent', 'skipped', 'failed', 'dead')),
      due_at INTEGER NOT NULL,
      leased_until INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      idempotency_key TEXT NOT NULL UNIQUE,
      prompt_text TEXT,
      event_payload_json TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_session_followup_runs_due
      ON session_followup_runs(status, due_at, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_session_followup_runs_cadence
      ON session_followup_runs(cadence_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_session_followup_runs_chat
      ON session_followup_runs(chat_id);
  `);
  ensureSessionFollowupColumns(db);
}

export function createSessionFollowupCadence(input: SessionFollowupCadenceInput): SessionFollowupCadence {
  ensureSessionFollowupTables();
  const now = input.now ?? Date.now();
  const id = normalizeId(input.id) ?? `sfup_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const name = requiredText(input.name, "name");
  const targetType = requireTargetType(input.targetType);
  const targetRef = requiredText(input.targetRef, "targetRef");
  const messageTemplate = requiredText(input.messageTemplate, "messageTemplate");
  const deliveryBarrier = requireDeliveryBarrier(input.deliveryBarrier ?? "followup", "deliveryBarrier");
  const schedule = validateSchedule(input.schedule, messageTemplate);
  const nextRunAt = schedule.type === "every" ? now : calculateNextRun(schedule, now);

  getDb()
    .prepare(
      `
      INSERT INTO session_followup_cadences (
        id, name, description, enabled, owner_type, owner_id, target_type, target_ref,
        schedule_type, schedule_every_ms, schedule_cron, schedule_at, schedule_steps_json, timezone,
        delivery_barrier, message_template, metadata_json, next_run_at,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      name,
      input.description?.trim() || null,
      input.enabled === false ? 0 : 1,
      input.ownerType?.trim() || "system",
      input.ownerId?.trim() || "ravi",
      targetType,
      targetRef,
      schedule.type,
      schedule.every ?? null,
      schedule.cron ?? null,
      schedule.at ?? null,
      schedule.type === "every" ? stringifyJson(schedule.steps ?? []) : null,
      schedule.timezone ?? null,
      deliveryBarrier,
      messageTemplate,
      stringifyJson(input.metadata),
      nextRunAt ?? null,
      now,
      now,
    );

  const created = getSessionFollowupCadence(id);
  if (!created) throw new Error(`Failed to create session followup cadence: ${id}`);
  return created;
}

export function getSessionFollowupCadence(id: string): SessionFollowupCadence | null {
  ensureSessionFollowupTables();
  const row = getDb().prepare("SELECT * FROM session_followup_cadences WHERE id = ?").get(id) as CadenceRow | undefined;
  return row ? rowToCadence(row) : null;
}

export function listSessionFollowupCadences(input: SessionFollowupListInput = {}): ListPage<SessionFollowupCadence> {
  ensureSessionFollowupTables();
  const page = normalizeLimitOffsetPage(input, { defaultLimit: 50, maxLimit: 500 });
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (!input.includeDisabled) where.push("enabled = 1");
  if (input.targetType) {
    where.push("target_type = ?");
    params.push(requireTargetType(input.targetType));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = countRows({ db: getDb(), table: "session_followup_cadences", where, params });
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM session_followup_cadences
      ${whereSql}
      ORDER BY enabled DESC, COALESCE(next_run_at, 9223372036854775807), created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, page.limit, page.offset) as CadenceRow[];
  return { total, limit: page.limit, offset: page.offset, items: rows.map(rowToCadence) };
}

export function getDueSessionFollowupCadences(now = Date.now(), limit = 50): SessionFollowupCadence[] {
  ensureSessionFollowupTables();
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM session_followup_cadences
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC, created_at ASC
      LIMIT ?
      `,
    )
    .all(now, Math.max(1, Math.min(500, limit))) as CadenceRow[];
  return rows.map(rowToCadence);
}

export function updateSessionFollowupCadenceState(
  id: string,
  input: {
    enabled?: boolean;
    nextRunAt?: number | null;
    lastRunAt?: number | null;
    lastStatus?: SessionFollowupCadenceStatus | null;
    lastError?: string | null;
    now?: number;
  },
): SessionFollowupCadence | null {
  ensureSessionFollowupTables();
  const current = getSessionFollowupCadence(id);
  if (!current) return null;
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `
      UPDATE session_followup_cadences
      SET enabled = ?,
          next_run_at = ?,
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(
      (input.enabled ?? current.enabled) ? 1 : 0,
      input.nextRunAt === undefined ? (current.nextRunAt ?? null) : input.nextRunAt,
      input.lastRunAt === undefined ? (current.lastRunAt ?? null) : input.lastRunAt,
      input.lastStatus === undefined ? (current.lastStatus ?? null) : input.lastStatus,
      input.lastError === undefined ? (current.lastError ?? null) : input.lastError,
      now,
      id,
    );
  return getSessionFollowupCadence(id);
}

export function updateSessionFollowupCadence(
  id: string,
  input: SessionFollowupCadenceUpdateInput,
): SessionFollowupCadence | null {
  ensureSessionFollowupTables();
  const current = getSessionFollowupCadence(id);
  if (!current) return null;
  const now = input.now ?? Date.now();
  const name = input.name === undefined ? current.name : requiredText(input.name, "name");
  const description =
    input.description === undefined ? (current.description ?? null) : input.description?.trim() || null;
  const messageTemplate =
    input.messageTemplate === undefined
      ? current.messageTemplate
      : requiredText(input.messageTemplate, "messageTemplate");
  const schedule = input.schedule === undefined ? current.schedule : validateSchedule(input.schedule, messageTemplate);
  const deliveryBarrier =
    input.deliveryBarrier === undefined
      ? current.deliveryBarrier
      : requireDeliveryBarrier(input.deliveryBarrier, "deliveryBarrier");
  const nextRunAt =
    input.recalculateNextRun === true
      ? schedule.type === "every"
        ? now
        : (calculateNextRun(schedule, now) ?? null)
      : (current.nextRunAt ?? null);

  getDb()
    .prepare(
      `
      UPDATE session_followup_cadences
      SET name = ?,
          description = ?,
          schedule_type = ?,
          schedule_every_ms = ?,
          schedule_cron = ?,
          schedule_at = ?,
          schedule_steps_json = ?,
          timezone = ?,
          delivery_barrier = ?,
          message_template = ?,
          metadata_json = ?,
          next_run_at = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(
      name,
      description,
      schedule.type,
      schedule.every ?? null,
      schedule.cron ?? null,
      schedule.at ?? null,
      schedule.type === "every" ? stringifyJson(schedule.steps ?? []) : null,
      schedule.timezone ?? null,
      deliveryBarrier,
      messageTemplate,
      stringifyJson(input.metadata ?? current.metadata),
      nextRunAt,
      now,
      id,
    );
  return getSessionFollowupCadence(id);
}

export function createSessionFollowupRun(input: SessionFollowupRunInput): SessionFollowupRunResult {
  ensureSessionFollowupTables();
  const now = input.now ?? Date.now();
  const id = `sfur_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  const existing = getDb()
    .prepare("SELECT * FROM session_followup_runs WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as RunRow | undefined;
  if (existing) return { run: rowToRun(existing), created: false };

  getDb()
    .prepare(
      `
      INSERT INTO session_followup_runs (
        id, cadence_id, target_type, target_ref, session_name, session_key, chat_id,
        status, due_at, idempotency_key, event_payload_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.cadenceId,
      requireTargetType(input.targetType),
      input.targetRef,
      input.sessionName?.trim() || null,
      input.sessionKey?.trim() || null,
      input.chatId?.trim() || null,
      input.dueAt,
      input.idempotencyKey,
      stringifyJson(input.eventPayload),
      now,
      now,
    );

  const row = getDb().prepare("SELECT * FROM session_followup_runs WHERE id = ?").get(id) as RunRow;
  return { run: rowToRun(row), created: true };
}

export function listRunnableSessionFollowupRuns(now = Date.now(), limit = 50): SessionFollowupRun[] {
  ensureSessionFollowupTables();
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM session_followup_runs
      WHERE due_at <= ?
        AND (
          status = 'pending'
          OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until <= ?)
          OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        )
      ORDER BY due_at ASC, created_at ASC
      LIMIT ?
      `,
    )
    .all(now, now, now, Math.max(1, Math.min(500, limit))) as RunRow[];
  return rows.map(rowToRun);
}

export function leaseSessionFollowupRun(id: string, now = Date.now(), leaseMs = 60_000): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  const result = getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET status = 'leased',
          leased_until = ?,
          attempt_count = attempt_count + 1,
          updated_at = ?
      WHERE id = ?
        AND (
          status = 'pending'
          OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until <= ?)
          OR (status = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        )
      `,
    )
    .run(now + leaseMs, now, id, now, now);
  if (result.changes === 0) return null;
  return getSessionFollowupRun(id);
}

export function getSessionFollowupRun(id: string): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  const row = getDb().prepare("SELECT * FROM session_followup_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listSessionFollowupRuns(input: SessionFollowupRunListInput = {}): ListPage<SessionFollowupRun> {
  ensureSessionFollowupTables();
  const page = normalizeLimitOffsetPage(input, { defaultLimit: 50, maxLimit: 500 });
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (input.cadenceId) {
    where.push("cadence_id = ?");
    params.push(input.cadenceId);
  }
  if (input.status) {
    where.push("status = ?");
    params.push(requireRunStatus(input.status));
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = countRows({ db: getDb(), table: "session_followup_runs", where, params });
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM session_followup_runs
      ${whereSql}
      ORDER BY due_at DESC, created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, page.limit, page.offset) as RunRow[];
  return { total, limit: page.limit, offset: page.offset, items: rows.map(rowToRun) };
}

export function markSessionFollowupRunSent(
  id: string,
  promptText: string,
  now = Date.now(),
): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET status = 'sent',
          prompt_text = ?,
          leased_until = NULL,
          next_attempt_at = NULL,
          last_error = NULL,
          sent_at = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(promptText, now, now, id);
  return getSessionFollowupRun(id);
}

export function updateSessionFollowupRunResolution(
  id: string,
  input: {
    sessionName?: string;
    sessionKey?: string;
    chatId?: string;
    eventPayload?: Record<string, unknown>;
    now?: number;
  },
): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  const current = getSessionFollowupRun(id);
  if (!current) return null;
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET session_name = ?,
          session_key = ?,
          chat_id = ?,
          event_payload_json = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(
      input.sessionName ?? current.sessionName ?? null,
      input.sessionKey ?? current.sessionKey ?? null,
      input.chatId ?? current.chatId ?? null,
      stringifyJson(input.eventPayload ?? current.eventPayload),
      now,
      id,
    );
  return getSessionFollowupRun(id);
}

export function markSessionFollowupRunSkipped(id: string, reason: string, now = Date.now()): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET status = 'skipped',
          leased_until = NULL,
          next_attempt_at = NULL,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(sanitizeError(reason), now, id);
  return getSessionFollowupRun(id);
}

export function markSessionFollowupRunFailed(id: string, reason: string, now = Date.now()): SessionFollowupRun | null {
  ensureSessionFollowupTables();
  const run = getSessionFollowupRun(id);
  if (!run) return null;
  const attempts = Math.max(1, run.attemptCount);
  const status: SessionFollowupStatus = attempts >= 5 ? "dead" : "failed";
  const backoffMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
  getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET status = ?,
          leased_until = NULL,
          next_attempt_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
      `,
    )
    .run(status, status === "failed" ? now + backoffMs : null, sanitizeError(reason), now, id);
  return getSessionFollowupRun(id);
}

export function retrySessionFollowupRuns(input: { id?: string; cadenceId?: string; now?: number } = {}): number {
  ensureSessionFollowupTables();
  const now = input.now ?? Date.now();
  if (input.id) {
    return getDb()
      .prepare(
        `
        UPDATE session_followup_runs
        SET status = 'pending', leased_until = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'dead')
        `,
      )
      .run(now, input.id).changes;
  }
  if (input.cadenceId) {
    return getDb()
      .prepare(
        `
        UPDATE session_followup_runs
        SET status = 'pending', leased_until = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ?
        WHERE cadence_id = ? AND status IN ('failed', 'dead')
        `,
      )
      .run(now, input.cadenceId).changes;
  }
  return getDb()
    .prepare(
      `
      UPDATE session_followup_runs
      SET status = 'pending', leased_until = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE status IN ('failed', 'dead')
      `,
    )
    .run(now).changes;
}

function rowToCadence(row: CadenceRow): SessionFollowupCadence {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    targetType: requireTargetType(row.target_type),
    targetRef: row.target_ref,
    schedule: {
      type: row.schedule_type as SessionFollowupCadence["schedule"]["type"],
      every: row.schedule_every_ms ?? undefined,
      cron: row.schedule_cron ?? undefined,
      at: row.schedule_at ?? undefined,
      steps:
        row.schedule_type === "every"
          ? parseScheduleSteps(row.schedule_steps_json, row.schedule_every_ms, row.message_template)
          : undefined,
      timezone: row.timezone ?? undefined,
    },
    deliveryBarrier: requireDeliveryBarrier(row.delivery_barrier, "deliveryBarrier"),
    messageTemplate: row.message_template,
    metadata: parseJsonRecord(row.metadata_json),
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: (row.last_status as SessionFollowupCadenceStatus | null) ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: RunRow): SessionFollowupRun {
  return {
    id: row.id,
    cadenceId: row.cadence_id,
    targetType: requireTargetType(row.target_type),
    targetRef: row.target_ref,
    sessionName: row.session_name ?? undefined,
    sessionKey: row.session_key ?? undefined,
    chatId: row.chat_id ?? undefined,
    status: requireRunStatus(row.status),
    dueAt: row.due_at,
    leasedUntil: row.leased_until ?? undefined,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    idempotencyKey: row.idempotency_key,
    promptText: row.prompt_text ?? undefined,
    eventPayload: parseJsonRecord(row.event_payload_json),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? undefined,
  };
}

function requiredText(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function validateSchedule(
  schedule: SessionFollowupCadenceInput["schedule"],
  fallbackMessageTemplate: string,
): SessionFollowupCadenceInput["schedule"] {
  if (schedule.type === "every") {
    const steps = normalizeScheduleSteps(schedule.steps, schedule.every, fallbackMessageTemplate);
    return { type: "every", every: steps[0]?.afterMs, steps };
  }
  if (schedule.type === "at") {
    if (!Number.isFinite(schedule.at) || (schedule.at ?? 0) <= 0) {
      throw new Error("schedule.at must be a positive epoch timestamp in milliseconds.");
    }
    return { type: "at", at: schedule.at };
  }
  if (schedule.type === "cron") {
    const cron = schedule.cron?.trim();
    if (!cron || !isValidCronExpression(cron)) {
      throw new Error("schedule.cron must be a valid cron expression.");
    }
    return { type: "cron", cron, timezone: schedule.timezone };
  }
  throw new Error(`Unknown followup schedule type: ${(schedule as { type?: string }).type ?? "unknown"}`);
}

function normalizeScheduleSteps(
  inputSteps: SessionFollowupCadenceInput["schedule"]["steps"] | undefined,
  fallbackEveryMs: number | undefined,
  fallbackMessageTemplate: string,
): NonNullable<SessionFollowupCadenceInput["schedule"]["steps"]> {
  const steps =
    inputSteps && inputSteps.length > 0
      ? inputSteps
      : fallbackEveryMs
        ? [{ afterMs: fallbackEveryMs, messageTemplate: fallbackMessageTemplate }]
        : [];
  const normalized = steps
    .map((step) => ({
      afterMs: Number(step.afterMs),
      messageTemplate: requiredText(step.messageTemplate, "step.messageTemplate"),
      label: step.label?.trim() || undefined,
    }))
    .sort((a, b) => a.afterMs - b.afterMs);
  if (normalized.length === 0) throw new Error("schedule.every must define at least one followup step.");
  for (const step of normalized) {
    if (!Number.isFinite(step.afterMs) || step.afterMs <= 0) {
      throw new Error("schedule step afterMs must be a positive duration in milliseconds.");
    }
  }
  return normalized;
}

function parseScheduleSteps(
  value: string | null,
  fallbackEveryMs: number | null,
  fallbackMessageTemplate: string,
): NonNullable<SessionFollowupCadenceInput["schedule"]["steps"]> {
  const fallback = fallbackEveryMs ? [{ afterMs: fallbackEveryMs, messageTemplate: fallbackMessageTemplate }] : [];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const steps = parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const afterMs = typeof record.afterMs === "number" ? record.afterMs : Number(record.afterMs);
        const messageTemplate = typeof record.messageTemplate === "string" ? record.messageTemplate.trim() : "";
        const label = typeof record.label === "string" ? record.label.trim() : undefined;
        if (!Number.isFinite(afterMs) || afterMs <= 0 || !messageTemplate) return null;
        return { afterMs, messageTemplate, label: label || undefined };
      })
      .filter(Boolean) as NonNullable<SessionFollowupCadenceInput["schedule"]["steps"]>;
    return steps.length > 0 ? steps.sort((a, b) => a.afterMs - b.afterMs) : fallback;
  } catch {
    return fallback;
  }
}

function ensureSessionFollowupColumns(database: Database): void {
  ensureColumn(database, "session_followup_cadences", "schedule_steps_json", "TEXT");
}

function tableHasColumn(database: Database, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((candidate) => candidate.name === column);
}

function ensureColumn(database: Database, table: string, column: string, definition: string): void {
  if (tableHasColumn(database, table, column)) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (
      error instanceof Error &&
      /duplicate column name/i.test(error.message) &&
      tableHasColumn(database, table, column)
    ) {
      return;
    }
    throw error;
  }
}

function normalizeId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function requireTargetType(value: string): SessionFollowupTargetType {
  if (!CADENCE_TARGET_TYPES.has(value)) {
    throw new Error(`Unknown followup target type: ${value}. Use session, chat, or reading_list.`);
  }
  return value as SessionFollowupTargetType;
}

function requireRunStatus(value: string): SessionFollowupStatus {
  if (!RUN_STATUSES.has(value)) {
    throw new Error(`Unknown followup run status: ${value}`);
  }
  return value as SessionFollowupStatus;
}

function stringifyJson(value?: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeError(value: string): string {
  return value.replace(/(token|secret|password|api[_-]?key)=\S+/gi, "$1=[redacted]").slice(0, 1000);
}
