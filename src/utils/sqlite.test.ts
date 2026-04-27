import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureSqliteConnection } from "./sqlite.js";

describe("configureSqliteConnection", () => {
  const dirs: string[] = [];
  function tmpDb(): { db: Database; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "ravi-sqlite-test-"));
    dirs.push(dir);
    return { db: new Database(join(dir, "test.db")), dir };
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("enables WAL mode, busy_timeout, and foreign_keys by default", () => {
    const { db } = tmpDb();
    configureSqliteConnection(db);

    const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const busy = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;

    expect(journal).toBe("wal");
    expect(busy).toBe(5000);
    expect(fk).toBe(1);
    db.close();
  });

  it("respects custom busy_timeout", () => {
    const { db } = tmpDb();
    configureSqliteConnection(db, { busyTimeoutMs: 10_000 });

    const busy = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    expect(busy).toBe(10_000);
    db.close();
  });

  it("can disable foreign keys", () => {
    const { db } = tmpDb();
    configureSqliteConnection(db, { foreignKeys: false });

    const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
    expect(fk).toBe(0);
    db.close();
  });

  it("concurrent writers do not throw SQLITE_BUSY with busy_timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-sqlite-concurrent-"));
    dirs.push(dir);
    const dbPath = join(dir, "concurrent.db");

    const db1 = new Database(dbPath);
    const db2 = new Database(dbPath);
    configureSqliteConnection(db1);
    configureSqliteConnection(db2);

    db1.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");

    const errors: Error[] = [];

    // Simulate concurrent writes from two connections (like two CLI processes).
    // With WAL + busy_timeout this must not throw "database is locked".
    for (let i = 0; i < 50; i++) {
      try {
        db1.prepare("INSERT INTO t (v) VALUES (?)").run(`conn1-${i}`);
      } catch (e) {
        errors.push(e as Error);
      }
      try {
        db2.prepare("INSERT INTO t (v) VALUES (?)").run(`conn2-${i}`);
      } catch (e) {
        errors.push(e as Error);
      }
    }

    const lockedErrors = errors.filter((e) => e.message.includes("database is locked"));
    expect(lockedErrors).toHaveLength(0);

    const count = (db1.prepare("SELECT COUNT(*) AS cnt FROM t").get() as { cnt: number }).cnt;
    expect(count).toBe(100);

    db1.close();
    db2.close();
  });

  it("concurrent writers throw SQLITE_BUSY without busy_timeout (regression proof)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-sqlite-no-timeout-"));
    dirs.push(dir);
    const dbPath = join(dir, "no-timeout.db");

    // Open two connections with WAL but WITHOUT busy_timeout.
    // This proves the failure mode that caused the original bug.
    const db1 = new Database(dbPath);
    const db2 = new Database(dbPath);
    db1.exec("PRAGMA journal_mode = WAL");
    db2.exec("PRAGMA journal_mode = WAL");

    db1.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");

    // Use explicit transactions to hold the write lock long enough for contention.
    // Without busy_timeout, db2 should fail immediately when db1 holds the lock.
    let lockedError = false;
    try {
      db1.exec("BEGIN IMMEDIATE");
      db1.prepare("INSERT INTO t (v) VALUES (?)").run("conn1");

      // db2 tries to start a write transaction while db1 still holds one
      db2.exec("BEGIN IMMEDIATE");
      db2.prepare("INSERT INTO t (v) VALUES (?)").run("conn2");
      db2.exec("COMMIT");
    } catch (e) {
      if ((e as Error).message.includes("database is locked")) {
        lockedError = true;
      }
    } finally {
      try {
        db1.exec("COMMIT");
      } catch {
        // may already be committed
      }
      try {
        db2.exec("ROLLBACK");
      } catch {
        // may not have started
      }
    }

    expect(lockedError).toBe(true);

    db1.close();
    db2.close();
  });
});
