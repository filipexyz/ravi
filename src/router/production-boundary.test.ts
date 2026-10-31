import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDatabaseTargetAllowed, openStateDatabase } from "../db/production-boundary.js";

const dirs: string[] = [];
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "ravi-production-boundary-"));
  dirs.push(homeDir);
  return { homeDir, argv: ["bun", "index.js"], env: {} };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("refuses default production before SQLite creates a file, including explicit state dir", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  for (const env of [{}, { RAVI_STATE_DIR: root }, { RAVI_CONFIRM_PRODUCTION_STATE_DIR: "1" }]) {
    expect(() => openStateDatabase(join(root, "ravi.db"), undefined, { ...options, env })).toThrow(
      "Refusing production database",
    );
  }
  expect(existsSync(join(root, "ravi.db"))).toBe(false);
});

it("protects symlinked directories, individual database symlinks, and hardlinks", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const dbPath = join(root, "ravi.db");
  writeFileSync(dbPath, "sentinel");
  symlinkSync(root, join(options.homeDir, "alias"));
  symlinkSync(dbPath, join(options.homeDir, "alias.db"));
  symlinkSync(join(root, "missing.db"), join(options.homeDir, "dangling.db"));
  for (const path of [
    join(options.homeDir, "alias", "new.db"),
    join(options.homeDir, "alias.db"),
    join(options.homeDir, "dangling.db"),
  ]) {
    expect(() => assertDatabaseTargetAllowed(path, options)).toThrow("Refusing production database");
  }
  linkSync(dbPath, join(options.homeDir, "innocent.db"));
  expect(() => assertDatabaseTargetAllowed(join(options.homeDir, "innocent.db"), options)).toThrow("hardlinked");
});

it("requires exact production root confirmation and never accepts it in tests", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  const path = join(root, "ravi.db");
  const env = { RAVI_CONFIRM_PRODUCTION_STATE_DIR: root };
  expect(() => assertDatabaseTargetAllowed(path, { ...options, env })).not.toThrow();
  expect(() => assertDatabaseTargetAllowed(path, { ...options, env: { ...env, NODE_ENV: "test" } })).toThrow(
    "Tests cannot confirm",
  );
  expect(() => assertDatabaseTargetAllowed(path, { ...options, env, argv: ["bun", "fixture.test.ts"] })).toThrow(
    "Tests cannot confirm",
  );
  expect(() =>
    assertDatabaseTargetAllowed(path, { ...options, env: { RAVI_CONFIRM_PRODUCTION_STATE_DIR: options.homeDir } }),
  ).toThrow();
});

it("protects an additional production root without unprotecting the default or legacy database", () => {
  const options = fixture();
  const extra = join(options.homeDir, "production");
  const env = { RAVI_PRODUCTION_STATE_DIR: extra };
  for (const path of [
    join(extra, "ravi.db"),
    join(options.homeDir, ".ravi", "ravi.db"),
    join(options.homeDir, "ravi", "ravi.db"),
  ]) {
    expect(() => assertDatabaseTargetAllowed(path, { ...options, env })).toThrow();
  }
  expect(() => assertDatabaseTargetAllowed(join(options.homeDir, ".ravi-dev", "ravi.db"), options)).not.toThrow();
});

it("blocks destructive initialization and preserves existing schema/data until explicitly confirmed", () => {
  const options = fixture();
  const root = join(options.homeDir, ".ravi");
  mkdirSync(root);
  const path = join(root, "ravi.db");
  const seed = new Database(path);
  seed.exec("CREATE TABLE task_decisions (id TEXT); INSERT INTO task_decisions VALUES ('kept')");
  seed.close();
  const migrate = (env: NodeJS.ProcessEnv) => {
    const db = openStateDatabase(path, undefined, { ...options, env });
    try {
      db.exec("DROP TABLE task_decisions");
    } finally {
      db.close();
    }
  };
  expect(() => migrate({})).toThrow("Refusing production database");
  const check = new Database(path, { readonly: true });
  expect(check.query("SELECT * FROM task_decisions").all()).toEqual([{ id: "kept" }]);
  check.close();
  migrate({ RAVI_CONFIRM_PRODUCTION_STATE_DIR: root });
  const migrated = new Database(path, { readonly: true });
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name='task_decisions'").all()).toEqual([]);
  migrated.close();
});

it("restores the harness state and blocks the real cleanup -> getSessionByName escape before opening SQLite", () => {
  const options = fixture();
  const harness = join(options.homeDir, "harness");
  mkdirSync(harness);
  // A separate process keeps the os mock out of other suites. No HOME override
  // or production data: even the pre-fix failing case lands in this fixture.
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
    // Model the original cleanup bug, or any future accidental deletion.
    delete process.env.RAVI_STATE_DIR;
    try { getSessionByName('recovery-loop'); throw new Error('UNSAFE_OPEN'); }
    catch (error) { if (error.code !== 'PRODUCTION_DATABASE_REFUSED') throw error; }
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
