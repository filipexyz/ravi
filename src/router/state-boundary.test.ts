import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDatabaseTargetAllowed, openStateDatabase, type DatabaseBoundaryOptions } from "../db/state-boundary.js";

const dirs: string[] = [];
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "ravi-state-boundary-"));
  dirs.push(homeDir);
  const release = join(homeDir, "release");
  mkdirSync(join(release, "dist", "bundle"), { recursive: true });
  writeFileSync(join(release, "package.json"), JSON.stringify({ name: "ravi.bot" }));
  const modulePath = join(release, "dist", "bundle", "state-boundary.ts");
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
  return {
    ...options,
    registeredProcesses: () => [
      { pid: 1234, name: "ravi", pm2_env: { pm_exec_path: options.argv[1], args: ["daemon", "run"] } },
    ],
  };
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

it("accepts only an installed daemon whose actual PID and executable match PM2; tests and source cannot opt in", () => {
  const options = fixture();
  const path = join(options.homeDir, ".ravi", "ravi.db");
  const registered = daemon(options);
  expect(() => assertDatabaseTargetAllowed(path, registered)).not.toThrow();
  for (const overridden of [
    { pid: 999 },
    { argv: ["bun", options.argv[1], "agents", "list"] },
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

it("launches the installed daemon without a new env; PM2 identity loss, CLI, test, build and worktree launches refuse actionably", () => {
  const options = fixture();
  const realState = join(options.homeDir, ".ravi");
  mkdirSync(realState);
  copyFileSync(resolve(import.meta.dir, "../db/state-boundary.ts"), options.modulePath);
  const entry = options.argv[1];
  const target = join(realState, "ravi.db");
  writeFileSync(
    entry,
    `import { openStateDatabase } from './state-boundary.ts';
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
      `#!/usr/bin/env bun\nconsole.log(JSON.stringify([{pid:process.ppid${valid ? "" : "+1"},name:'ravi',pm2_env:{pm_exec_path:${JSON.stringify(entry)},args:['daemon','run']}}]));\n`,
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
  expect(launch(["agents", "list"], { RAVI_STATE_DIR: realState, pm_id: "1", name: "ravi" }).status).not.toBe(0);
  expect(launch(["daemon", "run"], { NODE_ENV: "test" }).status).not.toBe(0);
  const release = join(options.homeDir, "release");
  mkdirSync(join(release, "src"));
  expect(launch().status).not.toBe(0);
  rmSync(join(release, "src"), { recursive: true });
  writeFileSync(join(release, ".git"), "gitdir: /fixture/worktree");
  expect(launch().status).not.toBe(0);
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

it("admits a registered installed channels runner only as an existing-state consumer", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  const channels = {
    ...options,
    argv: ["bun", options.argv[1], "channels", "run"],
    registeredProcesses: () => [
      { pid: 1234, name: "ravi-channels", pm2_env: { pm_exec_path: options.argv[1], args: ["channels", "run"] } },
    ],
  };
  expect(() => openStateDatabase(path, undefined, channels)).toThrow("start the installed daemon first");
  expect(existsSync(path)).toBe(false);
  const seed = new Database(path);
  seed.exec("CREATE TABLE sentinel (id TEXT)");
  seed.close();
  const db = openStateDatabase(path, undefined, channels);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='sentinel'").get()).toBeTruthy();
  db.close();
});
