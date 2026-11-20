import {
  assertRuntimeMaintenanceInactive,
  processExitState,
  runtimeReplacementReadiness,
} from "./runtime-maintenance.js";
import { spawn } from "node:child_process";
import { which } from "bun";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInsideDaemonProcessTree } from "./cli/daemon-process-tree.js";
import { MANAGED_RUNTIME_READY_TIMEOUT_MS } from "./db/state-boundary.js";
import {
  compareRaviVersions,
  readPreparedStateRelease,
  requiredFenceAdoptionWaypoint,
  UPDATE_WAYPOINT_REQUIRED,
  UpdateWaypointRequiredError,
} from "./update-preflight.js";
import { hopThroughWaypoint, type WaypointHopDependencies, type WaypointHopOutcome } from "./update-waypoint.js";
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
import { acquireSchemaFileLock } from "./db/schema-lock.js";
import { observeStableManagedRuntime } from "./runtime-stability.js";
import { performSupervisedDaemonRestart, type ManagedDaemonProcess } from "./cli/daemon-restart-supervision.js";
import { buildPm2Env, CHANNELS_PM2_PROCESS_NAME, getPm2Processes, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";
import {
  acquireStateStoreOwnership,
  planUpdateSnapshot,
  takeUpdateSnapshot,
  UPDATE_SNAPSHOT_SPACE,
  updateSnapshotsDir,
  updateStorePaths,
  type UpdateSnapshotManifest,
  type UpdateSnapshotPlan,
} from "./update-snapshot.js";
import {
  readUpdateSupervisorResult,
  recordUpdateSupervisorResult,
  globalInstallMethodOf,
  resolveUpdateRollbackPlan,
  rollBackUpdate,
  superviseOperatorRollback,
  UPDATE_ROLLBACK_UNAVAILABLE,
  type OperatorRollbackSupervisorDependencies,
  type UpdateRollbackDependencies,
  type UpdateRollbackOutcome,
  type UpdateRollbackPlan,
  type UpdateSupervisorResult,
} from "./update-rollback.js";

export { observeStableManagedRuntime } from "./runtime-stability.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";
/**
 * How long the CLI that started the supervisor waits for it, in ms. A CLI that
 * predates the stability window sets nothing, and its wait is short: 30 s up to
 * 3.261113.2 (the waypoint release), 90 s from 3.261113.3. Such a CLI gets no
 * window (`supervisorStabilityPlan`).
 */
export const MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV = "RAVI_UPDATE_SUPERVISOR_BUDGET_MS";
/** Kept after the window for the supervisor to exit and the CLI to verify. */
export const SUPERVISOR_EXIT_MARGIN_MS = 10_000;
/** How long the replaced runtime must stay unchanged before the update claims success. */
export const MANAGED_RUNTIME_STABILITY_WINDOW_ENV = "RAVI_UPDATE_STABILITY_WINDOW_MS";
export const DEFAULT_STABILITY_WINDOW_MS = 30_000;
/**
 * How long the CLI waits for the supervisor: the rebind, the stability window
 * and, when the target does not converge, the automatic rollback (which
 * reinstalls a release). CLIs before the window declare no wait and give up
 * after 30 s (up to 3.261113.2) or 90 s (3.261113.3 on); they get no window,
 * and the supervisor records its result for them.
 *
 * A fixed 15 minutes, as the update spec says, not a sum: the reinstall has no
 * timeout of its own, so any share left for it would be calibrated, not
 * measured. What it must always cover is asserted from the phases that do have
 * limits (`state-boundary.test.ts`), so a longer state-guard bound fails there
 * instead of eating the reinstall's share.
 */
export const MANAGED_RUNTIME_REBIND_TIMEOUT_MS = 900_000;
/** How long the rebind waits for the channels runner after the daemon: the ready window, as every supervisor. */
export const MANAGED_RUNTIME_CHANNELS_WAIT_MS = MANAGED_RUNTIME_READY_TIMEOUT_MS;
const MAX_STABILITY_WINDOW_MS = 300_000;

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
  /** `ravi update --rollback --execute`: the supervisor rolls back to the snapshot the preview named, no rebind. */
  rollback?: { snapshotId: string };
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
  /** Whether this update can roll back (`resolveUpdateRollbackPlan`); null keeps it without a snapshot. */
  rollbackPlan?: (input: {
    target: ManagedRuntimeTarget;
    processes: Pm2Process[];
    stateDir: string;
  }) => UpdateRollbackPlan | null;
  planSnapshot?: (input: { stateDir: string; stores: string[] }) => UpdateSnapshotPlan;
  takeSnapshot?: typeof takeUpdateSnapshot;
  acquireOwnership?: (stateDir: string, stores: string[], timeoutMs: number) => { release(): void };
  rollBack?: (dependencies: UpdateRollbackDependencies) => Promise<UpdateRollbackOutcome>;
  /** Overrides the rollback's own dependencies (tests). */
  rollbackOverrides?: Partial<UpdateRollbackDependencies>;
  /**
   * The window the restored release must hold before a rollback counts. Defaults to the configured window
   * (`RAVI_UPDATE_STABILITY_WINDOW_MS`, 30 s), also when the CLI declared no budget: that CLI reports the failure
   * anyway, and the rollback is only proven by the window.
   */
  rollbackStabilityWindowMs?: number;
  /** The waypoint hop (`update-waypoint.ts`; tests). */
  hopThroughWaypoint?: (dependencies: WaypointHopDependencies) => Promise<WaypointHopOutcome>;
  /** Set on the update that follows a waypoint: a second waypoint means the first did not prepare the state. */
  afterWaypoint?: boolean;
  storePaths?: (stateDir: string) => string[];
  /** Set on the update that follows a waypoint: what the first pass noted, recorded with this pass's result. */
  carriedWarnings?: string[];
  /**
   * Set on the update that follows a waypoint: the snapshot taken before the waypoint, of the state of the release
   * that wrote it. Kept when this pass takes its own, so the way back to that release survives until the next update.
   */
  keptSnapshot?: UpdateSnapshotManifest;
};

/** What the rebind ended with, for the result left to the CLI. */
function describeRollbackFailure(outcome: Extract<UpdateRollbackOutcome, { ok: false }>): string {
  return `the automatic rollback stopped at ${outcome.step}: ${outcome.message}`;
}

/** The stability window from `RAVI_UPDATE_STABILITY_WINDOW_MS` (at most 300 s), or 30 s. */
export function configuredStabilityWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MANAGED_RUNTIME_STABILITY_WINDOW_ENV]?.trim();
  if (raw && /^\d+$/.test(raw)) return Math.min(Number(raw), MAX_STABILITY_WINDOW_MS);
  return DEFAULT_STABILITY_WINDOW_MS;
}

function resolveStabilityWindowMs(dependencies: ManagedRuntimeRebindDependencies): number {
  if (dependencies.stabilityWindowMs !== undefined) return Math.max(0, dependencies.stabilityWindowMs);
  return configuredStabilityWindowMs();
}

/** The configured window, shortened to end by the deadline. */
export function boundedStabilityWindowMs(input: { windowMs: number; deadlineMs?: number; now: number }): number {
  if (input.deadlineMs === undefined) return input.windowMs;
  return Math.max(0, Math.min(input.windowMs, input.deadlineMs - input.now));
}

export type SupervisorStabilityPlan = Pick<
  ManagedRuntimeRebindDependencies,
  "stabilityWindowMs" | "stabilityDeadlineMs"
>;

/**
 * The stability window a supervisor may run, from the wait the CLI that started it declared
 * (`RAVI_UPDATE_SUPERVISOR_BUDGET_MS`). A declared wait gets the window, ending `SUPERVISOR_EXIT_MARGIN_MS` before
 * that wait runs out. No declaration means a CLI that predates the window, whose wait can be as short as 30 s
 * (3.261113.2, the waypoint release): it gets no window, so the supervisor answers as before this change and a
 * converged update is never reported as a failure.
 */
export function supervisorStabilityPlan(
  declaredBudget: string | undefined,
  startedAt: number,
): SupervisorStabilityPlan {
  const value = declaredBudget?.trim();
  if (!value || !/^\d+$/.test(value)) return { stabilityWindowMs: 0 };
  const budgetMs = Math.min(Number(value), MANAGED_RUNTIME_REBIND_TIMEOUT_MS * 5);
  return { stabilityDeadlineMs: startedAt + budgetMs - SUPERVISOR_EXIT_MARGIN_MS };
}

/** Runs a command and collects its output; the rollback and `ravi update --rollback` use it too. */
export function runManagedRuntimeCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return runCommand(command, args, options);
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

  const rollback = input.rollback;
  if (
    rollback !== undefined &&
    (!rollback ||
      typeof rollback !== "object" ||
      typeof rollback.snapshotId !== "string" ||
      !/^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(rollback.snapshotId))
  ) {
    throw new Error("Invalid managed runtime rebind request");
  }
  return {
    schemaVersion: 1,
    target,
    previousProcesses,
    ...(rollback ? { rollback: { snapshotId: rollback.snapshotId } } : {}),
  };
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
  const deadline = now() + (dependencies.readyTimeoutMs ?? MANAGED_RUNTIME_CHANNELS_WAIT_MS);
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
  // Before any stop: a pre-fence state the adoption cannot read needs a waypoint. The update takes it by itself
  // when it can roll back to the release that wrote the state (below); otherwise it refuses here, with the
  // running release still serving.
  const preparedRelease =
    readiness === "adopt-on-start"
      ? (dependencies.preparedStateRelease ?? (() => readPreparedStateRelease(stateDir)))()
      : null;
  const waypoint = requiredFenceAdoptionWaypoint({ readiness, preparedRelease });
  const sourceCheckout = existsSync(join(target.cwd, ".git")) ? target.cwd : null;
  const refuseWaypoint = (): never => {
    throw new UpdateWaypointRequiredError(preparedRelease, target.version, sourceCheckout);
  };
  // Refused at once, before PM2 is read: a checkout is switched by its operator, only a global install can be rolled
  // back, and a second waypoint means the first did not prepare the state.
  if (waypoint && (sourceCheckout || dependencies.afterWaypoint || !globalInstallMethodOf(target.cwd)))
    refuseWaypoint();
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

  // Before any stop: whether this update can roll back, and room on the disk for its snapshot.
  const rollbackPlan = (dependencies.rollbackPlan ?? resolveUpdateRollbackPlan)({
    target,
    processes: initial,
    stateDir,
  });
  // The waypoint is taken by the update only with a rollback to the release that wrote this state, and never as a
  // downgrade of that release.
  const hop =
    waypoint && rollbackPlan && compareRaviVersions(rollbackPlan.previousRelease, waypoint) < 0 ? waypoint : null;
  if (waypoint && !hop) refuseWaypoint();
  const stores = rollbackPlan ? (dependencies.storePaths ?? updateStorePaths)(stateDir) : [];
  const snapshotPlan = rollbackPlan ? (dependencies.planSnapshot ?? planUpdateSnapshot)({ stateDir, stores }) : null;
  const gone = (pid: number): boolean =>
    dependencies.pidAlive ? !dependencies.pidAlive(pid) : processExitState(pid) === "exited";

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
  // An update that can roll back stops both first too: the snapshot needs a moment with no
  // owner, after the predecessor's last write and before the target's first.
  const coordinated =
    !rollbackPlan &&
    readiness === "ready" &&
    predecessor?.status === "online" &&
    phase(asManaged(predecessor)) === "ready";
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

  const warnings: string[] = [...(dependencies.carriedWarnings ?? [])];
  const stoppedPids = initial
    .filter((process) => process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME)
    .map((process) => process.pid);
  // Nothing owns the state and the target has not started: the snapshot is the previous release's state.
  const snapshot =
    rollbackPlan && snapshotPlan
      ? await snapshotStoppedState({
          stateDir,
          stores,
          plan: snapshotPlan,
          rollbackPlan,
          target,
          pids: stoppedPids,
          gone,
          warnings,
          dependencies,
        })
      : null;

  const replace = async (): Promise<boolean> => {
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
  };

  if (!rollbackPlan) return replace();
  const record = (
    outcome: UpdateSupervisorResult["outcome"],
    message: string,
    extra: Partial<Pick<UpdateSupervisorResult, "restoredAt" | "candidateDir" | "commands">> = {},
  ) => {
    console.error(`ravi update: ${message}`);
    try {
      recordUpdateSupervisorResult(stateDir, {
        outcome,
        targetRelease: target.version,
        previousRelease: rollbackPlan.previousRelease,
        snapshotId: snapshot?.id ?? null,
        snapshotAt: snapshot?.createdAt ?? null,
        restoredAt: extra.restoredAt ?? null,
        candidateDir: extra.candidateDir ?? null,
        message,
        commands: extra.commands ?? [],
        warnings,
      });
    } catch (cause) {
      console.error(`ravi update: could not record the supervisor result: ${(cause as Error).message}`);
    }
  };
  /**
   * Back to the release that wrote the state: from `manifest`, or, with none, on that state untouched (the update
   * stopped both processes but took no snapshot). `headline` replaces "the target did not converge".
   */
  const rollBack = async (
    reason: string,
    manifest: UpdateSnapshotManifest | null,
    headline = `Ravi ${target.version} did not converge (${reason})`,
  ): Promise<void> => {
    let outcome: UpdateRollbackOutcome;
    try {
      outcome = await (dependencies.rollBack ?? rollBackUpdate)({
        stateDir,
        plan: rollbackPlan,
        manifest,
        ...(manifest ? {} : { stoppedPids }),
        previousProcesses,
        bunPath,
        run,
        getProcesses,
        pidAlive: (pid) => !gone(pid),
        now: dependencies.now,
        wait: dependencies.wait,
        schemaPhase: phase,
        stabilityWindowMs: dependencies.rollbackStabilityWindowMs ?? resolveStabilityWindowMs({}),
        ...dependencies.rollbackOverrides,
      });
    } catch (cause) {
      // Never an unrecorded end: the result names where to look for what the rollback did.
      const snapshotDir = manifest ? join(updateSnapshotsDir(stateDir), manifest.id) : null;
      outcome = {
        ok: false,
        step: "unknown",
        message: snapshotDir
          ? `the rollback threw (${(cause as Error).message}). Whether the state was restored is in ` +
            `${join(snapshotDir, "restore.json")}; the snapshot is in ${snapshotDir}.`
          : `bringing Ravi ${rollbackPlan.previousRelease} back threw (${(cause as Error).message}); the state is untouched.`,
        commands: snapshotDir
          ? ["ravi daemon status", "pm2 jlist", `cat ${join(snapshotDir, "restore.json")}`]
          : [
              `${rollbackPlan.method} install -g ravi.bot@${rollbackPlan.previousRelease}`,
              "ravi daemon start",
              ...(rollbackPlan.channelsOnline ? ["ravi channels start"] : []),
              "ravi daemon status",
            ],
        restoredAt: null,
        candidateDir: null,
      };
    }
    if (outcome.ok) {
      record(
        "rolled-back",
        manifest
          ? `${headline}. The update rolled back: Ravi ${rollbackPlan.previousRelease} ` +
              `runs again on its state as of ${manifest.createdAt}. What Ravi ${target.version} wrote between ` +
              `${manifest.createdAt} and ${outcome.restoredAt} is not in the live state; its files are kept in ` +
              `${outcome.candidateDir}.`
          : `${headline}. Ravi ${rollbackPlan.previousRelease} runs again on its untouched state; nothing else ` +
              "changed. Run the update again once the snapshot can be taken.",
        { restoredAt: outcome.restoredAt, candidateDir: outcome.candidateDir },
      );
      return;
    }
    record("rollback-failed", `${headline}, and ${describeRollbackFailure(outcome)}`, {
      restoredAt: outcome.restoredAt,
      candidateDir: outcome.candidateDir,
      commands: outcome.commands,
    });
  };
  const unprotected = (reason: string) =>
    `Ravi ${target.version} did not converge (${reason}). No snapshot was taken (${warnings.join("; ") || "unknown reason"}), ` +
    "so nothing was rolled back.";

  if (hop) {
    // Both processes of the release that wrote the state are stopped. Without its snapshot the waypoint has no
    // rollback, so it is not taken: the state is untouched, and that release comes back on it by itself (the
    // installed package is the target's by now). Only a stopped process that never exits leaves the host stopped:
    // nothing starts beside it, and the result names the commands.
    if (!snapshot) {
      await rollBack(
        "",
        null,
        `The state needs the waypoint Ravi ${hop}, but no snapshot of Ravi ${rollbackPlan.previousRelease}'s state ` +
          `could be taken (${warnings.join("; ") || "unknown reason"}), so neither the waypoint nor Ravi ` +
          `${target.version} was started`,
      );
      return false;
    }
    // The runner goes up for the waypoint's boot record even when it was stopped.
    if (channels?.status !== "online")
      warnings.push(
        `the channel runner was stopped; the waypoint Ravi ${hop} ran it for its boot record, and while it ran it ` +
          "processed queued inbound and outbound messages",
      );
    let outcome: WaypointHopOutcome;
    try {
      outcome = await (dependencies.hopThroughWaypoint ?? hopThroughWaypoint)({
        stateDir,
        waypoint: hop,
        target,
        method: rollbackPlan.method,
        packageRoot: rollbackPlan.packageRoot,
        bunPath,
        run,
        getProcesses,
        now: dependencies.now,
        wait: dependencies.wait,
        schemaPhase: phase,
        stabilityWindowMs: dependencies.rollbackStabilityWindowMs ?? resolveStabilityWindowMs({}),
      });
    } catch (cause) {
      outcome = { ok: false, step: "unknown", message: (cause as Error).message };
    }
    if (!outcome.ok) {
      if (outcome.step === "reinstall-target") {
        // The waypoint runs from memory on the state it prepared; the install holds what the message says.
        record(
          "failed",
          `Ravi ${hop} prepared the state and runs on it, but Ravi ${target.version} could not be installed ` +
            `again (${outcome.message}). Install it with the first command, then run the update again.`,
          {
            commands: [
              `${rollbackPlan.method} install -g ravi.bot@${target.version}`,
              "ravi daemon status",
              `ravi update --version ${target.version}`,
            ],
          },
        );
        return false;
      }
      await rollBack(`the waypoint Ravi ${hop} failed at ${outcome.step}: ${outcome.message}`, snapshot);
      return false;
    }
    console.error(`ravi update: Ravi ${hop} prepared the state; updating it to Ravi ${target.version}`);
    const afterWaypoint = (reason: string) =>
      record(
        "failed",
        `Ravi ${hop} prepared the state and runs on it, but the update to Ravi ${target.version} stopped before ` +
          `it began (${reason}). Nothing else changed; run the update again.`,
        { commands: ["ravi daemon status", `ravi update --version ${target.version}`] },
      );
    try {
      // The waypoint started the runner only for its boot record: one that was stopped before stays stopped.
      if (channels?.status !== "online" && (await remove(CHANNELS_PM2_PROCESS_NAME)) !== 0) {
        afterWaypoint("PM2 could not remove the waypoint's channel runner");
        return false;
      }
      const secondPassAt = Date.now();
      const converged = await rebindManagedRuntimeProcesses(managedRuntimeSnapshot(getProcesses()), target, {
        ...dependencies,
        afterWaypoint: true,
        carriedWarnings: warnings,
        keptSnapshot: snapshot,
      });
      // Every end of that pass is recorded, also one that returned before it could roll back.
      if (!converged && !readUpdateSupervisorResult(secondPassAt, stateDir))
        afterWaypoint("PM2 changed before it could stop the waypoint's processes");
      return converged;
    } catch (cause) {
      afterWaypoint((cause as Error).message);
      return false;
    }
  }

  let converged: boolean;
  try {
    converged = await replace();
  } catch (error) {
    const reason = `the rebind failed: ${(error as Error).message}`;
    if (snapshot) await rollBack(reason, snapshot);
    else record("failed", unprotected(reason));
    throw error;
  }
  if (converged) {
    record(
      "converged",
      `Ravi ${target.version} converged and stayed up for the stability window.` +
        (snapshot
          ? ` The snapshot of Ravi ${rollbackPlan.previousRelease}'s state is kept in ${join(updateSnapshotsDir(stateDir), snapshot.id)} until the next update.`
          : "") +
        (dependencies.keptSnapshot
          ? ` So is the one taken before the waypoint, of Ravi ${dependencies.keptSnapshot.previousRelease}'s state, in ` +
            `${join(updateSnapshotsDir(stateDir), dependencies.keptSnapshot.id)}.`
          : ""),
    );
    return true;
  }
  const reason = "it did not converge, or did not stay up for the stability window";
  if (snapshot) await rollBack(reason, snapshot);
  else record("failed", unprotected(reason));
  return false;
}

/**
 * The predecessors are gone and no daemon owns the stores: copy them. A
 * snapshot that cannot be taken leaves the update without a rollback, as
 * before this existed, and says why.
 */
async function snapshotStoppedState(input: {
  stateDir: string;
  stores: string[];
  plan: UpdateSnapshotPlan;
  rollbackPlan: UpdateRollbackPlan;
  target: ManagedRuntimeTarget;
  pids: number[];
  gone: (pid: number) => boolean;
  warnings: string[];
  dependencies: ManagedRuntimeRebindDependencies;
}): Promise<UpdateSnapshotManifest | null> {
  const now = input.dependencies.now ?? Date.now;
  const wait = input.dependencies.wait ?? ((ms: number) => delay(ms));
  const pids = input.pids.filter((pid) => pid > 0);
  const deadline = now() + 30_000;
  while (!pids.every(input.gone) && now() < deadline) {
    const before = now();
    await wait(250);
    if (now() <= before) break;
  }
  if (!pids.every(input.gone)) {
    input.warnings.push("a stopped process did not exit, so no snapshot was taken");
    return null;
  }
  let ownership: { release(): void };
  try {
    ownership = (input.dependencies.acquireOwnership ?? acquireStateStoreOwnership)(
      input.stateDir,
      input.stores,
      30_000,
    );
  } catch (cause) {
    input.warnings.push(
      `a process still owns the state stores (${(cause as Error).message}), so no snapshot was taken`,
    );
    return null;
  }
  try {
    const snapshot = (input.dependencies.takeSnapshot ?? takeUpdateSnapshot)({
      stateDir: input.stateDir,
      stores: input.stores,
      method: input.plan.method,
      previousRelease: input.rollbackPlan.previousRelease,
      targetRelease: input.target.version,
      keep: input.dependencies.keptSnapshot?.id ?? null,
    });
    console.error(
      `ravi update: snapshot ${snapshot.id} of Ravi ${input.rollbackPlan.previousRelease}'s state taken (${input.plan.method})`,
    );
    return snapshot;
  } catch (cause) {
    input.warnings.push(`the snapshot failed (${(cause as Error).message})`);
    return null;
  } finally {
    ownership.release();
  }
}

export function buildManagedRuntimeRebindSupervisorInvocation(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { rollback?: { snapshotId: string } } = {},
): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  const request: ManagedRuntimeRebindRequest = {
    schemaVersion: 1,
    target,
    previousProcesses: managedRuntimeSnapshot(processes),
    ...(options.rollback ? { rollback: options.rollback } : {}),
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
  rebind: typeof rebindManagedRuntimeProcesses = rebindManagedRuntimeProcesses,
  /** The operator rollback's PM2 reads and rollback (tests). */
  rollbackOverrides: Partial<OperatorRollbackSupervisorDependencies> = {},
): Promise<boolean> {
  const encoded = process.env[MANAGED_RUNTIME_REBIND_ENV];
  if (!encoded) return false;
  delete process.env[MANAGED_RUNTIME_REBIND_ENV];
  const declaredBudget = process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
  delete process.env[MANAGED_RUNTIME_SUPERVISOR_BUDGET_ENV];
  refuseRebindInsideDaemonTree(insideDaemonTree);
  const lock = acquireUpdateSupervisorLock();
  try {
    const request = decodeManagedRuntimeRebindRequest(encoded);
    if (request.rollback) {
      let rolledBack: boolean;
      try {
        rolledBack = await superviseOperatorRollback({
          stateDir: getRaviStateDir(),
          snapshotId: request.rollback.snapshotId,
          getProcesses: () => getPm2Processes({ strict: true }),
          run: runManagedRuntimeCommand,
          bunPath: process.execPath,
          pidAlive: (pid) => processExitState(pid) !== "exited",
          env: process.env,
          stabilityWindowMs: configuredStabilityWindowMs(process.env),
          installMethod: globalInstallMethodOf(request.target.cwd),
          ...rollbackOverrides,
        });
      } catch (error) {
        // Refused under the lock, before any stop: the reason reaches the CLI.
        if ((error as { code?: unknown } | null)?.code === UPDATE_ROLLBACK_UNAVAILABLE)
          throw recordSupervisorRefusal(UPDATE_ROLLBACK_UNAVAILABLE, (error as Error).message);
        throw error;
      }
      if (!rolledBack) throw new Error("ravi update --rollback did not bring the previous release back");
      return true;
    }
    // The CLI started waiting when it spawned this process.
    const plan = supervisorStabilityPlan(declaredBudget, Date.now() - process.uptime() * 1000);
    let converged: boolean;
    try {
      converged = await rebind(request.previousProcesses, request.target, plan);
    } catch (error) {
      // Refusals before any stop: the running release keeps serving, and the reason reaches the CLI.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === UPDATE_WAYPOINT_REQUIRED || code === UPDATE_SNAPSHOT_SPACE) {
        throw recordSupervisorRefusal(code, (error as Error).message);
      }
      throw error;
    }
    if (!converged) throw new Error("Managed Ravi runtime did not converge on the updated bundle");
    return true;
  } finally {
    lock.release();
  }
}

export const UPDATE_IN_PROGRESS = "UPDATE_IN_PROGRESS";

/**
 * One update supervisor per state directory, for its whole life: a second one would prune the first one's
 * snapshot and stop processes under it. The lock goes with the process, so a crash leaves nothing behind.
 */
export function acquireUpdateSupervisorLock(stateDir: string = getRaviStateDir()): { release(): void } {
  try {
    return acquireSchemaFileLock(join(stateDir, "updates", "update.lock"), 0);
  } catch (cause) {
    throw recordSupervisorRefusal(
      UPDATE_IN_PROGRESS,
      `${UPDATE_IN_PROGRESS}: another update supervisor holds ${join(stateDir, "updates", "update.lock")} ` +
        `(${(cause as Error).message}). Nothing was stopped. Wait for it to finish (its outcome goes to ` +
        `${join(stateDir, "updates", "supervisor-result.json")}), then run ravi update again if it is still needed.`,
      stateDir,
      cause,
    );
  }
}

const SUPERVISOR_LOG_FILE = "supervisor.log";

export type ManagedRuntimeSupervisorOutcome = {
  converged: boolean;
  /** What the supervisor recorded when it refused before stopping anything. */
  refusal: SupervisorRefusal | null;
  /** What a supervisor that could roll back recorded: converged, rolled back, or why not. */
  result: UpdateSupervisorResult | null;
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
  /** `rollback`: run `ravi update --rollback --execute` in the supervisor; `env`: the supervisor's environment. */
  options: { rollback?: { snapshotId: string }; env?: NodeJS.ProcessEnv } = {},
): Promise<ManagedRuntimeSupervisorOutcome> {
  const startedAt = Date.now();
  const log = openSupervisorLog(stateDir);
  const converged = await superviseManagedRuntimeRebind(target, processes, log?.fd, options);
  return {
    converged,
    // A refusal is recorded before any stop, so only an unconverged run can carry one.
    refusal: converged ? null : readSupervisorRefusal(startedAt, stateDir),
    result: readUpdateSupervisorResult(startedAt, stateDir),
    logPath: log?.path ?? null,
  };
}

function superviseManagedRuntimeRebind(
  target: ManagedRuntimeTarget,
  processes: Pm2Process[],
  logFd: number | undefined,
  options: { rollback?: { snapshotId: string }; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const invocation = buildManagedRuntimeRebindSupervisorInvocation(target, processes, options.env ?? process.env, {
    rollback: options.rollback,
  });
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
