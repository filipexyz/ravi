/** Dedicated preload for session-dispatcher.test.ts; never import from runtime code. */
import { afterAll, expect, mock } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const sqlite = { ...(await import("bun:sqlite")) };

// Resolve aliases even when the database file itself does not exist yet.
function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

const productionState = canonicalPath(join(homedir(), ".ravi"));
const blockedOpens: string[] = [];

function assertIsolated(path: unknown): void {
  if (typeof path !== "string" || path === ":memory:") return;
  const target = canonicalPath(path);
  const within = relative(productionState, target);
  if (within === "" || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
    blockedOpens.push(target);
    throw new Error(`TEST_PRODUCTION_DB_BLOCKED: ${target}`);
  }
}

const guardedDatabase = new Proxy(sqlite.Database, {
  construct(target, args) {
    assertIsolated(args[0]);
    return Reflect.construct(target, args);
  },
  get(target, key, receiver) {
    if (key === "open") {
      return (...args: Parameters<typeof sqlite.Database.open>) => {
        assertIsolated(args[0]);
        return Reflect.apply(target.open, target, args);
      };
    }
    return Reflect.get(target, key, receiver);
  },
});

mock.module("bun:sqlite", () => ({ ...sqlite, Database: guardedDatabase, default: guardedDatabase }));

// Reproduce the incident's launcher sandbox before any Ravi module is loaded.
// Inner fixtures must restore this value when their cleanup completes.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RAVI_")) delete process.env[key];
}
const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-guard-test-"));
process.env.RAVI_STATE_DIR = stateDir;
process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
process.env.NATS_URL = "nats://127.0.0.1:1";

// Some recovery paths catch exceptions. A caught blocked open must still fail CI.
afterAll(() => expect(blockedOpens).toEqual([]));
process.once("exit", () => {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // Windows can retain SQLite mappings until process teardown. Only our own
    // generated fixture is eligible for cleanup; never touch the operator state.
  }
});
