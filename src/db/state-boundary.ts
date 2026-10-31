import { Database, type DatabaseOptions } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export class StateDatabaseError extends Error {
  readonly code = "REAL_STATE_ACCESS_REFUSED";
}

// Resolve existing ancestors and dangling links before SQLite can create a file.
export function canonicalStatePath(input: string, depth = 0): string {
  if (depth > 40) throw new StateDatabaseError("State path has too many symlinks");
  const path = resolve(input);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return canonicalStatePath(resolve(dirname(path), readlinkSync(path)), depth + 1);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalStatePath(parent, depth + 1), relative(parent, path));
  }
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function installedPackageRoot(modulePath: string): string | null {
  let dir = dirname(canonicalStatePath(modulePath));
  while (true) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (pkg.name === "ravi.bot") {
        return existsSync(join(dir, "src")) || existsSync(join(dir, ".git")) ? null : dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface RegisteredRuntimeProcess {
  pid: number;
  name: string;
  pm2_env?: { pm_exec_path?: string; args?: string[] };
}

function readRegisteredProcesses(): RegisteredRuntimeProcess[] {
  // The CLI can auto-start PM2. Do not invoke it for an unmanaged foreground
  // process: its actual parent must already be the recorded live PM2 manager.
  try {
    const managerPid = Number(
      readFileSync(join(process.env.PM2_HOME || join(homedir(), ".pm2"), "pm2.pid"), "utf8").trim(),
    );
    if (!Number.isInteger(managerPid) || managerPid <= 1 || process.ppid !== managerPid) return [];
  } catch {
    return [];
  }
  // Query the process manager, not inherited pm_id/name environment variables.
  // Bounded and read-only; stdout contains env secrets, so it never gets logged.
  const result = spawnSync("pm2", ["jlist"], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return [];
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export interface DatabaseBoundaryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  argv?: string[];
  modulePath?: string;
  pid?: number;
  registeredProcesses?: () => RegisteredRuntimeProcess[];
}

const modulePath = fileURLToPath(import.meta.url);
const packageRoot = installedPackageRoot(modulePath);
let verifiedRuntime: { pid: number; role: RuntimeRole } | undefined;
type RuntimeRole = "daemon" | "channels";

/** Process role requires installed code AND the current PID registered by PM2. */
function runtimeRole(options: DatabaseBoundaryOptions): RuntimeRole | null {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  if (env.NODE_ENV === "test" || argv.some((arg) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg))) return null;
  const root = options.modulePath ? installedPackageRoot(options.modulePath) : packageRoot;
  if (!root) return null;
  const bundle = canonicalStatePath(join(root, "dist", "bundle", "index.js"));
  const role = argv[2];
  if (
    !argv[1] ||
    canonicalStatePath(argv[1]) !== bundle ||
    (role !== "daemon" && role !== "channels") ||
    argv[3] !== "run"
  )
    return null;
  const pid = options.pid ?? process.pid;
  const injectable =
    options.registeredProcesses !== undefined || options.pid !== undefined || options.modulePath !== undefined;
  if (!injectable && verifiedRuntime?.pid === pid && verifiedRuntime.role === role) return role;
  const match = (options.registeredProcesses ?? readRegisteredProcesses)().some((entry) => {
    if (entry.pid !== pid || entry.name !== (role === "daemon" ? "ravi" : "ravi-channels")) return false;
    const execPath = entry.pm2_env?.pm_exec_path;
    const args = entry.pm2_env?.args ?? [];
    return Boolean(execPath && canonicalStatePath(execPath) === bundle && args[0] === role && args[1] === "run");
  });
  if (match && !injectable) verifiedRuntime = { pid, role };
  return match ? role : null;
}

/** The runner never initializes schemas, including when exercised in isolated state. */
export function isSchemaConsumer(options: DatabaseBoundaryOptions = {}): boolean {
  const argv = options.argv ?? process.argv;
  return argv[2] === "channels" && argv[3] === "run";
}

/** Must run before mkdir, legacy file moves, opening SQLite, or cached reuse. */
export function assertDatabaseTargetAllowed(path: string, options: DatabaseBoundaryOptions = {}): void {
  if (path === ":memory:" || path === "") return;
  if (path.startsWith("file:")) throw new StateDatabaseError("Use a filesystem path, not a SQLite URI");
  const home = options.homeDir ?? homedir();
  const target = canonicalStatePath(path);
  const realState = canonicalStatePath(join(home, ".ravi"));
  const legacy = target === canonicalStatePath(join(home, "ravi", "ravi.db"));
  try {
    if (statSync(target).nlink > 1) throw new StateDatabaseError(`Refusing hardlinked state database: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!within(target, realState) && !legacy) return;
  if (runtimeRole(options)) return;
  throw new StateDatabaseError(
    `Refusing the real Ravi state database: ${target}. Only the installed daemon registered in PM2 may initialize or migrate it. ` +
      'For CLI, build or test execution, pass an isolated state directory on that command: RAVI_STATE_DIR="$(mktemp -d)" bun <command>. ' +
      "Selecting the real directory explicitly does not authorize a worktree or test. For real state, use the installed daemon gateway. No launcher setting or confirmation variable is required.",
  );
}

export function openStateDatabase(
  path: string,
  options?: DatabaseOptions,
  boundary?: DatabaseBoundaryOptions,
): Database {
  assertDatabaseTargetAllowed(path, boundary);
  if (isSchemaConsumer(boundary)) {
    if (!existsSync(path))
      throw new Error(
        "STATE_SCHEMA_NOT_READY: start the installed daemon first to initialize state, then start ravi-channels with the same release.",
      );
    return new Database(path, { readwrite: !options?.readonly, ...options, create: false });
  }
  return new Database(path, options);
}
