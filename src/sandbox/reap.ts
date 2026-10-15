/**
 * Orphaned-sandbox reaper for `ravi sandbox reap`.
 *
 * A sandbox run normally ends with `kill()`, but a host that dies mid-run, a `--keep`
 * pause that was forgotten or an E2B timeout that never fired leaves machines behind,
 * each holding a repository clone and billing time. The reaper lists the sandboxes this
 * host created (metadata `purpose: "ravi-task"`, `ravi_host`), selects the ones that
 * cannot belong to a live run and kills them only when asked to (`--execute`).
 *
 * Scope is the whole safety story: another host's sandboxes are never candidates unless
 * `--all-hosts` is passed, and even then only those tagged `purpose: "ravi-task"`. The
 * metadata filter E2B applies server-side is repeated here, so a looser server-side
 * match (or a forged `purpose` on a sandbox from elsewhere) cannot widen the set.
 */

import { MAX_SANDBOX_TIMEOUT_MIN } from "./e2b.js";

export const RAVI_TASK_PURPOSE = "ravi-task";
/** A run's sandbox lives task timeout + 5 min; anything older than this is not a live run. */
export const DEFAULT_REAP_OLDER_THAN_MIN = MAX_SANDBOX_TIMEOUT_MIN + 10;

export type ReapSandboxState = "running" | "paused";

/** The slice of E2B's SandboxInfo the reaper reads. */
export interface ReapSandboxInfo {
  sandboxId: string;
  state: ReapSandboxState;
  startedAt: Date;
  metadata: Record<string, string>;
  templateId?: string;
}

export type ReapCause = "paused" | "overdue" | "dead-pid";
export type ReapSkipCause = "not-ravi-task" | "other-host" | "live";

export interface ReapCandidate {
  sandboxId: string;
  state: ReapSandboxState;
  ageMin: number;
  raviHost: string | null;
  raviRun: string | null;
  raviPid: number | null;
  cause: ReapCause;
}

export interface ReapSkipped {
  sandboxId: string;
  cause: ReapSkipCause;
}

export interface ReapDeps {
  /** Lists sandboxes matching the metadata (running and paused); defaults to `Sandbox.list`. */
  list: (metadata: Record<string, string>) => Promise<ReapSandboxInfo[]>;
  /** Kills one sandbox; defaults to `Sandbox.kill`. */
  kill: (sandboxId: string) => Promise<unknown>;
  now?: () => number;
  /** Whether a process with this pid exists on this host; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

export interface ReapOptions {
  /** This host's `ravi_host` value (sandboxHostId()). */
  hostId: string;
  /** Running sandboxes older than this are candidates; default MAX_SANDBOX_TIMEOUT_MIN + 10. */
  olderThanMin?: number;
  /** Also consider other hosts' `ravi-task` sandboxes (paused or overdue only; their pids mean nothing here). */
  allHosts?: boolean;
  /** Kill the candidates; without it the result is the plan only. */
  execute?: boolean;
}

export interface ReapResult {
  hostId: string;
  allHosts: boolean;
  olderThanMin: number;
  scanned: number;
  candidates: ReapCandidate[];
  skipped: ReapSkipped[];
  executed: boolean;
  killed: string[];
  failed: Array<{ sandboxId: string; error: string }>;
}

/**
 * Whether a process with this pid exists here. Only a positive integer is ever passed to
 * `process.kill`: pid 0 is "this process group" and a negative pid is a whole group (or,
 * for -1, every process), which signal 0 would report as alive.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user, so it is alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * The ravi-task sandboxes the reaper may look at. The server-side filter is repeated
 * client-side: every item must carry `purpose: "ravi-task"` and, unless allHosts, this
 * host's `ravi_host`. Anything else is reported as skipped, never as a candidate.
 */
export async function listRaviTaskSandboxes(options: {
  hostId: string;
  allHosts?: boolean;
  list: ReapDeps["list"];
}): Promise<{ sandboxes: ReapSandboxInfo[]; skipped: ReapSkipped[] }> {
  const metadata: Record<string, string> = { purpose: RAVI_TASK_PURPOSE };
  if (!options.allHosts) metadata.ravi_host = options.hostId;
  const listed = await options.list(metadata);
  const sandboxes: ReapSandboxInfo[] = [];
  const skipped: ReapSkipped[] = [];
  for (const info of listed) {
    if (info.metadata?.purpose !== RAVI_TASK_PURPOSE) {
      skipped.push({ sandboxId: info.sandboxId, cause: "not-ravi-task" });
    } else if (!options.allHosts && info.metadata.ravi_host !== options.hostId) {
      skipped.push({ sandboxId: info.sandboxId, cause: "other-host" });
    } else {
      sandboxes.push(info);
    }
  }
  return { sandboxes, skipped };
}

function parsePid(value: string | undefined): number | null {
  if (!value || !/^\d{1,10}$/.test(value)) return null;
  const pid = Number(value);
  return pid > 0 ? pid : null;
}

/**
 * Which of the listed sandboxes cannot belong to a live run: paused ones, running ones
 * older than `olderThanMin`, and running ones whose `ravi_pid` is gone from this host.
 * The pid test applies only to this host's sandboxes: a pid from another machine says
 * nothing about processes here.
 */
export function selectReapCandidates(
  sandboxes: ReapSandboxInfo[],
  options: { hostId: string; olderThanMin: number; now: () => number; isAlive: (pid: number) => boolean },
): { candidates: ReapCandidate[]; skipped: ReapSkipped[] } {
  const candidates: ReapCandidate[] = [];
  const skipped: ReapSkipped[] = [];
  for (const info of sandboxes) {
    const ageMin = Math.max(0, Math.floor((options.now() - info.startedAt.getTime()) / 60_000));
    const raviHost = info.metadata.ravi_host ?? null;
    const raviPid = parsePid(info.metadata.ravi_pid);
    const base = {
      sandboxId: info.sandboxId,
      state: info.state,
      ageMin,
      raviHost,
      raviRun: info.metadata.ravi_run ?? null,
      raviPid,
    };
    let cause: ReapCause | null = null;
    if (info.state === "paused") cause = "paused";
    else if (ageMin > options.olderThanMin) cause = "overdue";
    else if (raviHost === options.hostId && raviPid !== null && !options.isAlive(raviPid)) cause = "dead-pid";
    if (cause) candidates.push({ ...base, cause });
    else skipped.push({ sandboxId: info.sandboxId, cause: "live" });
  }
  return { candidates, skipped };
}

/** List, select and (with `execute`) kill. Without `execute` nothing is called but `list`. */
export async function reapSandboxes(options: ReapOptions, deps: ReapDeps): Promise<ReapResult> {
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? processIsAlive;
  const olderThanMin = options.olderThanMin ?? DEFAULT_REAP_OLDER_THAN_MIN;
  if (!Number.isInteger(olderThanMin) || olderThanMin < 1)
    throw new Error("olderThanMin must be a whole number of minutes, at least 1.");
  const listed = await listRaviTaskSandboxes({ hostId: options.hostId, allHosts: options.allHosts, list: deps.list });
  const selected = selectReapCandidates(listed.sandboxes, { hostId: options.hostId, olderThanMin, now, isAlive });
  const result: ReapResult = {
    hostId: options.hostId,
    allHosts: Boolean(options.allHosts),
    olderThanMin,
    scanned: listed.sandboxes.length + listed.skipped.length,
    candidates: selected.candidates,
    skipped: [...listed.skipped, ...selected.skipped],
    executed: Boolean(options.execute),
    killed: [],
    failed: [],
  };
  if (!options.execute) return result;
  return killCandidates(result, deps);
}

/**
 * The one kill loop, shared by `reapSandboxes({ execute: true })` and the CLI's
 * `executeSandboxReap`: kills every candidate of `plan`, continues past a failed kill and
 * reports it in `failed`. Nothing outside `plan.candidates` is ever passed to `kill`.
 */
export async function killCandidates(plan: ReapResult, deps: Pick<ReapDeps, "kill">): Promise<ReapResult> {
  const result: ReapResult = { ...plan, executed: true, killed: [], failed: [] };
  for (const candidate of plan.candidates) {
    try {
      await deps.kill(candidate.sandboxId);
      result.killed.push(candidate.sandboxId);
    } catch (err) {
      result.failed.push({ sandboxId: candidate.sandboxId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Live E2B deps for the CLI; every page of `Sandbox.list` is read. */
export function e2bReapDeps(apiKey: string): ReapDeps {
  return {
    async list(metadata) {
      const { Sandbox } = await import("e2b");
      const paginator = Sandbox.list({ apiKey, query: { metadata, state: ["running", "paused"] } });
      const items: ReapSandboxInfo[] = [];
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) {
          items.push({
            sandboxId: info.sandboxId,
            state: info.state,
            startedAt: info.startedAt,
            metadata: info.metadata ?? {},
            templateId: info.templateId,
          });
        }
      }
      return items;
    },
    async kill(sandboxId) {
      const { Sandbox } = await import("e2b");
      await Sandbox.kill(sandboxId, { apiKey });
    },
  };
}
