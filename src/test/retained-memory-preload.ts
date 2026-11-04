/** Dedicated retained integration preload; never import this module from runtime code. */
import { afterAll, expect, mock } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Adapted from the immutable PR795 reviewer preload. Keep constructor/open
// redirection, synthetic identity anchors and the single retained snapshot hook.
const stateRoot = process.env.PR795_RETAINED_STATE;
const evidenceRoot = process.env.PR795_RUN_EVIDENCE;
if (!stateRoot || !evidenceRoot || !isAbsolute(stateRoot) || !isAbsolute(evidenceRoot)) {
  throw new Error("Missing absolute isolated retained roots");
}

/** Resolves existing ancestors, including symlinks, before deciding whether a path is synthetic. */
function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}

/** Tests containment without allowing a sibling whose name merely starts with the root. */
function within(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

const allowedState = canonicalPath(stateRoot);
const allowedEvidence = canonicalPath(evidenceRoot);
if (!within(allowedEvidence, allowedState)) throw new Error("Retained state must belong to its evidence directory");
const os = { ...(await import("node:os")) };
const productionRoots = [".ravi", ".codex", ".ssh", ".omni", ".aws", ".config", ".npmrc"].map((name) =>
  join(realpathSync(os.homedir()), name),
);
if (productionRoots.some((root) => within(root, allowedEvidence))) {
  throw new Error("Retained evidence cannot live inside production state or configuration");
}
mock.module("node:os", () => ({ ...os, homedir: () => join(stateRoot, "home") }));
mock.module("os", () => ({ ...os, homedir: () => join(stateRoot, "home") }));

const blocked: string[] = [];
const fileDenials: string[] = [];
const networkDenied: string[] = [];
const retainedRemovals: Array<{ operation: string; path: string }> = [];
const sqlite = { ...(await import("bun:sqlite")) };
const OriginalDatabase = sqlite.Database;
const opened: Array<{ requested: string; db: InstanceType<typeof OriginalDatabase> }> = [];

/** Rejects non-synthetic paths before constructing a memory-only SQLite connection. */
function openMemory(path: unknown): InstanceType<typeof OriginalDatabase> {
  if (typeof path !== "string") throw new Error("Synthetic DB must have an explicit path");
  if (path !== ":memory:") {
    if (!within(resolve(stateRoot!), resolve(path))) {
      blocked.push(resolve(path));
      throw new Error(`TEST_NON_SYNTHETIC_SQLITE_BLOCKED: ${path}`);
    }
    const target = canonicalPath(path);
    if (!within(allowedState, target)) {
      blocked.push(target);
      throw new Error(`TEST_NON_SYNTHETIC_SQLITE_BLOCKED: ${target}`);
    }
  }
  const db = new OriginalDatabase(":memory:");
  // Pending reply identity uses realpath(db.filename). This empty retained file
  // is an identity anchor only; SQLite never opens it as a database.
  const identityAnchor = path === ":memory:" ? join(stateRoot!, `memory-${opened.length}.anchor`) : path;
  if (!existsSync(identityAnchor)) writeFileSync(identityAnchor, "");
  Object.defineProperty(db, "filename", { value: identityAnchor, configurable: true });
  db.exec("PRAGMA temp_store = MEMORY");
  opened.push({ requested: path, db });
  return db;
}

const guardedDatabase = new Proxy(OriginalDatabase, {
  construct(_target, args) {
    return openMemory(args[0]);
  },
  get(target, key, receiver) {
    return key === "open" ? openMemory : Reflect.get(target, key, receiver);
  },
});
mock.module("bun:sqlite", () => ({ ...sqlite, Database: guardedDatabase, default: guardedDatabase }));

/** Extracts path arguments without interpreting arbitrary objects as filesystem authority. */
function filesystemPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

/** Keeps source files read-only and rejects production reads, including path aliases. */
function assertFileAccess(value: unknown, write: boolean, operation: string): void {
  const path = filesystemPath(value);
  if (path === undefined) return;
  if (productionRoots.some((root) => within(root, resolve(path)))) {
    fileDenials.push(`${operation}:${resolve(path)}`);
    throw new Error(`TEST_RETAINED_FILE_ACCESS_BLOCKED: ${operation}`);
  }
  const target = canonicalPath(path);
  if (productionRoots.some((root) => within(root, target)) || (write && !within(allowedEvidence, target))) {
    fileDenials.push(`${operation}:${target}`);
    throw new Error(`TEST_RETAINED_FILE_ACCESS_BLOCKED: ${operation}`);
  }
}

/** Intercepts removal only inside retained evidence; the requested path stays intact. */
function retainRemoval(operation: string, args: unknown[], promise: boolean): unknown {
  assertFileAccess(args[0], true, operation);
  const path = filesystemPath(args[0]);
  if (path === undefined) throw new Error("Retained removal requires a path");
  retainedRemovals.push({ operation, path: canonicalPath(path) });
  if (promise) return Promise.resolve();
  const callback = args.at(-1);
  if (typeof callback === "function") queueMicrotask(() => callback(null));
  return undefined;
}

/** Wraps Node filesystem entry points without introducing a cleanup or exit handler. */
function guardedFilesystem(original: Record<string, unknown>, promise: boolean): Record<string, unknown> {
  const guarded = { ...original };
  const reads = ["readFile", "readFileSync", "readdir", "readdirSync", "createReadStream"];
  const writes = [
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "mkdtemp",
    "mkdtempSync",
    "truncate",
    "truncateSync",
    "createWriteStream",
    "chmod",
    "chmodSync",
    "chown",
    "chownSync",
  ];
  for (const operation of [...reads, ...writes]) {
    const originalMethod = original[operation];
    if (typeof originalMethod !== "function") continue;
    guarded[operation] = (...args: unknown[]) => {
      assertFileAccess(args[0], writes.includes(operation), operation);
      return Reflect.apply(originalMethod, original, args);
    };
  }
  for (const operation of ["open", "openSync"]) {
    const originalMethod = original[operation];
    if (typeof originalMethod !== "function") continue;
    guarded[operation] = (...args: unknown[]) => {
      const flags = args[1] ?? "r";
      const write = typeof flags === "string" ? /[wa+]/.test(flags) : flags !== 0;
      assertFileAccess(args[0], write, operation);
      return Reflect.apply(originalMethod, original, args);
    };
  }
  for (const operation of ["copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync", "link", "linkSync"]) {
    const originalMethod = original[operation];
    if (typeof originalMethod !== "function") continue;
    guarded[operation] = (...args: unknown[]) => {
      assertFileAccess(args[0], operation.startsWith("rename"), operation);
      assertFileAccess(args[1], true, operation);
      return Reflect.apply(originalMethod, original, args);
    };
  }
  for (const operation of ["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync"]) {
    if (typeof original[operation] === "function") {
      guarded[operation] = (...args: unknown[]) => retainRemoval(operation, args, promise);
    }
  }
  return guarded;
}

const fsPromises = guardedFilesystem({ ...(await import("node:fs/promises")) }, true);
const fs = guardedFilesystem({ ...(await import("node:fs")) }, false);
fs.promises = fsPromises;
mock.module("node:fs/promises", () => ({ ...fsPromises, default: fsPromises }));
mock.module("fs/promises", () => ({ ...fsPromises, default: fsPromises }));
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("fs", () => ({ ...fs, default: fs }));

/** Records only the API name, never URL credentials or request contents. */
function denyNetwork(operation: string): never {
  networkDenied.push(operation);
  throw new Error(`TEST_NETWORK_OR_PROCESS_BLOCKED: ${operation}`);
}

/** Replaces exported network/process entry points while retaining non-I/O utility exports. */
async function guardModule(name: string, operations: string[]): Promise<Record<string, unknown>> {
  const original = { ...(await import(`node:${name}`)) } as Record<string, unknown>;
  const guarded = { ...original };
  for (const operation of operations) {
    if (typeof original[operation] === "function") guarded[operation] = () => denyNetwork(`${name}.${operation}`);
  }
  const replacement = { ...guarded, default: guarded };
  mock.module(`node:${name}`, () => replacement);
  mock.module(name, () => replacement);
  return original;
}

/** Patches constructors' connection methods as well as module-level convenience functions. */
function guardPrototype(module: Record<string, unknown>, constructor: string, method: string): void {
  const type = module[constructor] as { prototype?: Record<string, unknown> } | undefined;
  if (!type?.prototype || typeof type.prototype[method] !== "function") return;
  Object.defineProperty(type.prototype, method, {
    configurable: true,
    writable: true,
    value: () => denyNetwork(`${constructor}.${method}`),
  });
}

globalThis.fetch = Object.assign(async () => denyNetwork("fetch"), {
  preconnect: () => denyNetwork("fetch.preconnect"),
}) as typeof fetch;
const net = await guardModule("net", ["connect", "createConnection", "createServer"]);
guardPrototype(net, "Socket", "connect");
guardPrototype(net, "Server", "listen");
const tls = await guardModule("tls", ["connect", "createServer"]);
guardPrototype(tls, "TLSSocket", "connect");
for (const name of ["http", "https"]) {
  const module = await guardModule(name, ["request", "get", "createServer"]);
  guardPrototype(module, "Agent", "createConnection");
}
await guardModule("http2", ["connect", "createServer", "createSecureServer"]);
await guardModule("dgram", ["createSocket"]);
await guardModule("dns", ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "reverse"]);
await guardModule("dns/promises", ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "reverse"]);
await guardModule("child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
await guardModule("worker_threads", ["Worker"]);
const bunRuntime = globalThis.Bun;
const bunModule = { ...(await import("bun")) } as Record<string, unknown>;
for (const name of ["connect", "listen", "udpSocket", "serve", "spawn", "spawnSync"]) {
  const blockedOperation = () => denyNetwork(`Bun.${name}`);
  Object.defineProperty(bunRuntime, name, { value: blockedOperation });
  bunModule[name] = blockedOperation;
}
const originalBunFile = bunRuntime.file;
const originalBunWrite = bunRuntime.write;
const guardedBunFile = (...args: Parameters<typeof bunRuntime.file>) => {
  assertFileAccess(args[0], false, "Bun.file");
  const file = Reflect.apply(originalBunFile, bunRuntime, args) as ReturnType<typeof bunRuntime.file>;
  return new Proxy(file, {
    get(target, key) {
      if (key === "delete") return () => retainRemoval("Bun.file.delete", [args[0]], true);
      if (key === "writer") {
        return (...writerArgs: unknown[]) => {
          assertFileAccess(args[0], true, "Bun.file.writer");
          return Reflect.apply(target.writer, target, writerArgs);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
const guardedBunWrite = (...args: Parameters<typeof bunRuntime.write>) => {
  const destination = args[0];
  const path =
    typeof destination === "object" && destination !== null && "name" in destination ? destination.name : destination;
  assertFileAccess(path, true, "Bun.write");
  return Reflect.apply(originalBunWrite, bunRuntime, args);
};
Object.defineProperty(bunRuntime, "file", { value: guardedBunFile });
Object.defineProperty(bunRuntime, "write", { value: guardedBunWrite });
bunModule.file = guardedBunFile;
bunModule.write = guardedBunWrite;
mock.module("bun", () => ({ ...bunModule, default: bunModule }));
for (const name of ["WebSocket", "EventSource", "Worker"]) {
  if (name in globalThis) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: class {
        constructor() {
          denyNetwork(name);
        }
      },
    });
  }
}

process.env.RAVI_STATE_DIR = stateRoot;
process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
process.env.NATS_URL = "nats://127.0.0.1:1";

// This is the original preload's single snapshot hook, extended with guard
// observations. It never deletes or closes retained state. JS API interception
// on Linux is not an OS sandbox and does not claim protection against native code.
afterAll(() => {
  const snapshots = opened.map(({ requested, db }) => {
    const tables: Record<string, unknown> = {};
    try {
      const names = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      for (const row of names as Array<{ name: string }>) {
        const records = db.query(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all();
        if (records.length) tables[row.name] = records;
      }
      return { requested, journalMode: db.query("PRAGMA journal_mode").get(), tables };
    } catch (error) {
      return { requested, error: String(error), tables };
    }
  });
  writeFileSync(
    join(evidenceRoot, "memory-sql-snapshot.json"),
    JSON.stringify(
      { blocked, fileDenials, networkDenied, retainedRemovals, snapshots, diskPersistenceTested: false },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.filter((snapshot) => "error" in snapshot)).toEqual([]);
  expect(blocked).toEqual([]);
  expect(fileDenials).toEqual([]);
});
