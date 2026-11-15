import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStateSchema, STATE_SCHEMA_VERSION } from "../db/schema-owner.js";
import { openStateDatabase } from "../db/state-boundary.js";
import {
  assertThreadFenceReady,
  freezeThreadWrites,
  installThreadFenceTriggers,
  prepareThreadFence,
  readThreadSchemaFence,
  registerThreadFenceConnection,
  runThreadMutation,
  THREAD_FENCED_TABLES,
  THREAD_WRITER_PROTOCOL,
  type ThreadFenceBootstrapVerifier,
  type ThreadFenceMaintenanceVerifier,
} from "./schema-fence.js";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "ravi-thread-fence-"));
  directories.push(directory);
  return join(directory, "writers.db");
}
function open(filename = ":memory:"): Database {
  const db = openStateDatabase(filename);
  databases.push(db);
  return db;
}
function owner(filename = ":memory:", verify?: () => undefined): Database {
  const db = open(filename);
  registerThreadFenceConnection(db, verify);
  prepareThreadFence(db);
  return db;
}
function schema(db: Database): void {
  initializeStateSchema(db, "router", () => {
    for (const table of THREAD_FENCED_TABLES) {
      if (table === "state_schema_versions") continue;
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, value TEXT)`);
      db.query(`INSERT INTO ${table} VALUES (?, ?)`).run(table, "pending");
    }
  });
}
function noLease(db: Database): void {
  expect(db.query("SELECT * FROM thread_schema_write_lease").all()).toEqual([]);
}

describe("thread SQL transactional writer fence", () => {
  it("prepares empty isolated state additively without migrating Thread data or installing UDFs", () => {
    const db = owner();
    expect(readThreadSchemaFence(db)).toEqual({
      min_protocol: THREAD_WRITER_PROTOCOL,
      phase: "legacy_ready",
      epoch: 0,
    });
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
      { name: "thread_schema_fence" },
      { name: "thread_schema_write_lease" },
    ]);
    schema(db);
    expect(() => assertThreadFenceReady(db)).not.toThrow();
    expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "pending" });
    expect(() => db.exec("UPDATE threads SET value = 'raw-current-writer'")).toThrow(
      "transactional writer lease required",
    );
    expect(runThreadMutation(db, "UPDATE threads SET value = ?", "current").changes).toBe(1);
    noLease(db);
  });

  it("refuses first installation on existing state before readiness or schema can change", () => {
    const db = open();
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, value TEXT); INSERT INTO threads VALUES ('kept', 'private context')",
    );
    db.exec(
      "CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL); INSERT INTO state_schema_versions VALUES ('router', 'prior-release')",
    );
    const before = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    registerThreadFenceConnection(db);
    let initialized = false;
    expect(() =>
      initializeStateSchema(db, "router", () => {
        initialized = true;
      }),
    ).toThrow("externally verified persistence");
    expect(initialized).toBe(false);
    expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.query("SELECT * FROM threads").all()).toEqual([{ id: "kept", value: "private context" }]);
    expect(db.query("SELECT version FROM state_schema_versions").get()).toEqual({ version: "prior-release" });
  });

  it("does not translate failed external persistence/exit proof into successful bootstrap", () => {
    const db = open();
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
    registerThreadFenceConnection(db, () => {
      throw new Error("old channels PID still alive");
    });
    expect(() => prepareThreadFence(db)).toThrow("old channels PID still alive");
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
  });

  it("consults the external boundary for empty state too and leaves it untouched on refusal", () => {
    const filename = path();
    const db = open(filename);
    let inspected: { existingSchema: boolean; databasePath: string } | undefined;
    registerThreadFenceConnection(db, (context) => {
      inspected = context;
      throw new Error("fresh real state requires proof");
    });
    expect(() => prepareThreadFence(db)).toThrow("fresh real state requires proof");
    expect(inspected).toEqual({ existingSchema: false, databasePath: filename });
    expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it.each(["resolve", "reject"])(
    "refuses an async %s bootstrap verifier before any schema mutation",
    async (outcome) => {
      const db = open();
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, value TEXT); INSERT INTO threads VALUES ('kept', 'pending')");
      db.exec(
        "CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL); INSERT INTO state_schema_versions VALUES ('router', 'prior-release')",
      );
      const before = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
      const verifier = async () => {
        if (outcome === "reject") throw new Error("external proof rejected asynchronously");
      };
      // Exercise untyped callers too; the public type also excludes Promise.
      registerThreadFenceConnection(db, verifier as unknown as ThreadFenceBootstrapVerifier);
      expect(() => prepareThreadFence(db)).toThrow("must complete synchronously");
      expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
      expect(db.query("SELECT * FROM threads").all()).toEqual([{ id: "kept", value: "pending" }]);
      expect(db.query("SELECT version FROM state_schema_versions").get()).toEqual({ version: "prior-release" });
    },
  );

  it.each(["resolve", "reject"])(
    "refuses an async %s freeze verifier before changing phase or issuing a lease",
    async (outcome) => {
      const db = owner();
      schema(db);
      const before = readThreadSchemaFence(db);
      const verifier = async () => {
        if (outcome === "reject") throw new Error("maintenance proof rejected asynchronously");
      };
      expect(() => freezeThreadWrites(db, 0, verifier as unknown as ThreadFenceMaintenanceVerifier)).toThrow(
        "must complete synchronously",
      );
      expect(readThreadSchemaFence(db)).toEqual(before);
      noLease(db);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readThreadSchemaFence(db)).toEqual(before);
      noLease(db);
      expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "pending" });
    },
  );

  it("blocks legacy cached connection/statements, including readiness invalidation", () => {
    const filename = path();
    const legacy = open(filename);
    legacy.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, value TEXT); INSERT INTO threads VALUES ('work', 'queued')",
    );
    legacy.exec(
      "CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL); INSERT INTO state_schema_versions VALUES ('router', 'prior-release')",
    );
    const reply = legacy.prepare("UPDATE threads SET value = ? WHERE id = 'work'");
    const readiness = legacy.prepare("DELETE FROM state_schema_versions WHERE component = 'router'");
    reply.run("accepted-before-preparation");
    let proofs = 0;
    const current = owner(filename, () => {
      proofs++;
    });
    expect(proofs).toBe(1);
    expect(() => reply.run("old-reply")).toThrow("transactional writer lease required");
    expect(() => readiness.run()).toThrow("transactional writer lease required");
    runThreadMutation(current, "UPDATE threads SET value = ?", "new-reply");
    expect(() => reply.run("after-new-reply")).toThrow("transactional writer lease required");
    expect(current.query("SELECT value FROM threads").get()).toEqual({ value: "new-reply" });
    expect(current.query("SELECT version FROM state_schema_versions").get()).toEqual({ version: "prior-release" });
    noLease(legacy);
  });

  it.each(THREAD_FENCED_TABLES)("guards INSERT/UPDATE/DELETE on %s, even on a registered raw handle", (table) => {
    const filename = path();
    const current = owner(filename);
    schema(current);
    const legacy = open(filename);
    const statements =
      table === "state_schema_versions"
        ? [
            "INSERT INTO state_schema_versions VALUES ('other', 'old')",
            "UPDATE state_schema_versions SET version = 'old'",
            "DELETE FROM state_schema_versions",
          ]
        : [`INSERT INTO ${table} VALUES ('other', 'old')`, `UPDATE ${table} SET value = 'old'`, `DELETE FROM ${table}`];
    for (const sql of statements) {
      expect(() => legacy.exec(sql)).toThrow("transactional writer lease required");
      expect(() => current.exec(sql)).toThrow("transactional writer lease required");
    }
    noLease(current);
  });

  it.each([
    "COMMIT",
    "END",
    "BEGIN IMMEDIATE",
    "ROLLBACK",
    "SAVEPOINT unsafe",
    "PRAGMA defer_foreign_keys=OFF",
    "CREATE TABLE unsafe (id)",
  ])("rejects transaction/settings/schema SQL as a mutation: %s", (sql) => {
    const db = owner();
    schema(db);
    expect(() => runThreadMutation(db, sql)).toThrow("transaction control and PRAGMA are forbidden");
    expect(db.inTransaction).toBe(false);
    noLease(db);
  });

  it("has no callback surface, and native preparation never executes a multi-statement suffix", () => {
    const db = owner();
    schema(db);
    let called = false;
    expect(() =>
      runThreadMutation(db, (() => {
        called = true;
      }) as unknown as string),
    ).toThrow("Only one prepared");
    expect(called).toBe(false);
    db.exec("BEGIN IMMEDIATE");
    runThreadMutation(db, "UPDATE threads SET value = 'only-first'; COMMIT; UPDATE threads SET value = 'unsafe'");
    expect(db.inTransaction).toBe(true);
    noLease(db);
    db.exec("COMMIT");
    expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "only-first" });
  });

  it("nested raw BEGIN and Bun transactions keep atomicity with the lease removed before return", () => {
    const filename = path();
    const db = owner(filename);
    schema(db);
    const legacy = open(filename);
    db.exec("BEGIN IMMEDIATE");
    runThreadMutation(db, "UPDATE threads SET value = ?", "outer");
    noLease(db);
    db.transaction(() => {
      runThreadMutation(db, "UPDATE thread_entries SET value = ?", "nested");
      noLease(db);
    })();
    expect(() => legacy.exec("UPDATE threads SET value = 'concurrent-legacy'")).toThrow(/locked|busy/i);
    db.exec("COMMIT");
    expect(() => legacy.exec("UPDATE threads SET value = 'legacy-after-commit'")).toThrow(
      "transactional writer lease required",
    );
    noLease(legacy);
    expect(legacy.query("SELECT value FROM thread_entries").get()).toEqual({ value: "nested" });
  });

  it("preserves an outer transaction on statement failure and removes all uncommitted grants on rollback", () => {
    const db = owner();
    schema(db);
    db.exec("BEGIN IMMEDIATE");
    runThreadMutation(db, "UPDATE threads SET value = 'outer'");
    expect(() => runThreadMutation(db, "INSERT INTO threads VALUES ('threads', 'collision')")).toThrow(/UNIQUE/);
    expect(db.inTransaction).toBe(true);
    noLease(db);
    db.exec("ROLLBACK");
    expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "pending" });
    noLease(db);
    expect(() => runThreadMutation(db, "INSERT OR ROLLBACK INTO threads VALUES ('threads', 'collision')")).toThrow(
      /UNIQUE/,
    );
    expect(db.inTransaction).toBe(false);
    noLease(db);
    db.exec("BEGIN IMMEDIATE");
    runThreadMutation(db, "UPDATE threads SET value = 'must-roll-back-with-outer'");
    expect(() => runThreadMutation(db, "INSERT OR ROLLBACK INTO threads VALUES ('threads', 'collision')")).toThrow(
      /UNIQUE/,
    );
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "pending" });
    noLease(db);
  });

  it("a legacy read snapshot cannot acquire a writer lease after another writer commits", () => {
    const filename = path();
    const db = owner(filename);
    db.exec("PRAGMA journal_mode=WAL");
    schema(db);
    const legacy = open(filename);
    legacy.exec("BEGIN");
    legacy.query("SELECT value FROM threads").get();
    runThreadMutation(db, "UPDATE threads SET value = 'new'");
    expect(() => legacy.exec("UPDATE threads SET value = 'old-snapshot'")).toThrow(/locked|busy/i);
    legacy.exec("ROLLBACK");
    expect(() => legacy.exec("UPDATE threads SET value = 'old-retry'")).toThrow("transactional writer lease required");
  });

  it("does not depend on foreign_keys or defer_foreign_keys being enabled", () => {
    const db = owner();
    schema(db);
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA defer_foreign_keys=OFF; BEGIN IMMEDIATE");
    runThreadMutation(db, "UPDATE threads SET value = 'new'");
    noLease(db);
    db.exec("PRAGMA defer_foreign_keys=OFF; COMMIT");
    noLease(db);
    expect(() => db.exec("UPDATE threads SET value = 'raw'")).toThrow("transactional writer lease required");
  });

  it("process death inside SQLite's uncommitted lease sequence leaves neither mutation nor grant", () => {
    const filename = path();
    const db = owner(filename);
    schema(db);
    const child = spawnSync(
      process.execPath,
      [
        "--no-env-file",
        "--eval",
        `
      import { Database } from 'bun:sqlite';
      const db = new Database(process.env.THREAD_FENCE_CRASH_DB);
      db.exec("BEGIN IMMEDIATE; INSERT INTO thread_schema_write_lease VALUES(1,1,0,'write'); UPDATE threads SET value='uncommitted'");
      process.kill(process.pid, 'SIGKILL');
    `,
      ],
      { env: { THREAD_FENCE_CRASH_DB: filename }, encoding: "utf8", timeout: 5000 },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(db.query("SELECT value FROM threads").get()).toEqual({ value: "pending" });
    noLease(db);
    expect(() => db.exec("UPDATE threads SET value='raw-after-crash'")).toThrow("transactional writer lease required");
    runThreadMutation(db, "UPDATE threads SET value='recovered'");
    noLease(db);
  });

  it("freezes reply/receipt writers without losing durable queued work", () => {
    const filename = path();
    const db = owner(filename);
    schema(db);
    const channels = open(filename);
    expect(freezeThreadWrites(db, 0, () => {})).toEqual({ min_protocol: 1, phase: "frozen", epoch: 1 });
    expect(() => runThreadMutation(channels, "UPDATE slack_thread_lifecycle SET value = 'reply'")).toThrow(
      "traffic remains stopped",
    );
    expect(() => runThreadMutation(db, "UPDATE decision_deliveries SET value = 'receipt'")).toThrow(
      "traffic remains stopped",
    );
    expect(() => channels.exec("UPDATE slack_thread_lifecycle SET value = 'old-reply'")).toThrow(
      "transactional writer lease required",
    );
    expect(db.query("SELECT value FROM slack_thread_lifecycle").get()).toEqual({ value: "pending" });
    expect(db.query("SELECT value FROM decision_deliveries").get()).toEqual({ value: "pending" });
    noLease(db);
  });

  it("serializes freeze after accepted reply/receipt transactions instead of declaring partial work drained", () => {
    const filename = path();
    const daemon = owner(filename);
    schema(daemon);
    const channels = open(filename);
    channels.exec("BEGIN IMMEDIATE");
    runThreadMutation(channels, "UPDATE slack_thread_lifecycle SET value = 'reply-before-fence'");
    expect(() => freezeThreadWrites(daemon, 0, () => {})).toThrow(/locked|busy/i);
    expect(readThreadSchemaFence(daemon).phase).toBe("legacy_ready");
    runThreadMutation(channels, "UPDATE decision_deliveries SET value = 'receipt-before-fence'");
    channels.exec("COMMIT");
    freezeThreadWrites(daemon, 0, () => {});
    expect(daemon.query("SELECT value FROM decision_deliveries").get()).toEqual({ value: "receipt-before-fence" });
    noLease(daemon);
  });

  it("checks fence before cached schema initialization and preserves readiness on refusal", () => {
    const db = owner();
    schema(db);
    freezeThreadWrites(db, 0, () => {});
    let initialized = false;
    for (const component of ["router", "new-component"]) {
      expect(() =>
        initializeStateSchema(db, component, () => {
          initialized = true;
        }),
      ).toThrow("traffic remains stopped");
    }
    expect(initialized).toBe(false);
    expect(db.query("SELECT * FROM state_schema_versions").all()).toEqual([
      { component: "router", version: STATE_SCHEMA_VERSION },
    ]);
  });

  it("failed initialization fences partial tables and never republishes readiness", () => {
    const filename = path();
    const db = owner(filename);
    expect(() =>
      initializeStateSchema(db, "router", () => {
        db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, value TEXT)");
        throw new Error("partial schema initialization");
      }),
    ).toThrow("partial schema initialization");
    const legacy = open(filename);
    expect(() => legacy.exec("INSERT INTO threads VALUES ('late', 'unsafe')")).toThrow(
      "transactional writer lease required",
    );
    expect(() => legacy.exec("INSERT INTO state_schema_versions VALUES ('router', 'old-success')")).toThrow(
      "transactional writer lease required",
    );
    expect(db.query("SELECT * FROM state_schema_versions").all()).toEqual([]);
    noLease(db);
  });

  it("rejects stale epochs, unauthorized control, deletion and replacement of the durable fence", () => {
    const db = owner();
    expect(() => freezeThreadWrites(db, 7, () => {})).toThrow("Maintenance epoch changed");
    expect(readThreadSchemaFence(db).epoch).toBe(0);
    expect(() => runThreadMutation(db, "UPDATE thread_schema_fence SET phase='frozen', epoch=1")).toThrow(
      "maintenance owner required",
    );
    expect(() => db.exec("INSERT OR REPLACE INTO thread_schema_fence VALUES (1, 1, 'legacy_ready', 0)")).toThrow(
      "singleton cannot be replaced",
    );
    expect(() => db.exec("DELETE FROM thread_schema_fence")).toThrow("fence cannot be deleted");
    noLease(db);
    freezeThreadWrites(db, 0, () => {});
    expect(() => freezeThreadWrites(db, 1, () => {})).toThrow("traffic remains stopped");
  });

  it("treats missing durable state as failure rather than automatic repair", () => {
    const filename = path();
    const db = owner(filename);
    schema(db);
    db.exec("DROP TABLE thread_schema_fence");
    expect(() => db.exec("UPDATE threads SET value='unsafe'")).toThrow("thread_schema_fence");
    expect(() => prepareThreadFence(db)).toThrow("Previously installed fence is missing");
    const restart = open(filename);
    registerThreadFenceConnection(restart, () => {});
    expect(() => prepareThreadFence(restart)).toThrow("Previously installed fence is missing");
  });

  it("refuses a higher durable protocol before invalidating readiness", () => {
    const db = open();
    db.exec(
      "CREATE TABLE thread_schema_fence (id INTEGER PRIMARY KEY, min_protocol INTEGER, phase TEXT, epoch INTEGER); INSERT INTO thread_schema_fence VALUES (1, 2, 'canonical_ready', 2)",
    );
    db.exec(
      "CREATE TABLE state_schema_versions (component TEXT PRIMARY KEY, version TEXT); INSERT INTO state_schema_versions VALUES ('router', 'future')",
    );
    registerThreadFenceConnection(db);
    expect(() => initializeStateSchema(db, "router", () => {})).toThrow("older than the durable writer protocol");
    expect(() => installThreadFenceTriggers(db)).toThrow("older than the durable writer protocol");
    expect(db.query("SELECT version FROM state_schema_versions").get()).toEqual({ version: "future" });
  });
});
