import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRoutesSnapshot, RoutesSnapshotSchemaError } from "./routes-readonly.js";

const stateDirs: string[] = [];
setDefaultTimeout(60_000);

declare const Bun: { gc(force?: boolean): void };

function createStateDir(): string {
  const path = mkdtempSync(join(tmpdir(), "ravi-routes-readonly-"));
  stateDirs.push(path);
  return path;
}

function stateDigest(stateDir: string): Array<{ name: string; sha256: string }> {
  return readdirSync(stateDir)
    .sort()
    .map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(readFileSync(join(stateDir, name)))
        .digest("hex"),
    }));
}

function durableStateDigest(stateDir: string): Array<{ name: string; sha256: string }> {
  return stateDigest(stateDir).filter(({ name }) => !name.endsWith("-shm"));
}

function runRoutesCli(stateDir: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_") && key !== "NATS_URL"),
  );
  return spawnSync("bun", ["src/cli/index.ts", "routes", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...cleanEnv,
      RAVI_STATE_DIR: stateDir,
      ...extraEnv,
    },
  });
}

const NATS_TRAP_SOURCE = String.raw`
  const { appendFileSync, writeFileSync } = require("node:fs");
  const marker = process.env.RAVI_TEST_NATS_MARKER;
  const ready = process.env.RAVI_TEST_NATS_READY;
  if (!marker || !ready) throw new Error("missing trap paths");
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() { appendFileSync(marker, "connection\n", "utf8"); },
      data() { appendFileSync(marker, "data\n", "utf8"); },
    },
  });
  writeFileSync(ready, String(listener.port), "utf8");
  const stop = () => { listener.stop(true); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1000);
`;

function waitForFile(path: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
  if (!existsSync(path)) throw new Error(`Timed out waiting for helper file: ${path}`);
}

function startNatsConnectionTrap(stateDir: string): {
  child: ChildProcess;
  markerPath: string;
  natsUrl: string;
} {
  const markerPath = join(stateDir, "nats-contacted.log");
  const readyPath = join(stateDir, "nats-ready.txt");
  const child = spawn("bun", ["-e", NATS_TRAP_SOURCE], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      ...process.env,
      RAVI_TEST_NATS_MARKER: markerPath,
      RAVI_TEST_NATS_READY: readyPath,
    },
  });
  waitForFile(readyPath);
  const port = readFileSync(readyPath, "utf8").trim();
  return { child, markerPath, natsUrl: `nats://127.0.0.1:${port}` };
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

afterEach(async () => {
  for (const path of stateDirs.splice(0)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        Bun.gc(true);
        rmSync(path, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

describe("readRoutesSnapshot", () => {
  it("returns an empty snapshot without creating a missing database", () => {
    const stateDir = createStateDir();
    const snapshot = readRoutesSnapshot({ ...process.env, RAVI_STATE_DIR: stateDir });

    expect(snapshot).toMatchObject({ databaseExists: false, routes: [], instances: [], channels: [], tags: [] });
    expect(existsSync(join(stateDir, "ravi.db"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("reads current persisted route facts without changing any state file", () => {
    const stateDir = createStateDir();
    const dbPath = join(stateDir, "ravi.db");
    const database = new Database(dbPath);
    database.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, dm_scope TEXT);
      CREATE TABLE routes (
        id INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL,
        account_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        dm_scope TEXT,
        session_name TEXT,
        policy TEXT,
        priority INTEGER NOT NULL,
        channel TEXT,
        deleted_at INTEGER
      );
      CREATE TABLE instances (
        name TEXT PRIMARY KEY,
        instance_id TEXT,
        channel TEXT,
        agent TEXT,
        dm_policy TEXT,
        group_policy TEXT,
        contact_intake_mode TEXT,
        dm_scope TEXT,
        enabled INTEGER,
        defaults TEXT,
        default_contact_tags TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE channels (
        name TEXT PRIMARY KEY,
        provider TEXT,
        enabled INTEGER,
        credential_connection TEXT,
        defaults TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tag_definitions (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
      CREATE TABLE tag_bindings (
        id TEXT PRIMARY KEY,
        tag_id TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        metadata_json TEXT,
        source TEXT,
        created_by TEXT,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO agents VALUES ('main', '/srv/ravi/main', 'per-peer');
      INSERT INTO agents VALUES ('sales', '/srv/ravi/sales', 'per-peer');
      INSERT INTO instances VALUES ('main', 'instance-1', 'whatsapp', 'main', 'open', 'open', 'off', NULL, 1, NULL, NULL, 1, 2, NULL);
      INSERT INTO channels VALUES ('whatsapp', 'whatsapp', 1, NULL, NULL, 1, 2, NULL);
      INSERT INTO routes VALUES (7, '123@g.us', 'main', 'sales', NULL, 'vip', 'open', 10, 'whatsapp', NULL);
      INSERT INTO settings VALUES ('defaultAgent', 'main');
      INSERT INTO settings VALUES ('defaultDmScope', 'per-peer');
      INSERT INTO tag_definitions VALUES ('tag-1', 'important');
      INSERT INTO tag_bindings VALUES ('binding-1', 'tag-1', 'route', '7', '{"source":"fixture"}', 'ravi', NULL, NULL, 3, 4);
    `);
    database.close();
    const before = stateDigest(stateDir);

    const snapshot = readRoutesSnapshot({ ...process.env, RAVI_STATE_DIR: stateDir });

    expect(snapshot.routes).toEqual([
      {
        id: 7,
        pattern: "123@g.us",
        accountId: "main",
        agent: "sales",
        priority: 10,
        session: "vip",
        policy: "open",
        channel: "whatsapp",
      },
    ]);
    expect(snapshot.instances[0]).toMatchObject({ name: "main", instanceId: "instance-1", agent: "main" });
    expect(snapshot.channels[0]).toMatchObject({ name: "whatsapp", provider: "whatsapp" });
    expect(snapshot.tags[0]).toMatchObject({ tagSlug: "important", assetType: "route", assetId: "7" });
    expect(snapshot.routerConfig.routes[0]).toMatchObject({ pattern: "123@g.us", channel: "whatsapp" });
    expect(stateDigest(stateDir)).toEqual(before);
  });

  it("reads a minimal legacy schema without trying to migrate it", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    database.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
      CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT, account_id TEXT, agent_id TEXT);
      CREATE TABLE instances (name TEXT PRIMARY KEY);
      INSERT INTO agents VALUES ('main', '/legacy/main');
      INSERT INTO routes VALUES (1, '*', 'main', 'main');
      INSERT INTO instances VALUES ('main');
    `);
    database.close();
    const before = stateDigest(stateDir);

    const snapshot = readRoutesSnapshot({ ...process.env, RAVI_STATE_DIR: stateDir });

    expect(snapshot.routes[0]).toMatchObject({ id: 1, pattern: "*", accountId: "main", agent: "main", priority: 0 });
    expect(snapshot.instances[0]).toMatchObject({ name: "main", channel: "whatsapp", enabled: true });
    expect(stateDigest(stateDir)).toEqual(before);
  });

  it("rejects a malformed existing routes table without changing durable state", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    database.exec("CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT)");
    database.close();
    const before = durableStateDigest(stateDir);

    expect(() => readRoutesSnapshot({ ...process.env, RAVI_STATE_DIR: stateDir })).toThrow(
      expect.objectContaining({
        name: "RoutesSnapshotSchemaError",
        table: "routes",
        missingColumns: ["account_id", "agent_id"],
      }) as RoutesSnapshotSchemaError,
    );
    expect(durableStateDigest(stateDir)).toEqual(before);
  });

  it("reads committed WAL data safely while a writer connection remains active", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
        CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT, account_id TEXT, agent_id TEXT, priority INTEGER);
        CREATE TABLE instances (name TEXT PRIMARY KEY, channel TEXT);
        INSERT INTO agents VALUES ('main', '/wal/main');
        INSERT INTO instances VALUES ('main', 'whatsapp');
        INSERT INTO routes VALUES (9, '5511*', 'main', 'main', 5);
      `);
      const before = durableStateDigest(stateDir);

      const snapshot = readRoutesSnapshot({ ...process.env, RAVI_STATE_DIR: stateDir });

      expect(snapshot.routes).toContainEqual(
        expect.objectContaining({ id: 9, pattern: "5511*", accountId: "main", priority: 5 }),
      );
      expect(durableStateDigest(stateDir)).toEqual(before);
      expect(database.prepare("SELECT count(*) AS count FROM routes").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("keeps every route query on one WAL snapshot while a concurrent writer commits", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
        CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT, account_id TEXT, agent_id TEXT, priority INTEGER);
        CREATE TABLE instances (name TEXT PRIMARY KEY, channel TEXT, agent TEXT);
        INSERT INTO settings VALUES ('defaultAgent', 'before');
        INSERT INTO agents VALUES ('before', '/agents/before');
        INSERT INTO agents VALUES ('after', '/agents/after');
        INSERT INTO instances VALUES ('main', 'whatsapp', 'before');
        INSERT INTO routes VALUES (1, 'before-pattern', 'main', 'before', 1);
      `);

      let writerCommitted = false;
      let hookCalls = 0;
      const snapshot = readRoutesSnapshot(
        { ...process.env, RAVI_STATE_DIR: stateDir },
        {
          afterSettingsRead: () => {
            hookCalls += 1;
            database.transaction(() => {
              database.prepare("UPDATE settings SET value = 'after' WHERE key = 'defaultAgent'").run();
              database.prepare("UPDATE agents SET cwd = '/agents/after-committed' WHERE id = 'after'").run();
              database.prepare("UPDATE instances SET agent = 'after' WHERE name = 'main'").run();
              database.prepare("UPDATE routes SET pattern = 'after-pattern', agent_id = 'after' WHERE id = 1").run();
            })();
            writerCommitted = true;
          },
        },
      );

      expect(hookCalls).toBe(1);
      expect(writerCommitted).toBe(true);
      expect(database.prepare("SELECT value FROM settings WHERE key = 'defaultAgent'").get()).toEqual({
        value: "after",
      });
      expect(database.prepare("SELECT pattern, agent_id FROM routes WHERE id = 1").get()).toEqual({
        pattern: "after-pattern",
        agent_id: "after",
      });
      expect(snapshot.routes).toEqual([expect.objectContaining({ id: 1, pattern: "before-pattern", agent: "before" })]);
      expect(snapshot.instances).toEqual([expect.objectContaining({ name: "main", agent: "before" })]);
      expect(snapshot.routerConfig.defaultAgent).toBe("before");
      expect(snapshot.routerConfig.accountAgents).toEqual({ main: "before" });
      expect(snapshot.routerConfig.agents.after?.cwd).toBe("/agents/after");
    } finally {
      database.close();
    }
  });

  it("keeps routes list from creating state through the real CLI process", () => {
    const stateDir = createStateDir();
    const result = runRoutesCli(stateDir, ["list", "--json"]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 0, items: [], routes: [] });
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("rejects malformed route field lists through the real CLI with acceptedFields", () => {
    const stateDir = createStateDir();
    for (const fields of ["", "pattern,,agent", "pattern,"]) {
      const result = runRoutesCli(stateDir, ["list", "--json", "--fields", fields]);

      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        op: "routes list",
        error: {
          code: "USAGE_ERROR",
          acceptedFields: [
            "id",
            "accountId",
            "pattern",
            "agent",
            "priority",
            "policy",
            "session",
            "channel",
            "dmScope",
            "tags",
          ],
        },
      });
    }
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("returns a typed error for malformed persisted routes data without changing durable state", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    database.exec("CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT)");
    database.close();
    const before = durableStateDigest(stateDir);

    const result = runRoutesCli(stateDir, ["list", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "routes list",
      error: {
        code: "ROUTES_SCHEMA_UNSUPPORTED",
        retryable: false,
        table: "routes",
        missingColumns: ["account_id", "agent_id"],
      },
    });
    expect(durableStateDigest(stateDir)).toEqual(before);
  });

  it("keeps a missing route lookup on a legacy database read-only", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    database.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
      CREATE TABLE routes (id INTEGER PRIMARY KEY, pattern TEXT, account_id TEXT, agent_id TEXT);
      CREATE TABLE instances (name TEXT PRIMARY KEY);
      INSERT INTO agents VALUES ('main', '/legacy/main');
      INSERT INTO instances VALUES ('main');
      INSERT INTO routes VALUES (1, '5511*', 'main', 'main');
    `);
    database.close();
    const before = durableStateDigest(stateDir);

    const result = runRoutesCli(stateDir, ["show", "main", "missing-route", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "routes show",
      error: {
        code: "ROUTE_NOT_FOUND",
        suggestions: expect.any(Array),
      },
    });
    expect(durableStateDigest(stateDir)).toEqual(before);
  });

  it("runs list, show, and explain against one persisted fixture without changing durable state", () => {
    const stateDir = createStateDir();
    const database = new Database(join(stateDir, "ravi.db"));
    database.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, dm_scope TEXT);
      CREATE TABLE routes (
        id INTEGER PRIMARY KEY,
        pattern TEXT,
        account_id TEXT,
        agent_id TEXT,
        priority INTEGER,
        channel TEXT
      );
      CREATE TABLE instances (name TEXT PRIMARY KEY, channel TEXT, agent TEXT, enabled INTEGER);
      CREATE TABLE channels (name TEXT PRIMARY KEY, provider TEXT, enabled INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO agents VALUES ('main', '/fixture/main', 'per-peer');
      INSERT INTO agents VALUES ('sales', '/fixture/sales', 'per-peer');
      INSERT INTO instances VALUES ('main', 'whatsapp', 'main', 1);
      INSERT INTO channels VALUES ('whatsapp', 'whatsapp', 1);
      INSERT INTO routes VALUES (4, '123@g.us', 'main', 'sales', 10, 'whatsapp');
      INSERT INTO settings VALUES ('defaultAgent', 'main');
    `);
    database.close();
    const before = durableStateDigest(stateDir);

    const trap = startNatsConnectionTrap(createStateDir());
    const natsEnv = { NATS_URL: trap.natsUrl };
    let list;
    let optionalFieldList;
    let humanList;
    let show;
    let explain;
    try {
      list = runRoutesCli(stateDir, ["list", "main", "--json", "--fields", "pattern,agent,channel"], natsEnv);
      optionalFieldList = runRoutesCli(stateDir, ["list", "main", "--json", "--fields", "policy"], natsEnv);
      humanList = runRoutesCli(stateDir, ["list", "main"], natsEnv);
      show = runRoutesCli(stateDir, ["show", "main", "123@g.us", "--json"], natsEnv);
      explain = runRoutesCli(stateDir, ["explain", "main", "group:123", "--channel", "WHATSAPP", "--json"], natsEnv);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      expect(existsSync(trap.markerPath)).toBe(false);
    } finally {
      stopChild(trap.child);
    }

    expect(list).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(list.stdout).items).toEqual([{ pattern: "123@g.us", agent: "sales", channel: "whatsapp" }]);
    expect(optionalFieldList).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(optionalFieldList.stdout).items).toEqual([{ policy: null }]);
    expect(humanList).toMatchObject({ status: 0, stderr: "" });
    expect(humanList.stdout).toContain("123@g.us");
    expect(humanList.stdout).toContain("sales");
    expect(show).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(show.stdout).route).toMatchObject({ id: 4, pattern: "123@g.us", agent: "sales" });
    expect(explain).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(explain.stdout)).toMatchObject({
      channel: "whatsapp",
      origin: { kind: "config_simulation", daemonObserved: false },
      resolution: { matchedBy: "equivalent", canonicalPattern: "group:123" },
      liveEffect: { status: "verified", winningAgent: "sales" },
    });
    expect(durableStateDigest(stateDir)).toEqual(before);
  });
});
