/**
 * The stability window of a managed runtime: a runtime that converged can still crash right after, and a restart
 * loop shows up as a new PID or start time. Shared by the update and its rollback.
 */

import { CHANNELS_PM2_PROCESS_NAME, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const STABILITY_POLL_MS = 1_000;

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
 * Watch the converged processes for the window and fail on any change, instead of reporting success.
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
