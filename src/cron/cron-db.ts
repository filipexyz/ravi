/**
 * Cron Database Operations
 *
 * CRUD operations for cron jobs stored in SQLite.
 */

import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { calculateNextRun } from "./schedule.js";
import type {
  CronJob,
  CronJobInput,
  CronSchedule,
  ScheduleType,
  SessionTarget,
  JobStatus,
  JobStateUpdate,
} from "./types.js";

const log = logger.child("cron:db");

// ============================================================================
// Row Types
// ============================================================================

interface CronJobRow {
  id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  enabled: number;
  delete_after_run: number;

  schedule_type: string;
  schedule_at: number | null;
  schedule_every: number | null;
  schedule_cron: string | null;
  schedule_timezone: string | null;

  session_target: string;
  reply_session: string | null;
  payload_text: string;

  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;

  created_at: number;
  updated_at: number;
}

// ============================================================================
// Row Mapping
// ============================================================================

function rowToJob(row: CronJobRow): CronJob {
  const schedule: CronSchedule = {
    type: row.schedule_type as ScheduleType,
  };

  if (row.schedule_at !== null) schedule.at = row.schedule_at;
  if (row.schedule_every !== null) schedule.every = row.schedule_every;
  if (row.schedule_cron !== null) schedule.cron = row.schedule_cron;
  if (row.schedule_timezone !== null) schedule.timezone = row.schedule_timezone;

  const job: CronJob = {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    deleteAfterRun: row.delete_after_run === 1,
    schedule,
    sessionTarget: row.session_target as SessionTarget,
    message: row.payload_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.agent_id !== null) job.agentId = row.agent_id;
  if (row.description !== null) job.description = row.description;
  if (row.reply_session !== null) job.replySession = row.reply_session;
  if (row.next_run_at !== null) job.nextRunAt = row.next_run_at;
  if (row.last_run_at !== null) job.lastRunAt = row.last_run_at;
  if (row.last_status !== null) job.lastStatus = row.last_status as JobStatus;
  if (row.last_error !== null) job.lastError = row.last_error;
  if (row.last_duration_ms !== null) job.lastDurationMs = row.last_duration_ms;

  return job;
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new cron job.
 */
export function dbCreateCronJob(input: CronJobInput): CronJob {
  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();

  // Calculate initial next run time
  const nextRunAt = calculateNextRun(input.schedule);

  const stmt = db.prepare(`
    INSERT INTO cron_jobs (
      id, agent_id, name, description, enabled, delete_after_run,
      schedule_type, schedule_at, schedule_every, schedule_cron, schedule_timezone,
      session_target, reply_session, payload_text,
      next_run_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.agentId ?? null,
    input.name,
    input.description ?? null,
    input.enabled !== false ? 1 : 0,
    input.deleteAfterRun ? 1 : 0,
    input.schedule.type,
    input.schedule.at ?? null,
    input.schedule.every ?? null,
    input.schedule.cron ?? null,
    input.schedule.timezone ?? null,
    input.sessionTarget ?? "main",
    input.replySession ?? null,
    input.message,
    nextRunAt ?? null,
    now,
    now
  );

  log.info("Created cron job", { id, name: input.name, scheduleType: input.schedule.type });
  return dbGetCronJob(id)!;
}

/**
 * Get a cron job by ID.
 */
export function dbGetCronJob(id: string): CronJob | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM cron_jobs WHERE id = ?");
  const row = stmt.get(id) as CronJobRow | undefined;
  return row ? rowToJob(row) : null;
}

/**
 * List all cron jobs.
 */
export function dbListCronJobs(): CronJob[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC");
  const rows = stmt.all() as CronJobRow[];
  return rows.map(rowToJob);
}

/**
 * Update a cron job.
 */
export function dbUpdateCronJob(id: string, updates: Partial<CronJob>): CronJob {
  const db = getDb();
  const existing = dbGetCronJob(id);

  if (!existing) {
    throw new Error(`Cron job not found: ${id}`);
  }

  const now = Date.now();

  // Build update query dynamically
  type SQLValue = string | number | null;
  const fields: string[] = [];
  const values: SQLValue[] = [];

  if (updates.agentId !== undefined) {
    fields.push("agent_id = ?");
    values.push(updates.agentId ?? null);
  }
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description ?? null);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.deleteAfterRun !== undefined) {
    fields.push("delete_after_run = ?");
    values.push(updates.deleteAfterRun ? 1 : 0);
  }
  if (updates.schedule !== undefined) {
    fields.push("schedule_type = ?", "schedule_at = ?", "schedule_every = ?", "schedule_cron = ?", "schedule_timezone = ?");
    values.push(
      updates.schedule.type,
      updates.schedule.at ?? null,
      updates.schedule.every ?? null,
      updates.schedule.cron ?? null,
      updates.schedule.timezone ?? null
    );
    // Recalculate next run when schedule changes
    const nextRunAt = calculateNextRun(updates.schedule);
    fields.push("next_run_at = ?");
    values.push(nextRunAt ?? null);
  }
  if (updates.sessionTarget !== undefined) {
    fields.push("session_target = ?");
    values.push(updates.sessionTarget);
  }
  if (updates.replySession !== undefined) {
    fields.push("reply_session = ?");
    values.push(updates.replySession ?? null);
  }
  if (updates.message !== undefined) {
    fields.push("payload_text = ?");
    values.push(updates.message);
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  const sql = `UPDATE cron_jobs SET ${fields.join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...values);

  log.info("Updated cron job", { id });
  return dbGetCronJob(id)!;
}

/**
 * Delete a cron job.
 */
export function dbDeleteCronJob(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  const deleted = getDbChanges() > 0;
  if (deleted) {
    log.info("Deleted cron job", { id });
  }
  return deleted;
}

/**
 * Get all jobs that are due to run.
 * Returns jobs where enabled=1 and next_run_at <= now.
 */
export function dbGetDueJobs(): CronJob[] {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT * FROM cron_jobs
    WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `);
  const rows = stmt.all(now) as CronJobRow[];
  return rows.map(rowToJob);
}

/**
 * Get the next job that will run (for timer scheduling).
 */
export function dbGetNextDueJob(): CronJob | null {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM cron_jobs
    WHERE enabled = 1 AND next_run_at IS NOT NULL
    ORDER BY next_run_at ASC
    LIMIT 1
  `);
  const row = stmt.get() as CronJobRow | undefined;
  return row ? rowToJob(row) : null;
}

/**
 * Update job state after execution.
 */
export function dbUpdateJobState(id: string, state: JobStateUpdate): void {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    UPDATE cron_jobs SET
      last_run_at = ?,
      last_status = ?,
      last_error = ?,
      last_duration_ms = ?,
      next_run_at = ?,
      updated_at = ?
    WHERE id = ?
  `);

  stmt.run(
    state.lastRunAt,
    state.lastStatus,
    state.lastError ?? null,
    state.lastDurationMs ?? null,
    state.nextRunAt ?? null,
    now,
    id
  );

  log.debug("Updated job state", { id, status: state.lastStatus });
}

