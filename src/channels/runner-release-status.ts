import { PREPARE_STATE_COMMAND } from "../db/state-readiness.js";
import type { ManagedRuntimeIdentity } from "../managed-runtime.js";
import { CHANNELS_PM2_PROCESS_NAME } from "../pm2.js";
import type { ChannelAdapterHealth } from "./health.js";

/**
 * How a runner that is on another release than its daemon shows up to whoever
 * looks: `ravi channels status` (health `degraded`) and `ravi doctor`. PM2 keeps
 * calling such a runner online and its sockets stay up, so process liveness
 * says nothing; what does is the release each process booted with and whether
 * the runner's own state guard is refusing it.
 */

/**
 * A runner whose state guard is refusing it reports that as this entry of its
 * health snapshot. It is an `adapters` entry, not a new snapshot field: every
 * reader of the snapshot, an older CLI included, already treats a `degraded`
 * entry as unhealthy and prints it, and the typed return schema (and the SDKs
 * generated from it) does not change.
 */
export const RUNNER_RELEASE_GUARD_ADAPTER_ID = "runner:release-guard";

export type RunnerReleaseHealthReason = "release_drift" | "state_refused";

const DAEMON_RECONCILE_COMMAND = 'ravi daemon restart -m "reconcile runtime"';
const RUNNER_RESTART_COMMAND = "ravi channels restart";

export function runnerReleaseGuardAdapter(): ChannelAdapterHealth {
  return {
    id: RUNNER_RELEASE_GUARD_ADAPTER_ID,
    channelId: "runner",
    status: "degraded",
    reason: "state_refused",
    detail: "STATE_SCHEMA_NOT_READY",
  };
}

type RunnerReleaseRuntime = Pick<ManagedRuntimeIdentity, "daemon" | "channels">;

export type RunnerReleaseVerdict =
  | { state: "aligned"; version: string }
  /** The runner and the daemon booted with different releases, so the state guard refuses the runner. */
  | { state: "drift"; runnerVersion: string; daemonVersion: string; fix: string }
  /** The runner reports that its state guard is refusing it while the releases match or are unknown. */
  | { state: "refused"; runnerVersion: string | null; daemonVersion: string | null; fix: string }
  | { state: "unverified"; why: "runner_not_online" | "daemon_not_online" | "version_unknown" };

/**
 * Compares the release each process booted with (the boot receipt bound to its
 * PID and start time, never the installed package) and what the runner says
 * about its own guard. A release that cannot be verified is "unverified", never
 * "drift": a status read right after a restart, before the new process has
 * written its receipt, must not call a healthy runner broken.
 */
export function inspectRunnerRelease(
  runtime: RunnerReleaseRuntime,
  adapters: readonly ChannelAdapterHealth[] | null = null,
): RunnerReleaseVerdict {
  const { daemon, channels } = runtime;
  if (!channels.online) return { state: "unverified", why: "runner_not_online" };

  const runnerVersion = channels.runningVersion;
  const daemonVersion = daemon.online ? daemon.runningVersion : null;
  if (runnerVersion && daemonVersion && runnerVersion !== daemonVersion) {
    return { state: "drift", runnerVersion, daemonVersion, fix: driftFix(runtime) };
  }

  const refused = adapters?.some(
    (adapter) => adapter.id === RUNNER_RELEASE_GUARD_ADAPTER_ID && adapter.status === "degraded",
  );
  if (refused) {
    return {
      state: "refused",
      runnerVersion,
      daemonVersion,
      // Nothing prepares state while the daemon is down; otherwise the installed daemon does it when it restarts.
      fix: daemon.online ? PREPARE_STATE_COMMAND : "ravi daemon start",
    };
  }

  if (!daemon.online) return { state: "unverified", why: "daemon_not_online" };
  if (!runnerVersion || !daemonVersion) return { state: "unverified", why: "version_unknown" };
  return { state: "aligned", version: runnerVersion };
}

/** Restart the side that is not on the installed release; when that cannot be told, reconcile both in order. */
function driftFix({ daemon, channels }: RunnerReleaseRuntime): string {
  const runnerBehind = Boolean(channels.diskVersion && channels.runningVersion !== channels.diskVersion);
  const daemonBehind = Boolean(daemon.diskVersion && daemon.runningVersion !== daemon.diskVersion);
  if (runnerBehind && !daemonBehind) return RUNNER_RESTART_COMMAND;
  if (daemonBehind && !runnerBehind) return DAEMON_RECONCILE_COMMAND;
  return `${DAEMON_RECONCILE_COMMAND}, then ${RUNNER_RESTART_COMMAND}`;
}

/** The health reason `ravi channels status` reports for a verdict that makes the runner unhealthy, else null. */
export function runnerReleaseHealthReason(verdict: RunnerReleaseVerdict): RunnerReleaseHealthReason | null {
  if (verdict.state === "drift") return "release_drift";
  if (verdict.state === "refused") return "state_refused";
  return null;
}

export interface RunnerReleaseProblem {
  /** What is wrong and why it matters. */
  problem: string;
  /** The command that ends it. */
  fix: string;
}

/** The problem a verdict names, or null when there is none (aligned, or not verifiable). */
export function describeRunnerRelease(verdict: RunnerReleaseVerdict): RunnerReleaseProblem | null {
  if (verdict.state === "drift") {
    return {
      problem: `${CHANNELS_PM2_PROCESS_NAME} runs ${verdict.runnerVersion} but the daemon runs ${verdict.daemonVersion}: the state guard refuses a runner on another release, so replies stay queued while PM2 still reports it online`,
      fix: verdict.fix,
    };
  }
  if (verdict.state === "refused") {
    const versions =
      verdict.runnerVersion && verdict.daemonVersion
        ? ` (runner ${verdict.runnerVersion}, daemon ${verdict.daemonVersion})`
        : "";
    return {
      problem: `${CHANNELS_PM2_PROCESS_NAME} is refused by its state guard${versions}: state is not prepared for its release, so replies stay queued`,
      fix: verdict.fix,
    };
  }
  return null;
}

/** One line for a status warning: the problem and the command, or null when there is none. */
export function runnerReleaseWarning(verdict: RunnerReleaseVerdict): string | null {
  const described = describeRunnerRelease(verdict);
  return described ? `${described.problem}. Run: ${described.fix}` : null;
}
