/**
 * Storage cleanup engine — the deterministic, fail-closed orchestrator behind
 * `ravi storage cleanup`.
 *
 * Invariants implemented here:
 *  - dry-run is the default and never mutates a candidate root;
 *  - a single-instance lock guards the operation and a concurrent run fails
 *    closed without partial mutation;
 *  - every candidate is re-verified immediately before removal (lstat,
 *    allowlist, containment, protected paths);
 *  - removals are measured and individually recorded; partial failures are
 *    reported and never masked.
 */

import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync, rmSync } from "node:fs";
import { basename, join, sep } from "node:path";
import {
  isContainedIn,
  measureBytes,
  parseCodexSessionId,
  scanStorageAreas,
  type CodexProbe,
  type StorageEntry,
} from "./eligibility.js";
import { resolveStoragePolicy, tmpNameMatchesAllowlist, type StoragePolicy, type StorageTier } from "./policy.js";
import { isTerminalTask, taskTerminalStamp, type TaskProbe } from "./task-probe.js";
import {
  newStorageReceiptId,
  pruneStorageReceipts,
  writeStorageReceipt,
  type StorageAreaSummary,
  type StorageReceipt,
} from "./receipts.js";

export class StorageLockedError extends Error {
  constructor(readonly lockPath: string) {
    super(`another cleanup run holds the lock (${lockPath})`);
    this.name = "StorageLockedError";
  }
}

export interface StorageCleanupOptions {
  tier: StorageTier;
  execute?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Codex liveness probe; the default preserves every Codex artifact. */
  codexProbe?: CodexProbe;
  /** Task worktree probe; absent means every worktree is preserved. */
  taskProbe?: TaskProbe;
}

export interface StorageCleanupResult {
  success: boolean;
  op: "storage cleanup";
  tier: StorageTier;
  dryRun: boolean;
  policyVersion: string;
  policyHash: string;
  bytesBefore: number;
  bytesAfter: number;
  freedBytes: number;
  areas: Record<string, StorageAreaSummary>;
  errors: string[];
  limitations: string[];
  removed: string[];
  preserved: string[];
  receiptId: string;
  receiptPath: string;
  executedAt: string;
}

const LOCK_FILE = ".cleanup.lock";
const PRESERVED_SAMPLE_LIMIT = 20;

interface LockHandle {
  path: string;
  release(): void;
}

function acquireLock(dir: string): LockHandle | null {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return {
        path,
        release() {
          try {
            unlinkSync(path);
          } catch {
            /* already released */
          }
        },
      };
    } catch {
      let holderPid: number | null = null;
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
        holderPid = typeof holder.pid === "number" ? holder.pid : null;
      } catch {
        /* unreadable/incomplete lock */
      }
      const alive = holderPid !== null && isProcessAlive(holderPid);
      if (alive) return null;
      try {
        unlinkSync(path);
      } catch {
        /* raced */
      }
    }
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const CODEX_ROLLOUT = /^rollout-.*\.jsonl$/;

interface StorageProbes {
  codexProbe?: CodexProbe;
  taskProbe?: TaskProbe;
}

function canRemove(entry: StorageEntry, policy: StoragePolicy, now: number, probes: StorageProbes): string | null {
  let st;
  try {
    st = lstatSync(entry.path);
  } catch {
    return "entry disappeared before removal";
  }
  if (st.isSymbolicLink()) return "symlink not followed";
  if (isProtectedPath(entry.path, policy)) return "protected path";
  if (entry.area === "tmp-ravi") {
    if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
    if (!tmpNameMatchesAllowlist(basename(entry.path), policy.tmpNameAllowlist)) return "no longer matches allowlist";
    return null;
  }
  if (entry.area === "codex-inactive") {
    if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
    if (!CODEX_ROLLOUT.test(basename(entry.path))) return "no longer a codex rollout artifact";
    if (probes.codexProbe?.processRunning()) return "a live codex process is running";
    const sessionId = parseCodexSessionId(entry.path);
    if (!sessionId) return "session metadata unreadable (fail-closed)";
    const liveness = probes.codexProbe?.sessionLiveness(sessionId) ?? "unknown";
    if (liveness !== "not-live") return `session liveness is ${liveness}`;
    return null;
  }
  if (entry.area === "tasks-terminal") {
    const probe = probes.taskProbe;
    if (!probe) return "no task source available";
    const { records } = probe.listWorktreeTasks();
    const record = records.find((candidate) => candidate.worktreePath === entry.path);
    if (!record) return "task record not found or no longer a worktree task";
    if (!isTerminalTask(record)) return `task is not terminal (${record.status})`;
    if (now - taskTerminalStamp(record) < policy.taskMaxAgeMs) return "task is younger than the threshold";
    const assessment = probe.assess(record);
    return assessment.decision === "candidate" ? null : assessment.reason;
  }
  return "area removal is not wired";
}

function removeTaskWorktree(entry: StorageEntry, probe?: TaskProbe): { ok: boolean; error?: string } {
  if (!probe) return { ok: false, error: "no task source available" };
  const { records } = probe.listWorktreeTasks();
  const record = records.find((candidate) => candidate.worktreePath === entry.path);
  if (!record) return { ok: false, error: "task record disappeared before removal" };
  return probe.remove(record);
}

function isProtectedPath(target: string, policy: StoragePolicy): boolean {
  return policy.protectedPaths.some((root) => {
    const prefix = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(prefix);
  });
}

export function runStorageCleanup(options: StorageCleanupOptions): StorageCleanupResult {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const execute = options.execute === true;
  const policy = resolveStoragePolicy(options.tier, env);

  const lock = acquireLock(policy.receiptDir);
  if (!lock) throw new StorageLockedError(join(policy.receiptDir, LOCK_FILE));

  const errors: string[] = [];
  const removed: string[] = [];
  let freedBytes = 0;

  try {
    const scans = scanStorageAreas(policy, now, options.codexProbe, options.taskProbe);
    const entries = scans.flatMap((scan) => scan.entries);
    const limitations = scans.flatMap((scan) => scan.limitations);
    const candidates = entries.filter((entry) => entry.decision === "candidate");
    const bytesBefore = entries.reduce((sum, entry) => sum + entry.bytes, 0);

    const areas: Record<string, StorageAreaSummary> = {};
    for (const scan of scans) {
      areas[scan.area] = { candidates: 0, removed: 0, preserved: 0, freedBytes: 0 };
    }
    const areaOf = (entry: StorageEntry): StorageAreaSummary => {
      areas[entry.area] ??= { candidates: 0, removed: 0, preserved: 0, freedBytes: 0 };
      return areas[entry.area];
    };

    for (const entry of entries) {
      if (entry.decision === "candidate") areaOf(entry).candidates += 1;
      else areaOf(entry).preserved += 1;
    }

    if (execute) {
      const probes: StorageProbes = { codexProbe: options.codexProbe, taskProbe: options.taskProbe };
      for (const entry of candidates) {
        const blocked = canRemove(entry, policy, now, probes);
        if (blocked) {
          errors.push(`preserved ${entry.path}: ${blocked}`);
          areaOf(entry).preserved += 1;
          continue;
        }
        try {
          if (entry.area === "tasks-terminal") {
            const outcome = removeTaskWorktree(entry, options.taskProbe);
            if (!outcome.ok) {
              errors.push(`failed to remove ${entry.path}: ${outcome.error}`);
              continue;
            }
          } else {
            rmSync(entry.path, { recursive: true, force: false });
          }
          removed.push(entry.path);
          freedBytes += entry.bytes;
          areaOf(entry).removed += 1;
          areaOf(entry).freedBytes += entry.bytes;
        } catch (error) {
          errors.push(`failed to remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      freedBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
    }

    const bytesAfter = Math.max(0, bytesBefore - freedBytes);
    const receiptId = newStorageReceiptId(now);
    const receipt: StorageReceipt = {
      schema: "ravi.storage.receipt/v1",
      id: receiptId,
      createdAt: new Date(now).toISOString(),
      tier: policy.tier,
      dryRun: !execute,
      policyVersion: policy.version,
      policyHash: policy.hash,
      bytesBefore,
      bytesAfter,
      freedBytes,
      areas,
      errors,
      limitations,
      removed,
      preservedSample: entries
        .filter((entry) => entry.decision === "preserved")
        .slice(0, PRESERVED_SAMPLE_LIMIT)
        .map((entry) => ({ path: entry.path, bytes: entry.bytes, reason: entry.reason })),
    };
    const receiptPath = writeStorageReceipt(policy.receiptDir, receipt);
    if (execute) {
      pruneStorageReceipts(policy.receiptDir, {
        maxCount: policy.receiptMaxCount,
        maxAgeMs: policy.receiptMaxAgeMs,
        now,
        keepPaths: [receiptPath],
      });
    }

    return {
      success: errors.length === 0,
      op: "storage cleanup",
      tier: policy.tier,
      dryRun: !execute,
      policyVersion: policy.version,
      policyHash: policy.hash,
      bytesBefore,
      bytesAfter,
      freedBytes,
      areas,
      errors,
      limitations,
      removed,
      preserved: entries
        .filter((entry) => entry.decision === "preserved")
        .slice(0, PRESERVED_SAMPLE_LIMIT)
        .map((entry) => entry.path),
      receiptId,
      receiptPath,
      executedAt: new Date(now).toISOString(),
    };
  } finally {
    lock.release();
  }
}

/** Exposed for tests and the checker: measure a tree without mutating it. */
export { measureBytes };
