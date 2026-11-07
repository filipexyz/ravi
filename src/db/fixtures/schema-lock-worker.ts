import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDaemonSchemaOwnership, markDaemonSchemaReady } from "../daemon-schema-owner.js";
import { acquireSchemaFileLock, SchemaLockBusyError, withSchemaMigrationLock } from "../schema-lock.js";

const [mode, root, name, resource] = process.argv.slice(2);
if (!mode || !root || !name) throw new Error("Missing isolated worker arguments");
const gate = new Int32Array(new SharedArrayBuffer(4));
const marker = (stage: string) => join(root, `${name}.${stage}`);
const signal = (stage: string, value = "ready") => writeFileSync(marker(stage), value);
function waitFor(path: string): void {
  const deadline = performance.now() + 15_000;
  while (!existsSync(path)) {
    if (performance.now() > deadline) throw new Error(`Worker barrier timed out: ${path}`);
    Atomics.wait(gate, 0, 0, 5);
  }
}
function record(event: string): void {
  appendFileSync(join(root, "events.log"), `${event}:${name}\n`);
}

signal("started");
if (mode === "hold" || mode === "try" || mode === "inherit") {
  if (!resource) throw new Error("Missing lock path");
  try {
    const lock = acquireSchemaFileLock(resource, mode === "try" ? 120 : 3_000);
    signal("acquired");
    if (mode === "hold") waitFor(marker("release"));
    if (mode === "inherit") {
      const child = spawn([process.execPath, "--no-env-file", import.meta.path, "idle", root, "grandchild"], {
        cwd: root,
        env: { RAVI_STATE_DIR: root, TZ: "UTC" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      signal("child", String(child.pid));
      waitFor(join(root, "grandchild.started"));
      // Keep the child's independent process alive after this lock owner exits.
      process.exit(0);
    }
    lock.release();
    signal("released");
  } catch (cause) {
    if (!(cause instanceof SchemaLockBusyError)) throw cause;
    signal("busy");
  }
} else if (mode === "idle") {
  waitFor(marker("release"));
} else if (mode === "migrate" || mode === "migrate-contender") {
  if (!resource) throw new Error("Missing database path");
  const db = new Database(resource);
  try {
    if (mode === "migrate-contender") {
      try {
        acquireSchemaFileLock(`${resource}.schema.lock`, 120).release();
        throw new Error("Contender unexpectedly acquired the occupied migration lock");
      } catch (cause) {
        if (!(cause instanceof SchemaLockBusyError)) throw cause;
        signal("blocked");
      }
    }
    withSchemaMigrationLock(db, () => {
      record("enter");
      signal("entered");
      if (mode === "migrate") waitFor(marker("release"));
      // The migration owns its transaction. An external BEGIN would fail here.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
        db.query("INSERT INTO migrations VALUES (?)").run(name);
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      record("exit");
    });
  } finally {
    db.close();
  }
} else if (mode === "foreign-keys") {
  if (!resource) throw new Error("Missing database path");
  const db = new Database(resource);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    withSchemaMigrationLock(db, () => {
      const row = db.query("SELECT sql FROM sqlite_master WHERE name = 'connections'").get() as { sql: string };
      if (row.sql.includes("'file'")) return;
      signal("inspected");
      waitFor(marker("release"));
      db.exec("PRAGMA foreign_keys = OFF");
      const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      if (fk.foreign_keys !== 0) throw new Error("Migration cannot disable foreign keys outside its transaction");
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE connections_next (id TEXT PRIMARY KEY, backend TEXT CHECK (backend IN ('keychain', 'file')));
            INSERT INTO connections_next SELECT * FROM connections;
            DROP TABLE connections;
            ALTER TABLE connections_next RENAME TO connections;
          `);
          if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Broken child references");
        }).immediate();
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    });
    signal("migrated");
  } finally {
    db.close();
  }
} else if (mode === "daemon") {
  acquireDaemonSchemaOwnership(root);
  // This represents the first possible state mutation by a successor.
  const db = new Database(join(root, `${name}.db`));
  db.exec("CREATE TABLE started (pid INTEGER)");
  db.query("INSERT INTO started VALUES (?)").run(process.pid);
  db.close();
  signal("owned");
  waitFor(marker("ready-go"));
  markDaemonSchemaReady();
  signal("ready");
  waitFor(marker("release"));
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}
signal("done");
