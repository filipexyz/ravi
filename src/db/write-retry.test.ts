import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { executeWrite, executeWriteWithStats, isSqliteLockError } from "./write-retry.js";

let dir: string | null = null;

function openTempDb(): { db: Database; path: string } {
  const path = join(dir as string, `${randomUUID()}.db`);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 0"); // tests want fast failure
  db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT)");
  return { db, path };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-write-retry-"));
});

afterEach(() => {
  if (dir !== null) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("isSqliteLockError", () => {
  it("recognizes locked/busy errors", () => {
    expect(isSqliteLockError(new Error("database is locked"))).toBe(true);
    expect(isSqliteLockError(new Error("SQLITE_BUSY: database is busy"))).toBe(true);
    expect(isSqliteLockError(new Error("foo locked bar"))).toBe(true);
  });

  it("ignores non-lock errors and non-Error values", () => {
    expect(isSqliteLockError(new Error("constraint failed"))).toBe(false);
    expect(isSqliteLockError(new Error("not null violation"))).toBe(false);
    expect(isSqliteLockError("string error")).toBe(false);
    expect(isSqliteLockError(null)).toBe(false);
  });
});

describe("executeWrite", () => {
  it("commits the transaction and returns the callback value", () => {
    const { db } = openTempDb();
    const result = executeWrite(db, (database) => {
      database.exec("INSERT INTO items (value) VALUES ('a')");
      database.exec("INSERT INTO items (value) VALUES ('b')");
      return 42;
    });
    expect(result).toBe(42);
    const row = db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number };
    expect(row.n).toBe(2);
    db.close();
  });

  it("rolls back when the callback throws a non-lock error", () => {
    const { db } = openTempDb();
    expect(() => {
      executeWrite(db, (database) => {
        database.exec("INSERT INTO items (value) VALUES ('a')");
        throw new Error("boom");
      });
    }).toThrow("boom");
    const row = db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it("stats report attempts=1 and retried=false on happy path", () => {
    const { db } = openTempDb();
    const { value, stats } = executeWriteWithStats(db, () => "ok");
    expect(value).toBe("ok");
    expect(stats.attempts).toBe(1);
    expect(stats.retried).toBe(false);
    expect(stats.totalSleepMs).toBe(0);
    db.close();
  });

  it("does not retry on non-lock errors", () => {
    const { db } = openTempDb();
    let calls = 0;
    expect(() => {
      executeWrite(
        db,
        () => {
          calls++;
          throw new Error("constraint failed");
        },
        { maxAttempts: 5, minJitterMs: 1, maxJitterMs: 1 },
      );
    }).toThrow("constraint failed");
    expect(calls).toBe(1);
    db.close();
  });

  it("retries on lock errors and surfaces the lock error after maxAttempts", () => {
    const { db, path } = openTempDb();

    // Open a second connection and hold the write lock open.
    const blocker = new Database(path);
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("BEGIN IMMEDIATE");
    blocker.exec("INSERT INTO items (value) VALUES ('held')");

    let caught: Error | null = null;
    let stats: { attempts: number; retried: boolean; totalSleepMs: number } | null = null;
    try {
      const out = executeWriteWithStats(
        db,
        (database) => {
          database.exec("INSERT INTO items (value) VALUES ('blocked')");
        },
        {
          maxAttempts: 3,
          minJitterMs: 1,
          maxJitterMs: 2,
          label: "test:fails-after-max",
        },
      );
      stats = out.stats;
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(isSqliteLockError(caught)).toBe(true);
    expect(stats).toBeNull();

    blocker.exec("ROLLBACK");
    blocker.close();
    db.close();
  });

  it("returns the callback result type as-is", () => {
    const { db } = openTempDb();
    interface Row {
      id: number;
      value: string;
    }
    const inserted = executeWrite<Row>(db, (database) => {
      database.exec("INSERT INTO items (value) VALUES ('typed')");
      return database.prepare("SELECT * FROM items WHERE value = 'typed'").get() as Row;
    });
    expect(inserted.value).toBe("typed");
    db.close();
  });
});
