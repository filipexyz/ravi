import { Database, type DatabaseOptions } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePm2Jlist } from "../pm2-output.js";
import { registerThreadFenceConnection } from "../threads/schema-fence.js";
import { resolveAccountHome } from "../utils/account-home.js";

export class StateDatabaseError extends Error {
  readonly code = "REAL_STATE_ACCESS_REFUSED";
}

/** A store this process uses but does not prepare, and that nothing has prepared yet. */
export class StateNotPreparedError extends Error {
  readonly code = "STATE_SCHEMA_NOT_READY";
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

function hasPm2Parent(): boolean {
  const pm2Home = process.env.PM2_HOME || join(homedir(), ".pm2");
  // The CLI can auto-start PM2. Check the actual parent before invoking it,
  // without trusting inherited pm_id/name or the child app's PID file.
  try {
    const managerPid = Number(readFileSync(join(pm2Home, "pm2.pid"), "utf8").trim());
    return Number.isInteger(managerPid) && managerPid > 1 && process.ppid === managerPid;
  } catch (cause) {
    // PM2 may have no default PID file (for example, PM2_PID_FILE_PATH was
    // customized). A present but unreadable/mismatched file still fails closed.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  if (process.ppid <= 1) return false;
  const parent = spawnSync("/bin/ps", ["-ww", "-p", String(process.ppid), "-o", "args="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 64 * 1024,
  });
  if (parent.error || parent.status !== 0) return false;
  // This is the live parent process title, not a caller-supplied env label.
  const home = /^PM2 v[^:\s]+: God Daemon \(([^\r\n]+)\)$/.exec(parent.stdout.trim())?.[1];
  if (!home || !isAbsolute(home)) return false;
  try {
    return canonicalStatePath(home) === canonicalStatePath(pm2Home);
  } catch {
    // no-cause: An unverifiable manager home cannot establish runtime identity.
    return false;
  }
}

function readRegisteredProcesses(): RegisteredRuntimeProcess[] {
  if (!hasPm2Parent()) return [];
  // Query the process manager, not inherited pm_id/name environment variables.
  // Bounded and read-only; stdout contains env secrets, so it never gets logged.
  const result = spawnSync("pm2", ["jlist"], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return [];
  try {
    return parsePm2Jlist(result.stdout) as RegisteredRuntimeProcess[];
  } catch {
    // no-cause: Unavailable PM2 identity refuses access; do not expose secret-bearing registry data.
    return [];
  }
}

export interface DatabaseBoundaryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** The OS account's home, when it is not `homeDir`. Resolved by UID when neither is injected. */
  accountHome?: string | null;
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
    argv.length !== 4 ||
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
    if (!execPath) return false;
    if (role === "daemon")
      return canonicalStatePath(execPath) === bundle && args.length === 2 && args[0] === role && args[1] === "run";
    // The channels launcher registers Bun as the executable and passes the bundle
    // as its first argument. Match the running interpreter as well as the bundle.
    return (
      canonicalStatePath(execPath) === canonicalStatePath(process.execPath) &&
      args.length === 3 &&
      canonicalStatePath(args[0]) === bundle &&
      args[1] === role &&
      args[2] === "run"
    );
  });
  if (match && !injectable) verifiedRuntime = { pid, role };
  return match ? role : null;
}

const RUNTIME_INVOCATION_ENV = [
  "RAVI_CONTEXT_KEY",
  "RAVI_GATEWAY_URL",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
] as const;

/** A process that carries one of these acts for a runtime context or a remote gateway, never as the operator's terminal. */
export function hasRuntimeInvocationEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return RUNTIME_INVOCATION_ENV.some((name) => Boolean(env[name]?.trim()));
}

let installedCliEntry: string | null | undefined;

/** The process entry, when it is the CLI bundle of the installed package this code belongs to. */
function installedCliBundle(root: string, entry: string | undefined, cache: boolean): boolean {
  if (!entry) return false;
  if (cache && installedCliEntry !== undefined) return installedCliEntry !== null;
  let match = false;
  try {
    match = canonicalStatePath(entry) === canonicalStatePath(join(root, "dist", "bundle", "index.js"));
  } catch {
    // no-cause: an entry that cannot be resolved is not the installed CLI.
    match = false;
  }
  if (cache) installedCliEntry = match ? entry : null;
  return match;
}

/**
 * The installed CLI run by the operator in a terminal. The process entry must
 * be the bundle of an installed package (one with no `src` or `.git` beside
 * it), so a source checkout, a worktree, a build or a test never qualifies,
 * whatever directory or environment it names. A process that carries a
 * runtime context acts for the daemon and goes through its gateway, and
 * `daemon run` / `channels run` are runtime roles with their own check.
 *
 * Such a CLI reads and writes real state. It never prepares its schema (see
 * `isSchemaConsumer`): the daemon of the same release does.
 */
export function isInstalledOperatorCli(options: DatabaseBoundaryOptions = {}): boolean {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  // A test runner's entry is its test file, which the entry check below
  // refuses. The operator's own arguments may name anything, a test file too.
  if (env.NODE_ENV === "test") return false;
  if (hasRuntimeInvocationEnv(env)) return false;
  if ((argv[2] === "daemon" || argv[2] === "channels") && argv[3] === "run") return false;
  const root = options.modulePath ? installedPackageRoot(options.modulePath) : packageRoot;
  if (!root) return false;
  return installedCliBundle(root, argv[1], options.argv === undefined && options.modulePath === undefined);
}

function isRealStateTarget(path: string, home: string): boolean {
  const target = canonicalStatePath(path);
  return (
    within(target, canonicalStatePath(join(home, ".ravi"))) ||
    target === canonicalStatePath(join(home, "ravi", "ravi.db"))
  );
}

let processAccountHome: string | null | undefined;

/** The account's home by UID, which a `HOME` override does not move. Looked up once, and only for the operator's CLI. */
function accountHomeOf(options: DatabaseBoundaryOptions): string | null {
  if (options.accountHome !== undefined) return options.accountHome;
  if (options.homeDir !== undefined) return null;
  processAccountHome ??= resolveAccountHome();
  return processAccountHome;
}

/**
 * The operator's CLI on real state: the state directory it selected, or one
 * database it opens. Real state is `~/.ravi` under `HOME` and under the
 * account's own home, so a `HOME` override cannot turn the CLI into the one
 * that prepares the account's real state.
 */
function operatorCliUsesRealState(options: DatabaseBoundaryOptions, path?: string): boolean {
  if (!isInstalledOperatorCli(options)) return false;
  const home = options.homeDir ?? homedir();
  const selected = path ?? ((options.env ?? process.env).RAVI_STATE_DIR || join(home, ".ravi"));
  try {
    if (isRealStateTarget(selected, home)) return true;
    const accountHome = accountHomeOf(options);
    return accountHome !== null && isRealStateTarget(selected, accountHome);
  } catch {
    // no-cause: a location that cannot be resolved is treated as real state, which this CLI never prepares.
    return true;
  }
}

/**
 * Whether this process is the operator's installed CLI using real state, as
 * the boundary itself sees it. The commands that must work with no database
 * are chosen by this, so access and recovery never disagree.
 */
export function isOperatorCliOnRealState(options: DatabaseBoundaryOptions = {}): boolean {
  return operatorCliUsesRealState(options);
}

const schemaConsumerScope = new AsyncLocalStorage<true>();

/** Restricts this execution and its async work; it never grants real-state access. */
export function runAsSchemaConsumer<T>(callback: () => T): T {
  return schemaConsumerScope.run(true, callback);
}

/**
 * Whether this execution uses stores without preparing their schema. The
 * channel runner never initializes schemas, including in isolated state. The
 * operator's installed CLI never does on real state; on an isolated state
 * directory it prepares what it needs, as before.
 */
export function isSchemaConsumer(options: DatabaseBoundaryOptions = {}): boolean {
  const argv = options.argv ?? process.argv;
  return (
    schemaConsumerScope.getStore() === true ||
    (argv[2] === "channels" && argv[3] === "run") ||
    operatorCliUsesRealState(options)
  );
}

/** The same question for one database, which may be real state while the selected directory is not. */
export function isSchemaConsumerOf(path: string | null | undefined, options: DatabaseBoundaryOptions = {}): boolean {
  if (isSchemaConsumer(options)) return true;
  return !!path && path !== ":memory:" && operatorCliUsesRealState(options, path);
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
  if (isInstalledOperatorCli(options)) return;
  throw new StateDatabaseError(
    `Refusing the real Ravi state database: ${target}. Only the installed Ravi runtime may open it: the daemon registered in PM2, which prepares its schema, and the installed ravi CLI in the operator's terminal. ` +
      'A source checkout, worktree, build or test must pass an isolated state directory on that command: RAVI_STATE_DIR="$(mktemp -d)" bun <command>. ' +
      "Selecting the real directory explicitly does not authorize a worktree or test. A process that carries a runtime context uses the installed daemon gateway. No launcher setting or confirmation variable is required.",
  );
}

export function openStateDatabase(
  path: string,
  options?: DatabaseOptions,
  boundary?: DatabaseBoundaryOptions,
): Database {
  assertDatabaseTargetAllowed(path, boundary);
  const consumer = isSchemaConsumerOf(path, boundary);
  if (consumer) {
    if (!existsSync(path))
      throw new StateNotPreparedError(
        operatorCliUsesRealState(boundary ?? {}, path)
          ? `STATE_SCHEMA_NOT_READY: ${path} does not exist. The installed daemon creates the stores it serves when it starts: run \`ravi daemon start\`, then retry. The CLI never creates a store in real state; for one the daemon does not serve, select an isolated state directory with RAVI_STATE_DIR.`
          : "STATE_SCHEMA_NOT_READY: start the installed daemon first to initialize state, then start ravi-channels with the same release.",
      );
  }
  const database = new Database(
    path,
    consumer ? { readwrite: !options?.readonly, ...options, create: false } : options,
  );
  try {
    if (path !== ":memory:" && path !== "" && basename(canonicalStatePath(path)) === "ravi.db") {
      // Separate publication/console handles and schema consumers share the
      // bootstrap boundary. Registration grants no SQL lease and changes no schema.
      registerThreadFenceConnection(database, (context) => {
        const { assertThreadFenceBootstrapAuthorized } =
          require("../runtime-maintenance.js") as typeof import("../runtime-maintenance.js");
        return assertThreadFenceBootstrapAuthorized(context);
      });
    }
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}
