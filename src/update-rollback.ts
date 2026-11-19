/**
 * Automatic rollback of a `ravi update` whose target did not converge.
 *
 * Package and state always move together: the state stores go back to the
 * snapshot taken before the target started (`update-snapshot.ts`), and the
 * exact release that wrote them is reinstalled and started through its own
 * CLI. What the target wrote during the attempt is kept aside, never deleted.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildManagedRuntimeIdentity,
  findRaviPackageRoot,
  managedRuntimeMatchesTarget,
  normalizeRuntimePath,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeProcessSnapshot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { CHANNELS_PM2_PROCESS_NAME, clearedPm2ContextEnv, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";
import { settleThreadFenceLeftovers } from "./threads/fence-adoption.js";
import {
  acquireStateStoreOwnership,
  restoreUpdateSnapshot,
  updateSnapshotsDir,
  type UpdateSnapshotManifest,
} from "./update-snapshot.js";

export type GlobalInstallMethod = "bun" | "npm";

export type UpdateRollbackPlan = {
  /** The release the daemon was running, proven by its boot receipt: the one that wrote the state. */
  previousRelease: string;
  method: GlobalInstallMethod;
  /** The global install the target went into; the previous release goes back to the same place. */
  packageRoot: string;
  channelsOnline: boolean;
};

/** Which global installer owns this package directory; null for a source checkout or anything else. */
export function globalInstallMethodOf(packageRoot: string): GlobalInstallMethod | null {
  const normalized = (normalizeRuntimePath(packageRoot) ?? packageRoot).toLowerCase();
  if (normalized.includes("/.bun/")) return "bun";
  if (normalized.includes("/node_modules/")) return "npm";
  return null;
}

/**
 * Whether this update can roll back on its own, decided before any stop. It
 * can when the target is a global install, the daemon that was running proved
 * its release with a boot receipt, ran from that same install, and that
 * release is not the target. Anything else keeps the update without a
 * snapshot or rollback.
 */
export function resolveUpdateRollbackPlan(input: {
  target: ManagedRuntimeTarget;
  processes: Pm2Process[];
  stateDir: string;
}): UpdateRollbackPlan | null {
  const method = globalInstallMethodOf(input.target.cwd);
  if (!method) return null;
  const identity = buildManagedRuntimeIdentity(input.processes, input.target.bundlePath, -1, {
    stateDir: input.stateDir,
  });
  const daemon = identity.daemon;
  if (!daemon.online || !daemon.identityVerified || !daemon.runningVersion) return null;
  if (daemon.runningVersion === input.target.version) return null;
  if (normalizeRuntimePath(findRaviPackageRoot(daemon.bundlePath)) !== normalizeRuntimePath(input.target.cwd))
    return null;
  return {
    previousRelease: daemon.runningVersion,
    method,
    packageRoot: input.target.cwd,
    channelsOnline: identity.channels.online,
  };
}

const SUPERVISOR_RESULT_FILE = "supervisor-result.json";
const SUPERVISOR_RESULT_PROTOCOL = "ravi.update-supervisor-result/v1";

export type UpdateSupervisorOutcome = "converged" | "rolled-back" | "rollback-failed" | "failed";

export type UpdateSupervisorResult = {
  protocol: typeof SUPERVISOR_RESULT_PROTOCOL;
  pid: number;
  at: string;
  outcome: UpdateSupervisorOutcome;
  targetRelease: string;
  previousRelease: string | null;
  snapshotId: string | null;
  /** Writes after this moment were the target's: a rollback does not keep them in the live state. */
  snapshotAt: string | null;
  restoredAt: string | null;
  /** Where the files the target wrote were moved by the rollback. */
  candidateDir: string | null;
  message: string;
  commands: string[];
  warnings: string[];
};

export function updateSupervisorResultPath(stateDir: string): string {
  return join(stateDir, "updates", SUPERVISOR_RESULT_FILE);
}

/** Left for whoever started the supervisor: an older CLI stops waiting before a rollback ends. */
export function recordUpdateSupervisorResult(
  stateDir: string,
  result: Omit<UpdateSupervisorResult, "protocol" | "pid" | "at">,
  now = new Date(),
): void {
  const path = updateSupervisorResultPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: UpdateSupervisorResult = {
    protocol: SUPERVISOR_RESULT_PROTOCOL,
    pid: process.pid,
    at: now.toISOString(),
    ...result,
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** The result a supervisor recorded at or after `sinceMs`, if any. */
export function readUpdateSupervisorResult(sinceMs: number, stateDir: string): UpdateSupervisorResult | null {
  try {
    const result = JSON.parse(readFileSync(updateSupervisorResultPath(stateDir), "utf8")) as UpdateSupervisorResult;
    const at = typeof result.at === "string" ? Date.parse(result.at) : Number.NaN;
    if (result.protocol !== SUPERVISOR_RESULT_PROTOCOL || !Number.isFinite(at) || at < sinceMs) return null;
    if (typeof result.message !== "string" || !Array.isArray(result.commands)) return null;
    return result;
  } catch {
    // no-cause: No result file (or an unreadable one) means this supervisor recorded no outcome.
    return null;
  }
}

/** Keys the supervisor carries for the target that must not reach the previous release's CLI. */
const TARGET_ONLY_ENV = new Set([
  "RAVI_BUNDLE",
  "RAVI_DAEMON_CWD",
  "RAVI_PM2_EXECUTABLE",
  "RAVI_REPO",
  "RAVI_UPDATE_SUPERVISOR_BUDGET_MS",
  "RAVI_UPDATE_STABILITY_WINDOW_MS",
]);

/** The supervisor's environment without target routing and runtime context (removed, not emptied). */
export function previousReleaseCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const context = new Set(Object.keys(clearedPm2ContextEnv()));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || TARGET_ONLY_ENV.has(key) || context.has(key)) continue;
    result[key] = value;
  }
  return result;
}

type RunResult = { success: boolean; output: string };
type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; stream?: boolean };

export type UpdateRollbackStep = "stop" | "restore" | "reinstall" | "start" | "verify";

export type UpdateRollbackOutcome =
  | { ok: true; target: ManagedRuntimeTarget; restoredAt: string; candidateDir: string }
  | {
      ok: false;
      step: UpdateRollbackStep;
      message: string;
      commands: string[];
      restoredAt: string | null;
      candidateDir: string | null;
    };

export type UpdateRollbackDependencies = {
  stateDir: string;
  plan: UpdateRollbackPlan;
  manifest: UpdateSnapshotManifest;
  /** The processes before the update: the rollback brings back the ones that were online. */
  previousProcesses: ManagedRuntimeProcessSnapshot[];
  bunPath: string;
  run: (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
  getProcesses: () => Pm2Process[];
  pidAlive: (pid: number) => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  acquireOwnership?: (stateDir: string, stores: string[], timeoutMs: number) => { release(): void };
  restore?: (input: { stateDir: string; manifest: UpdateSnapshotManifest }) => {
    candidateDir: string;
    restoredAt: string;
  };
  settleLeftovers?: (stateDir: string) => "none" | "settled" | "running";
  resolveTarget?: (packageRoot: string) => ManagedRuntimeTarget | null;
  log?: (line: string) => void;
  exitTimeoutMs?: number;
  lockTimeoutMs?: number;
  startTimeoutMs?: number;
  channelStartAttempts?: number;
};

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Stops the target, restores the snapshot under the store locks, reinstalls
 * the previous release and starts the processes that were online through that
 * release's own CLI. Every failure names the step and the manual commands for
 * the state it leaves.
 */
export async function rollBackUpdate(deps: UpdateRollbackDependencies): Promise<UpdateRollbackOutcome> {
  const { plan, manifest, stateDir } = deps;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => delay(ms));
  const log = deps.log ?? ((line: string) => console.error(`ravi update rollback: ${line}`));
  const env = previousReleaseCliEnv(deps.env ?? process.env);
  const snapshotDir = join(updateSnapshotsDir(stateDir), manifest.id);
  const install =
    plan.method === "bun"
      ? `bun install -g ravi.bot@${plan.previousRelease}`
      : `npm install -g ravi.bot@${plan.previousRelease}`;
  const startCommands = [
    "ravi daemon start",
    ...(plan.channelsOnline ? ["ravi channels start"] : []),
    "ravi daemon status",
  ];
  let restored: { candidateDir: string; restoredAt: string } | null = null;
  const failed = (step: UpdateRollbackStep, message: string, commands: string[]): UpdateRollbackOutcome => {
    log(`failed at ${step}: ${message}`);
    return {
      ok: false,
      step,
      message,
      commands,
      restoredAt: restored?.restoredAt ?? null,
      candidateDir: restored?.candidateDir ?? null,
    };
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
  const unrestored = (reason: string) =>
    `${reason} Nothing was restored: the state is still what Ravi ${manifest.targetRelease} wrote. ` +
    `The snapshot of Ravi ${plan.previousRelease}'s state is intact in ${snapshotDir} (manifest.json lists where ` +
    `each file goes back). Stop both processes, put those files back, then install Ravi ${plan.previousRelease} ` +
    "and start it. Do not start Ravi " +
    `${plan.previousRelease} on the current state.`;

  // 1. Stop the target. Only a process that is gone cannot write after the restore.
  log(`stopping Ravi ${manifest.targetRelease} to restore the state Ravi ${plan.previousRelease} wrote`);
  const pids = new Set<number>();
  for (const name of [CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME]) {
    for (const entry of deps.getProcesses().filter((process) => process.name === name)) {
      if (entry.pid > 0) pids.add(entry.pid);
      const result = await deps.run("pm2", ["delete", String(entry.pm_id)], { env, stream: false });
      if (!result.success) {
        return failed(
          "stop",
          unrestored(`PM2 could not remove ${name} (pm_id ${entry.pm_id}): ${result.output.trim()}.`),
          ["pm2 delete ravi-channels", "pm2 delete ravi"],
        );
      }
    }
  }
  if (!(await waitFor(() => [...pids].every((pid) => !deps.pidAlive(pid)), deps.exitTimeoutMs ?? 30_000))) {
    return failed("stop", unrestored("A removed process did not exit."), [
      "pm2 delete ravi-channels",
      "pm2 delete ravi",
    ]);
  }

  // 2. Restore under the store locks, then settle what an adoption the target started left behind.
  let ownership: { release(): void };
  try {
    ownership = (deps.acquireOwnership ?? acquireStateStoreOwnership)(
      stateDir,
      manifest.stores,
      deps.lockTimeoutMs ?? 30_000,
    );
  } catch (cause) {
    return failed("stop", unrestored(`A process still owns the state stores (${describe(cause)}).`), ["pm2 jlist"]);
  }
  try {
    restored = (deps.restore ?? restoreUpdateSnapshot)({ stateDir, manifest });
  } catch (cause) {
    return failed(
      "restore",
      `The snapshot could not be put back (${describe(cause)}). Do not start any release: ${snapshotDir}/restore.json ` +
        "and manifest.json say which files moved. The files the target wrote are under " +
        `${snapshotDir}/candidate.`,
      [],
    );
  } finally {
    ownership.release();
  }
  log(`state restored to the snapshot of ${manifest.createdAt}; the target's files are in ${restored.candidateDir}`);
  try {
    if ((deps.settleLeftovers ?? settleThreadFenceLeftovers)(stateDir) === "running") {
      return failed(
        "restore",
        "The state is restored, but a thread fence adoption still holds its lease, so nothing was started.",
        [install, ...startCommands],
      );
    }
  } catch (cause) {
    return failed(
      "restore",
      `The state is restored, but the leftovers of the target's thread fence adoption could not be settled (${describe(cause)}).`,
      [install, ...startCommands],
    );
  }

  // 3. The release that wrote the restored state, in the same install.
  if (plan.method === "bun") {
    try {
      unlinkSync(join(dirname(dirname(plan.packageRoot)), "bun.lock"));
    } catch {
      // no-cause: The global lockfile may not exist; the update removes it the same way before installing.
    }
  }
  log(`installing Ravi ${plan.previousRelease} with ${plan.method}`);
  const reinstall = await deps.run(
    plan.method,
    plan.method === "bun"
      ? ["install", "-g", "--force", `ravi.bot@${plan.previousRelease}`]
      : ["install", "-g", `ravi.bot@${plan.previousRelease}`],
    { env, stream: false },
  );
  const target = (deps.resolveTarget ?? resolveManagedRuntimeTargetFromPackageRoot)(plan.packageRoot);
  if (!reinstall.success || !target || target.version !== plan.previousRelease) {
    return failed(
      "reinstall",
      `The state is restored, but Ravi ${plan.previousRelease} could not be installed ` +
        `(${reinstall.success ? `the install resolved to ${target?.version ?? "no runnable bundle"}` : reinstall.output.trim().split("\n").slice(-3).join(" ")}). ` +
        "Nothing is running.",
      [install, ...startCommands],
    );
  }

  // 4. Started by that release's own CLI, with its own launcher and registration.
  const member = (name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME) => {
    const identity = buildManagedRuntimeIdentity(deps.getProcesses(), target.bundlePath, -1, { stateDir });
    const current = name === PM2_PROCESS_NAME ? identity.daemon : identity.channels;
    return (
      current.online && current.identityVerified && !current.stale && current.runningVersion === plan.previousRelease
    );
  };
  const startTimeoutMs = deps.startTimeoutMs ?? 60_000;
  log(`starting the daemon with Ravi ${plan.previousRelease}`);
  const daemonStart = await deps.run(deps.bunPath, [target.bundlePath, "daemon", "start"], {
    cwd: target.cwd,
    env,
    stream: false,
  });
  log(daemonStart.output.trim());
  if (!daemonStart.success || !(await waitFor(() => member(PM2_PROCESS_NAME), startTimeoutMs))) {
    return failed(
      "start",
      `Ravi ${plan.previousRelease} is installed and the state is restored, but its daemon did not come up running it.`,
      startCommands,
    );
  }
  if (plan.channelsOnline) {
    let started = false;
    const attempts = deps.channelStartAttempts ?? 3;
    for (let attempt = 1; attempt <= attempts && !started; attempt += 1) {
      log(`starting the channel runner with Ravi ${plan.previousRelease} (attempt ${attempt})`);
      const channelsStart = await deps.run(deps.bunPath, [target.bundlePath, "channels", "start"], {
        cwd: target.cwd,
        env,
        stream: false,
      });
      log(channelsStart.output.trim());
      started =
        channelsStart.success && (await waitFor(() => member(CHANNELS_PM2_PROCESS_NAME), startTimeoutMs / attempts));
      if (!started && attempt < attempts) await wait(5_000);
    }
    if (!started) {
      return failed(
        "start",
        `The daemon runs Ravi ${plan.previousRelease} on the restored state, but the channel runner did not come up.`,
        ["ravi channels start", "ravi channels status"],
      );
    }
  }

  // 5. Saved and checked like an update.
  const save = await deps.run("pm2", ["save", "--force"], { env, stream: false });
  if (
    !save.success ||
    !managedRuntimeMatchesTarget(deps.previousProcesses, deps.getProcesses(), target, { stateDir })
  ) {
    return failed(
      "verify",
      `Ravi ${plan.previousRelease} was started on the restored state, but ${save.success ? "its processes do not match it" : "PM2 could not save its process list"}.`,
      ["ravi daemon status", "ravi channels status", "pm2 save --force"],
    );
  }
  log(`rolled back to Ravi ${plan.previousRelease}`);
  return { ok: true, target, restoredAt: restored.restoredAt, candidateDir: restored.candidateDir };
}
