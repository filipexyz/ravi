/**
 * Central SQLite connection configuration.
 *
 * Every Database handle opened by Ravi should call {@link configureSqliteConnection}
 * immediately after construction so that WAL mode, busy-timeout, and foreign-key
 * enforcement are consistent across all DB files.
 *
 * Without busy_timeout, concurrent CLI/daemon processes that write to the same
 * database will surface raw "database is locked" errors instead of retrying.
 */

import type { Database } from "bun:sqlite";

export interface SqliteConnectionOptions {
  /** Milliseconds to wait when another connection holds a write lock (default 5 000). */
  busyTimeoutMs?: number;
  /** Enable foreign-key enforcement (default true). */
  foreignKeys?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Apply the standard set of PRAGMAs to a freshly-opened Database handle:
 *
 * - `journal_mode = WAL` — allows concurrent readers while a writer is active.
 * - `busy_timeout`       — waits (default 5 s) before throwing SQLITE_BUSY.
 * - `foreign_keys = ON`  — enforces FK constraints.
 */
export function configureSqliteConnection(db: Database, options: SqliteConnectionOptions = {}): void {
  const busyTimeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const foreignKeys = options.foreignKeys ?? true;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  if (foreignKeys) {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
