/**
 * Supervised daemon restart cutover.
 *
 * `pm2 delete ravi` removes every process with that name and asks PM2 to
 * tree-kill the predecessor's children. Doing that before a different,
 * still-supervised successor exists is how a handoff ends as a clean stop
 * with nothing left for PM2 to resurrect. The cutover below refuses to stop
 * the running daemon unless a successor has stayed online, and it deletes by
 * pm id so the successor is not part of that stop.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

/** Set on every detached restart process so it cannot hand off again. */
export const DAEMON_RESTART_HANDOFF_ENV = "RAVI_DAEMON_RESTART_HANDOFF";

/**
 * Set on the grandchild that actually cuts over. The intermediate process
 * exits immediately so this worker is reparented outside the predecessor
 * tree before any stop.
 */
export const DAEMON_RESTART_HANDOFF_WORKER_ENV = "RAVI_DAEMON_RESTART_HANDOFF_WORKER";

export type DaemonRestartHandoffDecision = "reparent" | "handoff" | "cutover";

export function shouldHandoffDaemonRestart(input: {
  handoffEnv?: string;
  workerEnv?: string;
  runtimeInvocation: boolean;
  insideDaemonTree: boolean;
}): DaemonRestartHandoffDecision {
  const marked = input.handoffEnv === "1";
  const worker = input.workerEnv === "1";
  // The marker has to win over runtime session env. A handoff child reloads
  // ~/.ravi/.env and would otherwise hand off forever, or run a later
  // `pm2 delete` against whatever is left.
  if (marked && !worker) return "reparent";
  if (marked || worker) return "cutover";
  if (input.runtimeInvocation || input.insideDaemonTree) return "handoff";
  return "cutover";
}

export type ManagedDaemonProcess = {
  name: string;
  pmId: number;
  pid: number;
  status: string;
};

export type SupervisedDaemonRestartCode =
  | "restarted"
  | "started"
  | "orchestrator_attached"
  | "start_failed"
  | "successor_not_supervised"
  | "save_failed"
  | "predecessor_stop_failed"
  | "successor_lost";

export type SupervisedDaemonRestartResult = {
  ok: boolean;
  changed: boolean;
  code: SupervisedDaemonRestartCode;
  message: string;
  predecessorPmIds: number[];
  successorPmId: number | null;
  predecessorPreserved: boolean;
  saveStatus: number | null;
  deletedPmIds: number[];
};

export type SupervisedDaemonRestartDeps = {
  processName?: string;
  list: () => ManagedDaemonProcess[];
  start: (input: { force: boolean }) => number;
  deletePmId: (pmId: number) => number;
  save: () => number;
  pidAlive: (pid: number) => boolean;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  mustBeDetached?: boolean;
  isInsidePredecessorTree?: () => boolean;
  readyTimeoutMs?: number;
  detachTimeoutMs?: number;
  pollMs?: number;
  confirmations?: number;
};

type TimingDeps = Required<Pick<SupervisedDaemonRestartDeps, "wait" | "now" | "pollMs" | "confirmations">> & {
  readyTimeoutMs: number;
  detachTimeoutMs: number;
};

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DETACH_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_CONFIRMATIONS = 2;

function timing(deps: SupervisedDaemonRestartDeps): TimingDeps {
  return {
    wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
    pollMs: deps.pollMs ?? DEFAULT_POLL_MS,
    confirmations: deps.confirmations ?? DEFAULT_CONFIRMATIONS,
    readyTimeoutMs: deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    detachTimeoutMs: deps.detachTimeoutMs ?? DEFAULT_DETACH_TIMEOUT_MS,
  };
}

function isSupervised(process: ManagedDaemonProcess | undefined, pidAlive: (pid: number) => boolean): boolean {
  return Boolean(process && process.status === "online" && process.pid > 0 && pidAlive(process.pid));
}

async function pollUntil(deps: TimingDeps, timeoutMs: number, ready: () => boolean): Promise<boolean> {
  const started = deps.now();
  while (deps.now() - started <= timeoutMs) {
    if (ready()) return true;
    const before = deps.now();
    await deps.wait(deps.pollMs);
    if (deps.now() <= before) return ready();
  }
  return ready();
}

function result(input: SupervisedDaemonRestartResult): SupervisedDaemonRestartResult {
  return input;
}

export async function performSupervisedDaemonRestart(
  deps: SupervisedDaemonRestartDeps,
): Promise<SupervisedDaemonRestartResult> {
  const processName = deps.processName ?? "ravi";
  const clock = timing(deps);
  const deletedPmIds: number[] = [];

  if (deps.mustBeDetached) {
    const inside = deps.isInsidePredecessorTree ?? (() => false);
    const detached = await pollUntil(clock, clock.detachTimeoutMs, () => !inside());
    if (!detached) {
      return result({
        ok: false,
        changed: false,
        code: "orchestrator_attached",
        message:
          "Restart aborted: the orchestrator is still inside the running daemon's process tree. Stopping it now would take the only supervised daemon down with it.",
        predecessorPmIds: [],
        successorPmId: null,
        predecessorPreserved: true,
        saveStatus: null,
        deletedPmIds,
      });
    }
  }

  const named = () => deps.list().filter((process) => process.name === processName);
  const before = named();
  const beforeIds = new Set(before.map((process) => process.pmId));
  const predecessorPmIds = before.map((process) => process.pmId);
  const replaceRunning = before.some((process) => process.status === "online");

  const deletePmId = (pmId: number): number => {
    const status = deps.deletePmId(pmId);
    if (status === 0) deletedPmIds.push(pmId);
    return status;
  };

  const cleanupUnsupervisedArrivals = (): void => {
    for (const process of named()) {
      if (!beforeIds.has(process.pmId)) deletePmId(process.pmId);
    }
  };

  const preserved = (successorPmId: number | null, saveStatus: number | null): SupervisedDaemonRestartResult =>
    result({
      ok: false,
      changed: false,
      code: "successor_not_supervised",
      message: replaceRunning
        ? "Restart aborted: no supervised successor stayed online, so the running daemon was not stopped."
        : "Restart aborted: the daemon did not stay supervised after start.",
      predecessorPmIds,
      successorPmId,
      predecessorPreserved: replaceRunning,
      saveStatus,
      deletedPmIds,
    });

  const startStatus = deps.start({ force: replaceRunning });
  if (startStatus !== 0) {
    cleanupUnsupervisedArrivals();
    return result({
      ok: false,
      changed: false,
      code: "start_failed",
      message: replaceRunning
        ? "Restart aborted: the successor failed to start, so the running daemon was not stopped."
        : "Failed to start daemon.",
      predecessorPmIds,
      successorPmId: null,
      predecessorPreserved: replaceRunning,
      saveStatus: null,
      deletedPmIds,
    });
  }

  let hits = 0;
  let successor: ManagedDaemonProcess | null = null;
  const startedAt = clock.now();
  while (clock.now() - startedAt <= clock.readyTimeoutMs) {
    const candidate = named().find((process) => {
      if (!isSupervised(process, deps.pidAlive)) return false;
      if (replaceRunning && beforeIds.has(process.pmId)) return false;
      return true;
    });
    if (candidate) {
      hits += 1;
      successor = candidate;
      if (hits >= clock.confirmations) break;
    } else {
      hits = 0;
      successor = null;
    }
    const beforeWait = clock.now();
    await clock.wait(clock.pollMs);
    if (clock.now() <= beforeWait) break;
  }

  if (!successor || hits < clock.confirmations || !isSupervised(successor, deps.pidAlive)) {
    cleanupUnsupervisedArrivals();
    return preserved(successor?.pmId ?? null, null);
  }

  const successorPmId = successor.pmId;
  const stillSupervised = (): boolean =>
    isSupervised(
      named().find((process) => process.pmId === successorPmId),
      deps.pidAlive,
    );

  if (!stillSupervised()) {
    cleanupUnsupervisedArrivals();
    return preserved(successorPmId, null);
  }

  const saveBeforeStop = replaceRunning ? deps.save() : null;
  if (replaceRunning && saveBeforeStop !== 0) {
    deletePmId(successorPmId);
    return result({
      ok: false,
      changed: false,
      code: "save_failed",
      message: "Restart aborted: PM2 could not save its process list, so the running daemon was not stopped.",
      predecessorPmIds,
      successorPmId,
      predecessorPreserved: true,
      saveStatus: saveBeforeStop,
      deletedPmIds,
    });
  }

  if (replaceRunning) {
    if (!stillSupervised()) {
      cleanupUnsupervisedArrivals();
      return preserved(successorPmId, saveBeforeStop);
    }
    for (const pmId of predecessorPmIds) {
      if (pmId === successorPmId) continue;
      if (!stillSupervised()) {
        return preserved(successorPmId, saveBeforeStop);
      }
      const deleteStatus = deletePmId(pmId);
      if (deleteStatus !== 0) {
        return result({
          ok: false,
          changed: false,
          code: "predecessor_stop_failed",
          message:
            "Restart did not finish: the successor is online, but the previous daemon could not be stopped. Both processes may still be supervised.",
          predecessorPmIds,
          successorPmId,
          predecessorPreserved: true,
          saveStatus: saveBeforeStop,
          deletedPmIds,
        });
      }
    }
  }

  if (!stillSupervised()) {
    if (!replaceRunning) {
      cleanupUnsupervisedArrivals();
      return preserved(successorPmId, saveBeforeStop);
    }
    const recoveryStatus = deps.start({ force: false });
    let recovered: ManagedDaemonProcess | undefined;
    if (recoveryStatus === 0) {
      const recoveryStarted = clock.now();
      while (clock.now() - recoveryStarted <= clock.readyTimeoutMs) {
        recovered = named().find((process) => isSupervised(process, deps.pidAlive));
        if (recovered) break;
        const beforeWait = clock.now();
        await clock.wait(clock.pollMs);
        if (clock.now() <= beforeWait) break;
      }
    }
    const recoverySave = recovered ? deps.save() : null;
    return result({
      ok: false,
      changed: Boolean(recovered),
      code: "successor_lost",
      message: recovered
        ? "Restart failed closed: the successor exited when the previous daemon stopped. A replacement process was started, but the original restart did not complete cleanly."
        : "Restart failed closed: stopping the previous daemon left no supervised successor, and the replacement start failed.",
      predecessorPmIds,
      successorPmId: recovered?.pmId ?? null,
      predecessorPreserved: false,
      saveStatus: recoverySave,
      deletedPmIds,
    });
  }

  const saveStatus = deps.save();
  if (saveStatus !== 0) {
    return result({
      ok: false,
      changed: true,
      code: "save_failed",
      message: replaceRunning
        ? "Daemon restarted, but failed to save the PM2 process list."
        : "Daemon started, but failed to save the PM2 process list.",
      predecessorPmIds,
      successorPmId,
      predecessorPreserved: false,
      saveStatus,
      deletedPmIds,
    });
  }

  return result({
    ok: true,
    changed: true,
    code: replaceRunning ? "restarted" : "started",
    message: replaceRunning
      ? "Daemon restarted and PM2 startup state saved"
      : "Daemon started and PM2 startup state saved",
    predecessorPmIds,
    successorPmId,
    predecessorPreserved: false,
    saveStatus,
    deletedPmIds,
  });
}

export function daemonRestartLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "logs", "daemon-restart.log");
}

export function appendDaemonRestartLog(line: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = daemonRestartLogPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  return path;
}

export function formatDaemonRestartOutcome(resultValue: SupervisedDaemonRestartResult): string {
  const predecessor = resultValue.predecessorPmIds.length > 0 ? resultValue.predecessorPmIds.join(",") : "-";
  const successor = resultValue.successorPmId ?? "-";
  return `outcome=${resultValue.code} predecessor=${predecessor} successor=${successor} preserved=${resultValue.predecessorPreserved} ${resultValue.message}`;
}
