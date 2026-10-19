/**
 * Cloud runs started for local tasks (`ravi tasks dispatch --cloud`), in
 * `ravi.db` (spec `cloud/agents`, "Task dispatch").
 *
 * The CLI records a row when the Console accepts the run; the daemon's watcher
 * polls the Console only while a row is still open, and records what it did
 * so a result is delivered once: approvals already relayed, when the result
 * reached the session and when the Console acknowledged it.
 */

import type { Database } from "bun:sqlite";

import { getDb } from "../router/router-db.js";

export type CloudTaskRunState = "active" | "delivered" | "acknowledged";

export interface CloudTaskRun {
  runId: string;
  taskId: string;
  agentId: string;
  /** The session that gets the result as a `[System] Inform`; null when dispatched from the terminal. */
  sessionName: string | null;
  project: string;
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
    `);
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
  },
  now = Date.now(),
): CloudTaskRun {
  db()
    .prepare(
      `INSERT INTO cloud_agent_task_runs (run_id, task_id, agent_id, session_name, project, state, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(input.runId, input.taskId, input.agentId, input.sessionName, input.project, input.status, now, now);
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
