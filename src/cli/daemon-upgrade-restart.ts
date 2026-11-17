import { join } from "node:path";
import { readRuntimeMaintenance } from "../runtime-maintenance.js";
import { databaseHasThreadFence, readUpgradeFailure } from "../threads/fence-adoption.js";

/**
 * Restart onto a database written by a pre-fence release. The supervised
 * restart cannot apply: it keeps the old daemon running until the new one is
 * ready, and the new one refuses to adopt while a legacy writer is alive. Here
 * the old processes stop first (channels, then daemon), the daemon starts on
 * the installed release and adopts the fence at its entry, and the channel
 * runner comes back once the fence is in place.
 */
export type UpgradeRestartProcess = { name: string; pid: number; status: string };

export type UpgradeRestartHost = {
  stateDir: string;
  list(): UpgradeRestartProcess[];
  /** Stops through the launcher, which keeps it stopped until an explicit start. */
  stop(name: "ravi" | "ravi-channels"): number;
  /** Starts the existing registration (same script and environment). */
  start(name: "ravi" | "ravi-channels"): number;
  /** Creates the daemon registration when none exists. */
  startNew(): number;
  exitState(pid: number): "exited" | "present" | "unknown";
  wait(): Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

export type UpgradeRestartOutcome = {
  ok: boolean;
  code: "THREAD_FENCE_ADOPTED" | "THREAD_FENCE_UPGRADE_BLOCKED" | "THREAD_FENCE_UPGRADE_TIMEOUT" | "PM2_FAILED";
  message: string;
  channelsStarted: boolean;
};

const UPGRADE_WAIT_MS = 180_000;

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
  const channels = before.find((entry) => entry.name === "ravi-channels");
  const channelsWereOnline = channels?.status === "online";
  const startedAt = now();

  for (const name of ["ravi-channels", "ravi"] as const) {
    const entry = before.find((candidate) => candidate.name === name && candidate.status === "online");
    if (!entry) continue;
    if (host.stop(name) !== 0) return fail("PM2_FAILED", `pm2 stop ${name} failed; nothing was upgraded`);
    const deadline = now() + 30_000;
    while (entry.pid > 0 && host.exitState(entry.pid) !== "exited") {
      if (now() >= deadline) return fail("PM2_FAILED", `${name} (pid ${entry.pid}) did not exit after pm2 stop`);
      await host.wait();
    }
  }

  const started = daemons.length === 1 ? host.start("ravi") : host.startNew();
  if (started !== 0) return fail("PM2_FAILED", "the daemon could not be started; run 'ravi daemon start'");

  const databasePath = join(host.stateDir, "ravi.db");
  const deadline = now() + (host.timeoutMs ?? UPGRADE_WAIT_MS);
  while (now() < deadline) {
    const failure = readUpgradeFailure(host.stateDir);
    if (failure && failure.at >= startedAt) return fail("THREAD_FENCE_UPGRADE_BLOCKED", failure.failure);
    if (!readRuntimeMaintenance(host.stateDir) && databaseHasThreadFence(databasePath)) {
      let channelsStarted = false;
      const current = host.list().find((entry) => entry.name === "ravi-channels");
      // The daemon restarts a runner it stopped itself; one stopped here is started here.
      if (channelsWereOnline && current?.status !== "online") {
        if (host.start("ravi-channels") !== 0)
          return {
            ok: true,
            code: "THREAD_FENCE_ADOPTED",
            message:
              "Database upgraded and daemon restarted; 'pm2 start ravi-channels' failed, run 'ravi channels start'",
            channelsStarted: false,
          };
        channelsStarted = true;
      }
      return {
        ok: true,
        code: "THREAD_FENCE_ADOPTED",
        message: `Database upgraded to the thread fence and daemon restarted${channelsStarted ? "; channel runner started" : ""}`,
        channelsStarted,
      };
    }
    await host.wait();
  }
  return fail(
    "THREAD_FENCE_UPGRADE_TIMEOUT",
    "the daemon did not finish the database upgrade in time; read 'pm2 logs ravi' for the reason",
  );
}
