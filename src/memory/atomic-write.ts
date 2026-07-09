/**
 * R10 — Atomic write with drift detection + .bak.
 *
 * Before rewriting, verify the on-disk content still matches what the caller
 * observed. If drift is detected (external edit / concurrent session), refuse
 * and drop a `.bak` — never silently truncate the divergent state.
 *
 * The write itself is temp+rename to guarantee readers never see a partial
 * file. Cold-start (R26) is a valid state: absent target ≠ drift.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AtomicWriteInput, AtomicWriteResult } from "./types.js";

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

  return {
    written: true,
    driftDetected: false,
    finalChars: input.newContent.length,
  };
}

function targetBaseName(targetPath: string): string {
  const parts = targetPath.split("/");
  return parts[parts.length - 1] ?? "target";
}
