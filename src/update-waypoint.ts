/**
 * The automatic waypoint of `ravi update`. A state written before the thread fence that a release older than
 * 3.261113.2 prepared cannot be adopted by the target: the update takes it through 3.261113.2 first, by itself.
 *
 * Runs in the update supervisor (the target's bundle), after both processes of the release that wrote the state
 * have stopped and that state is in a snapshot. The waypoint is installed in the same global install and started
 * through its own CLI; it counts once it prepared the state the way the target's adoption reads it (its readiness
 * markers, and a boot record of both processes from it) and held for the stability window. Then the target is
 * installed again and the update goes on from the waypoint. A waypoint that fails is rolled back by the caller to
 * the release that wrote the state (`update-rollback.ts`).
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedDaemonProcess } from "./cli/daemon-restart-supervision.js";
import { readDaemonSchemaPhase } from "./db/daemon-schema-owner.js";
import {
  buildManagedRuntimeIdentity,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";
import { readLastRuntimeBootReceipt } from "./runtime-process-identity.js";
import { observeStableManagedRuntime } from "./runtime-stability.js";
import { compareRaviVersions, readPreparedStateRelease } from "./update-preflight.js";
import { previousReleaseCliEnv, SCHEMA_PHASE_RECEIPTS_RELEASE, type GlobalInstallMethod } from "./update-rollback.js";

/** `unknown`: the hop itself threw, outside a step it tracks. */
export type WaypointHopStep = "install" | "start" | "prepare" | "reinstall-target" | "unknown";

export type WaypointHopOutcome = { ok: true } | { ok: false; step: WaypointHopStep; message: string };

type RunResult = { success: boolean; output: string };
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; stream?: boolean };

export type WaypointHopDependencies = {
  stateDir: string;
  /** The release the state goes through (3.261113.2). */
  waypoint: string;
  /** The release the update installs after the waypoint. */
  target: ManagedRuntimeTarget;
  method: GlobalInstallMethod;
  /** The global install the target went into; the waypoint goes to the same place. */
  packageRoot: string;
  bunPath: string;
  run: (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
  getProcesses: () => Pm2Process[];
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  resolveTarget?: (packageRoot: string) => ManagedRuntimeTarget | null;
  /** Release that last prepared the state (test seam; default `readPreparedStateRelease`). */
  preparedRelease?: () => string | null;
  /** Schema phase of a daemon (`readDaemonSchemaPhase`): the waypoint's daemon counts only at `ready`. */
  schemaPhase?: (process: ManagedDaemonProcess) => "waiting" | "owned" | "ready" | null;
  startTimeoutMs?: number;
  prepareTimeoutMs?: number;
  stabilityWindowMs?: number;
};

/**
 * Whether the waypoint prepared the state the way the target's adoption reads it: readiness markers of the waypoint
 * or later, and the last boot record of both `ravi` and `ravi-channels` written by the waypoint, with its bundle.
 */
export function waypointPreparedState(
  stateDir: string,
  waypoint: string,
  preparedRelease: string | null = readPreparedStateRelease(stateDir),
): { prepared: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!preparedRelease || compareRaviVersions(preparedRelease, waypoint) < 0)
    missing.push(`readiness markers of Ravi ${waypoint} (the state shows ${preparedRelease ?? "none"})`);
  for (const name of [PM2_PROCESS_NAME, CHANNELS_PM2_PROCESS_NAME] as const) {
    const receipt = readLastRuntimeBootReceipt(name, stateDir);
    if (!receipt?.bundle || receipt.runningVersion !== waypoint)
      missing.push(`a boot record of ${name} from Ravi ${waypoint}`);
  }
  return { prepared: missing.length === 0, missing };
}

export async function hopThroughWaypoint(deps: WaypointHopDependencies): Promise<WaypointHopOutcome> {
  const log = deps.log ?? ((line: string) => console.error(`ravi update waypoint: ${line}`));
  const failed = (step: WaypointHopStep, message: string): WaypointHopOutcome => {
    log(`failed at ${step}: ${message}`);
    return { ok: false, step, message };
  };
  let step: WaypointHopStep = "install";
  try {
    return await hopSteps(deps, (current) => {
      step = current;
    });
  } catch (cause) {
    // A strict PM2 read, an unreadable state: whatever escapes ends as a failure of the step it happened in.
    return failed(
      step,
      `the waypoint stopped on an unexpected error (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

async function hopSteps(
  deps: WaypointHopDependencies,
  enter: (step: WaypointHopStep) => void,
): Promise<WaypointHopOutcome> {
  const { stateDir, waypoint, target } = deps;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => delay(ms));
  const log = deps.log ?? ((line: string) => console.error(`ravi update waypoint: ${line}`));
  const env = previousReleaseCliEnv(deps.env ?? process.env);
  const resolveTarget = deps.resolveTarget ?? resolveManagedRuntimeTargetFromPackageRoot;
  const preparedRelease = deps.preparedRelease ?? (() => readPreparedStateRelease(stateDir));
  const failed = (step: WaypointHopStep, message: string): WaypointHopOutcome => {
    log(`failed at ${step}: ${message}`);
    return { ok: false, step, message };
  };
  const waitFor = async (check: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (check()) return true;
      if (now() >= deadline) return false;
      const before = now();
      await wait(250);
      if (now() <= before) return check();
    }
  };
  /** The same install, at `release`; null with the reason when it did not resolve to that release. */
  const install = async (release: string): Promise<{ installed: ManagedRuntimeTarget | null; detail: string }> => {
    if (deps.method === "bun") {
      try {
        unlinkSync(join(dirname(dirname(deps.packageRoot)), "bun.lock"));
      } catch {
        // no-cause: The global lockfile may not exist; the update removes it the same way before installing.
      }
    }
    // Not the supervisor's cwd: that is the package directory these installs replace.
    const result = await deps.run(
      deps.method,
      deps.method === "bun"
        ? ["install", "-g", "--force", `ravi.bot@${release}`]
        : ["install", "-g", `ravi.bot@${release}`],
      { cwd: homedir(), env, stream: false },
    );
    const installed = resolveTarget(deps.packageRoot);
    if (result.success && installed?.version === release) return { installed, detail: "" };
    return {
      installed: null,
      detail: result.success
        ? `the install resolved to ${installed?.version ?? "no runnable bundle"}`
        : result.output.trim().split("\n").slice(-3).join(" "),
    };
  };

  // 1. The waypoint, in the same install.
  enter("install");
  log(`installing Ravi ${waypoint}, the release this state must go through before Ravi ${target.version}`);
  const waypointInstall = await install(waypoint);
  const waypointTarget = waypointInstall.installed;
  if (!waypointTarget) return failed("install", `Ravi ${waypoint} could not be installed (${waypointInstall.detail})`);

  // 2. Both processes, through the waypoint's own CLI: the target's adoption needs a boot record of each. The daemon
  // writes its boot record before it prepares the stores, so it counts only at schema phase `ready`, and the same
  // process must stay there.
  enter("start");
  const phase = deps.schemaPhase ?? ((process: ManagedDaemonProcess) => readDaemonSchemaPhase(process, stateDir));
  const phaseRecorded = compareRaviVersions(waypoint, SCHEMA_PHASE_RECEIPTS_RELEASE) >= 0;
  let readyDaemon: { pmId: number; pid: number; startedAt: number | undefined } | null = null;
  const daemonReady = (processes: Pm2Process[]) => {
    const current = processes.find((process) => process.name === PM2_PROCESS_NAME && process.status === "online");
    if (!current) return false;
    const startedAt = current.startedAt ?? undefined;
    if (
      readyDaemon &&
      (current.pm_id !== readyDaemon.pmId || current.pid !== readyDaemon.pid || startedAt !== readyDaemon.startedAt)
    )
      return false;
    if (!phaseRecorded) return true;
    return (
      phase({ name: current.name, pmId: current.pm_id, pid: current.pid, status: current.status, startedAt }) ===
      "ready"
    );
  };
  const runsWaypoint = (processes: Pm2Process[], name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME) => {
    const identity = buildManagedRuntimeIdentity(processes, waypointTarget.bundlePath, -1, { stateDir });
    const current = name === PM2_PROCESS_NAME ? identity.daemon : identity.channels;
    const running = current.online && current.identityVerified && !current.stale && current.runningVersion === waypoint;
    return running && (name !== PM2_PROCESS_NAME || daemonReady(processes));
  };
  const startTimeoutMs = deps.startTimeoutMs ?? 120_000;
  for (const [name, command] of [
    [PM2_PROCESS_NAME, "daemon"],
    [CHANNELS_PM2_PROCESS_NAME, "channels"],
  ] as const) {
    log(`starting ${name} with Ravi ${waypoint}`);
    const started = await deps.run(deps.bunPath, [waypointTarget.bundlePath, command, "start"], {
      cwd: waypointTarget.cwd,
      env,
      stream: false,
    });
    log(started.output.trim());
    if (!started.success || !(await waitFor(() => runsWaypoint(deps.getProcesses(), name), startTimeoutMs)))
      return failed(
        "start",
        `${name} did not come up running Ravi ${waypoint}${name === PM2_PROCESS_NAME ? " and ready" : ""}`,
      );
    if (name === PM2_PROCESS_NAME) {
      const daemon = deps.getProcesses().find((process) => process.name === PM2_PROCESS_NAME);
      readyDaemon = daemon ? { pmId: daemon.pm_id, pid: daemon.pid, startedAt: daemon.startedAt ?? undefined } : null;
    }
  }

  // 3. Prepared the way the target reads it, then held for the window.
  enter("prepare");
  const prepared = () => waypointPreparedState(stateDir, waypoint, preparedRelease()).prepared;
  if (!(await waitFor(prepared, deps.prepareTimeoutMs ?? 120_000))) {
    const { missing } = waypointPreparedState(stateDir, waypoint, preparedRelease());
    return failed("prepare", `Ravi ${waypoint} runs but did not prepare the state: missing ${missing.join("; ")}`);
  }
  const stable = await observeStableManagedRuntime({
    getProcesses: deps.getProcesses,
    isConverged: (processes) =>
      runsWaypoint(processes, PM2_PROCESS_NAME) && runsWaypoint(processes, CHANNELS_PM2_PROCESS_NAME),
    windowMs: deps.stabilityWindowMs ?? 30_000,
    now,
    wait,
  });
  if (!stable) return failed("prepare", `Ravi ${waypoint} did not stay up for the stability window`);

  // 4. The target again, in the same install; the waypoint keeps running from memory until the update replaces it.
  enter("reinstall-target");
  log(`Ravi ${waypoint} prepared the state; installing Ravi ${target.version} again`);
  const targetInstall = await install(target.version);
  if (!targetInstall.installed)
    return failed("reinstall-target", `Ravi ${target.version} could not be installed again (${targetInstall.detail})`);
  return { ok: true };
}
