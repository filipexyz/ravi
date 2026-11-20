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
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedDaemonProcess } from "./cli/daemon-restart-supervision.js";
import { readDaemonSchemaPhase } from "./db/daemon-schema-owner.js";
import {
  buildManagedRuntimeIdentity,
  findRaviPackageRoot,
  managedRuntimeBundlePath,
  managedRuntimeMatchesTarget,
  normalizeRuntimePath,
  resolveManagedRuntimeTargetFromPackageRoot,
  type ManagedRuntimeProcessSnapshot,
  type ManagedRuntimeTarget,
} from "./managed-runtime.js";
import { CHANNELS_PM2_PROCESS_NAME, clearedPm2ContextEnv, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";
import { readRuntimeBootReceipt } from "./runtime-process-identity.js";
import { observeStableManagedRuntime } from "./runtime-stability.js";
import { compareRaviVersions } from "./update-preflight.js";
import { settleThreadFenceLeftovers } from "./threads/fence-adoption.js";
import {
  acquireStateStoreOwnership,
  readUpdateSnapshot,
  restoreUpdateSnapshot,
  UpdateSnapshotRestoreError,
  updateSnapshotManualRestoreCommands,
  updateSnapshotsDir,
  type UpdateSnapshotManifest,
} from "./update-snapshot.js";

export type GlobalInstallMethod = "bun" | "npm";

export type UpdateRollbackPlan = {
  /** The release the daemon was running: the one that wrote the state. */
  previousRelease: string;
  method: GlobalInstallMethod;
  /** The global install the target went into; the previous release goes back to the same place. */
  packageRoot: string;
  channelsOnline: boolean;
  /**
   * How `previousRelease` is known: the daemon's boot receipt, with the bundle's digest; for a daemon that writes
   * none, the version PM2 recorded when it launched it, or the operator's `--running-release`. Absent means
   * `receipt`. The rollback proves the release runs again the same way: by its receipt, or by PM2's record.
   */
  evidence?: "receipt" | "pm2" | "declared";
};

/** The first release whose processes write a boot receipt; an older one is known by PM2's record or its operator. */
export const BOOT_RECEIPTS_RELEASE = "3.261104.2";

/** A Ravi release number, such as 3.261101.3. */
export function isRaviRelease(value: string): boolean {
  return /^\d+\.\d{6}\.\d+$/.test(value);
}

/** `askOperator`: the operator's `--running-release` can settle what stopped the plan. */
export type UnreceiptedRelease = { plan: UpdateRollbackPlan } | { reason: string; askOperator: boolean };

/**
 * The release of an online daemon that wrote no boot receipt (a release before 3.261104.2), so the update can take
 * the waypoint with a rollback to it. Null when this does not apply: no global install, no daemon online, or a daemon
 * with a receipt, which decides by itself (`resolveUpdateRollbackPlan`).
 *
 * Weaker evidence than a receipt, which carries the bundle's digest: PM2 reads `pm2_env.version` from the
 * package.json nearest the script it launches, each time it launches it. That counts only when the script is inside
 * this install's package (not a launcher or another install), and only as a release that writes no receipt: a later
 * one would have written one, so PM2 and the state would disagree. The operator's `--running-release` stands in when
 * PM2's record is not usable, and must agree with it when it is. Whatever fails gives the reason, and the update
 * refuses: it never guesses.
 */
export function resolveUnreceiptedRollbackPlan(input: {
  target: ManagedRuntimeTarget;
  processes: Pm2Process[];
  stateDir: string;
  declaredRelease?: string | null;
}): UnreceiptedRelease | null {
  const method = globalInstallMethodOf(input.target.cwd);
  const daemon = input.processes.find((process) => process.name === PM2_PROCESS_NAME);
  // An online registration with no process (PM2 keeps one when a launcher fails) is no running release at all.
  const running = daemon?.status === "online" && Number.isInteger(daemon.pid) && daemon.pid > 0;
  if (!method || !daemon || !running || readRuntimeBootReceipt(daemon, input.stateDir)) return null;
  const channelsOnline = input.processes.some(
    (process) => process.name === CHANNELS_PM2_PROCESS_NAME && process.status === "online",
  );
  const plan = (previousRelease: string, evidence: "pm2" | "declared"): UnreceiptedRelease => ({
    plan: { previousRelease, method, packageRoot: input.target.cwd, channelsOnline, evidence },
  });
  const writesReceipts = (release: string) => compareRaviVersions(release, BOOT_RECEIPTS_RELEASE) >= 0;

  // PM2's record, when it is the daemon's: launched from a script of this install's package.
  const recorded = daemon.version && daemon.version !== "N/A" ? daemon.version : null;
  const pm2Problem = !insidePackage(daemon.execPath, input.target.cwd)
    ? "PM2 launches the daemon from a script outside this install's package (a launcher, or another install), so " +
      "the version it recorded is not the daemon's release"
    : !recorded
      ? "PM2 recorded no version for the daemon"
      : !isRaviRelease(recorded)
        ? `PM2 recorded ${recorded} for the daemon, which is not a Ravi release`
        : null;
  const pm2Release = pm2Problem ? null : recorded;

  const declared = input.declaredRelease;
  if (declared) {
    if (!isRaviRelease(declared))
      return { reason: `--running-release ${declared} is not a Ravi release`, askOperator: false };
    if (writesReceipts(declared))
      return {
        reason: `--running-release says Ravi ${declared}, a release that writes a boot record`,
        askOperator: false,
      };
    if (pm2Release && pm2Release !== declared)
      return {
        reason: `PM2 recorded Ravi ${pm2Release} for the daemon, not the ${declared} given with --running-release`,
        askOperator: false,
      };
    return plan(declared, "declared");
  }
  if (!pm2Release) return { reason: pm2Problem ?? "PM2 recorded no version for the daemon", askOperator: true };
  if (writesReceipts(pm2Release))
    return {
      reason: `PM2 recorded Ravi ${pm2Release} for the daemon, a release that writes a boot record`,
      askOperator: false,
    };
  return plan(pm2Release, "pm2");
}

function insidePackage(path: string | null | undefined, packageRoot: string): boolean {
  return Boolean(path) && normalizeRuntimePath(findRaviPackageRoot(path!)) === normalizeRuntimePath(packageRoot);
}

/**
 * Whether PM2 runs `release` from this install, for a release that writes no receipt: online, launched from a script
 * of the install's package and, for the daemon, with that version recorded. The runner may run through bun (its
 * bundle is then the first argument), and PM2 records bun's version for it instead.
 */
function pm2RunsRelease(
  processes: Pm2Process[],
  name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME,
  target: ManagedRuntimeTarget,
  release: string,
): boolean {
  const current = processes.find((process) => process.name === name);
  // PM2 keeps an online registration with PID 0 when a launcher fails: that runs nothing.
  if (!current || current.status !== "online" || !Number.isInteger(current.pid) || current.pid <= 0) return false;
  if (name === CHANNELS_PM2_PROCESS_NAME)
    return insidePackage(current.execPath, target.cwd) || insidePackage(current.args?.[0], target.cwd);
  return insidePackage(current.execPath, target.cwd) && current.version === release;
}

/** `managedRuntimeMatchesTarget` for a release that writes no receipt, from what PM2 records. */
function pm2MatchesRelease(
  previousProcesses: ManagedRuntimeProcessSnapshot[],
  processes: Pm2Process[],
  target: ManagedRuntimeTarget,
  release: string,
): boolean {
  for (const name of [PM2_PROCESS_NAME, CHANNELS_PM2_PROCESS_NAME] as const) {
    const previous = previousProcesses.find((process) => process.name === name);
    if (!previous) continue;
    if (previous.status !== "online") {
      if (processes.some((process) => process.name === name)) return false;
      continue;
    }
    if (!pm2RunsRelease(processes, name, target, release)) return false;
  }
  return true;
}

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
    evidence: "receipt",
  };
}

export const UPDATE_ROLLBACK_UNAVAILABLE = "UPDATE_ROLLBACK_UNAVAILABLE";

export const UPDATE_PREVIOUS_RELEASE_UNAVAILABLE = "UPDATE_PREVIOUS_RELEASE_UNAVAILABLE";

/** Whether the npm registry answers for `ravi.bot@<release>`: a rollback installs it again. */
export type ReleaseAvailability = { ok: true } | { ok: false; reason: string; cause?: unknown };

/**
 * A probe before any stop: the release a rollback would install again must be in the registry now. Found out after
 * the stop (a release that does not exist, a typo in `--running-release`), the host stays down; on a host with no
 * shell access nobody can fix that by hand.
 */
export async function releaseInRegistry(
  release: string,
  fetchRelease: typeof fetch = fetch,
): Promise<ReleaseAvailability> {
  let response: Response;
  try {
    response = await fetchRelease(`https://registry.npmjs.org/ravi.bot/${encodeURIComponent(release)}`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    return registryUnanswered(release, cause);
  }
  if (response.status === 404) return { ok: false, reason: `ravi.bot@${release} is not in the npm registry` };
  if (!response.ok)
    return { ok: false, reason: `the npm registry answered ${response.status} for ravi.bot@${release}` };
  return { ok: true };
}

/** A registry that does not answer is a reason to refuse too; the error stays with it as the cause. */
function registryUnanswered(release: string, cause: unknown): ReleaseAvailability {
  return { ok: false, reason: `the npm registry did not answer for ravi.bot@${release} (${describe(cause)})`, cause };
}

/** The update would have no way back: the release it rolls back to cannot be installed now. Nothing was stopped. */
export class UpdatePreviousReleaseUnavailableError extends Error {
  readonly code = UPDATE_PREVIOUS_RELEASE_UNAVAILABLE;
  constructor(
    input: { reason: string; previousRelease: string; targetVersion: string; declared: boolean },
    options?: ErrorOptions,
  ) {
    super(
      `${UPDATE_PREVIOUS_RELEASE_UNAVAILABLE}: ${input.reason}, and this update goes back to Ravi ` +
        `${input.previousRelease} only by installing it again. Nothing was stopped: Ravi ${input.previousRelease} keeps ` +
        `serving, but the installed package is already Ravi ${input.targetVersion}. ` +
        (input.declared
          ? "That release came from --running-release: check it and run the same `ravi update` again."
          : "Run the same `ravi update` again once the registry has it; `ravi daemon status` shows what runs meanwhile."),
      options,
    );
    this.name = "UpdatePreviousReleaseUnavailableError";
  }
}

/** `ravi update --rollback` cannot go back from here; nothing was stopped. */
export class UpdateRollbackUnavailableError extends Error {
  readonly code = UPDATE_ROLLBACK_UNAVAILABLE;
  constructor(reason: string, options?: ErrorOptions) {
    super(
      `${UPDATE_ROLLBACK_UNAVAILABLE}: ${reason}${reason.endsWith("\n") ? "" : " "}This run stopped nothing.`,
      options,
    );
    this.name = "UpdateRollbackUnavailableError";
  }
}

const SNAPSHOT_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/** The newest snapshot with a readable manifest, or null. */
export function latestUpdateSnapshot(stateDir: string): UpdateSnapshotManifest | null {
  let ids: string[];
  try {
    ids = readdirSync(updateSnapshotsDir(stateDir));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  for (const id of ids
    .filter((entry) => SNAPSHOT_ID.test(entry))
    .sort()
    .reverse()) {
    try {
      return readUpdateSnapshot(stateDir, id);
    } catch {
      // no-cause: A snapshot without a readable manifest is incomplete; the next older one is checked.
    }
  }
  return null;
}

export type OperatorRollbackPlan = {
  manifest: UpdateSnapshotManifest;
  plan: UpdateRollbackPlan;
  /** The release the daemon runs now: the last update's target. */
  runningRelease: string;
  /** What runs now; the rollback brings back the processes that are online. */
  previousProcesses: ManagedRuntimeProcessSnapshot[];
};

/**
 * `ravi update --rollback`: back to the release before the last update, with its state as of that update's snapshot.
 * Only from the release that update installed (its target, proven by the daemon's boot receipt), from a global
 * install, with a snapshot that was not restored yet. It reads the state and PM2 and writes nothing, except that a
 * run that executes (`keepCommands`) and finds a rollback cut short keeps the commands that finish it in
 * `finish-by-hand.txt` next to the snapshot. The preview writes nothing.
 */
export function planOperatorRollback(input: {
  stateDir: string;
  processes: Pm2Process[];
  /** How this Ravi was installed, for the commands when nothing runs (the daemon's install is unknown then). */
  installMethod?: GlobalInstallMethod | null;
  /** Keep the commands of a rollback cut short in `finish-by-hand.txt` (an executing run; never the preview). */
  keepCommands?: boolean;
}): OperatorRollbackPlan {
  const manifest = latestUpdateSnapshot(input.stateDir);
  if (!manifest)
    throw new UpdateRollbackUnavailableError(
      "there is no update snapshot to go back to; only an update that could roll back keeps one.",
    );
  // Nothing under PM2 next to an unused snapshot: a rollback (or an update) stopped both processes and was cut.
  if (
    !input.processes.some((process) => process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME)
  )
    throw new UpdateRollbackUnavailableError(
      cutShort(input.stateDir, manifest, input.installMethod ?? null, input.keepCommands === true),
    );
  if (existsSync(join(updateSnapshotsDir(input.stateDir), manifest.id, "restore.json")))
    throw new UpdateRollbackUnavailableError(
      `the snapshot of ${manifest.createdAt} was already restored, or a restore of it was cut short (see its ` +
        "restore.json).",
    );
  const bundlePath = managedRuntimeBundlePath(input.processes.find((process) => process.name === PM2_PROCESS_NAME));
  const packageRoot = findRaviPackageRoot(bundlePath);
  const method = packageRoot ? globalInstallMethodOf(packageRoot) : null;
  if (!bundlePath || !packageRoot || !method)
    throw new UpdateRollbackUnavailableError(
      "the daemon does not run from a global install of Ravi (bun or npm); a source checkout is switched by hand.",
    );
  const identity = buildManagedRuntimeIdentity(input.processes, bundlePath, -1, { stateDir: input.stateDir });
  const running = identity.daemon.online && identity.daemon.identityVerified ? identity.daemon.runningVersion : null;
  if (running !== manifest.targetRelease)
    throw new UpdateRollbackUnavailableError(
      `the last snapshot belongs to the update from Ravi ${manifest.previousRelease} to Ravi ` +
        `${manifest.targetRelease}, and the daemon runs ${running ? `Ravi ${running}` : "no verified release"}.`,
    );
  return {
    manifest,
    runningRelease: running,
    plan: {
      previousRelease: manifest.previousRelease,
      method,
      packageRoot,
      channelsOnline: identity.channels.online,
    },
    previousProcesses: input.processes
      .filter((process) => process.name === PM2_PROCESS_NAME || process.name === CHANNELS_PM2_PROCESS_NAME)
      .map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null })),
  };
}

/** What to tell when neither process runs: the state may be the target's, half restored, or restored. */
function cutShort(
  stateDir: string,
  manifest: UpdateSnapshotManifest,
  method: GlobalInstallMethod | null,
  keep: boolean,
): string {
  const directory = join(updateSnapshotsDir(stateDir), manifest.id);
  const install = method
    ? `${method} install -g ravi.bot@${manifest.previousRelease}`
    : `bun install -g ravi.bot@${manifest.previousRelease} (npm install -g for an npm install)`;
  const start = [install, "ravi daemon start", "ravi channels start", "ravi daemon status"];
  const restored = existsSync(join(directory, "restore.json"));
  const commands = restored ? start : [...updateSnapshotManualRestoreCommands(stateDir, manifest), ...start];
  // One command per line, and, by a run that executes, kept next to the snapshot: a message line past 2048
  // characters reaches the operator as "[redacted:oversize]", and a long message is cut.
  const file = join(directory, "finish-by-hand.txt");
  let kept = false;
  if (keep) {
    try {
      writeFileSync(file, `${commands.join("\n")}\n`, { mode: 0o600 });
      kept = true;
    } catch {
      // no-cause: The same commands follow in the message; the file is only their durable copy.
    }
  }
  const head = restored
    ? `Ravi is not running under PM2, and a restore of the snapshot of ${manifest.createdAt} ran: a rollback ` +
      `stopped after it. ${directory}/restore.json lists every move and whether it was done; once all are done, ` +
      `bring Ravi ${manifest.previousRelease} back`
    : `Ravi is not running under PM2, and the snapshot of ${manifest.createdAt} (Ravi ${manifest.previousRelease}'s ` +
      `state, before the update to Ravi ${manifest.targetRelease}) was not restored: a rollback may have stopped ` +
      "both processes and been cut. To go back by hand, with nothing started meanwhile";
  return `${head}, run in order${kept ? ` (the commands are also in ${file})` : ""}:\n${commands.join("\n")}\n`;
}

export type OperatorRollbackSupervisorDependencies = {
  stateDir: string;
  /** The snapshot the operator's preview named: under the lock, the plan must still be about it. */
  snapshotId: string;
  getProcesses: () => Pm2Process[];
  run: UpdateRollbackDependencies["run"];
  bunPath: string;
  pidAlive: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
  stabilityWindowMs?: number;
  installMethod?: GlobalInstallMethod | null;
  rollBack?: typeof rollBackUpdate;
  recordResult?: typeof recordUpdateSupervisorResult;
  /** `releaseInRegistry` (tests). */
  releaseAvailable?: (release: string) => Promise<ReleaseAvailability>;
};

/** A result that cannot be written (a full disk) does not undo the rollback that ran: say so, and go on. */
function warnUnrecorded(cause: unknown): void {
  console.error(`ravi update --rollback: could not record the supervisor result: ${describe(cause)}`);
}

/**
 * `ravi update --rollback --execute`, in the update supervisor: a detached process that holds the update lock and
 * outlives the CLI, so a closed terminal or a Ctrl-C after the first stop cuts nothing. The plan is made again under
 * the lock (the operator previewed it without one) and must be about the snapshot the preview named. The outcome goes
 * to `supervisor-result.json`, where the CLI, or the operator after a cut, reads it.
 */
export async function superviseOperatorRollback(deps: OperatorRollbackSupervisorDependencies): Promise<boolean> {
  const { stateDir } = deps;
  const { manifest, plan, previousProcesses, runningRelease } = planOperatorRollback({
    stateDir,
    keepCommands: true,
    processes: deps.getProcesses(),
    installMethod: deps.installMethod ?? null,
  });
  if (manifest.id !== deps.snapshotId)
    throw new UpdateRollbackUnavailableError(
      `the last snapshot is now ${manifest.id} (${manifest.createdAt}), not the ${deps.snapshotId} the preview ` +
        "named; preview again.",
    );
  // The same probe as an update's, before any stop: the rollback installs that release again.
  const available = await (deps.releaseAvailable ?? releaseInRegistry)(plan.previousRelease);
  if (!available.ok)
    throw new UpdateRollbackUnavailableError(
      `${available.reason}, and the rollback installs Ravi ${plan.previousRelease} again, so it cannot run now.`,
      { cause: available.cause },
    );
  let outcome: UpdateRollbackOutcome;
  try {
    outcome = await (deps.rollBack ?? rollBackUpdate)({
      stateDir,
      plan,
      manifest,
      previousProcesses,
      bunPath: deps.bunPath,
      run: deps.run,
      getProcesses: deps.getProcesses,
      pidAlive: deps.pidAlive,
      env: deps.env,
      stabilityWindowMs: deps.stabilityWindowMs,
    });
  } catch (cause) {
    outcome = {
      ok: false,
      step: "unknown",
      message: `the rollback threw (${describe(cause)}); ${join(updateSnapshotsDir(stateDir), manifest.id, "restore.json")} says what was restored.`,
      commands: ["ravi daemon status", "pm2 jlist"],
      restoredAt: null,
      candidateDir: null,
    };
  }
  try {
    (deps.recordResult ?? recordUpdateSupervisorResult)(stateDir, {
      outcome: outcome.ok ? "rolled-back" : "rollback-failed",
      targetRelease: runningRelease,
      previousRelease: plan.previousRelease,
      snapshotId: manifest.id,
      snapshotAt: manifest.createdAt,
      restoredAt: outcome.restoredAt,
      candidateDir: outcome.candidateDir,
      message: outcome.ok
        ? `Ravi ${plan.previousRelease} runs again on its state as of ${manifest.createdAt}. What Ravi ` +
          `${runningRelease} wrote since then is kept in ${outcome.candidateDir}.`
        : `ravi update --rollback stopped at ${outcome.step}: ${outcome.message}`,
      commands: outcome.ok ? [] : outcome.commands,
      warnings: [],
    });
  } catch (cause) {
    warnUnrecorded(cause);
  }
  return outcome.ok;
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

/** `unknown`: the rollback itself threw, outside any step it tracks. */
export type UpdateRollbackStep = "stop" | "restore" | "reinstall" | "start" | "verify" | "unknown";

export type UpdateRollbackOutcome =
  /** `restoredAt`/`candidateDir` are null when there was no snapshot to restore (`manifest: null`). */
  | { ok: true; target: ManagedRuntimeTarget; restoredAt: string | null; candidateDir: string | null }
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
  /**
   * The snapshot to put back. Null when the update stopped both processes but took no snapshot: the state is the
   * previous release's own, untouched, so nothing is restored and that release only comes back on it.
   */
  manifest: UpdateSnapshotManifest | null;
  /** Processes the update already stopped: nothing starts until they have exited. */
  stoppedPids?: number[];
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
  /** Schema phase of a daemon (`readDaemonSchemaPhase`): only a daemon that reached `ready` counts as up. */
  schemaPhase?: (process: ManagedDaemonProcess) => "waiting" | "owned" | "ready" | null;
  /** How long the restored release must stay up before the rollback counts, as the update's window (30 s). */
  stabilityWindowMs?: number;
};

const DEFAULT_ROLLBACK_STABILITY_WINDOW_MS = 30_000;
/**
 * The first release whose daemon records its schema phase (`runtime-processes/schema-owner-<pid>.json`, #817).
 * An older release writes no phase: its boot receipt and the stability window are the proof it is up.
 */
export const SCHEMA_PHASE_RECEIPTS_RELEASE = "3.261109.1";

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
  const phase = deps.schemaPhase ?? ((process: ManagedDaemonProcess) => readDaemonSchemaPhase(process, stateDir));
  const snapshotDir = manifest ? join(updateSnapshotsDir(stateDir), manifest.id) : null;
  const onState = manifest ? "the restored state" : "its untouched state";
  const stateIs = manifest ? "The state is restored" : "The state is untouched";
  const install =
    plan.method === "bun"
      ? `bun install -g ravi.bot@${plan.previousRelease}`
      : `npm install -g ravi.bot@${plan.previousRelease}`;
  const startCommands = [
    "ravi daemon start",
    ...(plan.channelsOnline ? ["ravi channels start"] : []),
    "ravi daemon status",
  ];
  // Every live file of each store goes aside (WAL and shared memory included) before a snapshot file comes back.
  const manualRestore = () =>
    manifest
      ? [
          "pm2 delete ravi-channels",
          "pm2 delete ravi",
          ...updateSnapshotManualRestoreCommands(stateDir, manifest),
          install,
          ...startCommands,
        ]
      : // Nothing to restore: only what PM2 still lists goes, before that release comes back.
        ["pm2 delete ravi-channels", "pm2 delete ravi", install, ...startCommands];
  let restored: { candidateDir: string; restoredAt: string } | null = null;
  let step: UpdateRollbackStep = "stop";
  const failed = (failedStep: UpdateRollbackStep, message: string, commands: string[]): UpdateRollbackOutcome => {
    log(`failed at ${failedStep}: ${message}`);
    return {
      ok: false,
      step: failedStep,
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
    manifest
      ? unrestoredSnapshot(reason, manifest)
      : `${reason} The state is untouched: no snapshot was taken and nothing ran on it after Ravi ` +
        `${plan.previousRelease}. Once every stopped process has exited` +
        `${deps.stoppedPids?.length ? ` (\`ps -p ${deps.stoppedPids.join(",")}\` lists none)` : ""}, remove what PM2 ` +
        `still lists, then install and start Ravi ${plan.previousRelease}: nothing may start beside a live one.`;
  const unrestoredSnapshot = (reason: string, manifest: UpdateSnapshotManifest) =>
    `${reason} Nothing was restored: the state is still what Ravi ${manifest.targetRelease} wrote. ` +
    `The snapshot of Ravi ${plan.previousRelease}'s state is intact in ${snapshotDir}. The commands stop both ` +
    "processes, move every live file of each store aside (its WAL and shared memory too, so none is left next " +
    `to a restored database), put the snapshot files back, then install and start Ravi ${plan.previousRelease}. ` +
    `Do not start Ravi ${plan.previousRelease} on the current state.`;

  try {
    return await rollBackSteps();
  } catch (cause) {
    // Whatever escapes a step still ends as a recorded failure that names the step and the commands.
    let commands: string[];
    try {
      commands =
        step === "stop"
          ? manualRestore()
          : step === "restore"
            ? cause instanceof UpdateSnapshotRestoreError
              ? [...cause.commands, install, ...startCommands]
              : []
            : step === "reinstall"
              ? [install, ...startCommands]
              : step === "start"
                ? startCommands
                : ["ravi daemon status", "ravi channels status", "pm2 save --force"];
    } catch {
      // no-cause: The failure below already carries the cause; these commands only need to be safe to print.
      commands = ["ravi daemon status", "pm2 jlist"];
    }
    return failed(
      step,
      `The rollback stopped at ${step} on an unexpected error (${describe(cause)}). ` +
        (restored && manifest
          ? `The state is restored to the snapshot of ${manifest.createdAt}.`
          : manifest
            ? `The state may still be what Ravi ${manifest.targetRelease} wrote; the snapshot is in ${snapshotDir}.`
            : `The state is untouched; once every stopped process has exited` +
              `${deps.stoppedPids?.length ? ` (\`ps -p ${deps.stoppedPids.join(",")}\` lists none)` : ""}, remove ` +
              `what PM2 still lists, then install and start Ravi ${plan.previousRelease}.`),
      commands,
    );
  }

  async function restoreSnapshot(manifest: UpdateSnapshotManifest): Promise<UpdateRollbackOutcome | null> {
    let ownership: { release(): void };
    try {
      ownership = (deps.acquireOwnership ?? acquireStateStoreOwnership)(
        stateDir,
        manifest.stores,
        deps.lockTimeoutMs ?? 30_000,
      );
    } catch (cause) {
      return failed("stop", unrestored(`A process still owns the state stores (${describe(cause)}).`), manualRestore());
    }
    step = "restore";
    try {
      restored = (deps.restore ?? restoreUpdateSnapshot)({ stateDir, manifest });
    } catch (cause) {
      // A restore that stopped knows what it moved: its commands finish it, then the previous release comes back.
      return failed(
        "restore",
        `The snapshot could not be put back (${describe(cause)}). Do not start any release before the restore is ` +
          `finished: ${snapshotDir}/restore.json lists every move and whether it was done, and the commands finish ` +
          `it, then install and start Ravi ${plan.previousRelease}.`,
        cause instanceof UpdateSnapshotRestoreError ? [...cause.commands, install, ...startCommands] : [],
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
    return null;
  }

  async function rollBackSteps(): Promise<UpdateRollbackOutcome> {
    // 1. Stop the target. Only a process that is gone cannot write after the restore.
    log(
      manifest
        ? `stopping Ravi ${manifest.targetRelease} to restore the state Ravi ${plan.previousRelease} wrote`
        : `bringing Ravi ${plan.previousRelease} back on its untouched state`,
    );
    const pids = new Set<number>((deps.stoppedPids ?? []).filter((pid) => pid > 0));
    for (const name of [CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME]) {
      for (const entry of deps.getProcesses().filter((process) => process.name === name)) {
        if (entry.pid > 0) pids.add(entry.pid);
        const result = await deps.run("pm2", ["delete", String(entry.pm_id)], { env, stream: false });
        if (!result.success) {
          return failed(
            "stop",
            unrestored(`PM2 could not remove ${name} (pm_id ${entry.pm_id}): ${result.output.trim()}.`),
            manualRestore(),
          );
        }
      }
    }
    if (!(await waitFor(() => [...pids].every((pid) => !deps.pidAlive(pid)), deps.exitTimeoutMs ?? 30_000))) {
      return failed("stop", unrestored("A removed process did not exit."), manualRestore());
    }

    // 2. Restore under the store locks, then settle what an adoption the target started left behind. Without a
    // snapshot the state is untouched: nothing ran on it after the previous release.
    if (manifest) {
      const failure = await restoreSnapshot(manifest);
      if (failure) return failure;
    }

    // 3. The release that wrote the state, in the same install.
    step = "reinstall";
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
      // Not the supervisor's cwd: that is the package directory this install replaces.
      { cwd: homedir(), env, stream: false },
    );
    const target = (deps.resolveTarget ?? resolveManagedRuntimeTargetFromPackageRoot)(plan.packageRoot);
    if (!reinstall.success || !target || target.version !== plan.previousRelease) {
      return failed(
        "reinstall",
        `${stateIs}, but Ravi ${plan.previousRelease} could not be installed ` +
          `(${reinstall.success ? `the install resolved to ${target?.version ?? "no runnable bundle"}` : reinstall.output.trim().split("\n").slice(-3).join(" ")}). ` +
          "Nothing is running.",
        [install, ...startCommands],
      );
    }

    // 4. Started by that release's own CLI, with its own launcher and registration.
    step = "start";
    // A release known by PM2's record or by its operator writes no receipt: PM2's record proves it runs again.
    const receipted = (plan.evidence ?? "receipt") === "receipt";
    const matches = (processes: Pm2Process[]) =>
      receipted
        ? managedRuntimeMatchesTarget(deps.previousProcesses, processes, target, { stateDir })
        : pm2MatchesRelease(deps.previousProcesses, processes, target, plan.previousRelease);
    const member = (name: typeof PM2_PROCESS_NAME | typeof CHANNELS_PM2_PROCESS_NAME) => {
      if (!receipted) return pm2RunsRelease(deps.getProcesses(), name, target, plan.previousRelease);
      const identity = buildManagedRuntimeIdentity(deps.getProcesses(), target.bundlePath, -1, { stateDir });
      const current = name === PM2_PROCESS_NAME ? identity.daemon : identity.channels;
      return (
        current.online && current.identityVerified && !current.stale && current.runningVersion === plan.previousRelease
      );
    };
    // Like the update: the daemon counts once it reached `ready` (its boot receipt is written before that), and the
    // same process must stay ready for the window. A release older than the schema phase records has no `ready` to
    // read; there the receipt and the window decide.
    const phaseRecorded = compareRaviVersions(plan.previousRelease, SCHEMA_PHASE_RECEIPTS_RELEASE) >= 0;
    let readyDaemon: ManagedDaemonProcess | null = null;
    const asManaged = (process: Pm2Process): ManagedDaemonProcess => ({
      name: process.name,
      pmId: process.pm_id,
      pid: process.pid,
      status: process.status,
      startedAt: process.startedAt ?? undefined,
    });
    const daemonReady = (processes: Pm2Process[]): boolean => {
      const current = processes.find((process) => process.name === PM2_PROCESS_NAME && process.status === "online");
      if (!current) return false;
      const managed = asManaged(current);
      if (
        readyDaemon &&
        (managed.pmId !== readyDaemon.pmId ||
          managed.pid !== readyDaemon.pid ||
          managed.startedAt !== readyDaemon.startedAt)
      )
        return false;
      return !phaseRecorded || phase(managed) === "ready";
    };
    const startTimeoutMs = deps.startTimeoutMs ?? 60_000;
    log(`starting the daemon with Ravi ${plan.previousRelease}`);
    const daemonStart = await deps.run(deps.bunPath, [target.bundlePath, "daemon", "start"], {
      cwd: target.cwd,
      env,
      stream: false,
    });
    log(daemonStart.output.trim());
    if (
      !daemonStart.success ||
      !(await waitFor(() => member(PM2_PROCESS_NAME) && daemonReady(deps.getProcesses()), startTimeoutMs))
    ) {
      return failed(
        "start",
        `Ravi ${plan.previousRelease} is installed and ${stateIs.toLowerCase()}, but its daemon did not come up ` +
          "running it and ready on that state.",
        [...startCommands, "pm2 logs ravi --lines 200 --nostream"],
      );
    }
    const daemonNow = deps.getProcesses().find((process) => process.name === PM2_PROCESS_NAME);
    readyDaemon = daemonNow ? asManaged(daemonNow) : null;
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
          `The daemon runs Ravi ${plan.previousRelease} on ${onState}, but the channel runner did not come up.`,
          ["ravi channels start", "ravi channels status"],
        );
      }
    }

    // 5. Saved and checked like an update, then held for the stability window.
    step = "verify";
    const save = await deps.run("pm2", ["save", "--force"], { env, stream: false });
    if (!save.success || !matches(deps.getProcesses())) {
      return failed(
        "verify",
        `Ravi ${plan.previousRelease} was started on ${onState}, but ${save.success ? "its processes do not match it" : "PM2 could not save its process list"}.`,
        ["ravi daemon status", "ravi channels status", "pm2 save --force"],
      );
    }
    const converged = (processes: Pm2Process[]) => daemonReady(processes) && matches(processes);
    const stable = await observeStableManagedRuntime({
      getProcesses: deps.getProcesses,
      isConverged: converged,
      windowMs: deps.stabilityWindowMs ?? DEFAULT_ROLLBACK_STABILITY_WINDOW_MS,
      now,
      wait,
    });
    if (!stable) {
      return failed(
        "verify",
        `Ravi ${plan.previousRelease} came up on ${onState}, but did not stay up for the stability window ` +
          "(a process restarted, or the daemon left ready).",
        ["ravi daemon status", "ravi channels status", "pm2 logs ravi --lines 200 --nostream"],
      );
    }
    log(`rolled back to Ravi ${plan.previousRelease}`);
    return {
      ok: true,
      target,
      restoredAt: restored?.restoredAt ?? null,
      candidateDir: restored?.candidateDir ?? null,
    };
  }
}
