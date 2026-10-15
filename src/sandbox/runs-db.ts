// Sandbox run records and the served-jti queue, two module-owned tables in
// ravi.db (Console `sandbox-gateway/listener` SPEC §Local run record, §Drift
// Check "Reporting"; OSS `.ravi/specs/sandbox/listener`). Kept out of
// `router-db.ts` on purpose: the schema is created here with
// `CREATE TABLE IF NOT EXISTS`, every write goes through `executeWrite`.
//
// `sandbox_runs` holds, per run, the grant the host CLI received at mint and
// verified, plus the claims it was bound to and the two context ids that make
// up the run's authority. Revoking a run blanks the grant; a daemon start
// deletes expired and revoked rows. `sandbox_served_jtis` is the queue 05b
// reports to Console: one row per request the listener answered with
// `x-ravi-listener: 1`, appended BEFORE the response is written and removed
// only after Console acknowledged the report that carried it. It also backs
// the Gate-assertion replay cache across a restart, with the verified
// assertion `exp` when there was one.
//
// The connection runs with `secure_delete = ON`: the stored grant is a bearer
// credential, and blanking it on revoke or deleting the row must zero the
// freed bytes instead of leaving them in the file's free space.

import type { Database } from "bun:sqlite";
import { reconcileColumns } from "../db/reconcile-columns.js";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";

/** Unacknowledged served jtis kept at most; beyond it the oldest are dropped and the overflow flag set. */
export const SANDBOX_SERVED_JTI_QUEUE_MAX = 2048;
/** How many jtis one host report carries (oldest first). */
export const SANDBOX_SERVED_JTI_REPORT_BATCH = 128;

const schemaReady = new WeakSet<Database>();

// The source of truth for the module's tables: `reconcileColumns` adds any
// column declared here that an older ravi.db lacks (`assertion_exp` arrived
// after the first 04b schema), so existing databases evolve in place.
const SANDBOX_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS sandbox_runs (
      run_id TEXT PRIMARY KEY,
      jti TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      home_task_id TEXT,
      caps_json TEXT NOT NULL,
      cmds_json TEXT NOT NULL,
      grant_jws TEXT,
      grant_sha256 TEXT NOT NULL,
      org_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      root_context_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      e2b_sandbox_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoke_reason TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_request_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_runs_agent ON sandbox_runs(agent_id, expires_at);

    CREATE TABLE IF NOT EXISTS sandbox_served_jtis (
      jti TEXT PRIMARY KEY,
      run_id TEXT,
      status INTEGER NOT NULL,
      served_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      assertion_exp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_served_jtis_pending
      ON sandbox_served_jtis(acknowledged_at, served_at);

    CREATE TABLE IF NOT EXISTS sandbox_listener_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
`;

export function ensureSandboxSchema(): Database {
  const db = getDb();
  if (schemaReady.has(db)) return db;
  // Per connection, set once before any sandbox write: the revoke UPDATE
  // that blanks `grant_jws` and every prune DELETE zero what they free.
  db.exec("PRAGMA secure_delete = ON");
  db.exec(SANDBOX_SCHEMA_SQL);
  reconcileColumns(db, SANDBOX_SCHEMA_SQL, { label: "sandbox-runs-db" });
  schemaReady.add(db);
  return db;
}

export interface SandboxRunRecord {
  runId: string;
  /** The stored grant's `jti`. */
  jti: string;
  agentId: string;
  homeTaskId: string | null;
  caps: string[];
  cmds: string[];
  /** The grant compact JWS; `null` once the run is revoked. */
  grantJws: string | null;
  /** base64url SHA-256 of the grant, kept after revocation for the assertion lookup. */
  grantSha256: string;
  org: string;
  installationId: string;
  rootContextId: string;
  contextId: string;
  e2bSandboxId: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokeReason: string | null;
  requestCount: number;
  lastRequestAt: number | null;
}

export type SandboxRunInsert = Omit<
  SandboxRunRecord,
  "revokedAt" | "revokeReason" | "requestCount" | "lastRequestAt" | "e2bSandboxId"
> & { e2bSandboxId?: string | null };

interface SandboxRunRow {
  run_id: string;
  jti: string;
  agent_id: string;
  home_task_id: string | null;
  caps_json: string;
  cmds_json: string;
  grant_jws: string | null;
  grant_sha256: string;
  org_id: string;
  installation_id: string;
  root_context_id: string;
  context_id: string;
  e2b_sandbox_id: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
  request_count: number;
  last_request_at: number | null;
}

function rowToRun(row: SandboxRunRow): SandboxRunRecord {
  return {
    runId: row.run_id,
    jti: row.jti,
    agentId: row.agent_id,
    homeTaskId: row.home_task_id,
    caps: parseStringList(row.caps_json),
    cmds: parseStringList(row.cmds_json),
    grantJws: row.grant_jws,
    grantSha256: row.grant_sha256,
    org: row.org_id,
    installationId: row.installation_id,
    rootContextId: row.root_context_id,
    contextId: row.context_id,
    e2bSandboxId: row.e2b_sandbox_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    requestCount: row.request_count,
    lastRequestAt: row.last_request_at,
  };
}

function parseStringList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function dbInsertSandboxRun(input: SandboxRunInsert): SandboxRunRecord {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) =>
      handle
        .prepare(
          `INSERT INTO sandbox_runs (
            run_id, jti, agent_id, home_task_id, caps_json, cmds_json, grant_jws, grant_sha256, org_id,
            installation_id, root_context_id, context_id, e2b_sandbox_id, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.jti,
          input.agentId,
          input.homeTaskId,
          JSON.stringify(input.caps),
          JSON.stringify(input.cmds),
          input.grantJws,
          input.grantSha256,
          input.org,
          input.installationId,
          input.rootContextId,
          input.contextId,
          input.e2bSandboxId ?? null,
          input.createdAt,
          input.expiresAt,
        ),
    { label: "sandbox_runs.insert" },
  );
  return dbGetSandboxRun(input.runId)!;
}

export function dbGetSandboxRun(runId: string): SandboxRunRecord | null {
  const db = ensureSandboxSchema();
  const row = db.prepare("SELECT * FROM sandbox_runs WHERE run_id = ?").get(runId) as SandboxRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function dbListSandboxRuns(options: { includeInactive?: boolean; now?: number } = {}): SandboxRunRecord[] {
  const db = ensureSandboxSchema();
  const rows = db.prepare("SELECT * FROM sandbox_runs ORDER BY created_at ASC").all() as SandboxRunRow[];
  const now = options.now ?? Date.now();
  return rows.map(rowToRun).filter((run) => options.includeInactive || (run.revokedAt === null && run.expiresAt > now));
}

/** Marks the run revoked and blanks the stored grant; the hash stays for the assertion lookup. */
export function dbRevokeSandboxRun(runId: string, reason: string, revokedAt = Date.now()): SandboxRunRecord | null {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) =>
      handle
        .prepare(
          `UPDATE sandbox_runs SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?),
             grant_jws = NULL WHERE run_id = ?`,
        )
        .run(revokedAt, reason, runId),
    { label: "sandbox_runs.revoke" },
  );
  return dbGetSandboxRun(runId);
}

export function dbSetSandboxRunE2bSandboxId(runId: string, e2bSandboxId: string): void {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) => handle.prepare("UPDATE sandbox_runs SET e2b_sandbox_id = ? WHERE run_id = ?").run(e2bSandboxId, runId),
    { label: "sandbox_runs.attach" },
  );
}

export function dbBumpSandboxRunRequest(runId: string, at = Date.now()): void {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) =>
      handle
        .prepare("UPDATE sandbox_runs SET request_count = request_count + 1, last_request_at = ? WHERE run_id = ?")
        .run(at, runId),
    { label: "sandbox_runs.bump" },
  );
}

/** Deletes every expired or revoked run row (daemon start). Served-jti rows are never touched here. */
export function dbDeleteInactiveSandboxRuns(now = Date.now()): SandboxRunRecord[] {
  const db = ensureSandboxSchema();
  const inactive = dbListSandboxRuns({ includeInactive: true, now }).filter(
    (run) => run.revokedAt !== null || run.expiresAt <= now,
  );
  if (inactive.length === 0) return [];
  executeWrite(
    db,
    (handle) => {
      const del = handle.prepare("DELETE FROM sandbox_runs WHERE run_id = ?");
      for (const run of inactive) del.run(run.runId);
    },
    { label: "sandbox_runs.prune" },
  );
  return inactive;
}

// Served-jti queue.

export interface ServedJtiRecord {
  jti: string;
  runId: string | null;
  status: number;
  servedAt: number;
  acknowledgedAt: number | null;
  /** The verified Gate assertion's `exp` (Unix seconds); null when no assertion verified or for rows written before the column existed. */
  assertionExp: number | null;
}

interface ServedJtiRow {
  jti: string;
  run_id: string | null;
  status: number;
  served_at: number;
  acknowledged_at: number | null;
  assertion_exp: number | null;
}

const rowToServed = (row: ServedJtiRow): ServedJtiRecord => ({
  jti: row.jti,
  runId: row.run_id,
  status: row.status,
  servedAt: row.served_at,
  acknowledgedAt: row.acknowledged_at,
  assertionExp: row.assertion_exp ?? null,
});

/**
 * Appends one served jti. Called by the listener BEFORE it writes the
 * response; a throw here means the listener closes the connection instead.
 * A second request with an already-served jti (a refused replay) keeps the
 * first row. Returns whether the queue overflowed and dropped its oldest.
 */
export function dbAppendServedJti(input: {
  jti: string;
  runId: string | null;
  status: number;
  servedAt: number;
  /** The verified assertion's `exp` in Unix seconds, when the Gate assertion verified. */
  assertionExp?: number | null;
}): {
  overflow: boolean;
} {
  const db = ensureSandboxSchema();
  return executeWrite(
    db,
    (handle) => {
      handle
        .prepare(
          "INSERT OR IGNORE INTO sandbox_served_jtis (jti, run_id, status, served_at, assertion_exp) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.jti, input.runId, input.status, input.servedAt, input.assertionExp ?? null);
      const pending = (
        handle.prepare("SELECT COUNT(*) AS n FROM sandbox_served_jtis WHERE acknowledged_at IS NULL").get() as {
          n: number;
        }
      ).n;
      if (pending <= SANDBOX_SERVED_JTI_QUEUE_MAX) return { overflow: false };
      handle
        .prepare(
          `DELETE FROM sandbox_served_jtis WHERE jti IN (
             SELECT jti FROM sandbox_served_jtis WHERE acknowledged_at IS NULL ORDER BY served_at ASC, jti ASC LIMIT ?
           )`,
        )
        .run(pending - SANDBOX_SERVED_JTI_QUEUE_MAX);
      handle
        .prepare(
          `INSERT INTO sandbox_listener_state (key, value, updated_at) VALUES ('jti_overflow_at', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(input.servedAt), input.servedAt);
      return { overflow: true };
    },
    { label: "sandbox_served_jtis.append" },
  );
}

/** Oldest first, at most `limit`; what the next host report carries. */
export function dbListUnacknowledgedServedJtis(limit = SANDBOX_SERVED_JTI_REPORT_BATCH): ServedJtiRecord[] {
  const db = ensureSandboxSchema();
  const rows = db
    .prepare("SELECT * FROM sandbox_served_jtis WHERE acknowledged_at IS NULL ORDER BY served_at ASC, jti ASC LIMIT ?")
    .all(limit) as ServedJtiRow[];
  return rows.map(rowToServed);
}

export function dbCountUnacknowledgedServedJtis(): number {
  const db = ensureSandboxSchema();
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sandbox_served_jtis WHERE acknowledged_at IS NULL").get() as { n: number }
  ).n;
}

/** Served within the last `windowMs`, acknowledged or not: what a restarted listener preloads into its replay cache. */
export function dbListRecentServedJtis(now: number, windowMs: number): ServedJtiRecord[] {
  const db = ensureSandboxSchema();
  const rows = db
    .prepare("SELECT * FROM sandbox_served_jtis WHERE served_at >= ? ORDER BY served_at ASC")
    .all(now - windowMs) as ServedJtiRow[];
  return rows.map(rowToServed);
}

/** Console answered 2xx to the report that carried these jtis (05b). */
export function acknowledgeServedJtis(jtis: readonly string[], acknowledgedAt = Date.now()): number {
  if (jtis.length === 0) return 0;
  const db = ensureSandboxSchema();
  return executeWrite(
    db,
    (handle) => {
      const update = handle.prepare(
        "UPDATE sandbox_served_jtis SET acknowledged_at = ? WHERE jti = ? AND acknowledged_at IS NULL",
      );
      let changed = 0;
      for (const jti of jtis) changed += update.run(acknowledgedAt, jti).changes;
      return changed;
    },
    { label: "sandbox_served_jtis.acknowledge" },
  );
}

/** Acknowledged rows older than `before` can go; unacknowledged rows are never deleted here. */
export function dbPruneAcknowledgedServedJtis(before: number): number {
  const db = ensureSandboxSchema();
  return executeWrite(
    db,
    (handle) =>
      handle
        .prepare("DELETE FROM sandbox_served_jtis WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?")
        .run(before).changes,
    { label: "sandbox_served_jtis.prune" },
  );
}

/** When the persisted queue last dropped entries, or null; 05b reports `jtiOverflow` until an acknowledged report carried it. */
export function dbGetServedJtiOverflowAt(): number | null {
  const db = ensureSandboxSchema();
  const row = db.prepare("SELECT value FROM sandbox_listener_state WHERE key = 'jti_overflow_at'").get() as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dbClearServedJtiOverflow(): void {
  const db = ensureSandboxSchema();
  executeWrite(
    db,
    (handle) => handle.prepare("DELETE FROM sandbox_listener_state WHERE key = 'jti_overflow_at'").run(),
    {
      label: "sandbox_listener_state.clear_overflow",
    },
  );
}
