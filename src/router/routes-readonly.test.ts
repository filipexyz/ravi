import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

function runRoutesCli(stateDir: string, args: string[]) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_")));
  return spawnSync("bun", ["src/cli/index.ts", "routes", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...cleanEnv,
      RAVI_STATE_DIR: stateDir,
      RAVI_NO_AUDIT: "1",
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    },
  });
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

  it("keeps routes list from creating state through the real CLI process", () => {
    const stateDir = createStateDir();
    const result = runRoutesCli(stateDir, ["list", "--json"]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 0, items: [], routes: [] });
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

    const list = runRoutesCli(stateDir, ["list", "main", "--json", "--fields", "pattern,agent,channel"]);
    const humanList = runRoutesCli(stateDir, ["list", "main"]);
    const show = runRoutesCli(stateDir, ["show", "main", "123@g.us", "--json"]);
    const explain = runRoutesCli(stateDir, ["explain", "main", "group:123", "--channel", "WHATSAPP", "--json"]);

    expect(list).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(list.stdout).items).toEqual([{ pattern: "123@g.us", agent: "sales", channel: "whatsapp" }]);
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
