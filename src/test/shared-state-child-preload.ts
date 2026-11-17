/** A child of an isolated fixture shares its state, but never storage outside it. */
import { mock } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

const requestedState = process.env.RAVI_STATE_DIR;
if (!requestedState) throw new Error("Shared isolated fixture state required");
const state = canonicalPath(requestedState);
if (!basename(state).startsWith("ravi-") || !within(canonicalPath(tmpdir()), state)) {
  throw new Error("Shared state must be a Ravi fixture in the temporary directory");
}

let blockedOpen = false;
function assertFixtureStorage(path: unknown): void {
  if (path === ":memory:") return;
  if (typeof path === "string" && within(state, canonicalPath(path))) return;
  blockedOpen = true;
  throw new Error("TEST_SHARED_STATE_STORAGE_BLOCKED");
}

const sqlite = { ...(await import("bun:sqlite")) };
const guarded = new Proxy(sqlite.Database, {
  construct(target, args) {
    assertFixtureStorage(args[0]);
    return Reflect.construct(target, args);
  },
  get(target, key, receiver) {
    if (key === "open") {
      return (...args: Parameters<typeof sqlite.Database.open>) => {
        assertFixtureStorage(args[0]);
        return Reflect.apply(target.open, target, args);
      };
    }
    return Reflect.get(target, key, receiver);
  },
});
mock.module("bun:sqlite", () => ({ ...sqlite, Database: guarded, default: guarded }));
process.once("exit", () => {
  // A recovery catch cannot convert a blocked production open into test success
  // or the expected intentional crash code of a crash-window regression.
  if (blockedOpen) process.exitCode = 24;
});
