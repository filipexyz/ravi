/**
 * R10 — Atomic write with drift detection + .bak + per-target write lock.
 *
 * Before rewriting, verify the on-disk content still matches what the caller
 * observed. If drift is detected (external edit / concurrent session), refuse
 * and drop a `.bak` — never silently truncate the divergent state.
 *
 * The write itself is temp+rename to guarantee readers never see a partial
 * file. Cold-start (R26) is a valid state: absent target ≠ drift.
 *
 * m3 — lost-update / TOCTOU: the drift check and the rename are NOT atomic on
 * their own. Two curation cycles for the same agent (distinct sessions) can
 * both read the same prior content, both pass the drift check, and both rename
 * — the second silently clobbers the first. An `O_EXCL` lock file held across
 * the entire read→compare→rename critical section serializes writers to a
 * single target so at most one wins; the loser is reported as `lockContention`
 * and retries on the next cadence instead of overwriting.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AtomicWriteInput, AtomicWriteResult } from "./types.js";

/**
 * A lock older than this is treated as abandoned by a crashed writer and
 * stolen, so a crash can never wedge an agent's memory permanently. Curator
 * writes are sub-second; 30s is orders of magnitude of headroom.
 */
const STALE_LOCK_MS = 30_000;

/**
 * Perform an atomic write.
 *
 * Returns `written=false` when either drift is detected (the target changed
 * externally since the caller last read it) or the write cannot proceed. In
 * the drift case, a `.bak` snapshot of the on-disk state is written next to
 * the target so an operator can reconcile.
 *
 * Cold-start (R26): if the target does not exist and no expected prior content
 * was supplied, the write proceeds as-if fresh — absence is not drift.
 */
export function atomicWrite(input: AtomicWriteInput): AtomicWriteResult {
  // m3: serialize all writers to this target across the whole
  // read→compare→rename section. Without the lock, two concurrent cycles both
  // pass the drift check and the second rename clobbers the first.
  const lock = acquireWriteLock(input.targetPath);
  if (!lock) {
    return {
      written: false,
      driftDetected: false,
      lockContention: true,
      finalChars: 0,
      reason: "R10: another writer holds the target lock; refused to avoid a lost update — retry next cycle",
    };
  }

  try {
    const targetExists = existsSync(input.targetPath);

    if (input.expectedPriorContent !== undefined) {
      const onDisk = targetExists ? readFileSync(input.targetPath, "utf-8") : "";
      if (onDisk !== input.expectedPriorContent) {
        const backupPath = `${input.targetPath}.bak`;
        writeFileSync(backupPath, onDisk, "utf-8");
        return {
          written: false,
          driftDetected: true,
          backupPath,
          finalChars: onDisk.length,
          reason: `R10: on-disk content diverged from expectedPriorContent; wrote ${backupPath}`,
        };
      }
    } else if (targetExists) {
      const stats = statSync(input.targetPath);
      if (stats.size > 0) {
        // No expectation provided and file is populated. Refuse rather than
        // clobber unknown state — force the caller to pass expectedPriorContent.
        return {
          written: false,
          driftDetected: true,
          finalChars: stats.size,
          reason: "R10: target exists and is non-empty but no expectedPriorContent was supplied",
        };
      }
    }

    const tmpName = `.${randomUUID()}.tmp`;
    const tmpPath = join(dirname(input.targetPath), `${targetBaseName(input.targetPath)}${tmpName}`);
    // m5: fsync the temp file before the rename so a crash between write and FS
    // commit cannot leave a rename-visible but zero-length file after reboot.
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, input.newContent);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, input.targetPath);
    // m5-follow-up: fsync the parent directory so the rename itself is durable —
    // without it a crash right after the rename can lose the directory entry
    // even though the file bytes were fsync'd, breaking the crash-safety claim.
    fsyncDir(dirname(input.targetPath));

    return {
      written: true,
      driftDetected: false,
      finalChars: input.newContent.length,
    };
  } finally {
    releaseWriteLock(input.targetPath, lock);
  }
}

/**
 * Acquire an exclusive per-target write lock via `O_EXCL` (`wx`). Returns the
 * open lock fd on success, or null when another live writer holds it. A lock
 * whose mtime is older than STALE_LOCK_MS is assumed abandoned by a crashed
 * writer and stolen, so a crash can never wedge memory permanently.
 */
function acquireWriteLock(targetPath: string): number | null {
  const lockPath = `${targetPath}.lock`;
  try {
    return openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
  // Lock exists — steal it only if it is provably stale.
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < STALE_LOCK_MS) {
      return null;
    }
    rmSync(lockPath, { force: true });
    return openSync(lockPath, "wx");
  } catch (err) {
    // Lost a race to steal (another writer recreated it) or it vanished — treat
    // as live contention rather than forcing a write.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw err;
  }
}

function releaseWriteLock(targetPath: string, fd: number): void {
  const lockPath = `${targetPath}.lock`;
  try {
    closeSync(fd);
  } catch {
    /* best-effort */
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* best-effort — a stolen-then-recreated lock is self-healing via mtime */
  }
}

function fsyncDir(dir: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch {
    // Some platforms (or a directory fsync on certain filesystems) reject this;
    // it is a durability hardening, never a correctness gate — degrade quietly.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        /* best-effort */
      }
    }
  }
}

function targetBaseName(targetPath: string): string {
  const parts = targetPath.split("/");
  return parts[parts.length - 1] ?? "target";
}
