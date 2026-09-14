/**
 * Storage receipts — one compact JSON record per run, with bounded retention.
 *
 * Receipts are never cleanup candidates and retention pruning never re-scans
 * the receipt directory as an allowlist root, and never deletes the receipt
 * currently being written.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StorageAreaSummary {
  candidates: number;
  removed: number;
  preserved: number;
  freedBytes: number;
}

export interface StorageReceipt {
  schema: "ravi.storage.receipt/v1";
  id: string;
  createdAt: string;
  tier: string;
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
  preservedSample: Array<{ path: string; bytes: number; reason: string }>;
}

export function newStorageReceiptId(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 10);
  return `cleanup-${stamp}-${rand}`;
}

export function writeStorageReceipt(dir: string, receipt: StorageReceipt): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${receipt.id}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return file;
}

export interface PruneReceiptsOptions {
  maxCount: number;
  maxAgeMs: number;
  now: number;
  keepPaths?: readonly string[];
}

/**
 * Delete receipts beyond the retention bound. Returns the removed paths.
 * `keepPaths` (the in-flight receipt) is always preserved.
 */
export function pruneStorageReceipts(dir: string, options: PruneReceiptsOptions): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const keep = new Set(options.keepPaths ?? []);
  const records = names
    .map((name) => {
      const path = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        /* ignored */
      }
      return { path, mtimeMs };
    })
    .filter((record) => !keep.has(record.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  records.forEach((record, index) => {
    const tooOld = options.now - record.mtimeMs > options.maxAgeMs;
    const overCount = index >= options.maxCount;
    if (!tooOld && !overCount) return;
    try {
      unlinkSync(record.path);
      removed.push(record.path);
    } catch {
      /* a concurrent run removed it first; retention is best-effort by design */
    }
  });
  return removed;
}
