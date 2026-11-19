import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getPm2Processes, getRaviPid, PM2_PROCESS_NAME } from "../pm2.js";

/** The parent pid in a `/proc/<pid>/stat` line, "pid (comm) state ppid ...". */
export function parseProcStatParentPid(stat: string): number | null {
  // comm may hold spaces or parentheses, so read after the last ")".
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const parsed = Number.parseInt(stat.slice(close + 2).split(" ")[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Linux: `/proc/<pid>/stat` works where `ps -p` does not (BusyBox). */
function procParentPid(pid: number): number | null {
  try {
    return parseProcStatParentPid(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    // no-cause: No /proc entry (macOS, or the process exited): the caller falls back to ps.
    return null;
  }
}

function nativeParentPid(pid: number): number | null {
  return procParentPid(pid) ?? psParentPid(pid);
}

function psParentPid(pid: number): number | null {
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
  /**
   * An unknown answer throws instead of "outside": PM2 that cannot be read, and an ancestry that cannot be read,
   * loops or is deeper than the walk. For callers that must never run inline in the tree.
   */
  strict?: boolean;
  startPid?: number;
  readParentPid?: (pid: number) => number | null;
};

type ManagedDaemon = { pid: number; cwd: string | null };

/**
 * Every `ravi` registration from a strict PM2 read (throws when PM2 cannot be read). A supervised restart starts
 * the successor before it deletes the predecessor, so two can be listed at once.
 */
function readManagedDaemonsStrict(): ManagedDaemon[] {
  return getPm2Processes({ strict: true })
    .filter((process) => process.name === PM2_PROCESS_NAME)
    .map((process) => ({ pid: process.pid, cwd: process.cwd ?? null }));
}

const MAX_ANCESTRY_DEPTH = 24;

/** The first of `daemonPids` met walking up from `startPid`; null when the walk ends outside. */
function findDaemonAncestor(
  daemonPids: Array<number | null>,
  options: Pick<DaemonProcessTreeOptions, "strict" | "startPid" | "readParentPid">,
): number | null {
  const targets = new Set(daemonPids.filter((pid): pid is number => typeof pid === "number" && pid > 0));
  if (targets.size === 0) return null;
  const readParentPid = options.readParentPid ?? nativeParentPid;
  const unknown = (reason: string): null => {
    if (options.strict) throw new Error(`Could not read the process ancestry: ${reason}`);
    return null;
  };
  const seen = new Set<number>();
  let pid = options.startPid ?? process.ppid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (!pid || pid <= 1) return null;
    if (targets.has(pid)) return pid;
    if (seen.has(pid)) return unknown(`it loops at pid ${pid}`);
    seen.add(pid);
    const parent = readParentPid(pid);
    if (parent === null) return unknown(`the parent of pid ${pid} is unreadable`);
    pid = parent;
  }
  return unknown(`it is deeper than ${MAX_ANCESTRY_DEPTH} levels`);
}

export type DaemonTreePosition = {
  inside: boolean;
  /** cwd of the running daemon: a relative `RAVI_STATE_DIR` it handed down resolves against it. */
  daemonCwd: string | null;
};

/**
 * Where this process sits relative to the daemon, from one strict PM2 read. Throws when PM2 cannot be read:
 * an unknown position must never be taken for "outside".
 */
export function locateInDaemonProcessTree(
  options: Omit<DaemonProcessTreeOptions, "daemonPid" | "strict"> & {
    /** Test seam for the `ravi` registrations; the default reads PM2 strictly. */
    daemons?: ManagedDaemon[];
  } = {},
): DaemonTreePosition {
  const daemons = options.daemons ?? readManagedDaemonsStrict();
  const ancestor = findDaemonAncestor(
    daemons.map((daemon) => daemon.pid),
    { ...options, strict: true },
  );
  if (ancestor === null) return { inside: false, daemonCwd: null };
  return { inside: true, daemonCwd: daemons.find((daemon) => daemon.pid === ancestor)?.cwd ?? null };
}

/** A PM2 read that fails counts as still inside: the worker keeps waiting and, at the deadline, stops nothing. */
function insideOrUnreadable(isInside: () => boolean): boolean {
  try {
    return isInside();
  } catch {
    // no-cause: An unreadable PM2 is an unknown position, so it counts as inside and the worker keeps waiting.
    return true;
  }
}

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
  const daemonPids =
    options.daemonPid !== undefined
      ? [options.daemonPid]
      : options.strict
        ? readManagedDaemonsStrict().map((daemon) => daemon.pid)
        : [getRaviPid()];
  return findDaemonAncestor(daemonPids, options) !== null;
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
  const isInside = options.isInside ?? (() => isInsideDaemonProcessTree({ strict: true }));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 5_000);
  for (;;) {
    if (!insideOrUnreadable(isInside)) return true;
    if (now() >= deadline) return false;
    await wait(options.pollMs ?? 100);
  }
}
