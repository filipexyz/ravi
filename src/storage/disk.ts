/**
 * Disk usage snapshots for `ravi storage` — the `df before/after` half of the
 * receipt contract.
 *
 * `statfs` is read-only and host-local. When the target does not exist (for
 * example a fixture receipt directory that has not been created yet) the
 * nearest existing ancestor is measured instead; when even that fails the
 * snapshot is `null` and the caller records a limitation instead of guessing.
 */

import { existsSync, statfsSync } from "node:fs";
import { dirname, parse } from "node:path";

export interface DiskUsage {
  /** Path whose filesystem was measured. */
  root: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

function nearestExisting(path: string): string | null {
  let current = path;
  const root = parse(current).root;
  for (;;) {
    if (existsSync(current)) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readDiskUsage(path: string): DiskUsage | null {
  const target = nearestExisting(path);
  if (!target) return null;
  try {
    const stats = statfsSync(target);
    const blockSize = stats.bsize;
    const totalBytes = stats.blocks * blockSize;
    const freeBytes = stats.bfree * blockSize;
    const availableBytes = stats.bavail * blockSize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const denominator = usedBytes + availableBytes;
    const usedPercent = denominator > 0 ? Math.round((usedBytes / denominator) * 1000) / 10 : 0;
    return { root: target, totalBytes, usedBytes, availableBytes, usedPercent };
  } catch {
    return null;
  }
}
