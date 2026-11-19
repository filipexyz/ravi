import packageInfo from "../../package.json" with { type: "json" };
import { isStateNotReadyError } from "../db/state-readiness.js";
import { findRaviPackageRoot, readRaviVersion } from "../managed-runtime.js";

/**
 * Consecutive `STATE_SCHEMA_NOT_READY` refusals tolerated before a runner
 * concludes it is not just waiting for its daemon to finish preparing state.
 * At the 30 s reconcile interval the relaunch comes within about 90 s of the
 * daemon moving to the new release.
 */
export const RUNNER_RELEASE_REFUSAL_THRESHOLD = 3;

/** Exit status of a runner that left because its release no longer matches the prepared state. */
export const RUNNER_RELEASE_DRIFT_EXIT_CODE = 75;

/** A drain that does not finish must not keep a refused runner alive. */
export const RUNNER_RELEASE_DRIFT_FORCE_EXIT_MS = 20_000;

export interface RunnerReleaseRelaunch {
  runningVersion: string;
  installedVersion: string;
  refusals: number;
}

export interface RunnerReleaseGuardOptions {
  /** Release baked into the running bundle. Defaults to this bundle's package version. */
  runningVersion?: string;
  /** Release of the bundle currently installed on disk, or null when unknown. */
  readInstalledVersion?: () => string | null;
  threshold?: number;
  /** Called at most once, when restarting onto the installed release is the way out. */
  onRelaunch?: (relaunch: RunnerReleaseRelaunch) => void;
}

/** Version of the bundle this process was started from, as it is now on disk. */
export function readInstalledRunnerVersion(bundlePath: string | undefined = process.argv[1]): string | null {
  return readRaviVersion(findRaviPackageRoot(bundlePath));
}

/**
 * State is prepared for one exact release (`state_schema_versions`). When the
 * installed daemon moves to a newer release, a runner still executing the
 * previous bundle is refused by that guard on every call that re-checks it,
 * while its sockets stay up and PM2 keeps calling it online. Restarting is the
 * only way out, and it is safe only when the installed bundle really is a
 * different release: then the relaunched process matches the prepared state.
 *
 * The guard therefore relaunches on one condition: repeated state refusals
 * while the installed release differs from the running one. Staleness alone
 * never restarts a runner (restart stays an operator decision), and a refusal
 * with matching releases (daemon not prepared yet) is reported, not acted on,
 * because a restart could not help. After one relaunch the releases match, so
 * it cannot loop.
 */
export class RunnerReleaseGuard {
  private refusals = 0;
  private relaunched = false;

  constructor(private readonly options: RunnerReleaseGuardOptions = {}) {}

  /** A reconciliation passed the state guard: whatever refused it is over. */
  recordSuccess(): void {
    this.refusals = 0;
  }

  /** A reconciliation failed. Only a state refusal counts toward a relaunch. */
  recordFailure(error: unknown): RunnerReleaseRelaunch | null {
    if (!isStateNotReadyError(error)) return null;
    this.refusals += 1;
    if (this.relaunched || this.refusals < (this.options.threshold ?? RUNNER_RELEASE_REFUSAL_THRESHOLD)) return null;

    const runningVersion = this.options.runningVersion ?? packageInfo.version;
    const installedVersion = (this.options.readInstalledVersion ?? readInstalledRunnerVersion)();
    if (!installedVersion || installedVersion === runningVersion) return null;

    this.relaunched = true;
    const relaunch = { runningVersion, installedVersion, refusals: this.refusals };
    this.options.onRelaunch?.(relaunch);
    return relaunch;
  }
}

export interface RelaunchExitOptions {
  /** Stops every component (the runner's `stop`). It rejects when the drain cannot be proven. */
  stop: () => Promise<void>;
  exit: (code: number) => void;
  /** The drain failed or was not proven; the exit still happens. */
  onDrainFailure?: (error: unknown) => void;
  forceAfterMs?: number;
  /** Replaced in tests; the real timer is unref'd so it never keeps a process alive by itself. */
  setTimer?: (callback: () => void, ms: number) => { unref(): unknown };
}

/**
 * Leaves the process so its supervisor starts the installed bundle. A relaunch must
 * not depend on the drain: PM2 only restarts a process that exits, and the refusals
 * that caused it make the drain proof reject by design (`WORK_DRAIN_UNPROVEN`), even
 * though `stop` has already stopped every component by then. The exit is therefore
 * unconditional, with a forced one after a bounded wait for a drain that never ends.
 */
export async function drainAndExitForRelaunch(options: RelaunchExitOptions): Promise<void> {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  setTimer(
    () => options.exit(RUNNER_RELEASE_DRIFT_EXIT_CODE),
    options.forceAfterMs ?? RUNNER_RELEASE_DRIFT_FORCE_EXIT_MS,
  ).unref();
  try {
    await options.stop();
  } catch (error) {
    options.onDrainFailure?.(error);
  }
  options.exit(RUNNER_RELEASE_DRIFT_EXIT_CODE);
}
