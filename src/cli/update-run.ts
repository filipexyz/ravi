/**
 * Detached execution of `ravi update`.
 *
 * The update ends by replacing the managed daemon, and `pm2 delete ravi`
 * tree-kills every descendant of the daemon. An update started from inside
 * that tree (an agent tool, a cron shell job, a hook) used to die between the
 * stop and the start, leaving PM2 without `ravi` and `ravi-channels`. The same
 * two-step handoff as `ravi daemon restart` moves the work out of the tree
 * before anything is installed or stopped:
 *
 *   caller (inside the tree)   -> spawns a detached child, returns the run id
 *   child   (RAVI_UPDATE_HANDOFF=1) -> spawns the worker and exits at once
 *   worker  (…_WORKER=1)        -> reparented outside the tree, runs the update
 *
 * Each run keeps its request, log and result under `<state>/updates/<runId>/`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveHandoffStateDir } from "../runtime/restart-reason.js";
import { getRaviStateDir } from "../utils/paths.js";

/** Set on the detached child; it only reparents the worker. */
export const UPDATE_HANDOFF_ENV = "RAVI_UPDATE_HANDOFF";
/** Set on the worker that runs the update once it is outside the daemon tree. */
export const UPDATE_HANDOFF_WORKER_ENV = "RAVI_UPDATE_HANDOFF_WORKER";
/** Run id shared by the child and the worker. */
export const UPDATE_RUN_ID_ENV = "RAVI_UPDATE_RUN_ID";

export const UPDATE_RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export type UpdateExecution = "reparent" | "handoff" | "inline";

export function decideUpdateExecution(input: {
  handoffEnv?: string;
  workerEnv?: string;
  insideDaemonTree: boolean;
}): UpdateExecution {
  const marked = input.handoffEnv === "1";
  const worker = input.workerEnv === "1";
  // The markers win over the tree check: the child is still inside the tree
  // and would otherwise hand off forever.
  if (marked && !worker) return "reparent";
  if (marked || worker) return "inline";
  return input.insideDaemonTree ? "handoff" : "inline";
}

export function createUpdateRunId(
  now: Date = new Date(),
  random: () => string = () => randomBytes(3).toString("hex"),
): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${stamp}-${random()}`;
}

export type UpdateRunPaths = {
  dir: string;
  log: string;
  request: string;
  result: string;
};

export function updateRunPaths(runId: string, stateDir: string = getRaviStateDir()): UpdateRunPaths {
  if (!UPDATE_RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid update run id: ${runId}`);
  const dir = join(resolve(stateDir), "updates", runId);
  return {
    dir,
    log: join(dir, "log"),
    request: join(dir, "request.json"),
    result: join(dir, "result.json"),
  };
}

/** `RAVI_*` keys the detached update keeps; every other one is runtime context. */
const DETACHED_UPDATE_KEPT_RAVI_KEYS = new Set(["RAVI_HOME", "RAVI_REPO", "RAVI_SUPPRESS_AUDIT_EVENTS"]);

/**
 * The state directory of a handed-off update, as an absolute path. A caller in the daemon tree inherited
 * `RAVI_STATE_DIR` from the daemon; a relative value comes from a daemon that predates the boot anchor and
 * resolves it against its own cwd (#857), so it is anchored there, never at the caller's cwd, or the run and the
 * successor would use a different, empty directory. Unset stays unset (default `~/.ravi`). A relative value with
 * no known daemon cwd throws: there is no directory that is certainly the daemon's.
 */
export function resolveDetachedUpdateStateDir(env: NodeJS.ProcessEnv, daemonCwd: string | null): string | undefined {
  const value = env.RAVI_STATE_DIR;
  if (!value || isAbsolute(value)) return value || undefined;
  if (!daemonCwd) {
    throw new Error(
      `RAVI_STATE_DIR is relative (${value}) and the daemon's working directory is unknown, so the state ` +
        "directory the daemon uses cannot be resolved",
    );
  }
  return resolveHandoffStateDir(env, daemonCwd);
}

/**
 * Environment of the detached update: no runtime context, session or gateway
 * routing (the worker is an operator process, like the restart worker), the
 * daemon's state directory as an absolute path (`resolveDetachedUpdateStateDir`),
 * and the run markers.
 */
export function buildDetachedUpdateEnv(
  env: NodeJS.ProcessEnv,
  runId: string,
  stateDir: string | undefined,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("RAVI_") && !DETACHED_UPDATE_KEPT_RAVI_KEYS.has(key)) continue;
    clean[key] = value;
  }
  if (stateDir) clean.RAVI_STATE_DIR = stateDir;
  clean[UPDATE_HANDOFF_ENV] = "1";
  clean[UPDATE_RUN_ID_ENV] = runId;
  return clean;
}

/** The part of `ChildProcess` the detached launch uses. */
export type DetachedChild = {
  pid?: number;
  unref(): void;
  once(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type DetachedSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["ignore", number, number]; detached: true },
) => DetachedChild;

/**
 * Starts a detached process with stdout/stderr appended to the run log and
 * resolves with its pid once it is running. A launch that fails (missing
 * executable or working directory) reports it as an asynchronous `error`
 * event, not as a throw: it rejects here, so the caller refuses the update
 * instead of crashing on an unhandled event after reporting.
 */
export async function spawnDetachedUpdateProcess(
  input: { command: string; args: string[]; env: Record<string, string>; cwd: string; logPath: string },
  spawnImpl: DetachedSpawn = spawn as unknown as DetachedSpawn,
): Promise<number> {
  const fd = openSync(input.logPath, "a", 0o600);
  try {
    const child = spawnImpl(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      // Stays attached after the launch settles: a later error event changes
      // nothing here and must not surface as an unhandled one.
      child.on("error", reject);
      child.once("spawn", resolve);
    });
    if (!child.pid) throw new Error(`could not start ${input.command}`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export function prepareUpdateRunDir(paths: UpdateRunPaths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
}

/** Written atomically: a reader never sees a partial result. */
export function writeUpdateRunFile(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
