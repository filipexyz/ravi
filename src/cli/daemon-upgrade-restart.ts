import { MANAGED_RUNTIME_READY_TIMEOUT_MS } from "../db/state-boundary.js";
import { join } from "node:path";
import { readRuntimeMaintenance } from "../runtime-maintenance.js";
import {
  databaseHasThreadFence,
  readChannelsStoppedForUpgrade,
  readUpgradeFailure,
  recordChannelsStoppedForUpgrade,
} from "../threads/fence-adoption.js";

/**
 * Restart onto a database written by a pre-fence release. The supervised
 * restart cannot apply: it keeps the old daemon running until the new one is
 * ready, and the new one refuses to adopt while a legacy writer is alive. Here
 * the old processes stop first (channels, then daemon) and the daemon starts
 * on the target bundle, adopting the fence at its entry. A runner stopped here
 * is recorded first; the ready daemon starts it again, also after a refusal
 * followed by a later adopting start.
 */
export type UpgradeRestartProcess = {
  name: string;
  pid: number;
  status: string;
  /** The registration can start the target bundle as it is: same bundle and a launcher that still exists. */
  onTarget: boolean;
};

export type UpgradeRestartHost = {
  stateDir: string;
  list(): UpgradeRestartProcess[];
  /** Stops through the launcher, which keeps it stopped until an explicit start. */
  stop(name: "ravi" | "ravi-channels"): number;
  /** Starts the existing registration (same script and environment). */
  start(name: "ravi"): number;
  /** Deletes a registration (used when it starts another bundle). */
  remove(name: "ravi"): number;
  /** Creates the daemon registration on the target bundle. */
  startNew(): number;
  /** The `ravi` process online now has reported its schema phase `ready`. */
  daemonReady(): boolean;
  exitState(pid: number): "exited" | "present" | "unknown";
  wait(): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  channelsTimeoutMs?: number;
  /** How long PM2 may take to give a started daemon a pid before the start counts as failed. */
  spawnGraceMs?: number;
};

export type UpgradeRestartOutcome = {
  ok: boolean;
  code: "THREAD_FENCE_ADOPTED" | "THREAD_FENCE_UPGRADE_BLOCKED" | "THREAD_FENCE_UPGRADE_TIMEOUT" | "PM2_FAILED";
  message: string;
  channelsStarted: boolean;
};

const UPGRADE_WAIT_MS = 180_000;
/** The runner passes the same state guard as the daemon, so it gets the same ready window. */
export const CHANNELS_WAIT_MS = MANAGED_RUNTIME_READY_TIMEOUT_MS;
const SPAWN_GRACE_MS = 15_000;

export async function performUpgradeRestart(host: UpgradeRestartHost): Promise<UpgradeRestartOutcome> {
  const now = host.now ?? Date.now;
  const fail = (code: UpgradeRestartOutcome["code"], message: string): UpgradeRestartOutcome => ({
    ok: false,
    code,
    message,
    channelsStarted: false,
  });
  const before = host.list();
  const daemons = before.filter((entry) => entry.name === "ravi");
  if (daemons.length > 1)
    return fail("PM2_FAILED", "more than one 'ravi' process is registered in PM2; remove the duplicate first");
  for (const name of ["ravi-channels", "ravi"] as const) {
    const entry = before.find((candidate) => candidate.name === name && candidate.status === "online");
    if (!entry) continue;
    // Before the stop: a refusal anywhere after it must not leave the runner down for good.
    if (name === "ravi-channels") recordChannelsStoppedForUpgrade(host.stateDir, "daemon restart");
    if (host.stop(name) !== 0) return fail("PM2_FAILED", `pm2 stop ${name} failed; nothing was upgraded`);
    const deadline = now() + 30_000;
    while (entry.pid > 0 && host.exitState(entry.pid) !== "exited") {
      if (now() >= deadline) return fail("PM2_FAILED", `${name} (pid ${entry.pid}) did not exit after pm2 stop`);
      await host.wait();
    }
  }

  // A registration on another bundle would start the legacy again, which never adopts.
  const registered = daemons[0];
  if (registered && !registered.onTarget && host.remove("ravi") !== 0)
    return fail("PM2_FAILED", "the 'ravi' registration starts another bundle and could not be removed");
  // This restart's runner, or one an earlier refused attempt stopped: the ready daemon brings it back.
  const runnerExpected = readChannelsStoppedForUpgrade(host.stateDir) !== null;
  // Notes older than this start belong to earlier attempts (a refusing predecessor writes one until it is stopped).
  const startedAt = now();
  const started = registered?.onTarget ? host.start("ravi") : host.startNew();
  if (started !== 0) return fail("PM2_FAILED", "the daemon could not be started; run 'ravi daemon start'");

  const databasePath = join(host.stateDir, "ravi.db");
  const deadline = now() + (host.timeoutMs ?? UPGRADE_WAIT_MS);
  while (now() < deadline) {
    const failure = readUpgradeFailure(host.stateDir);
    if (failure && failure.at > startedAt)
      return fail(
        "THREAD_FENCE_UPGRADE_BLOCKED",
        `${failure.failure}. PM2 retries the start every 30 s; the channel runner comes back once the daemon adopts`,
      );
    if (!readRuntimeMaintenance(host.stateDir) && databaseHasThreadFence(databasePath) && host.daemonReady())
      return awaitChannels(host, now, runnerExpected);
    // PM2 reports the registration online while spawning failed (a missing launcher or runtime): no pid ever
    // appears and no adoption or refusal can follow. That is a daemon that did not start, not a slow upgrade.
    if (now() - startedAt >= (host.spawnGraceMs ?? SPAWN_GRACE_MS) && !daemonHasProcess(host))
      return fail(
        "PM2_FAILED",
        "PM2 registered the daemon but no process started (no pid), so the database upgrade never began; " +
          "read ~/.pm2/pm2.log for the spawn error, then run 'ravi daemon stop' and 'ravi daemon start'",
      );
    await host.wait();
  }
  return fail(
    "THREAD_FENCE_UPGRADE_TIMEOUT",
    "the daemon did not finish the database upgrade in time; read 'ravi daemon logs' for the reason",
  );
}

function daemonHasProcess(host: UpgradeRestartHost): boolean {
  const daemon = host.list().find((entry) => entry.name === "ravi");
  return Boolean(daemon && daemon.status !== "online") || Boolean(daemon && daemon.pid > 0);
}

/** The ready daemon starts the runner the upgrade stopped; this only waits for it and says what happened. */
async function awaitChannels(
  host: UpgradeRestartHost,
  now: () => number,
  runnerExpected: boolean,
): Promise<UpgradeRestartOutcome> {
  const upgraded = "Database upgraded to the thread fence and daemon ready";
  const runnerOnline = () => host.list().some((entry) => entry.name === "ravi-channels" && entry.status === "online");
  if (!runnerExpected) return { ok: true, code: "THREAD_FENCE_ADOPTED", message: upgraded, channelsStarted: false };
  const deadline = now() + (host.channelsTimeoutMs ?? CHANNELS_WAIT_MS);
  while (now() < deadline) {
    if (!readChannelsStoppedForUpgrade(host.stateDir) && runnerOnline())
      return {
        ok: true,
        code: "THREAD_FENCE_ADOPTED",
        message: `${upgraded}; channel runner started`,
        channelsStarted: true,
      };
    await host.wait();
  }
  return {
    ok: true,
    code: "THREAD_FENCE_ADOPTED",
    message: `${upgraded}, but the channel runner did not come back; run 'ravi channels start'`,
    channelsStarted: false,
  };
}
