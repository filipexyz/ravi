import type { Changes, Database, SQLQueryBindings } from "bun:sqlite";
import { withSchemaMigrationLock } from "../db/schema-lock.js";

// Fixed by the compiled writer; never supplied through environment or callers.
export const THREAD_WRITER_PROTOCOL = 1;
export const THREAD_FENCE_TABLE = "thread_schema_fence";
export const THREAD_FENCED_TABLES = [
  "slack_thread_lifecycle",
  "threads",
  "thread_entries",
  "thread_links",
  "thread_handoffs",
  "decisions",
  "decision_history",
  "decision_deliveries",
  "slack_thread_turn_health",
  "slack_thread_attention_notices",
  "state_schema_versions",
] as const;
const leaseTable = "thread_schema_write_lease";
const triggerPrefix = "thread_fence_";
let savepointSequence = 0;

export type ThreadFencePhase = "legacy_ready" | "frozen" | "migrating" | "canonical_ready";
export interface ThreadSchemaFence {
  min_protocol: number;
  phase: ThreadFencePhase;
  epoch: number;
}
export interface ThreadFenceBootstrapContext {
  existingSchema: boolean;
  databasePath: string;
}
export type ThreadFenceBootstrapVerifier = (context: ThreadFenceBootstrapContext) => undefined;
export type ThreadFenceMaintenanceVerifier = () => undefined;
interface ConnectionFence {
  prepared: boolean;
  verifyLegacyBootstrap?: ThreadFenceBootstrapVerifier;
}
const connections = new WeakMap<Database, ConnectionFence>();

export class ThreadSchemaFenceError extends Error {
  constructor(
    readonly code: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options);
  }
}
function refused(detail: string, cause?: unknown): never {
  throw new ThreadSchemaFenceError("THREAD_SCHEMA_FENCED", detail, cause ? { cause } : undefined);
}

function assertSynchronousProof(result: unknown): void {
  if (result === undefined) return;
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as PromiseLike<unknown>).then === "function"
  ) {
    // A rejected async verifier is already invalid evidence. Consume its
    // rejection so refusing synchronously does not create an unhandled rejection.
    void Promise.resolve(result).catch(() => {
      // no-cause: Async proof is refused synchronously below; this observer only prevents a later unhandled rejection.
    });
  }
  refused(
    "Proof verifiers must complete synchronously and return undefined; async evidence cannot authorize mutation.",
  );
}

/** Connection bookkeeping only: does not initialize schema or grant a SQL lease. */
export function registerThreadFenceConnection(
  db: Database,
  verifyLegacyBootstrap?: ThreadFenceBootstrapVerifier,
): void {
  if (!connections.has(db)) connections.set(db, { prepared: false, verifyLegacyBootstrap });
}
function hasFence(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(THREAD_FENCE_TABLE) !== null;
}
export function usesThreadSchemaFence(db: Database): boolean {
  return connections.has(db) || hasFence(db);
}

export function readThreadSchemaFence(db: Database): ThreadSchemaFence {
  try {
    const rows = db
      .query(`SELECT min_protocol, phase, epoch FROM ${THREAD_FENCE_TABLE} WHERE id = 1`)
      .all() as ThreadSchemaFence[];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isSafeInteger(row.min_protocol) ||
      row.min_protocol < 1 ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 0 ||
      !["legacy_ready", "frozen", "migrating", "canonical_ready"].includes(row.phase)
    ) {
      refused("Missing or invalid durable thread fence; maintenance remains blocked.");
    }
    return row;
  } catch (cause) {
    if (cause instanceof ThreadSchemaFenceError) throw cause;
    refused("The durable thread fence is unavailable; start only after verified offline preparation.", cause);
  }
}
export function assertThreadFenceReady(db: Database): void {
  const fence = readThreadSchemaFence(db);
  if (fence.min_protocol > THREAD_WRITER_PROTOCOL) refused("This bundle is older than the durable writer protocol.");
  if (fence.phase !== "legacy_ready") refused(`Thread schema phase is ${fence.phase}; traffic remains stopped.`);
}
export function assertThreadFenceSchemaWriteAllowed(db: Database): void {
  if (usesThreadSchemaFence(db)) assertThreadFenceReady(db);
}

function installTableTriggers(db: Database): void {
  for (const table of THREAD_FENCED_TABLES) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${triggerPrefix}${table}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM ${leaseTable} l JOIN ${THREAD_FENCE_TABLE} f ON f.id = l.id
            WHERE l.id = 1 AND l.protocol >= f.min_protocol AND l.epoch = f.epoch
              AND l.purpose = 'write' AND f.phase = 'legacy_ready'
          ) THEN RAISE(ABORT, 'THREAD_SCHEMA_FENCED: current transactional writer lease required') END;
        END`);
    }
  }
}

/** Additive preparation. Existing or real state requires external offline proof. */
export function prepareThreadFence(db: Database): void {
  const state = connections.get(db);
  if (!state) refused("Register the compiled writer protocol before preparing schema.");
  withSchemaMigrationLock(db, () => {
    if (hasFence(db)) {
      assertThreadFenceReady(db);
      state.prepared = true;
      return;
    }
    if (
      state.prepared ||
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name GLOB ? LIMIT 1").get(`${triggerPrefix}*`)
    ) {
      refused("Previously installed fence is missing; automatic repair is forbidden.");
    }
    const existing = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
      .get();
    if (existing && !state.verifyLegacyBootstrap)
      refused(
        "First installation on existing state requires externally verified persistence and process-exit evidence.",
      );
    assertSynchronousProof(
      state.verifyLegacyBootstrap?.({ existingSchema: Boolean(existing), databasePath: db.filename }),
    );
    db.transaction(() => {
      db.exec(`CREATE TABLE ${THREAD_FENCE_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        min_protocol INTEGER NOT NULL CHECK (typeof(min_protocol) = 'integer' AND min_protocol >= 1),
        phase TEXT NOT NULL CHECK (phase IN ('legacy_ready', 'frozen', 'migrating', 'canonical_ready')),
        epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch >= 0)
      );
      INSERT INTO ${THREAD_FENCE_TABLE} VALUES (1, ${THREAD_WRITER_PROTOCOL}, 'legacy_ready', 0);
      CREATE TABLE ${leaseTable} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        protocol INTEGER NOT NULL CHECK (typeof(protocol) = 'integer' AND protocol >= 1),
        epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch >= 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('write', 'freeze'))
      );
      CREATE TRIGGER ${triggerPrefix}control_insert BEFORE INSERT ON ${THREAD_FENCE_TABLE}
        BEGIN SELECT RAISE(ABORT, 'THREAD_SCHEMA_FENCED: singleton cannot be replaced'); END;
      CREATE TRIGGER ${triggerPrefix}control_delete BEFORE DELETE ON ${THREAD_FENCE_TABLE}
        BEGIN SELECT RAISE(ABORT, 'THREAD_SCHEMA_FENCED: fence cannot be deleted'); END;
      CREATE TRIGGER ${triggerPrefix}control_update BEFORE UPDATE ON ${THREAD_FENCE_TABLE} BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM ${leaseTable} WHERE id = 1 AND purpose = 'freeze'
            AND protocol >= OLD.min_protocol AND epoch = OLD.epoch)
            THEN RAISE(ABORT, 'THREAD_SCHEMA_FENCED: maintenance owner required')
          WHEN NEW.id != OLD.id OR NEW.min_protocol < OLD.min_protocol OR NEW.epoch != OLD.epoch + 1
            THEN RAISE(ABORT, 'THREAD_SCHEMA_FENCED: fence cannot regress')
          WHEN NEW.min_protocol > (SELECT protocol FROM ${leaseTable} WHERE id = 1)
            THEN RAISE(ABORT, 'THREAD_SCHEMA_FENCED: unsupported writer protocol')
          WHEN OLD.phase != 'legacy_ready' OR NEW.phase != 'frozen'
            THEN RAISE(ABORT, 'THREAD_SCHEMA_FENCED: this release only prepares and freezes')
        END;
      END;`);
      installTableTriggers(db);
    }).immediate();
    state.prepared = true;
  });
}
export function prepareRegisteredThreadFence(db: Database): void {
  if (connections.has(db)) prepareThreadFence(db);
}
export function installThreadFenceTriggers(db: Database): void {
  if (!connections.has(db)) return;
  assertThreadFenceReady(db);
  installTableTriggers(db);
}

/**
 * Own ONE native prepared DML execution. No callback, user SQL exec(), async gap,
 * TTL, or committed lease. SQLite serializes writers; another connection cannot
 * observe this lease before commit, and it has already been deleted at commit.
 * Nested callers retain their outer transaction; our SAVEPOINT removes the lease
 * before returning, including before a caller can issue its own COMMIT.
 */
export function runThreadMutation(db: Database, sql: string, ...bindings: SQLQueryBindings[]): Changes {
  if (typeof sql !== "string" || !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
    refused(
      "Only one prepared INSERT, UPDATE, DELETE or REPLACE is allowed; transaction control and PRAGMA are forbidden.",
    );
  }
  return mutateWithLease(db, "write", sql, bindings);
}

function mutateWithLease(
  db: Database,
  purpose: "write" | "freeze",
  sql: string,
  bindings: SQLQueryBindings[],
): Changes {
  assertThreadFenceReady(db);
  // prepare() compiles only the first statement; it never executes a suffix such
  // as '; COMMIT'. The supplied text is NEVER passed to Database.exec().
  const statement = db.prepare(sql);
  const outer = db.inTransaction;
  const savepoint = `thread_writer_${++savepointSequence}`;
  let started = false;
  try {
    db.exec(outer ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    started = true;
    assertThreadFenceReady(db);
    const fence = readThreadSchemaFence(db);
    if (db.query(`SELECT 1 FROM ${leaseTable} LIMIT 1`).get())
      refused("Unexpected outstanding lease; refuse rather than inherit writer authority.");
    db.query(`INSERT INTO ${leaseTable} (id, protocol, epoch, purpose) VALUES (1, ?, ?, ?)`).run(
      THREAD_WRITER_PROTOCOL,
      fence.epoch,
      purpose,
    );
    const result = statement.run(...bindings);
    db.exec(`DELETE FROM ${leaseTable}`);
    db.exec(outer ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (cause) {
    if (started && db.inTransaction) {
      try {
        if (outer) db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        else db.exec("ROLLBACK");
      } catch (rollbackCause) {
        // Preserve the original mutation failure, and refuse reuse of a handle
        // whose lease cleanup cannot be proven. Close rolls back uncommitted SQL.
        db.close();
        throw new AggregateError([cause, rollbackCause], "Thread mutation and lease rollback both failed", { cause });
      }
    }
    throw cause;
  } finally {
    statement.finalize();
  }
}

/** This release exposes freeze only: no migration, thaw or canonical cutover. */
export function freezeThreadWrites(
  db: Database,
  expectedEpoch: number,
  verifyMaintenance: ThreadFenceMaintenanceVerifier,
): ThreadSchemaFence {
  return withSchemaMigrationLock(db, () => {
    // External checks run BEFORE issuing the internal lease, never while a
    // callback could COMMIT it or change connection settings.
    assertSynchronousProof(verifyMaintenance());
    const current = readThreadSchemaFence(db);
    if (current.epoch !== expectedEpoch) refused("Maintenance epoch changed; refresh the evidence before retrying.");
    const result = mutateWithLease(
      db,
      "freeze",
      `UPDATE ${THREAD_FENCE_TABLE} SET phase = 'frozen', epoch = epoch + 1 WHERE id = 1 AND epoch = ?`,
      [expectedEpoch],
    );
    if (result.changes !== 1) refused("Maintenance epoch changed; refresh the evidence before retrying.");
    return readThreadSchemaFence(db);
  });
}
