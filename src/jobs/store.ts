import { randomUUID } from "node:crypto";
import { getDb, getDbChanges } from "../router/router-db.js";
import type { JobCreateInput, JobOrigin, JobRecord, JobStatus } from "./types.js";

interface JobRow {
  id: string;
  session_name: string | null;
  agent_id: string | null;
  command: string;
  cwd: string | null;
  status: string;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  log_path: string;
  origin: string;
  notified_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    sessionName: row.session_name,
    agentId: row.agent_id,
    command: row.command,
    cwd: row.cwd,
    status: row.status as JobStatus,
    pid: row.pid,
    exitCode: row.exit_code,
    signal: row.signal,
    logPath: row.log_path,
    origin: row.origin as JobOrigin,
    notifiedAt: row.notified_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function dbCreateJob(input: JobCreateInput): JobRecord {
  ensureJobsSchema();
  const now = Date.now();
  const id = input.id ?? `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  getDb()
    .prepare(
      `INSERT INTO jobs (id, session_name, agent_id, command, cwd, status, pid, exit_code, signal, log_path, origin,
                         notified_at, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      input.sessionName ?? null,
      input.agentId ?? null,
      input.command,
      input.cwd ?? null,
      input.logPath,
      input.origin ?? "cli",
      now,
      now,
    );
  const created = dbGetJob(id);
  if (!created) throw new Error(`Job not found after insert: ${id}`);
  return created;
}

export function dbGetJob(id: string): JobRecord | null {
  ensureJobsSchema();
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function dbListJobs(
  input: { sessionName?: string | null; status?: JobStatus | null; limit?: number } = {},
): JobRecord[] {
  ensureJobsSchema();
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.sessionName) {
    clauses.push("session_name = ?");
    params.push(input.sessionName);
  }
  if (input.status) {
    clauses.push("status = ?");
    params.push(input.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
  const rows = getDb()
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as JobRow[];
  return rows.map(rowToJob);
}

export function dbMarkJobRunning(id: string, pid: number | null): boolean {
  ensureJobsSchema();
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE jobs SET status = 'running', pid = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(pid, now, now, id);
  return getDbChanges() > 0;
}

export function dbFinishJob(
  id: string,
  input: { status: Exclude<JobStatus, "pending" | "running">; exitCode: number | null; signal: string | null },
): boolean {
  ensureJobsSchema();
  const now = Date.now();
  getDb()
    .prepare("UPDATE jobs SET status = ?, exit_code = ?, signal = ?, finished_at = ?, updated_at = ? WHERE id = ?")
    .run(input.status, input.exitCode, input.signal, now, now, id);
  return getDbChanges() > 0;
}

export function dbMarkJobNotified(id: string): boolean {
  ensureJobsSchema();
  const now = Date.now();
  getDb().prepare("UPDATE jobs SET notified_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return getDbChanges() > 0;
}

/** Jobs que ficaram marcados como rodando quando o daemon morreu. */
export function dbListRunningJobs(): JobRecord[] {
  ensureJobsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY created_at")
    .all() as JobRow[];
  return rows.map(rowToJob);
}

function ensureJobsSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      session_name TEXT,
      agent_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','killed')),
      pid INTEGER,
      exit_code INTEGER,
      signal TEXT,
      log_path TEXT NOT NULL,
      origin TEXT NOT NULL,
      notified_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
  `);
}
