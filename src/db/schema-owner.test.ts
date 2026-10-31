import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertRuntimeStateReady } from "./runtime-state.js";
import { assertStateSchemaReady, initializeStateSchema, STATE_SCHEMA_VERSION } from "./schema-owner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-schema-owner-"));
  dirs.push(dir);
  return dir;
}
const channels = { argv: ["bun", "index.js", "channels", "run"] };

it("channels refuses old/unprepared schema without executing migrations or changing schema/data", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE task_decisions (id TEXT); INSERT INTO task_decisions VALUES ('kept')");
  let migrated = false;
  expect(() =>
    initializeStateSchema(
      db,
      "router",
      () => {
        migrated = true;
        db.exec("DROP TABLE task_decisions");
      },
      channels,
    ),
  ).toThrow("Start the installed daemon first");
  expect(migrated).toBe(false);
  expect(db.query("SELECT * FROM task_decisions").all()).toEqual([{ id: "kept" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='state_schema_versions'").get()).toBeNull();
  db.close();
});

it("matching release serves normal queries while wrong release fails and failed migration leaves no ready marker", () => {
  const db = new Database(":memory:");
  initializeStateSchema(db, "router", () => db.exec("CREATE TABLE ready (id TEXT)"));
  expect(() => assertStateSchemaReady(db, "router")).not.toThrow();
  db.query("INSERT INTO ready VALUES (?)").run("normal traffic");
  expect(db.query("SELECT id FROM ready").get()).toEqual({ id: "normal traffic" });
  db.query("UPDATE state_schema_versions SET version = 'old'").run();
  expect(() => assertStateSchemaReady(db, "router")).toThrow("same release");
  expect(() =>
    initializeStateSchema(db, "partial", () => {
      throw new Error("migration failed");
    }),
  ).toThrow("migration failed");
  expect(() => assertStateSchemaReady(db, "partial")).toThrow("STATE_SCHEMA_NOT_READY");
  expect(STATE_SCHEMA_VERSION).toStartWith("1:");
  db.close();
});

it("channels startup refuses missing state before connecting to NATS and creates no database", () => {
  const state = fixture();
  const result = run(
    state,
    `
    const { ChannelRunner } = await import('./src/channels/runner.ts');
    try { await new ChannelRunner({ natsUrl: 'nats://127.0.0.1:1' }).start(); throw new Error('UNSAFE_START'); }
    catch (error) { if (error.code !== 'STATE_SCHEMA_NOT_READY') throw error; }
  `,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(state).filter((name) => name.endsWith(".db"))).toEqual([]);
});

it("daemon prepares all stores; channels validates and uses those stores with zero schema changes", () => {
  const state = fixture();
  const prepared = run(
    state,
    `const { initializeRuntimeState } = await import('./src/db/runtime-state.ts'); await initializeRuntimeState();`,
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(state)
        .filter((name) => name.endsWith(".db"))
        .map((name) => {
          const db = new Database(join(state, name), { readonly: true });
          const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
          const markers = db.query("SELECT * FROM state_schema_versions ORDER BY component").all();
          const version = db.query("PRAGMA schema_version").get();
          db.close();
          return [name, { schema, markers, version }];
        }),
    );
  const before = snapshot();
  expect(() => assertRuntimeStateReady({ RAVI_STATE_DIR: state })).not.toThrow();
  const consumer = run(
    state,
    `
    process.argv[2] = 'channels'; process.argv[3] = 'run';
    const { assertRuntimeStateReady, initializeRuntimeState } = await import('./src/db/runtime-state.ts');
    assertRuntimeStateReady(); await initializeRuntimeState();
    const { getDb } = await import('./src/router/router-db.ts');
    if (!getDb().query('SELECT id FROM agents').get()) throw new Error('NORMAL_QUERY_FAILED');
  `,
  );
  expect(consumer.status, consumer.stderr).toBe(0);
  expect(snapshot()).toEqual(before);
  const old = new Database(join(state, "ravi.db"));
  old.query("UPDATE state_schema_versions SET version = 'old' WHERE component='router'").run();
  old.close();
  expect(() => assertRuntimeStateReady({ RAVI_STATE_DIR: state })).toThrow("STATE_SCHEMA_NOT_READY");
});

function run(state: string, script: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("RAVI_") || key.startsWith("GIT_")) delete env[key];
  return spawnSync(process.execPath, ["--eval", script], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...env, RAVI_STATE_DIR: state, LOG_LEVEL: "error" },
    encoding: "utf8",
    timeout: 15000,
  });
}
