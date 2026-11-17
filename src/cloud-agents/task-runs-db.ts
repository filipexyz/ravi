/**
 * Cloud runs started for local tasks (`ravi tasks dispatch --cloud`), in
 * `ravi.db` (spec `cloud/agents`, "Task dispatch").
 *
 * The CLI records a row when the Console accepts the run; the daemon's watcher
 * polls the Console only while a row is still open, and records what it did
 * so a result is delivered once: approvals already relayed, when the result
 * reached the session and when the Console acknowledged it. Each row keeps the
 * installation and organization of the login that started it: another login
 * never polls (or fails) it.
 *
 * A dispatch is claimed in `cloud_agent_task_dispatches` before the Console is
 * called, with the idempotency key it uses: a retry after a lost response, or
 * a concurrent `--execute`, sends the same key and gets the same run.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { getDb } from "../router/router-db.js";

export type CloudTaskRunState = "active" | "delivered" | "acknowledged";

export interface CloudTaskRun {
  runId: string;
  taskId: string;
  agentId: string;
  /** The session that gets the result as a `[System] Inform`; null when dispatched from the terminal. */
  sessionName: string | null;
  project: string;
  /** The login that started it; null on rows from before this was recorded. */
  installationId: string | null;
  organizationId: string | null;
  state: CloudTaskRunState;
  /** Last run status the watcher saw. */
  status: string;
  /** Approval ids already relayed to the session. */
  relayedApprovals: string[];
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
}

interface Row {
  run_id: string;
  task_id: string;
  agent_id: string;
  session_name: string | null;
  project: string;
  installation_id: string | null;
  organization_id: string | null;
  state: string;
  status: string;
  relayed_approvals_json: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  acknowledged_at: number | null;
}

const ensured = new WeakSet<Database>();

function db(): Database {
  const database = getDb();
  if (!ensured.has(database)) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS cloud_agent_task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_name TEXT,
        project TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','delivered','acknowledged')),
        status TEXT NOT NULL,
        relayed_approvals_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_task_runs_state ON cloud_agent_task_runs(state);
      CREATE INDEX IF NOT EXISTS idx_cloud_agent_task_runs_task ON cloud_agent_task_runs(task_id);
      CREATE TABLE IF NOT EXISTS cloud_agent_task_dispatches (
        task_id TEXT PRIMARY KEY,
        attempt INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','started','failed','abandoned')),
        run_id TEXT,
        agent_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        project TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        organization_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = new Set(
      (database.prepare("PRAGMA table_info(cloud_agent_task_runs)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!columns.has("installation_id"))
      database.exec("ALTER TABLE cloud_agent_task_runs ADD COLUMN installation_id TEXT");
    if (!columns.has("organization_id"))
      database.exec("ALTER TABLE cloud_agent_task_runs ADD COLUMN organization_id TEXT");
    ensured.add(database);
  }
  return database;
}

function toRun(row: Row): CloudTaskRun {
  let relayed: string[] = [];
  try {
    const parsed = JSON.parse(row.relayed_approvals_json) as unknown;
    if (Array.isArray(parsed)) relayed = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    relayed = [];
  }
  return {
    runId: row.run_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    sessionName: row.session_name,
    project: row.project,
    installationId: row.installation_id ?? null,
    organizationId: row.organization_id ?? null,
    state: row.state as CloudTaskRunState,
    status: row.status,
    relayedApprovals: relayed,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

export function dbRecordCloudTaskRun(
  input: {
    runId: string;
    taskId: string;
    agentId: string;
    sessionName: string | null;
    project: string;
    status: string;
    installationId: string | null;
    organizationId: string | null;
  },
  now = Date.now(),
): CloudTaskRun {
  db()
    .prepare(
      `INSERT INTO cloud_agent_task_runs
         (run_id, task_id, agent_id, session_name, project, installation_id, organization_id, state, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.taskId,
      input.agentId,
      input.sessionName,
      input.project,
      input.installationId,
      input.organizationId,
      input.status,
      now,
      now,
    );
  return dbGetCloudTaskRun(input.runId)!;
}

export function dbGetCloudTaskRun(runId: string): CloudTaskRun | null {
  const row = db().prepare("SELECT * FROM cloud_agent_task_runs WHERE run_id = ?").get(runId) as Row | null;
  return row ? toRun(row) : null;
}

/** Rows the watcher still has work for: not delivered, or delivered but not acknowledged. */
export function dbListOpenCloudTaskRuns(): CloudTaskRun[] {
  const rows = db()
    .prepare("SELECT * FROM cloud_agent_task_runs WHERE state != 'acknowledged' ORDER BY created_at ASC")
    .all() as Row[];
  return rows.map(toRun);
}

/** The run of a task that has not delivered its result yet, if any. */
export function dbGetActiveCloudTaskRunForTask(taskId: string): CloudTaskRun | null {
  const row = db()
    .prepare(
      "SELECT * FROM cloud_agent_task_runs WHERE task_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(taskId) as Row | null;
  return row ? toRun(row) : null;
}

export function dbHasOpenCloudTaskRuns(): boolean {
  const row = db().prepare("SELECT 1 AS found FROM cloud_agent_task_runs WHERE state != 'acknowledged' LIMIT 1").get();
  return Boolean(row);
}

export function dbSetCloudTaskRunStatus(
  runId: string,
  status: string,
  lastError: string | null = null,
  now = Date.now(),
) {
  db()
    .prepare("UPDATE cloud_agent_task_runs SET status = ?, last_error = ?, updated_at = ? WHERE run_id = ?")
    .run(status, lastError, now, runId);
}

export function dbAddRelayedApprovals(runId: string, approvalIds: readonly string[], now = Date.now()): void {
  const current = dbGetCloudTaskRun(runId);
  if (!current) return;
  const next = [...new Set([...current.relayedApprovals, ...approvalIds])];
  db()
    .prepare("UPDATE cloud_agent_task_runs SET relayed_approvals_json = ?, updated_at = ? WHERE run_id = ?")
    .run(JSON.stringify(next), now, runId);
}

/**
 * Mark the result delivered. Returns false when another process already did
 * (the state moved on), so a result reaches the session once.
 */
export function dbMarkCloudTaskRunDelivered(runId: string, status: string, now = Date.now()): boolean {
  const result = db()
    .prepare(
      `UPDATE cloud_agent_task_runs SET state = 'delivered', status = ?, delivered_at = ?, updated_at = ?, last_error = NULL
       WHERE run_id = ? AND state = 'active'`,
    )
    .run(status, now, now, runId);
  return result.changes > 0;
}

/** The inform could not be sent: back to `active`, so the next tick tries again. */
export function dbReopenCloudTaskRun(runId: string, lastError: string, now = Date.now()): void {
  db()
    .prepare(
      `UPDATE cloud_agent_task_runs SET state = 'active', delivered_at = NULL, last_error = ?, updated_at = ?
       WHERE run_id = ? AND state = 'delivered'`,
    )
    .run(lastError.slice(0, 500), now, runId);
}

export function dbMarkCloudTaskRunAcknowledged(runId: string, now = Date.now()): void {
  db()
    .prepare(
      "UPDATE cloud_agent_task_runs SET state = 'acknowledged', acknowledged_at = ?, updated_at = ? WHERE run_id = ?",
    )
    .run(now, now, runId);
}

// ---------------------------------------------------------------------------
// Dispatch claims

export type CloudTaskDispatchState = "pending" | "started" | "failed" | "abandoned";

export interface CloudTaskDispatch {
  taskId: string;
  attempt: number;
  idempotencyKey: string;
  state: CloudTaskDispatchState;
  runId: string | null;
  agentId: string;
  sessionName: string;
  project: string;
  installationId: string;
  organizationId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DispatchRow {
  task_id: string;
  attempt: number;
  idempotency_key: string;
  state: string;
  run_id: string | null;
  agent_id: string;
  session_name: string;
  project: string;
  installation_id: string;
  organization_id: string | null;
  created_at: number;
  updated_at: number;
}

function toDispatch(row: DispatchRow): CloudTaskDispatch {
  return {
    taskId: row.task_id,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    state: row.state as CloudTaskDispatchState,
    runId: row.run_id,
    agentId: row.agent_id,
    sessionName: row.session_name,
    project: row.project,
    installationId: row.installation_id,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbGetCloudTaskDispatch(taskId: string): CloudTaskDispatch | null {
  const row = db()
    .prepare("SELECT * FROM cloud_agent_task_dispatches WHERE task_id = ?")
    .get(taskId) as DispatchRow | null;
  return row ? toDispatch(row) : null;
}

export class CloudTaskDispatchActiveError extends Error {
  constructor(readonly runId: string) {
    super(`The task already runs in the cloud (run ${runId}).`);
    this.name = "CloudTaskDispatchActiveError";
  }
}

/**
 * The idempotency key for this dispatch, claimed before the Console is called
 * (one transaction): a pending claim keeps its key, so a retry or a concurrent
 * call starts the same run; after a run that ended (or a start the Console
 * answered with an error) the next dispatch gets a new key. Throws
 * `CloudTaskDispatchActiveError` while the claimed run is still open here.
 */
export function dbClaimCloudTaskDispatch(
  input: {
    taskId: string;
    agentId: string;
    sessionName: string;
    project: string;
    installationId: string;
    organizationId: string | null;
  },
  options: { newKey?: () => string; now?: number } = {},
): CloudTaskDispatch {
  const database = db();
  const now = options.now ?? Date.now();
  const newKey = options.newKey ?? (() => `ravi-task:${input.taskId}:${randomUUID()}`);
  const claim = database.transaction(() => {
    const current = dbGetCloudTaskDispatch(input.taskId);
    if (current?.state === "pending") return current;
    if (current?.state === "started" && current.runId) {
      const run = dbGetCloudTaskRun(current.runId);
      if (run && run.state !== "acknowledged") throw new CloudTaskDispatchActiveError(current.runId);
    }
    const attempt = (current?.attempt ?? 0) + 1;
    database
      .prepare(
        `INSERT INTO cloud_agent_task_dispatches
           (task_id, attempt, idempotency_key, state, run_id, agent_id, session_name, project, installation_id, organization_id, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET attempt = excluded.attempt, idempotency_key = excluded.idempotency_key,
           state = 'pending', run_id = NULL, agent_id = excluded.agent_id, session_name = excluded.session_name,
           project = excluded.project, installation_id = excluded.installation_id,
           organization_id = excluded.organization_id, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      )
      .run(
        input.taskId,
        attempt,
        newKey(),
        input.agentId,
        input.sessionName,
        input.project,
        input.installationId,
        input.organizationId,
        now,
        now,
      );
    return dbGetCloudTaskDispatch(input.taskId)!;
  });
  return claim.immediate();
}

function setDispatchState(
  taskId: string,
  idempotencyKey: string,
  state: CloudTaskDispatchState,
  runId: string | null,
  now = Date.now(),
): void {
  db()
    .prepare(
      `UPDATE cloud_agent_task_dispatches SET state = ?, run_id = COALESCE(?, run_id), updated_at = ?
       WHERE task_id = ? AND idempotency_key = ?`,
    )
    .run(state, runId, now, taskId, idempotencyKey);
}

export function dbMarkCloudTaskDispatchStarted(taskId: string, idempotencyKey: string, runId: string): void {
  setDispatchState(taskId, idempotencyKey, "started", runId);
}

/** The Console answered the start with an error: no run for this key, the next dispatch gets a new one. */
export function dbMarkCloudTaskDispatchFailed(taskId: string, idempotencyKey: string): void {
  setDispatchState(taskId, idempotencyKey, "failed", null);
}

/** A pending claim whose run never showed up on the Console. */
export function dbAbandonCloudTaskDispatch(taskId: string, idempotencyKey: string): void {
  setDispatchState(taskId, idempotencyKey, "abandoned", null);
}

/** Claims whose start got no answer: the watcher looks for their run on the Console. */
export function dbListPendingCloudTaskDispatches(): CloudTaskDispatch[] {
  const rows = db()
    .prepare("SELECT * FROM cloud_agent_task_dispatches WHERE state = 'pending' ORDER BY created_at ASC")
    .all() as DispatchRow[];
  return rows.map(toDispatch);
}
