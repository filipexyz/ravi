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

import {
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { readDiskUsage, type DiskUsage } from "./disk.js";
import {
  isContainedIn,
  measureBytes,
  parseCodexRolloutMeta,
  parseCodexSessionId,
  RAVI_CODEX_ORIGINATOR,
  scanStorageAreas,
  type CodexProbe,
  type OmniBroadcastProbe,
  type StorageEntry,
} from "./eligibility.js";
import { isProtectedPath } from "./fsutil.js";
import { newestBackupPaths } from "./backups.js";
import { staticOmniProbe } from "./omni-probe.js";
import { resolveStoragePolicy, tmpNameMatchesAllowlist, type StoragePolicy, type StorageTier } from "./policy.js";
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
  /** Bytes actually removed. Always 0 on a dry-run. */
  freedBytes: number;
  /** Bytes the policy would remove. Equal to `freedBytes` after a clean execute. */
  wouldFreeBytes: number;
  classes: Record<string, StorageClassSummary>;
  disk: { before: DiskUsage | null; after: DiskUsage | null };
  errors: string[];
  blocked: string[];
  limitations: string[];
  removed: string[];
  preserved: string[];
  receiptId: string;
  receiptPath: string;
  executedAt: string;
}

const LOCK_FILE = ".cleanup.lock";
const PRESERVED_SAMPLE_LIMIT = 20;
/**
 * An unreadable lock is only considered stale after this long. The writer opens
 * the file and then writes the pid, so a reader can legitimately observe an
 * empty lock for a few microseconds; deleting it there would let two runs in.
 */
const LOCK_UNREADABLE_STALE_MS = 60_000;

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
      // The file exists (or the directory is not writable). Never steal a lock
      // without proof that its holder is gone AND the file is old enough that a
      // concurrent writer could not still be filling it in.
      if (!isLockStale(path)) return null;
      try {
        unlinkSync(path);
      } catch {
        /* raced */
      }
    }
  }
  return null;
}

function isLockStale(path: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // The file vanished between EEXIST and stat: retry immediately.
    return true;
  }
  let holderPid: number | null = null;
  let readable = false;
  try {
    const holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    readable = true;
    holderPid = typeof holder.pid === "number" ? holder.pid : null;
  } catch {
    /* unreadable/incomplete lock */
  }
  if (readable && holderPid !== null) return !isProcessAlive(holderPid);
  // Unreadable or pid-less: only stale once it is old enough to rule out a
  // writer that is still inside the open->write window.
  return Date.now() - mtimeMs > LOCK_UNREADABLE_STALE_MS;
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

/** Probes injected into the execute-time gate. */
export interface StorageProbes {
  codexProbe?: CodexProbe;
  taskProbe?: TaskProbe;
  omniBroadcastProbe?: OmniBroadcastProbe;
}

/** The single allowlist root that owns a class, when it has one. */
function classRoot(entry: StorageEntry, policy: StoragePolicy): string | null {
  switch (entry.area) {
    case "tmp-ravi":
      return entry.root;
    case "codex-inactive":
      return policy.codexSessionsDir;
    case "backups-superseded":
      return policy.backupsDir;
    case "instance-attachments":
      return policy.attachmentsDir;
    case "claude-jsonl":
      return policy.claudeProjectsDir;
    case "omni-broadcast-mp4":
      return policy.omniMediaDir;
    case "tasks-terminal":
      return policy.tasksDir;
    default:
      return null;
  }
}

/** Normalize a path to the `/`-separated form Omni stores for media paths. */
function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Exposed for tests: the execute-time re-verification gate for one candidate. */
export function canRemove(
  entry: StorageEntry,
  policy: StoragePolicy,
  now: number,
  probes: StorageProbes,
): string | null {
  let st;
  try {
    st = lstatSync(entry.path);
  } catch {
    return "entry disappeared before removal";
  }
  if (st.isSymbolicLink()) return "symlink not followed";
  // Only the class's own allowlist root is exempt from the protected roots: a
  // class root can live inside a protected root (`~/.codex/sessions`,
  // `~/.ravi/tasks`) and its candidates must stay removable. Everything else
  // inside those protected roots stays protected.
  const ownRoot = classRoot(entry, policy);
  const exemptions = ownRoot ? [ownRoot] : [];
  if (isProtectedPath(entry.path, policy.protectedPaths, exemptions)) return "protected path";

  switch (entry.area) {
    case "tmp-ravi": {
      if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
      if (!tmpNameMatchesAllowlist(basename(entry.path), policy.tmpNameAllowlist)) return "no longer matches allowlist";
      if (now - st.mtimeMs < policy.tmpMaxAgeMs) return "entry is younger than the threshold (re-checked)";
      return null;
    }
    case "codex-inactive": {
      if (!isContainedIn(entry.path, entry.root)) return "real path escapes allowlist root";
      if (!CODEX_ROLLOUT.test(basename(entry.path))) return "no longer a codex rollout artifact";
      // Re-check the class threshold like every other class: a rollout touched
      // between the scan and the removal (a resumed session writing to it) is
      // no longer the artifact the dry-run agreed to remove.
      if (now - st.mtimeMs < policy.codexMaxAgeMs) return "rollout is younger than the threshold (re-checked)";
      if (probes.codexProbe?.processRunning()) return "a live codex process is running";
      const ownership = parseCodexRolloutMeta(entry.path);
      const sessionId = ownership?.sessionId ?? parseCodexSessionId(entry.path);
      if (!sessionId || !ownership) return "session metadata unreadable (fail-closed)";
      if (ownership.originator !== RAVI_CODEX_ORIGINATOR) {
        return `rollout is not proven to belong to Ravi (originator=${ownership.originator ?? "missing"})`;
      }
      const liveness = probes.codexProbe?.sessionLiveness(sessionId) ?? "unknown";
      if (liveness !== "not-live") return `session liveness is ${liveness}`;
      return null;
    }
    case "backups-superseded": {
      const root = policy.backupsDir;
      if (!root) return "class disabled";
      if (!isContainedIn(entry.path, root)) return "real path escapes the backups root";
      if (!entry.path.startsWith(root + sep)) return "not a direct backup entry";
      // Re-prove supersession: if the newest backup of this type disappeared
      // since the scan, this entry is now the newest and must survive, or the
      // type would be left with no backup at all.
      if (newestBackupPaths(root).includes(entry.path)) {
        return "backup is now the newest of its type (re-checked)";
      }
      return null;
    }
    case "instance-attachments": {
      if (!policy.attachmentsDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.attachmentsDir)) return "real path escapes the attachments root";
      if (!st.isFile()) return "no longer a regular file";
      if (!ATTACHMENT_NAME.test(basename(entry.path))) return "name no longer matches the attachment allowlist";
      if (now - st.mtimeMs < policy.attachmentsMaxAgeMs) return "attachment is younger than the threshold (re-checked)";
      return null;
    }
    case "claude-jsonl": {
      if (!policy.claudeProjectsDir) return "class disabled";
      if (!isContainedIn(entry.path, policy.claudeProjectsDir)) return "real path escapes the Claude root";
      if (!CLAUDE_JSONL.test(basename(entry.path))) return "no longer a Claude transcript";
      if (entry.path.split(sep).includes("memory")) return "never delete */memory/*";
      if (now - st.mtimeMs < policy.claudeJsonlMaxAgeMs) return "transcript is younger than the threshold (re-checked)";
      return null;
    }
    case "omni-broadcast-mp4": {
      const root = policy.omniMediaDir;
      if (!root) return "class disabled";
      if (!isContainedIn(entry.path, root)) return "real path escapes the Omni media root";
      const name = basename(entry.path);
      if (!name.toLowerCase().endsWith(".mp4")) return "no longer an mp4 artifact";
      // Re-prove the status@broadcast match at removal time, exactly like the
      // Codex liveness re-check: a source that became unavailable preserves the
      // file instead of trusting the earlier scan.
      const probe = probes.omniBroadcastProbe;
      if (!probe) return "status@broadcast source not provided (fail-closed)";
      const probeResult = probe.listStatusBroadcastMedia();
      if (probeResult.error) return `status@broadcast source unavailable (${probeResult.error})`;
      if (now - st.mtimeMs < policy.omniBroadcastMaxAgeMs) return "video is younger than the threshold (re-checked)";
      const relativePath = normalizeRelative(relative(root, entry.path));
      const stem = name.slice(0, -4);
      const row = probeResult.rows.find((candidate) => normalizeRelative(candidate.localPath) === relativePath);
      if (!row) return "no matching status@broadcast externalId (re-checked)";
      if (row.externalId !== stem) return "status@broadcast externalId no longer matches the file name";
      if (now - row.postedAt < policy.omniBroadcastMaxAgeMs)
        return "status@broadcast message is younger than the threshold";
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
  const blocked: string[] = [];
  const removed: string[] = [];
  const removedSample: Array<{ path: string; bytes: number; reason: string }> = [];
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
    const wouldFreeBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);

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
      const probes: StorageProbes = {
        codexProbe: options.codexProbe,
        taskProbe: options.taskProbe,
        omniBroadcastProbe,
      };
      for (const entry of candidates) {
        const blockedReason = canRemove(entry, policy, now, probes);
        if (blockedReason) {
          // A candidate that the execute gate refuses is a deterministic
          // preservation, not a failure: it must not turn a healthy run red.
          blocked.push(`preserved ${entry.path}: ${blockedReason}`);
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
          if (removedSample.length < PRESERVED_SAMPLE_LIMIT) {
            removedSample.push({ path: entry.path, bytes: entry.bytes, reason: entry.reason });
          }
          freedBytes += entry.bytes;
          classOf(entry).removed += 1;
          classOf(entry).freedBytes += entry.bytes;
        } catch (error) {
          errors.push(`failed to remove ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      // A dry-run never frees anything: `freedBytes` stays 0 and the estimate
      // lives in `wouldFreeBytes`, so `summary` cannot double count.
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
      wouldFreeBytes,
      classes,
      disk: { before: probe, after: diskAfter },
      errors,
      blocked,
      limitations,
      removed,
      removedSample,
      preservedSample: entries
        .filter((entry) => entry.decision === "preserved")
        .slice(0, PRESERVED_SAMPLE_LIMIT)
        .map((entry) => ({ path: entry.path, bytes: entry.bytes, reason: entry.reason })),
    };
    const receiptPath = writeStorageReceipt(policy.receiptDir, receipt);
    // Retention applies to every run, dry-run included: a dry-run writes a
    // receipt too, so leaving its pruning to `--execute` leaks files.
    pruneStorageReceipts(policy.receiptDir, {
      maxCount: policy.receiptMaxCount,
      maxAgeMs: policy.receiptMaxAgeMs,
      now,
      keepPaths: [receiptPath],
    });

    return {
      success: errors.length === 0,
      op: "storage cleanup",
      tier: policy.tier,
      dryRun: !execute,
      policyVersion: policy.version,
      policyHash: policy.hash,
      freedBytes,
      wouldFreeBytes,
      classes,
      disk: { before: probe, after: diskAfter },
      errors,
      blocked,
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
