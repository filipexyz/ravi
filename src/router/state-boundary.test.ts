import { afterEach, expect, it } from "bun:test";
import { which } from "bun";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertDatabaseTargetAllowed,
  isInstalledOperatorCli,
  isOperatorCliOnRealState,
  isSchemaConsumer,
  isSchemaConsumerOf,
  openStateDatabase,
  PM2_JLIST_ATTEMPT_TIMEOUTS_MS,
  readPm2Registry,
  type DatabaseBoundaryOptions,
  type Pm2JlistResult,
  type Pm2JlistRunner,
} from "../db/state-boundary.js";
import { buildChannelsPm2Env, buildDaemonPm2StartArgs } from "../daemon-stdin.js";
import { buildManagedRuntimeRebindPlan } from "../managed-runtime-rebind.js";
import { OUTDATED_PM2_BANNER } from "../test/pm2-jlist.js";

const dirs: string[] = [];
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "ravi-state-boundary-"));
  dirs.push(homeDir);
  const release = join(homeDir, "release");
  mkdirSync(join(release, "dist", "bundle"), { recursive: true });
  mkdirSync(join(release, "dist", "db"), { recursive: true });
  writeFileSync(join(release, "package.json"), JSON.stringify({ name: "ravi.bot" }));
  const modulePath = join(release, "dist", "db", "state-boundary.ts");
  const bundle = join(release, "dist", "bundle", "index.js");
  return {
    homeDir,
    modulePath,
    argv: ["bun", bundle, "daemon", "run"],
    env: {},
    pid: 1234,
    registeredProcesses: () => [],
  } satisfies DatabaseBoundaryOptions;
}
function daemon(options: ReturnType<typeof fixture>): DatabaseBoundaryOptions {
  const args = buildDaemonPm2StartArgs({ bundlePath: options.argv[1] });
  return {
    ...options,
    registeredProcesses: () => [
      {
        pid: 1234,
        name: args[args.indexOf("--name") + 1],
        pm2_env: {
          pm_exec_path: resolve(args[args.indexOf("--cwd") + 1], args[1]),
          args: args.slice(args.indexOf("--") + 1),
        },
      },
    ],
  };
}
function channelsFromLauncher(options: ReturnType<typeof fixture>) {
  const target = { bundlePath: options.argv[1], cwd: join(options.homeDir, "release"), version: "test" };
  const start = buildManagedRuntimeRebindPlan(
    [{ name: "ravi-channels", status: "online", pid: 1234, createdAt: null }],
    target,
  ).find((step) => step.action === "start");
  if (!start) throw new Error("Channel launcher did not produce a start command");
  const args = start.args.slice(start.args.indexOf("--") + 1);
  const entry = {
    pid: 1234,
    name: "ravi-channels",
    pm2_env: { pm_exec_path: which(start.args[1], { PATH: buildChannelsPm2Env().PATH }) ?? "missing-bun", args },
  };
  return {
    ...options,
    argv: [process.execPath, ...args],
    registeredProcesses: () => [entry],
  } satisfies DatabaseBoundaryOptions;
}
/** Copies the boundary and its imports into the fixture release, as the installed package lays them out. */
function installRelease(options: ReturnType<typeof fixture>) {
  copyFileSync(resolve(import.meta.dir, "../db/state-boundary.ts"), options.modulePath);
  copyFileSync(resolve(import.meta.dir, "../pm2-output.ts"), join(options.homeDir, "release", "dist", "pm2-output.ts"));
  const fixtureDist = join(options.homeDir, "release", "dist");
  mkdirSync(join(fixtureDist, "threads"));
  copyFileSync(resolve(import.meta.dir, "../threads/schema-fence.ts"), join(fixtureDist, "threads", "schema-fence.ts"));
  copyFileSync(resolve(import.meta.dir, "../db/schema-lock.ts"), join(fixtureDist, "db", "schema-lock.ts"));
  mkdirSync(join(options.homeDir, "release", "dist", "utils"));
  copyFileSync(
    resolve(import.meta.dir, "../utils/account-home.ts"),
    join(options.homeDir, "release", "dist", "utils", "account-home.ts"),
  );
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("refuses implicit real state before opening SQLite, including explicit real state and inherited PM2 env", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  for (const env of [{}, { RAVI_STATE_DIR: root }, { name: "ravi", pm_id: "1" }]) {
    expect(() => openStateDatabase(join(root, "ravi.db"), undefined, { ...options, env })).toThrow(
      "Refusing the real Ravi state",
    );
  }
  expect(existsSync(join(root, "ravi.db"))).toBe(false);
});

it("protects symlinked roots, dangling file symlinks and hardlinks", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  writeFileSync(path, "sentinel");
  symlinkSync(root, join(options.homeDir, "alias"));
  symlinkSync(path, join(options.homeDir, "alias.db"));
  symlinkSync(join(root, "missing.db"), join(options.homeDir, "dangling.db"));
  for (const path of [
    join(options.homeDir, "alias", "new.db"),
    join(options.homeDir, "alias.db"),
    join(options.homeDir, "dangling.db"),
  ]) {
    expect(() => assertDatabaseTargetAllowed(path, options)).toThrow("Refusing the real Ravi state");
  }
  linkSync(path, join(options.homeDir, "innocent.db"));
  expect(() => assertDatabaseTargetAllowed(join(options.homeDir, "innocent.db"), options)).toThrow("hardlinked");
});

it("accepts as a daemon only one whose actual PID and executable match PM2; tests and source cannot opt in", () => {
  const options = fixture();
  const path = join(options.homeDir, ".ravi", "ravi.db");
  const registered = daemon(options);
  expect(() => assertDatabaseTargetAllowed(path, registered)).not.toThrow();
  for (const overridden of [
    { pid: 999 },
    { env: { NODE_ENV: "test" } },
    { registeredProcesses: () => [{ pid: 1234, name: "other" }] },
    { modulePath: resolve(import.meta.dir, "../db/state-boundary.ts") },
  ])
    expect(() => assertDatabaseTargetAllowed(path, { ...registered, ...overridden })).toThrow(
      "Refusing the real Ravi state",
    );
  expect(() => assertDatabaseTargetAllowed(join(options.homeDir, ".ravi-dev", "ravi.db"), options)).not.toThrow();
  expect(() => assertDatabaseTargetAllowed(join(options.homeDir, "ravi", "ravi.db"), options)).toThrow();
});

it.each([false, true])(
  "launches the installed daemon with PM2 banner=%s and the installed CLI on prepared state; identity loss, runtime context, test, build and worktree launches refuse",
  (banner) => {
    const options = fixture();
    const realState = join(options.homeDir, ".ravi");
    mkdirSync(realState);
    installRelease(options);
    const entry = options.argv[1];
    const target = join(realState, "ravi.db");
    writeFileSync(
      entry,
      `import { openStateDatabase } from '../db/state-boundary.ts';
    const db = openStateDatabase(${JSON.stringify(target)}, undefined, { homeDir: ${JSON.stringify(options.homeDir)} });
    db.exec('CREATE TABLE IF NOT EXISTS launched (id TEXT)'); db.close();`,
    );
    const bin = join(options.homeDir, "bin");
    mkdirSync(bin);
    const pm2Home = join(options.homeDir, "pm2");
    mkdirSync(pm2Home);
    writeFileSync(join(pm2Home, "pm2.pid"), String(process.pid));
    const pm2 = join(bin, "pm2");
    const register = (valid: boolean) => {
      writeFileSync(
        pm2,
        `#!/usr/bin/env bun\n${banner ? `console.log(${JSON.stringify(OUTDATED_PM2_BANNER)});` : ""}\nconsole.log(JSON.stringify([{pid:process.ppid${valid ? "" : "+1"},name:'ravi',pm2_env:{pm_exec_path:${JSON.stringify(entry)},args:['daemon','run']}}]));\n`,
      );
      chmodSync(pm2, 0o755);
    };
    const launch = (args = ["daemon", "run"], extra: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [entry, ...args], {
        env: { PATH: `${bin}:${process.env.PATH}`, PM2_HOME: pm2Home, ...extra },
        encoding: "utf8",
        timeout: 5000,
      });
    register(false);
    const refused = launch();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('RAVI_STATE_DIR="$(mktemp -d)" bun <command>');
    expect(refused.stderr).toContain("installed daemon gateway");
    expect(existsSync(target)).toBe(false);
    register(true);
    expect(launch().status).toBe(0);
    const check = new Database(target, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE name='launched'").get()).toEqual({ name: "launched" });
    check.close();
    // The installed CLI in a terminal opens the state the daemon prepared;
    // inherited PM2 labels neither help nor hurt it.
    expect(launch(["agents", "list"]).status).toBe(0);
    expect(launch(["agents", "list"], { RAVI_STATE_DIR: realState, pm_id: "1", name: "ravi" }).status).toBe(0);
    // A process that carries a runtime context goes through the gateway instead.
    for (const key of [
      "RAVI_CONTEXT_KEY",
      "RAVI_GATEWAY_URL",
      "RAVI_SESSION_KEY",
      "RAVI_SESSION_NAME",
      "RAVI_AGENT_ID",
    ])
      expect(launch(["agents", "list"], { [key]: "fixture" }).status).not.toBe(0);
    expect(launch(["agents", "list"], { NODE_ENV: "test" }).status).not.toBe(0);
    expect(launch(["daemon", "run"], { NODE_ENV: "test" }).status).not.toBe(0);
    for (const content of ["not-a-pid", String(process.pid + 1), ""]) {
      writeFileSync(join(pm2Home, "pm2.pid"), content);
      expect(launch().status).not.toBe(0);
    }
    rmSync(join(pm2Home, "pm2.pid"));
    // A foreground child with inherited PM2 labels is still not PM2-managed.
    expect(
      launch(["daemon", "run"], { pm_id: "0", name: "ravi", PM2_DAEMON_TITLE: `PM2 v7.1.2: God Daemon (${pm2Home})` })
        .status,
    ).not.toBe(0);
    writeFileSync(join(pm2Home, "pm2.pid"), String(process.pid));
    const release = join(options.homeDir, "release");
    mkdirSync(join(release, "src"));
    expect(launch().status).not.toBe(0);
    expect(launch(["agents", "list"]).status).not.toBe(0);
    rmSync(join(release, "src"), { recursive: true });
    writeFileSync(join(release, ".git"), "gitdir: /fixture/worktree");
    expect(launch().status).not.toBe(0);
    expect(launch(["agents", "list"]).status).not.toBe(0);
  },
);

it("a daemon whose `pm2 jlist` answers after the old 2 s limit still opens the real state", () => {
  // Siqueira (1 vCPU): `pm2 jlist` took 2.0–3.6 s under load and the guard
  // refused the PM2-registered daemon and channels runner as unregistered.
  const options = fixture();
  const realState = join(options.homeDir, ".ravi");
  mkdirSync(realState);
  installRelease(options);
  const entry = options.argv[1];
  const target = join(realState, "ravi.db");
  writeFileSync(
    entry,
    `import { openStateDatabase } from '../db/state-boundary.ts';
    const db = openStateDatabase(${JSON.stringify(target)}, undefined, { homeDir: ${JSON.stringify(options.homeDir)} });
    db.exec('CREATE TABLE IF NOT EXISTS launched (id TEXT)'); db.close();`,
  );
  const bin = join(options.homeDir, "bin");
  mkdirSync(bin);
  const pm2Home = join(options.homeDir, "pm2");
  mkdirSync(pm2Home);
  writeFileSync(join(pm2Home, "pm2.pid"), String(process.pid));
  writeFileSync(
    join(bin, "pm2"),
    `#!/usr/bin/env bun\nawait Bun.sleep(2600);\nconsole.log(JSON.stringify([{pid:process.ppid,name:'ravi',pm2_env:{pm_exec_path:${JSON.stringify(entry)},args:['daemon','run']}}]));\n`,
  );
  chmodSync(join(bin, "pm2"), 0o755);
  const launched = spawnSync(process.execPath, [entry, "daemon", "run"], {
    env: { PATH: `${bin}:${process.env.PATH}`, PM2_HOME: pm2Home },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(launched.stderr).not.toContain("Refusing the real Ravi state");
  expect(launched.status).toBe(0);
  expect(existsSync(target)).toBe(true);
}, 20_000);

it("retries a slow or failed `pm2 jlist` within a finite bound and refuses when PM2 never answers", () => {
  const registry = JSON.stringify([{ pid: 1234, name: "ravi", pm2_env: { pm_exec_path: "/x", args: [] } }]);
  const timedOut = (): Pm2JlistResult => ({
    stdout: "",
    status: null,
    error: Object.assign(new Error("spawnSync pm2 ETIMEDOUT"), { code: "ETIMEDOUT" }),
  });
  const limits: number[] = [];
  const slowThenAnswers: Pm2JlistRunner = (timeoutMs) => {
    limits.push(timeoutMs);
    return limits.length === 1 ? timedOut() : { stdout: registry, status: 0 };
  };
  expect(readPm2Registry(slowThenAnswers)).toEqual(JSON.parse(registry));
  expect(limits).toEqual([...PM2_JLIST_ATTEMPT_TIMEOUTS_MS]);
  expect(PM2_JLIST_ATTEMPT_TIMEOUTS_MS[0]).toBeGreaterThan(2_000);
  expect(PM2_JLIST_ATTEMPT_TIMEOUTS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);

  // Never answering, or answering garbage, can only refuse.
  let calls = 0;
  expect(
    readPm2Registry(() => {
      calls++;
      return timedOut();
    }),
  ).toEqual([]);
  expect(calls).toBe(PM2_JLIST_ATTEMPT_TIMEOUTS_MS.length);
  expect(readPm2Registry(() => ({ stdout: "not json", status: 0 }))).toEqual([]);
  // No pm2 binary: no point waiting for a retry.
  calls = 0;
  expect(
    readPm2Registry(() => {
      calls++;
      return { stdout: "", status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
    }),
  ).toEqual([]);
  expect(calls).toBe(1);

  // The registry it returns decides as before: a slow answer grants only to the registered daemon.
  const options = fixture();
  const path = join(options.homeDir, ".ravi", "ravi.db");
  const registered = daemon(options);
  const entries = registered.registeredProcesses?.() ?? [];
  let attempt = 0;
  const slowRegistry = () =>
    readPm2Registry(() => (attempt++ === 0 ? timedOut() : { stdout: JSON.stringify(entries), status: 0 }));
  expect(() => assertDatabaseTargetAllowed(path, { ...registered, registeredProcesses: slowRegistry })).not.toThrow();
  expect(() =>
    assertDatabaseTargetAllowed(path, { ...registered, registeredProcesses: () => readPm2Registry(timedOut) }),
  ).toThrow("Refusing the real Ravi state");
});

it("leaves schema/data intact when a non-daemon attempts destructive initialization", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  const seed = new Database(path);
  seed.exec("CREATE TABLE task_decisions (id TEXT); INSERT INTO task_decisions VALUES ('kept')");
  seed.close();
  const migrate = (boundary: DatabaseBoundaryOptions) => {
    const db = openStateDatabase(path, undefined, boundary);
    try {
      db.exec("DROP TABLE task_decisions");
    } finally {
      db.close();
    }
  };
  expect(() => migrate(options)).toThrow("Refusing the real Ravi state");
  const check = new Database(path, { readonly: true });
  expect(check.query("SELECT * FROM task_decisions").all()).toEqual([{ id: "kept" }]);
  check.close();
  migrate(daemon(options));
});

it("restores the harness state and blocks cleanup -> getSessionByName before any real-state open", () => {
  const options = fixture();
  const harness = join(options.homeDir, "harness");
  mkdirSync(harness);
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from 'bun:test';
    import * as os from 'node:os';
    const home = process.env.RAVI_BOUNDARY_TEST_HOME;
    mock.module('node:os', () => ({ ...os, homedir: () => home, default: { ...os, homedir: () => home } }));
    const { createIsolatedRaviState, cleanupIsolatedRaviState } = await import('./src/test/ravi-state.ts');
    const { getSessionByName } = await import('./src/router/sessions.ts');
    const prior = process.env.RAVI_STATE_DIR;
    const isolated = await createIsolatedRaviState();
    await cleanupIsolatedRaviState(isolated);
    if (process.env.RAVI_STATE_DIR !== prior) throw new Error('HARNESS_STATE_NOT_RESTORED');
    delete process.env.RAVI_STATE_DIR;
    try { getSessionByName('recovery-loop'); throw new Error('UNSAFE_OPEN'); }
    catch (error) { if (error.code !== 'REAL_STATE_ACCESS_REFUSED') throw error; }
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, RAVI_BOUNDARY_TEST_HOME: options.homeDir, RAVI_STATE_DIR: harness },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.stderr).not.toContain("UNSAFE_OPEN");
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(options.homeDir, ".ravi"))).toBe(false);
});

it.each(["changed", "removed"])("cached router statements revalidate state when its selection is %s", (selection) => {
  const options = fixture();
  const state = join(options.homeDir, "isolated-a");
  const other = join(options.homeDir, "isolated-b");
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from 'bun:test';
    import * as os from 'node:os';
    const home = ${JSON.stringify(options.homeDir)};
    mock.module('node:os', () => ({ ...os, homedir: () => home, default: { ...os, homedir: () => home } }));
    const { dbGetSetting, dbSetSetting, closeRouterDb } = await import('./src/router/router-db.ts');
    dbSetSetting('boundary-cache', 'first');
    if (dbGetSetting('boundary-cache') !== 'first') throw new Error('CACHE_NOT_PRIMED');
    if (${JSON.stringify(selection)} === 'changed') {
      process.env.RAVI_STATE_DIR = ${JSON.stringify(other)};
      if (dbGetSetting('boundary-cache') !== null) throw new Error('STALE_STATEMENT_READ');
      dbSetSetting('boundary-cache', 'second');
      process.env.RAVI_STATE_DIR = ${JSON.stringify(state)};
      if (dbGetSetting('boundary-cache') !== 'first') throw new Error('STALE_STATEMENT_WRITE');
      process.env.RAVI_STATE_DIR = ${JSON.stringify(other)};
      if (dbGetSetting('boundary-cache') !== 'second') throw new Error('SECOND_STATE_NOT_USED');
    } else {
      delete process.env.RAVI_STATE_DIR;
      for (const access of [() => dbGetSetting('boundary-cache'), () => dbSetSetting('boundary-cache', 'unsafe')]) {
        try { access(); throw new Error('UNSAFE_CACHED_ACCESS'); }
        catch (error) { if (error.code !== 'REAL_STATE_ACCESS_REFUSED') throw error; }
      }
    }
    closeRouterDb();
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, RAVI_STATE_DIR: state },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(options.homeDir, ".ravi"))).toBe(false);
});

it.each(["", "-wal", "-shm"])("legacy migration rejects a hardlinked %s source before moving any file", (suffix) => {
  const options = fixture();
  const legacy = join(options.homeDir, "ravi", "ravi.db");
  const target = join(options.homeDir, ".ravi", "ravi.db");
  mkdirSync(join(options.homeDir, "ravi"));
  const seed = new Database(legacy);
  seed.exec("CREATE TABLE migration_sentinel (id TEXT); INSERT INTO migration_sentinel VALUES ('kept')");
  seed.close();
  writeFileSync(`${legacy}-wal`, "wal-sentinel");
  writeFileSync(`${legacy}-shm`, "shm-sentinel");
  linkSync(`${legacy}${suffix}`, join(options.homeDir, "second-link"));
  const before = ["", "-wal", "-shm"].map((part) => readFileSync(`${legacy}${part}`));
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from 'bun:test';
    import * as os from 'node:os';
    const home = ${JSON.stringify(options.homeDir)};
    mock.module('node:os', () => ({ ...os, homedir: () => home, default: { ...os, homedir: () => home } }));
    const boundary = { ...await import('./src/db/state-boundary.ts') };
    const identity = {
      homeDir: home, modulePath: ${JSON.stringify(options.modulePath)}, argv: ${JSON.stringify(options.argv)},
      env: {}, pid: 1234,
      registeredProcesses: () => [{ pid: 1234, name: 'ravi', pm2_env: {
        pm_exec_path: ${JSON.stringify(options.argv[1])}, args: ['daemon', 'run'],
      } }],
    };
    // Inject only installed-runtime identity; every actual path goes through the real guard.
    mock.module('./src/db/state-boundary.ts', () => ({ ...boundary,
      assertDatabaseTargetAllowed: (path) => boundary.assertDatabaseTargetAllowed(path, identity),
      openStateDatabase: (path, options) => boundary.openStateDatabase(path, options, identity),
    }));
    delete process.env.RAVI_STATE_DIR;
    const { getDb, closeRouterDb } = await import('./src/router/router-db.ts');
    try { getDb(); throw new Error('UNSAFE_MIGRATION'); }
    catch (error) { if (error.code !== 'REAL_STATE_ACCESS_REFUSED' || !error.message.includes('hardlinked')) throw error; }
    finally { closeRouterDb(); }
  `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), env: process.env, encoding: "utf8", timeout: 15000 },
  );
  expect(result.status, result.stderr).toBe(0);
  for (const [index, part] of ["", "-wal", "-shm"].entries()) {
    expect(existsSync(`${legacy}${part}`)).toBe(true);
    expect(readFileSync(`${legacy}${part}`)).toEqual(before[index]);
    expect(existsSync(`${target}${part}`)).toBe(false);
  }
});

it("admits a registered installed channels runner only as an existing-state consumer", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  const channels = channelsFromLauncher(options);
  expect(() => openStateDatabase(path, undefined, channels)).toThrow("start the installed daemon first");
  expect(existsSync(path)).toBe(false);
  const seed = new Database(path);
  seed.exec("CREATE TABLE sentinel (id TEXT)");
  seed.close();
  const db = openStateDatabase(path, undefined, channels);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='sentinel'").get()).toBeTruthy();
  db.close();
});

function operatorCli(options: ReturnType<typeof fixture>, command = ["agents", "list"]) {
  return { ...options, argv: ["bun", options.argv[1], ...command] } satisfies DatabaseBoundaryOptions;
}

it("admits the installed CLI in the operator's terminal to real state, never to prepare it", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  const terminal = operatorCli(options);
  expect(isInstalledOperatorCli(terminal)).toBe(true);
  expect(isSchemaConsumer(terminal)).toBe(true);

  // No state yet: the CLI creates nothing and says what prepares it.
  expect(() => openStateDatabase(path, undefined, terminal)).toThrow("does not exist");
  expect(() => openStateDatabase(path, undefined, terminal)).toThrow("ravi daemon start");
  try {
    openStateDatabase(path, undefined, terminal);
  } catch (error) {
    expect((error as { code?: string }).code).toBe("STATE_SCHEMA_NOT_READY");
  }
  expect(existsSync(path)).toBe(false);

  // State the daemon prepared: read and written in place.
  const seed = new Database(path);
  seed.exec("CREATE TABLE sentinel (id TEXT)");
  seed.close();
  const db = openStateDatabase(path, undefined, terminal);
  db.exec("INSERT INTO sentinel VALUES ('written from the terminal')");
  expect(db.query("SELECT id FROM sentinel").all()).toEqual([{ id: "written from the terminal" }]);
  db.close();

  // An explicit real state directory is the same real state.
  expect(() => assertDatabaseTargetAllowed(path, { ...terminal, env: { RAVI_STATE_DIR: root } })).not.toThrow();
  expect(isSchemaConsumer({ ...terminal, env: { RAVI_STATE_DIR: root } })).toBe(true);
});

it("lets the installed CLI prepare an isolated state directory, and still not a real database it opens from there", () => {
  const options = fixture();
  mkdirSync(join(options.homeDir, ".ravi"));
  const isolated = join(options.homeDir, "isolated");
  mkdirSync(isolated);
  const terminal = { ...operatorCli(options), env: { RAVI_STATE_DIR: isolated } };

  expect(isSchemaConsumer(terminal)).toBe(false);
  const db = openStateDatabase(join(isolated, "ravi.db"), undefined, terminal);
  db.exec("CREATE TABLE created (id TEXT)");
  db.close();
  expect(existsSync(join(isolated, "ravi.db"))).toBe(true);

  const real = join(options.homeDir, ".ravi", "ravi.db");
  expect(isSchemaConsumerOf(real, terminal)).toBe(true);
  expect(() => openStateDatabase(real, undefined, terminal)).toThrow("does not exist");
  expect(existsSync(real)).toBe(false);
});

it("never lets a HOME override make the installed CLI the one that prepares the account's real state", () => {
  const options = fixture();
  // The account's own home, which HOME does not point at any more.
  const accountHome = join(options.homeDir, "account");
  const accountState = join(accountHome, ".ravi");
  mkdirSync(accountState, { recursive: true });
  const terminal = { ...operatorCli(options), accountHome, env: { RAVI_STATE_DIR: accountState } };

  // The boundary itself judges by HOME and lets the path through; the CLI still never prepares it.
  expect(isOperatorCliOnRealState(terminal)).toBe(true);
  expect(isSchemaConsumer(terminal)).toBe(true);
  expect(() => openStateDatabase(join(accountState, "ravi.db"), undefined, terminal)).toThrow("does not exist");
  expect(existsSync(join(accountState, "ravi.db"))).toBe(false);

  // A state directory under neither home is isolated, and the CLI's own to prepare.
  const isolated = { ...terminal, env: { RAVI_STATE_DIR: join(options.homeDir, "isolated") } };
  expect(isOperatorCliOnRealState(isolated)).toBe(false);
  expect(isSchemaConsumer(isolated)).toBe(false);
  // A state directory inside real state is real state.
  expect(
    isOperatorCliOnRealState({ ...terminal, env: { RAVI_STATE_DIR: join(options.homeDir, ".ravi", "nested") } }),
  ).toBe(true);
});

it("gives the operator role to nothing but the installed CLI entry with no runtime context", () => {
  const options = fixture();
  const path = join(options.homeDir, ".ravi", "ravi.db");
  const terminal = operatorCli(options);
  const refused = (boundary: DatabaseBoundaryOptions) => {
    expect(isInstalledOperatorCli(boundary)).toBe(false);
    expect(() => assertDatabaseTargetAllowed(path, boundary)).toThrow("Refusing the real Ravi state");
  };

  // A runtime context or an explicit gateway: the daemon authorizes those.
  for (const key of ["RAVI_CONTEXT_KEY", "RAVI_GATEWAY_URL", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"])
    refused({ ...terminal, env: { [key]: "fixture" } });
  // A test: by its environment, or because its entry is the test file and not the CLI.
  refused({ ...terminal, env: { NODE_ENV: "test" } });
  refused({ ...terminal, argv: ["bun", join(options.homeDir, "fixture.test.ts")] });
  // A runtime entry that PM2 does not supervise is not a terminal command.
  refused(operatorCli(options, ["daemon", "run"]));
  refused(operatorCli(options, ["channels", "run"]));
  // Source code: a checkout, a worktree, or a package this module does not belong to.
  refused({ ...terminal, modulePath: resolve(import.meta.dir, "../db/state-boundary.ts") });
  for (const marker of ["src", ".git"]) {
    const release = join(options.homeDir, "release");
    if (marker === "src") mkdirSync(join(release, "src"));
    else writeFileSync(join(release, ".git"), "gitdir: /fixture/worktree");
    refused(terminal);
    rmSync(join(release, marker), { recursive: true, force: true });
  }
  // Another script that merely loads the installed package.
  refused({ ...terminal, argv: ["bun", join(options.homeDir, "script.js"), "agents", "list"] });
  refused({ ...terminal, argv: ["bun"] });

  expect(() => assertDatabaseTargetAllowed(path, terminal)).not.toThrow();
  // The operator's own arguments may name anything, a test file included.
  for (const command of [
    ["agents", "list", "--tag", "flaky.test.ts"],
    ["sessions", "send", "dev", "rode src/x.test.ts"],
  ]) {
    const named = operatorCli(options, command);
    expect(isInstalledOperatorCli(named)).toBe(true);
    expect(() => assertDatabaseTargetAllowed(path, named)).not.toThrow();
  }
});

it("rejects mismatched identity and arguments for the canonical Bun channels launcher", () => {
  const options = fixture();
  const path = join(options.homeDir, ".ravi", "ravi.db");
  const channels = channelsFromLauncher(options);
  const entry = channels.registeredProcesses()[0];
  for (const invalid of [
    { ...entry, pid: 999 },
    { ...entry, name: "ravi" },
    { ...entry, pm2_env: { ...entry.pm2_env, pm_exec_path: join(options.homeDir, "other-bun") } },
    { ...entry, pm2_env: { ...entry.pm2_env, args: [join(options.homeDir, "other.js"), "channels", "run"] } },
    { ...entry, pm2_env: { ...entry.pm2_env, args: [options.argv[1], "daemon", "run"] } },
    { ...entry, pm2_env: { ...entry.pm2_env, args: [options.argv[1], "channels", "start"] } },
    { ...entry, pm2_env: { ...entry.pm2_env, args: [...entry.pm2_env.args, "--other"] } },
  ]) {
    expect(() => assertDatabaseTargetAllowed(path, { ...channels, registeredProcesses: () => [invalid] })).toThrow(
      "Refusing the real Ravi state",
    );
  }
  for (const argv of [
    [process.execPath, join(options.homeDir, "other.js"), "channels", "run"],
    [process.execPath, options.argv[1], "daemon", "run"],
    [...channels.argv, "--other"],
  ]) {
    expect(() => assertDatabaseTargetAllowed(path, { ...channels, argv })).toThrow("Refusing the real Ravi state");
  }
});

it("bridge and publication stores cannot reopen real state after source fixture cleanup", () => {
  const options = fixture();
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from 'bun:test';
    import * as os from 'node:os';
    const home = process.env.RAVI_BOUNDARY_TEST_HOME;
    mock.module('node:os', () => ({ ...os, homedir: () => home, default: { ...os, homedir: () => home } }));
    delete process.env.RAVI_STATE_DIR;
    const { getBridgeStore } = await import('./src/bridge/store.ts');
    const { openPublicationJournal } = await import('./src/pr/journal.ts');
    for (const open of [() => getBridgeStore(), () => openPublicationJournal({}, {})]) {
      try { open(); throw new Error('UNSAFE_OPEN'); }
      catch (error) { if (!['REAL_STATE_ACCESS_REFUSED', 'PUBLICATION_AUDIT_FAILED'].includes(error.code)) throw error; }
    }
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, RAVI_BOUNDARY_TEST_HOME: options.homeDir },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(options.homeDir, ".ravi"))).toBe(false);
});
