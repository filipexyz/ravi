import { assertRuntimeMaintenanceInactive, runtimeReplacementReadiness } from "./runtime-maintenance.js";
import { spawn } from "node:child_process";
import { which } from "bun";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInsideDaemonProcessTree } from "./cli/daemon-process-tree.js";
import { assertFenceAdoptionWaypoint, readPreparedStateRelease, UPDATE_WAYPOINT_REQUIRED } from "./update-preflight.js";
import { setTimeout as delay } from "node:timers/promises";
import { buildRunnerPm2Env } from "./channels/pm2-env.js";
import {
  readChannelsStoppedForUpgrade,
  recordChannelsStoppedForUpgrade,
  settleThreadFenceLeftovers,
} from "./threads/fence-adoption.js";
import { getRaviStateDir } from "./utils/paths.js";
import {
  managedRuntimeMatchesTarget,
  managedRuntimeBundlePath,
  normalizeRuntimePath,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeProcessSnapshot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { buildChannelsPm2Env, buildChannelsPm2StartArgs, buildDaemonPm2StartArgs } from "./daemon-stdin.js";
import { readDaemonSchemaPhase } from "./db/daemon-schema-owner.js";
import { performSupervisedDaemonRestart, type ManagedDaemonProcess } from "./cli/daemon-restart-supervision.js";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
/** Covers the rebind plus the stability window. CLIs before this change wait 90 s. */
export const MANAGED_RUNTIME_REBIND_TIMEOUT_MS = 180_000;
/**
 * How long the CLI that started the supervisor waits for it, in ms. A CLI
 * that predates the stability window sets nothing and gives up after 90 s:
 * a window past that would turn a converged update into a reported failure.
 */
export const MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV = "RAVI_UPDATE_SUPERVISOR_BUDGET_MS";
const LEGACY_SUPERVISOR_BUDGET_MS = 90_000;
/** Kept after the window for the supervisor to exit and the CLI to verify. */
const SUPERVISOR_EXIT_MARGIN_MS = 10_000;
/** How long the replaced runtime must stay unchanged before the update claims success. */
export const MANAGED_RUNTIME_STABILITY_WINDOW_ENV = "RAVI_UPDATE_STABILITY_WINDOW_MS";
const DEFAULT_STABILITY_WINDOW_MS = 30_000;
const MAX_STABILITY_WINDOW_MS = 300_000;
const STABILITY_POLL_MS = 1_000;

type RunResult = {
  success: boolean;
  output: string;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stream?: boolean;
};

export type ManagedRuntimeRebindStep =
  | {
      action: "delete";
      processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
      args: string[];
    }
  | {
      action: "start";
      processName: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME;
      args: string[];
      cwd: string;
    }
  | { action: "save"; args: string[] };

type ManagedRuntimeRebindRequest = {
  schemaVersion: 1;
  target: ManagedRuntimeTarget;
  previousProcesses: ManagedRuntimeProcessSnapshot[];
};

type ManagedRuntimeRebindDependencies = {
  stateDir?: string;
  run?: (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
  getProcesses?: () => Pm2Process[];
  runnerEnv?: () => Record<string, string>;
  bunPath?: string;
  schemaPhase?: (process: ManagedDaemonProcess) => "waiting" | "owned" | "ready" | null;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  /** `adopt-on-start`: pre-fence database; every legacy writer stops before the daemon starts. */
  assertPrepared?: () => Promise<"ready" | "adopt-on-start"> | "ready" | "adopt-on-start";
  /** Release that last prepared the state (its readiness markers); null when it predates them. */
  preparedStateRelease?: () => string | null;
  /** Overrides `RAVI_UPDATE_STABILITY_WINDOW_MS` (default 30 s). */
  stabilityWindowMs?: number;
  /** The window ends by this time (`now()` clock): the CLI waiting for the supervisor stops soon after. */
  stabilityDeadlineMs?: number;
};

function resolveStabilityWindowMs(dependencies: ManagedRuntimeRebindDependencies): number {
  if (dependencies.stabilityWindowMs !== undefined) return Math.max(0, dependencies.stabilityWindowMs);
  const raw = process.env[MANAGED_RUNTIME_STABILITY_WINDOW_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) return Math.min(Number(raw), MAX_STABILITY_WINDOW_MS);
  return DEFAULT_STABILITY_WINDOW_MS;
}

/** The configured window, shortened to end by the deadline. */
export function boundedStabilityWindowMs(input: { windowMs: number; deadlineMs?: number; now: number }): number {
  if (input.deadlineMs === undefined) return input.windowMs;
  return Math.max(0, Math.min(input.windowMs, input.deadlineMs - input.now));
}

/** The wait the starting CLI declared; 90 s when it declared none (a CLI that predates the window). */
export function supervisorBudgetMs(raw: string | undefined): number {
  const value = raw?.trim();
  if (value && /^\d+$/.test(value)) return Math.min(Number(value), MANAGED_RUNTIME_REBIND_TIMEOUT_MS * 5);
  return LEGACY_SUPERVISOR_BUDGET_MS;
}

function onlineRuntimeIdentity(processes: Pm2Process[]): string {
  return processes
    .filter(
      (process) =>
        (process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME) &&
        process.status === "online",
    )
    .map((process) => `${process.name}:${process.pm_id}:${process.pid}:${process.startedAt ?? ""}`)
    .sort()
    .join("|");
}

/**
 * A runtime that converged can still crash right after: a restart loop shows up
 * as a new PID or start time. Watch the converged processes for the window and
 * fail the update on any change, instead of reporting success.
 */
export async function observeStableManagedRuntime(input: {
  getProcesses: () => Pm2Process[];
  isConverged: (processes: Pm2Process[]) => boolean;
  windowMs: number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<boolean> {
  // The window, PM2 reads included, ends by its deadline: the CLI's wait is bounded.
  const started = input.now();
  const deadline = started + input.windowMs;
  const initial = onlineRuntimeIdentity(input.getProcesses());
  let readMs = input.now() - started;
  for (;;) {
    // Room for the read that ends the next wait; no time left means the window is over.
    const remaining = deadline - input.now() - readMs;
    if (remaining <= 0) return true;
    const before = input.now();
    await input.wait(Math.min(input.pollMs ?? STABILITY_POLL_MS, remaining));
    const readStarted = input.now();
    const current = input.getProcesses();
    readMs = Math.max(readMs, input.now() - readStarted);
    if (onlineRuntimeIdentity(current) !== initial || !input.isConverged(current)) return false;
    // A clock that does not advance cannot measure a window; stop after this check.
    if (input.now() <= before) return true;
  }
}

function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const executable = which(command, { PATH: process.env.PATH });
      if (!executable) throw new Error(`${command} executable is unavailable in the caller PATH`);
      child = spawn(executable, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(options.env ?? process.env), FORCE_COLOR: options.stream === false ? "0" : "1" },
      });
    } catch (error) {
      resolve({ success: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }

    const output: string[] = [];
    child.stdout?.on("data", (data) => output.push(data.toString()));
    child.stderr?.on("data", (data) => output.push(data.toString()));
    child.once("close", (code) => resolve({ success: code === 0, output: output.join("") }));
    child.once("error", (error) => resolve({ success: false, output: error.message }));
  });
}

export function managedRuntimeSnapshot(processes: Pm2Process[]): ManagedRuntimeProcessSnapshot[] {
  return processes
    .filter((process) => process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME)
    .map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null }));
}

export function buildManagedRuntimeRebindPlan(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  bunPath = process.execPath,
  processes: Pm2Process[] = [],
): ManagedRuntimeRebindStep[] {
  const daemon = previousProcesses.find((process) => process.name === PM2_PROCESS_NAME);
  const channels = previousProcesses.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  const plan: ManagedRuntimeRebindStep[] = [];

  // Stop intake before replacing the daemon so both processes always use one bundle.
  if (channels) {
    plan.push({
      action: "delete",
      processName: CHANNELS_PM2_PROCESS_NAME,
      args: ["delete", CHANNELS_PM2_PROCESS_NAME],
    });
  }
  if (daemon) {
    plan.push({ action: "delete", processName: PM2_PROCESS_NAME, args: ["delete", PM2_PROCESS_NAME] });
  }
  if (daemon?.status === "online") {
    plan.push({
      action: "start",
      processName: PM2_PROCESS_NAME,
      args: buildDaemonPm2StartArgs({ bundlePath: target.bundlePath }),
      cwd: target.cwd,
    });
  }
  if (channels?.status === "online") {
    plan.push({
      action: "start",
      processName: CHANNELS_PM2_PROCESS_NAME,
      args: buildChannelsPm2StartArgs({ bundlePath: target.bundlePath, bunPath, processes }),
      cwd: target.cwd,
    });
  }
  if (daemon || channels) plan.push({ action: "save", args: ["save", "--force"] });
  return plan;
}

function encodeManagedRuntimeRebindRequest(request: ManagedRuntimeRebindRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export function decodeManagedRuntimeRebindRequest(encoded: string): ManagedRuntimeRebindRequest {
  if (!encoded || encoded.length > 32_768) throw new Error("Invalid managed runtime rebind request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid managed runtime rebind request");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid managed runtime rebind request");
  const input = parsed as Partial<ManagedRuntimeRebindRequest>;
  if (input.schemaVersion !== 1 || !input.target || !Array.isArray(input.previousProcesses)) {
    throw new Error("Invalid managed runtime rebind request");
  }

  const target = resolveManagedRuntimeTargetFromPackageRoot(input.target.cwd);
  if (
    !target ||
    normalizeRuntimePath(target.bundlePath) !== normalizeRuntimePath(input.target.bundlePath) ||
    target.version !== input.target.version
  ) {
    throw new Error("Managed runtime rebind target is not the requested Ravi bundle");
  }

  const seen = new Set<string>();
  const previousProcesses = input.previousProcesses.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid managed runtime process snapshot");
    if (entry.name !== PM2_PROCESS_NAME && entry.name !== CHANNELS_PM2_PROCESS_NAME) {
      throw new Error("Invalid managed runtime process name");
    }
    if (seen.has(entry.name)) throw new Error("Duplicate managed runtime process snapshot");
    seen.add(entry.name);
    if (
      typeof entry.status !== "string" ||
      typeof entry.pid !== "number" ||
      (entry.createdAt !== null && typeof entry.createdAt !== "number")
    ) {
      throw new Error("Invalid managed runtime process snapshot");
    }
    return { name: entry.name, status: entry.status, pid: entry.pid, createdAt: entry.createdAt };
  });

  return { schemaVersion: 1, target, previousProcesses };
}

async function waitForManagedRuntimeTarget(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  getProcesses: () => Pm2Process[],
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managedRuntimeMatchesTarget(previousProcesses, getProcesses(), target)) return true;
    await delay(250);
  }
  return managedRuntimeMatchesTarget(previousProcesses, getProcesses(), target);
}

/** The ready daemon consumes the intent and starts the runner; this waits for both. */
async function waitForChannelsAfterUpgrade(
  stateDir: string,
  getProcesses: () => Pm2Process[],
  dependencies: ManagedRuntimeRebindDependencies,
): Promise<boolean> {
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((ms: number) => delay(ms));
  const deadline = now() + (dependencies.readyTimeoutMs ?? 30_000);
  for (;;) {
    const online = getProcesses().some(
      (process) => process.name === CHANNELS_PM2_PROCESS_NAME && process.status === "online",
    );
    if (online && !readChannelsStoppedForUpgrade(stateDir)) return true;
    if (now() >= deadline) return false;
    await wait(250);
  }
}

export async function rebindManagedRuntimeProcesses(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  target: ManagedRuntimeTarget,
  dependencies: ManagedRuntimeRebindDependencies = {},
): Promise<boolean> {
  const stateDir = dependencies.stateDir ?? getRaviStateDir();
  // Leftovers of an interrupted upgrade settle here, so the update reaches the daemon entry.
  settleThreadFenceLeftovers(stateDir);
  assertRuntimeMaintenanceInactive(stateDir);
  if (previousProcesses.length === 0) return true;
  const readiness = await (dependencies.assertPrepared ?? runtimeReplacementReadiness)();
  // Before any stop: a pre-fence state the adoption cannot read refuses here,
  // with the running release still serving.
  assertFenceAdoptionWaypoint({
    readiness,
    preparedRelease:
      readiness === "adopt-on-start"
        ? (dependencies.preparedStateRelease ?? (() => readPreparedStateRelease(stateDir)))()
        : null,
    targetVersion: target.version,
    sourceCheckout: existsSync(join(target.cwd, ".git")) ? target.cwd : null,
  });
  const run = dependencies.run ?? runCommand;
  const getProcesses = dependencies.getProcesses ?? (() => getPm2Processes({ strict: true }));
  const bunPath = dependencies.bunPath ?? process.execPath;
  const phase = dependencies.schemaPhase ?? readDaemonSchemaPhase;
  const daemon = previousProcesses.find((process) => process.name === PM2_PROCESS_NAME);
  const channels = previousProcesses.find((process) => process.name === CHANNELS_PM2_PROCESS_NAME);
  if (channels?.status === "online" && daemon?.status !== "online") return false;

  const initial = getProcesses();
  for (const previous of previousProcesses) {
    const matches = initial.filter((process) => process.name === previous.name);
    if (
      matches.length !== 1 ||
      matches[0]!.pid !== previous.pid ||
      (previous.createdAt !== null && matches[0]!.createdAt !== previous.createdAt)
    )
      return false;
  }

  // Prepare launch arguments and runner settings before any PM2 mutation.
  const plan = buildManagedRuntimeRebindPlan(previousProcesses, target, bunPath, initial);
  const runtimeEnv = buildPm2Env({
    RAVI_BUNDLE: target.bundlePath,
    RAVI_DAEMON_CWD: target.cwd,
    RAVI_PM2_EXECUTABLE: bunPath,
  });
  runtimeEnv[MANAGED_RUNTIME_REBIND_ENV] = "";
  runtimeEnv.RAVI_REPO = existsSync(join(target.cwd, ".git")) ? target.cwd : "";
  const runnerEnv = { ...(dependencies.runnerEnv ?? buildRunnerPm2Env)(), ...buildChannelsPm2Env(bunPath) };
  const execute = async (args: string[], env = runtimeEnv, cwd?: string): Promise<number> => {
    assertRuntimeMaintenanceInactive(stateDir);
    const result = await run("pm2", args, { cwd, env, stream: false });
    return result.success ? 0 : 1;
  };
  const save = () => execute(["save", "--force"]);
  const remove = async (name: string): Promise<number> => {
    for (const process of getProcesses().filter((entry) => entry.name === name)) {
      if ((await execute(["delete", String(process.pm_id)])) !== 0) return 1;
    }
    return 0;
  };
  const asManaged = (process: Pm2Process): ManagedDaemonProcess => ({
    name: process.name,
    pmId: process.pm_id,
    pid: process.pid,
    status: process.status,
    startedAt: process.startedAt ?? undefined,
  });
  const predecessor = initial.find((process) => process.name === PM2_PROCESS_NAME);
  // A pre-fence database is adopted by the new daemon at its entry, which refuses while a
  // legacy writer runs: no overlap, the predecessors are removed before it starts.
  const coordinated =
    readiness === "ready" && predecessor?.status === "online" && phase(asManaged(predecessor)) === "ready";
  let readyDaemon: ManagedDaemonProcess | undefined;
  const daemonStillReady = (processes: Pm2Process[]): boolean => {
    const expected = readyDaemon;
    if (!expected) return daemon?.status !== "online";
    const current = processes.find(
      (process) =>
        process.name === PM2_PROCESS_NAME &&
        process.pm_id === expected.pmId &&
        process.pid === expected.pid &&
        (process.startedAt ?? undefined) === expected.startedAt,
    );
    return Boolean(
      current &&
        current.status === "online" &&
        phase(asManaged(current)) === "ready" &&
        managedRuntimeMatchesTarget([daemon!], processes, target),
    );
  };

  // Legacy owners do not hold the schema lock. They cannot coexist with a new
  // writer, even while PM2 reports both processes online.
  // On a pre-fence database the runner comes back through the ready daemon that adopted,
  // whichever start that is: the intent is written before its registration goes.
  const channelsViaDaemon = readiness === "adopt-on-start" && channels?.status === "online";
  if (channelsViaDaemon) recordChannelsStoppedForUpgrade(stateDir, "update");
  if (!coordinated) {
    if ((await remove(CHANNELS_PM2_PROCESS_NAME)) !== 0) return false;
    if ((await remove(PM2_PROCESS_NAME)) !== 0) return false;
  }

  const daemonStart = plan.find((step) => step.action === "start" && step.processName === PM2_PROCESS_NAME);
  if (daemonStart) {
    const result = await performSupervisedDaemonRestart({
      list: () =>
        getProcesses()
          .filter((process) => process.name === PM2_PROCESS_NAME)
          .map(asManaged),
      start: ({ force }) => {
        const args = [...daemonStart.args];
        if (force) args.splice(args.indexOf("--"), 0, "--force");
        return execute(args, runtimeEnv, target.cwd);
      },
      deletePmId: (pmId) => execute(["delete", String(pmId)]),
      save,
      beforePredecessorStop: () => remove(CHANNELS_PM2_PROCESS_NAME),
      pidAlive:
        dependencies.pidAlive ??
        ((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            // no-cause: A failed liveness probe cannot prove a supervised successor, so preserve the predecessor.
            return false;
          }
        }),
      schemaPhase: (candidate) => {
        const current = getProcesses().find(
          (process) => process.pm_id === candidate.pmId && process.pid === candidate.pid,
        );
        if (
          !current ||
          normalizeRuntimePath(managedRuntimeBundlePath(current)) !== normalizeRuntimePath(target.bundlePath)
        )
          return null;
        return phase(candidate);
      },
      now: dependencies.now,
      wait: dependencies.wait,
      readyTimeoutMs: dependencies.readyTimeoutMs,
    });
    if (!result.ok || !result.readySuccessor) return false;
    readyDaemon = result.readySuccessor;
    if (!daemonStillReady(getProcesses())) return false;
  }

  const channelStart = plan.find((step) => step.action === "start" && step.processName === CHANNELS_PM2_PROCESS_NAME);
  if (channelsViaDaemon) {
    if (!(await waitForChannelsAfterUpgrade(stateDir, getProcesses, dependencies))) return false;
  } else if (
    channelStart &&
    (await execute(channelStart.args, buildPm2Env({ ...runtimeEnv, ...runnerEnv }), target.cwd)) !== 0
  )
    return false;
  if (!(await waitForManagedRuntimeTarget(previousProcesses, target, getProcesses))) return false;
  if (!daemonStillReady(getProcesses())) return false;
  if ((await save()) !== 0) return false;
  const converged = (processes: Pm2Process[]) =>
    daemonStillReady(processes) && managedRuntimeMatchesTarget(previousProcesses, processes, target);
  if (!converged(getProcesses())) return false;
  const clock = dependencies.now ?? Date.now;
  return observeStableManagedRuntime({
    getProcesses,
    isConverged: converged,
    windowMs: boundedStabilityWindowMs({
      windowMs: resolveStabilityWindowMs(dependencies),
      deadlineMs: dependencies.stabilityDeadlineMs,
      now: clock(),
    }),
    now: clock,
    wait: dependencies.wait ?? ((ms: number) => delay(ms)),
  });
}

export function buildManagedRuntimeRebindSupervisorInvocation(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const request: ManagedRuntimeRebindRequest = {
    schemaVersion: 1,
    target,
    previousProcesses: managedRuntimeSnapshot(processes),
  };
  const env = buildPm2Env({
    ...(baseEnv as Record<string, string>),
    RAVI_BUNDLE: target.bundlePath,
    RAVI_DAEMON_CWD: target.cwd,
  });
  if (existsSync(join(target.cwd, ".git"))) env.RAVI_REPO = target.cwd;
  else delete env.RAVI_REPO;
  env[MANAGED_RUNTIME_REBIND_ENV] = encodeManagedRuntimeRebindRequest(request);
  env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV] = String(MANAGED_RUNTIME_REBIND_TIMEOUT_MS);
  return { command: process.execPath, args: [target.bundlePath], cwd: target.cwd, env };
}

export const UPDATE_SUPERVISOR_IN_DAEMON_TREE = "UPDATE_REFUSED_IN_DAEMON_TREE";

/**
 * The rebind deletes `ravi`, and PM2 tree-kills every descendant of the daemon.
 * A supervisor started by a CLI inside that tree (an agent tool, a cron shell
 * job) would die between the stop and the start and leave PM2 without either
 * process. Refuse before touching PM2: the predecessors keep running. Current
 * CLIs detach before starting a supervisor, so only an older installed CLI
 * reaches this; running the update again uses the CLI it just installed.
 */
export function refuseRebindInsideDaemonTree(
  insideDaemonTree: () => boolean,
  stateDir: string = getRaviStateDir(),
): void {
  // An unreadable PM2 is an unknown position: refused like "inside", never taken for "outside".
  let readFailure: unknown;
  try {
    if (!insideDaemonTree()) return;
  } catch (cause) {
    readFailure = cause;
  }
  const where =
    readFailure === undefined
      ? "was started inside the daemon's process tree"
      : `could not read PM2 to tell whether it runs inside the daemon's process tree (${
          readFailure instanceof Error ? readFailure.message : String(readFailure)
        })`;
  const message =
    `${UPDATE_SUPERVISOR_IN_DAEMON_TREE}: the update supervisor ${where}, ` +
    "where stopping the daemon would kill it before the new runtime starts. Nothing was stopped. " +
    "Run ravi update again: the CLI it installed detaches first.";
  throw recordSupervisorRefusal(UPDATE_SUPERVISOR_IN_DAEMON_TREE, message, stateDir, readFailure);
}

const SUPERVISOR_REFUSAL_FILE = "supervisor-refused.json";

export type SupervisorRefusal = { code: string; pid: number; at: string; message: string };

/**
 * A supervisor's stdout/stderr may go nowhere (older CLIs ignore them), so a
 * refusal before any stop is also left on disk for whoever started it.
 */
export function recordSupervisorRefusal(
  code: string,
  message: string,
  stateDir: string = getRaviStateDir(),
  cause?: unknown,
): Error {
  try {
    const dir = join(stateDir, "updates");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const refusal: SupervisorRefusal = { code, pid: process.pid, at: new Date().toISOString(), message };
    writeFileSync(join(dir, SUPERVISOR_REFUSAL_FILE), `${JSON.stringify(refusal, null, 2)}\n`, { mode: 0o600 });
  } catch (writeFailure) {
    return new Error(message, { cause: writeFailure });
  }
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

/** The refusal a supervisor recorded at or after `sinceMs`, if any. */
export function readSupervisorRefusal(sinceMs: number, stateDir: string = getRaviStateDir()): SupervisorRefusal | null {
  try {
    const refusal = JSON.parse(
      readFileSync(join(stateDir, "updates", SUPERVISOR_REFUSAL_FILE), "utf8"),
    ) as Partial<SupervisorRefusal>;
    const at = typeof refusal.at === "string" ? Date.parse(refusal.at) : Number.NaN;
    if (!Number.isFinite(at) || at < sinceMs || typeof refusal.message !== "string") return null;
    return {
      code: String(refusal.code),
      pid: Number(refusal.pid),
      at: refusal.at as string,
      message: refusal.message,
    };
  } catch {
    // no-cause: No refusal file (or an unreadable one) means the supervisor recorded no refusal.
    return null;
  }
}

export async function maybeRunManagedRuntimeRebindFromEnv(
  insideDaemonTree: () => boolean = () => isInsideDaemonProcessTree({ strict: true }),
): Promise<boolean> {
  const encoded = process.env[MANAGED_RUNTIME_REBIND_ENV];
  if (!encoded) return false;
  delete process.env[MANAGED_RUNTIME_REBIND_ENV];
  const budgetMs = supervisorBudgetMs(process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV]);
  delete process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
  refuseRebindInsideDaemonTree(insideDaemonTree);
  const request = decodeManagedRuntimeRebindRequest(encoded);
  // The CLI started waiting when it spawned this process.
  const startedAt = Date.now() - process.uptime() * 1000;
  let converged: boolean;
  try {
    converged = await rebindManagedRuntimeProcesses(request.previousProcesses, request.target, {
      stabilityDeadlineMs: startedAt + budgetMs - SUPERVISOR_EXIT_MARGIN_MS,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === UPDATE_WAYPOINT_REQUIRED) {
      throw recordSupervisorRefusal(UPDATE_WAYPOINT_REQUIRED, (error as Error).message);
    }
    throw error;
  }
  if (!converged) throw new Error("Managed Ravi runtime did not converge on the updated bundle");
  return true;
}

const SUPERVISOR_LOG_FILE = "supervisor.log";

export type ManagedRuntimeSupervisorOutcome = {
  converged: boolean;
  /** What the supervisor recorded when it refused before stopping anything. */
  refusal: SupervisorRefusal | null;
  /** The supervisor's stdout and stderr (last run only); null when it could not be opened. */
  logPath: string | null;
};

function openSupervisorLog(stateDir: string): { fd: number; path: string } | null {
  const path = join(stateDir, "updates", SUPERVISOR_LOG_FILE);
  try {
    mkdirSync(join(stateDir, "updates"), { recursive: true, mode: 0o700 });
    return { fd: openSync(path, "w", 0o600), path };
  } catch (cause) {
    // no-cause: Without a log file the supervisor runs as before, output ignored; a refusal still reaches the CLI through its file.
    console.error(`ravi update: supervisor log unavailable at ${path}: ${(cause as Error).message}`);
    return null;
  }
}

export async function runManagedRuntimeRebindSupervisor(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  stateDir: string = getRaviStateDir(),
): Promise<ManagedRuntimeSupervisorOutcome> {
  const startedAt = Date.now();
  const log = openSupervisorLog(stateDir);
  const converged = await superviseManagedRuntimeRebind(target, processes, log?.fd);
  return {
    converged,
    // A refusal is recorded before any stop, so only an unconverged run can carry one.
    refusal: converged ? null : readSupervisorRefusal(startedAt, stateDir),
    logPath: log?.path ?? null,
  };
}

function superviseManagedRuntimeRebind(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  logFd: number | undefined,
): Promise<boolean> {
  const invocation = buildManagedRuntimeRebindSupervisorInvocation(target, processes);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        detached: true,
        stdio: logFd === undefined ? "ignore" : ["ignore", logFd, logFd],
      });
    } catch (cause) {
      // no-cause: A supervisor that cannot start reaches the CLI as a run that did not converge; the update fails on that result.
      console.error(`ravi update: could not start the update supervisor: ${(cause as Error).message}`);
      resolve(false);
      return;
    } finally {
      // The child holds its own copy of the descriptor.
      if (logFd !== undefined) closeSync(logFd);
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.unref();
      resolve(success);
    };
    timer = setTimeout(() => finish(false), MANAGED_RUNTIME_REBIND_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
