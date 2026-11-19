import { execSync } from "node:child_process";
import { getRaviPid } from "../pm2.js";

function nativeParentPid(pid: number): number | null {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // no-cause: An unreadable parent ends the walk; the caller treats the chain as outside the daemon.
    return null;
  }
}

export type DaemonProcessTreeOptions = {
  daemonPid?: number | null;
  startPid?: number;
  readParentPid?: (pid: number) => number | null;
};

/**
 * True when this process lives inside the daemon's own process tree -- cron
 * shell jobs, agent bash tools and hook scripts all do.
 *
 * Those callers cannot run a sequence that starts with `pm2 delete ravi`:
 * that kills the daemon, and pm2's treekill takes every descendant with it,
 * including a `detached` child whose parent is still in the tree. The
 * following `pm2 start` never runs and the daemon stays offline.
 */
export function isInsideDaemonProcessTree(options: DaemonProcessTreeOptions = {}): boolean {
  const daemonPid = options.daemonPid === undefined ? getRaviPid() : options.daemonPid;
  if (!daemonPid) return false;

  const readParentPid = options.readParentPid ?? nativeParentPid;
  const seen = new Set<number>();
  let pid = options.startPid ?? process.ppid;

  for (let depth = 0; depth < 24; depth += 1) {
    if (!pid || pid <= 1 || seen.has(pid)) return false;
    if (pid === daemonPid) return true;
    seen.add(pid);
    const parent = readParentPid(pid);
    if (parent === null) return false;
    pid = parent;
  }

  return false;
}

/**
 * A reparented worker leaves the tree when its intermediate parent exits.
 * Polls until that happened; false means the worker must not stop anything.
 */
export async function waitUntilOutsideDaemonProcessTree(
  options: {
    isInside?: () => boolean;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const isInside = options.isInside ?? (() => isInsideDaemonProcessTree());
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 5_000);
  for (;;) {
    if (!isInside()) return true;
    if (now() >= deadline) return false;
    await wait(options.pollMs ?? 100);
  }
}
