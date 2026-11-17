/** SQLite evidence lifecycle for the dedicated retained test preload only. */
import type { Database, Statement } from "bun:sqlite";

export interface RetainedSqliteSnapshot {
  requested: string;
  tables: Record<string, unknown[]>;
  journalMode?: unknown;
  error?: string;
}

export interface RetainedSqliteConnection {
  readonly requested: string;
  readonly db: Database;
  /** Read live data afresh, or return evidence captured before a completed close. */
  snapshot(): RetainedSqliteSnapshot;
}

/** Collector-owned statements must not change whether native close(true) can succeed. */
function readStatement<Row, Result>(
  db: Database,
  sql: string,
  read: (statement: Statement<Row, []>) => Result,
): Result {
  const statement = db.prepare<Row, []>(sql);
  try {
    return read(statement);
  } finally {
    statement.finalize();
  }
}

/** Retain partial evidence when a real query or statement finalization fails. */
function captureConnection(requested: string, db: Database): RetainedSqliteSnapshot {
  const tables: RetainedSqliteSnapshot["tables"] = {};
  try {
    const names = readStatement<{ name: string }, Array<{ name: string }>>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      (statement) => statement.all(),
    );
    for (const { name } of names) {
      const records = readStatement(db, `SELECT * FROM "${name.replaceAll('"', '""')}"`, (statement) =>
        statement.all(),
      );
      if (records.length) tables[name] = records;
    }
    const journalMode = readStatement(db, "PRAGMA journal_mode", (statement) => statement.get());
    return { requested, tables, journalMode };
  } catch (error) {
    return { requested, tables, error: String(error) };
  }
}

/**
 * Retains evidence per actual connection; callers must keep one returned record
 * per open, even when multiple opens requested the same pathname.
 *
 * The close wrapper preserves the original receiver, arguments, return value and
 * exception. Bun's native disposal calls this.close(true); leaving it intact lets
 * a close decorator finish writing before capture immediately at native close.
 * Only a successful native close confirms that its snapshot is final. A disposal
 * that calls a replacement/no-op close leaves the record live for fresh capture.
 *
 * Capture errors stay in evidence without replacing native close exceptions.
 * This function opens no database, registers no hooks and performs no file I/O.
 */
export function trackRetainedSqliteConnection(requested: string, db: Database): RetainedSqliteConnection {
  const nativeClose = db.close;
  let closed = false;
  let retainedSnapshot: RetainedSqliteSnapshot | undefined;
  let captureFailure: string | undefined;

  /** A caller catch or a later successful capture cannot clear earlier evidence loss. */
  function capture(): RetainedSqliteSnapshot {
    const value = captureConnection(requested, db);
    if (value.error !== undefined) captureFailure ??= value.error;
    return value;
  }

  /** Commit evidence only after the native close actually returns successfully. */
  function retainBeforeClose<Result>(invoke: () => Result): Result {
    if (closed) return invoke();
    const snapshot = capture();
    const result = invoke();
    closed = true;
    retainedSnapshot = snapshot;
    return result;
  }

  Object.defineProperty(db, "close", {
    configurable: true,
    writable: true,
    value(this: unknown, ...args: unknown[]) {
      const invoke = () => Reflect.apply(nativeClose, this, args);
      return this === db ? retainBeforeClose(invoke) : invoke();
    },
  });

  return {
    requested,
    db,
    snapshot() {
      const value = closed
        ? (retainedSnapshot ?? { requested, tables: {}, error: "TEST_RETAINED_SQLITE_CAPTURE_MISSING" })
        : capture();
      return captureFailure === undefined ? value : { ...value, error: captureFailure };
    },
  };
}
