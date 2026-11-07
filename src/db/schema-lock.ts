import { dlopen, FFIType, read } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const held = new Map<string, { fd: number; references: number }>();

function loadLockLibrary() {
  const darwin = process.platform === "darwin";
  if (!darwin && process.platform !== "linux") throw new Error("SCHEMA_LOCK_UNSUPPORTED_PLATFORM");
  return dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [darwin ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
  });
}

let library: ReturnType<typeof loadLockLibrary> | undefined;

export class SchemaLockBusyError extends Error {
  readonly code = "STATE_SCHEMA_BUSY";
  constructor() {
    super(
      "STATE_SCHEMA_BUSY: another process owns schema access; wait for it to exit and retry. Never delete the lock file.",
    );
  }
}

/** Stable sidecar inode: never unlink it, including after failure or a crash. */
export function acquireSchemaFileLock(path: string, timeoutMs = 5_000): { release(): void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid schema lock timeout");
  library ??= loadLockLibrary();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(path)), basename(path));
  const existing = held.get(canonical);
  if (existing) {
    existing.references += 1;
    return releaseHandle(canonical, existing);
  }
  const fd = openSync(canonical, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe schema lock inode");
    // FD_CLOEXEC: spawned runtimes must not inherit and prolong this lease.
    if (library.symbols.fcntl(fd, 2, 1) !== 0) throw new Error("Could not set schema lock close-on-exec");
    const deadline = performance.now() + timeoutMs;
    while (library.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errnoPointer = library.symbols[process.platform === "darwin" ? "__error" : "__errno_location"]();
      if (!errnoPointer) throw new Error("Could not read schema lock errno");
      const errno = read.i32(errnoPointer);
      if (errno !== osConstants.errno.EAGAIN && errno !== osConstants.errno.EINTR) {
        throw new Error(`Schema lock failed (errno ${errno})`);
      }
      if (performance.now() >= deadline) throw new SchemaLockBusyError();
      Atomics.wait(sleeper, 0, 0, Math.min(20, deadline - performance.now()));
    }
    const entry = { fd, references: 1 };
    held.set(canonical, entry);
    return releaseHandle(canonical, entry);
  } catch (cause) {
    closeSync(fd);
    throw cause;
  }
}

function releaseHandle(key: string, entry: { fd: number; references: number }): { release(): void } {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references === 0) {
        held.delete(key);
        closeSync(entry.fd);
      }
    },
  };
}

/**
 * Serialize the whole inspect/migrate/ready sequence, without a SQL transaction.
 * Callers retain their BEGIN/COMMIT and connection-local foreign_keys semantics.
 * File aliases converge; hardlinked DBs are refused because their sidecars cannot.
 */
export function withSchemaMigrationLock<T>(db: Database, migrate: () => T): T {
  const filename = db.filename;
  if (!filename || filename === ":memory:") return migrate();
  const path = realpathSync(resolve(filename));
  if (statSync(path).nlink !== 1) throw new Error("Schema migration refuses a hardlinked database");
  const lock = acquireSchemaFileLock(`${path}.schema.lock`);
  try {
    return migrate();
  } finally {
    lock.release();
  }
}
