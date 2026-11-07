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

it("interleaved initializers publish the same ready marker without a uniqueness failure", () => {
  const state = fixture();
  const path = join(state, "interleaved.db");
  const first = new Database(path);
  const second = new Database(path);
  try {
    initializeStateSchema(first, "chat", () => {
      first.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT)");
      initializeStateSchema(second, "chat", () => second.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT)"));
    });
    expect(() => assertStateSchemaReady(first, "chat")).not.toThrow();
    expect(() => assertStateSchemaReady(second, "chat")).not.toThrow();
    expect(first.query("SELECT count(*) AS count FROM state_schema_versions").get()).toEqual({ count: 1 });
  } finally {
    first.close();
    second.close();
  }
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

it.each(["channel-outbound-publish", "slack-automatic-output"])(
  "channels startup refuses missing %s readiness even when router schema is ready",
  (component) => {
    const state = fixture();
    const prepared = run(
      state,
      `const { initializeRuntimeState } = await import('./src/db/runtime-state.ts'); await initializeRuntimeState();`,
    );
    expect(prepared.status, prepared.stderr).toBe(0);
    const database = new Database(join(state, "ravi.db"));
    database.query("DELETE FROM state_schema_versions WHERE component = ?").run(component);
    const before = database.query("PRAGMA schema_version").get();
    expect(() => assertRuntimeStateReady({ RAVI_STATE_DIR: state })).toThrow(`STATE_SCHEMA_NOT_READY: ${component}`);
    const consumer = run(
      state,
      `
      process.argv[2] = 'channels'; process.argv[3] = 'run';
      const { ChannelRunner } = await import('./src/channels/runner.ts');
      try { await new ChannelRunner({ natsUrl: 'nats://127.0.0.1:1' }).start(); throw new Error('UNSAFE_START'); }
      catch (error) { if (error.code !== 'STATE_SCHEMA_NOT_READY' || !error.message.includes(${JSON.stringify(component)})) throw error; }
    `,
    );
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(database.query("PRAGMA schema_version").get()).toEqual(before);
    expect(database.query("SELECT * FROM state_schema_versions WHERE component = ?").get(component)).toBeNull();
    database.close();
  },
);

it("daemon prepares all stores; channels validates and uses those stores with zero schema changes", () => {
  const state = fixture();
  const prepared = run(
    state,
    `const { initializeRuntimeState } = await import('./src/db/runtime-state.ts'); await initializeRuntimeState();`,
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const snapshot = () =>
    Object.fromEntries(
      readdirSync(state, { recursive: true })
        .map((name) => name.toString())
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
    getDb().query('SELECT runtime_provider_config_revision FROM sessions LIMIT 0').all();
    getDb().query('SELECT trace_turn_id FROM channel_backend_runtime_state LIMIT 0').all();
    getDb().query('SELECT request_id FROM slack_thread_turn_health LIMIT 0').all();
    getDb().query('SELECT response_id FROM slack_automatic_terminal_manifests LIMIT 0').all();
    const { reserveSlackAutomaticOutput } = await import('./src/channels/slack/automatic-output-circuit.ts');
    const reservation = reserveSlackAutomaticOutput({
      idempotencyKey: 'schema-owner-output', requestFingerprint: 'schema-owner-fingerprint',
      scope: 'fixture:C_SCHEMA', sourceId: 'source', sourceReceivedAt: 1, now: 1,
    });
    if (reservation.status !== 'allowed') throw new Error('NORMAL_RESERVATION_FAILED');
    const { sqliteChannelOutboundPublishOutboxStore, getChannelOutboundPublishJob, prunePublishedChannelOutboundPublishJobs } = await import('./src/channels/outbound-publish-outbox.ts');
    if (sqliteChannelOutboundPublishOutboxStore.summary(1).pendingCount !== 0) throw new Error('NORMAL_OUTBOX_QUERY_FAILED');
    if (getChannelOutboundPublishJob('absent') !== null) throw new Error('NORMAL_OUTBOX_READ_FAILED');
    if (prunePublishedChannelOutboundPublishJobs(1, 1) !== 0) throw new Error('NORMAL_OUTBOX_PRUNE_FAILED');
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
