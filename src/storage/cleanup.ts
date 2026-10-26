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
 *  - removals are measured per class; partial failures are reported and never
 *    masked;
 *  - the receipt records per-class bytes and the disk (`df`) snapshot before
 *    and after the run.
 */

import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync, rmSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { readDiskUsage, type DiskUsage } from "./disk.js";
import {
  isContainedIn,
  measureBytes,
  parseCodexSessionId,
  scanStorageAreas,
  type CodexProbe,
  type OmniBroadcastProbe,
  type StorageEntry,
} from "./eligibility.js";
import { isProtectedPath } from "./fsutil.js";
import { staticOmniProbe } from "./omni-probe.js";
import {
  resolveClassExemptions,
  resolveStoragePolicy,
  tmpNameMatchesAllowlist,
  type StoragePolicy,
  type StorageTier,
} from "./policy.js";
import { isTerminalTask, taskTerminalStamp, type TaskProbe } from "./task-probe.js";
import {
  newStorageReceiptId,
  pruneStorageReceipts,
  writeStorageReceipt,
  type StorageClassSummary,
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
  /** status@broadcast reference source; absent preserves every video. */
  omniBroadcastProbe?: OmniBroadcastProbe;
}

export interface StorageCleanupResult {
  success: boolean;
  op: "storage cleanup";
  tier: StorageTier;
  dryRun: boolean;
  policyVersion: string;
  policyHash: string;
  freedBytes: number;
  classes: Record<string, StorageClassSummary>;
  disk: { before: DiskUsage | null; after: DiskUsage | null };
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

const NO_OMNI_PROBE: OmniBroadcastProbe = staticOmniProbe({
  rows: [],
  error: "status@broadcast source not provided",
});

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
const ATTACHMENT_NAME = /^\d{10,16}-[A-Za-z0-9]{8,}\.[A-Za-z0-9]{2,6}$/;
const CLAUDE_JSONL = /\.jsonl$/;

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
  const exemptions = resolveClassExemptions(policy);
  if (isProtectedPath(entry.path, policy.protectedPaths, exemptions)) return "protected path";

  switch (entry.area) {
    case "tmp-ravi": {
      if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
      if (!tmpNameMatchesAllowlist(basename(entry.path), policy.tmpNameAllowlist)) return "no longer matches allowlist";
      return null;
    }
    case "codex-inactive": {
      if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
      if (!CODEX_ROLLOUT.test(basename(entry.path))) return "no longer a codex rollout artifact";
      if (probes.codexProbe?.processRunning()) return "a live codex process is running";
      const sessionId = parseCodexSessionId(entry.path);
      if (!sessionId) return "session metadata unreadable (fail-closed)";
      const liveness = probes.codexProbe?.sessionLiveness(sessionId) ?? "unknown";
      if (liveness !== "not-live") return `session liveness is ${liveness}`;
      return null;
    }
    case "backups-superseded": {
      if (!policy.backupsDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.backupsDir)) return "real path escapes the backups root";
      if (!entry.path.startsWith(policy.backupsDir + sep)) return "not a direct backup entry";
      return null;
    }
    case "instance-attachments": {
      if (!policy.attachmentsDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.attachmentsDir)) return "real path escapes the attachments root";
      if (!st.isFile()) return "no longer a regular file";
      if (!ATTACHMENT_NAME.test(basename(entry.path))) return "name no longer matches the attachment allowlist";
      return null;
    }
    case "claude-jsonl": {
      if (!policy.claudeProjectsDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.claudeProjectsDir)) return "real path escapes the Claude root";
      if (!CLAUDE_JSONL.test(basename(entry.path))) return "no longer a Claude transcript";
      if (entry.path.split(sep).includes("memory")) return "never delete */memory/*";
      return null;
    }
    case "omni-broadcast-mp4": {
      if (!policy.omniMediaDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.omniMediaDir)) return "real path escapes the Omni media root";
      if (!basename(entry.path).toLowerCase().endsWith(".mp4")) return "no longer an mp4 artifact";
      // The externalId match cannot be re-proven here without a second source
      // read; the scan's positive match plus the age check is the gate, and any
      // late liveness change is recorded by the next run.
      return null;
    }
    case "tasks-terminal": {
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
    default:
      return "area removal is not wired";
  }
}

function removeTaskWorktree(entry: StorageEntry, probe?: TaskProbe): { ok: boolean; error?: string } {
  if (!probe) return { ok: false, error: "no task source available" };
  const { records } = probe.listWorktreeTasks();
  const record = records.find((candidate) => candidate.worktreePath === entry.path);
  if (!record) return { ok: false, error: "task record disappeared before removal" };
  return probe.remove(record);
}

function emptyClassSummary(): StorageClassSummary {
  return {
    candidates: 0,
    removed: 0,
    preserved: 0,
    eligibleBytes: 0,
    inDoubtBytes: 0,
    preservedBytes: 0,
    freedBytes: 0,
  };
}

export function runStorageCleanup(options: StorageCleanupOptions): StorageCleanupResult {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const execute = options.execute === true;
  const policy = resolveStoragePolicy(options.tier, env);
  const omniBroadcastProbe = options.omniBroadcastProbe ?? NO_OMNI_PROBE;

  const lock = acquireLock(policy.receiptDir);
  if (!lock) throw new StorageLockedError(join(policy.receiptDir, LOCK_FILE));

  const errors: string[] = [];
  const removed: string[] = [];
  let freedBytes = 0;

  try {
    const probe = readDiskUsage(policy.receiptDir);
    const scans = scanStorageAreas(policy, {
      now,
      codexProbe: options.codexProbe,
      taskProbe: options.taskProbe,
      omniBroadcastProbe,
    });
    const entries = scans.flatMap((scan) => scan.entries);
    const limitations = scans.flatMap((scan) => scan.limitations);
    const candidates = entries.filter((entry) => entry.decision === "candidate");

    const classes: Record<string, StorageClassSummary> = {};
    for (const scan of scans) classes[scan.area] = emptyClassSummary();
    const classOf = (entry: StorageEntry): StorageClassSummary => {
      classes[entry.area] ??= emptyClassSummary();
      return classes[entry.area];
    };

    for (const entry of entries) {
      if (entry.decision === "candidate") {
        classOf(entry).candidates += 1;
        classOf(entry).eligibleBytes += entry.bytes;
      } else {
        classOf(entry).preserved += 1;
        classOf(entry).preservedBytes += entry.bytes;
        if (entry.doubt) classOf(entry).inDoubtBytes += entry.bytes;
      }
    }

    if (execute) {
      const probes: StorageProbes = { codexProbe: options.codexProbe, taskProbe: options.taskProbe };
      for (const entry of candidates) {
        const blocked = canRemove(entry, policy, now, probes);
        if (blocked) {
          errors.push(`preserved ${entry.path}: ${blocked}`);
          const summary = classOf(entry);
          summary.candidates = Math.max(0, summary.candidates - 1);
          summary.eligibleBytes = Math.max(0, summary.eligibleBytes - entry.bytes);
          summary.preserved += 1;
          summary.preservedBytes += entry.bytes;
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
          classOf(entry).removed += 1;
          classOf(entry).freedBytes += entry.bytes;
        } catch (error) {
          errors.push(`failed to remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      freedBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of candidates) classOf(entry).freedBytes += entry.bytes;
    }

    const diskAfter = execute ? readDiskUsage(policy.receiptDir) : probe;
    const receiptId = newStorageReceiptId(now);
    const receipt: StorageReceipt = {
      schema: "ravi.storage.receipt/v2",
      id: receiptId,
      createdAt: new Date(now).toISOString(),
      tier: policy.tier,
      dryRun: !execute,
      policyVersion: policy.version,
      policyHash: policy.hash,
      freedBytes,
      classes,
      disk: { before: probe, after: diskAfter },
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
      freedBytes,
      classes,
      disk: { before: probe, after: diskAfter },
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
