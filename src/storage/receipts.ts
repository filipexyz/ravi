/**
 * Storage receipts — one compact JSON record per run, with bounded retention.
 *
 * Receipts are never cleanup candidates and retention pruning never re-scans
 * the receipt directory as an allowlist root, and never deletes the receipt
 * currently being written. v2 adds per-class eligibility bytes and the `df`
 * before/after snapshot; v1 receipts stay readable so `summary` can span the
 * upgrade.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiskUsage } from "./disk.js";

export interface StorageClassSummary {
  candidates: number;
  removed: number;
  preserved: number;
  /** Aggregate bytes that the policy would remove (candidates). */
  eligibleBytes: number;
  /** Preserved bytes caused by an unresolved/ambiguous signal. */
  inDoubtBytes: number;
  /** Every preserved byte in the class (deterministic + in doubt). */
  preservedBytes: number;
  freedBytes: number;
}

export interface StorageReceipt {
  schema: "ravi.storage.receipt/v2";
  id: string;
  createdAt: string;
  tier: string;
  dryRun: boolean;
  policyVersion: string;
  policyHash: string;
  /** Bytes actually removed. Always 0 on a dry-run. */
  freedBytes: number;
  /** Bytes the policy would remove (the dry-run estimate). */
  wouldFreeBytes: number;
  classes: Record<string, StorageClassSummary>;
  disk: { before: DiskUsage | null; after: DiskUsage | null };
  errors: string[];
  /** Candidates the execute gate preserved (deterministic, not a failure). */
  blocked: string[];
  limitations: string[];
  removed: string[];
  removedSample: Array<{ path: string; bytes: number; reason: string }>;
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

interface LegacyAreaSummary {
  candidates?: number;
  removed?: number;
  preserved?: number;
  eligibleBytes?: number;
  inDoubtBytes?: number;
  preservedBytes?: number;
  freedBytes?: number;
}

interface LegacyReceipt {
  schema?: string;
  id?: string;
  createdAt?: string;
  tier?: string;
  dryRun?: boolean;
  policyVersion?: string;
  policyHash?: string;
  freedBytes?: number;
  wouldFreeBytes?: number;
  classes?: Record<string, Partial<StorageClassSummary>>;
  areas?: Record<string, LegacyAreaSummary>;
  disk?: { before?: DiskUsage | null; after?: DiskUsage | null } | null;
  errors?: string[];
  blocked?: string[];
  limitations?: string[];
  removed?: string[];
  removedSample?: Array<{ path: string; bytes: number; reason: string }>;
  preservedSample?: Array<{ path: string; bytes: number; reason: string }>;
}

/** A finite, non-negative count/byte value; null when the receipt is damaged. */
function finiteNumber(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function normalizeStorageReceipt(raw: LegacyReceipt): StorageReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const sourceClasses = raw.classes ?? raw.areas;
  if (!sourceClasses || typeof sourceClasses !== "object") return null;
  const classes: Record<string, StorageClassSummary> = {};
  for (const [id, summary] of Object.entries(sourceClasses)) {
    const preserved = Number(summary.preserved ?? 0);
    const fields = {
      candidates: finiteNumber(summary.candidates),
      removed: finiteNumber(summary.removed),
      preserved: finiteNumber(preserved),
      eligibleBytes: finiteNumber(summary.eligibleBytes),
      inDoubtBytes: finiteNumber(summary.inDoubtBytes),
      preservedBytes: finiteNumber(summary.preservedBytes),
      freedBytes: finiteNumber(summary.freedBytes),
    };
    // A damaged class row invalidates the receipt instead of silently counting 0.
    if (Object.values(fields).some((value) => value === null)) return null;
    classes[id] = fields as StorageClassSummary;
  }
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) return null;
  const freedBytes = finiteNumber(raw.freedBytes);
  if (freedBytes === null) return null;
  const wouldFreeBytes = finiteNumber(raw.wouldFreeBytes);
  if (wouldFreeBytes === null) return null;
  return {
    schema: "ravi.storage.receipt/v2",
    id: typeof raw.id === "string" ? raw.id : "legacy",
    createdAt: raw.createdAt,
    tier: typeof raw.tier === "string" ? raw.tier : "unknown",
    dryRun: raw.dryRun === true,
    policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : "0",
    policyHash: typeof raw.policyHash === "string" ? raw.policyHash : "",
    freedBytes,
    wouldFreeBytes,
    classes,
    disk: { before: raw.disk?.before ?? null, after: raw.disk?.after ?? null },
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    blocked: Array.isArray(raw.blocked) ? raw.blocked : [],
    limitations: Array.isArray(raw.limitations) ? raw.limitations : [],
    removed: Array.isArray(raw.removed) ? raw.removed : [],
    removedSample: Array.isArray(raw.removedSample) ? raw.removedSample : [],
    preservedSample: Array.isArray(raw.preservedSample) ? raw.preservedSample : [],
  };
}

export interface ParseIssues {
  files: number;
  invalid: string[];
}

/** Read every receipt file in `dir`, normalizing v1 rows. Never throws. */
export function readStorageReceipts(dir: string, issues?: ParseIssues): StorageReceipt[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const receipts: StorageReceipt[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (issues) issues.files += 1;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as LegacyReceipt;
      const normalized = normalizeStorageReceipt(parsed);
      if (normalized) receipts.push(normalized);
      else issues?.invalid.push(path);
    } catch {
      issues?.invalid.push(path);
    }
  }
  return receipts.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
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
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  records.forEach((record, index) => {
    // `keepPaths` still consumes one slot of the cap; otherwise the in-flight
    // receipt lets the directory hold `maxCount + 1` files forever.
    const tooOld = options.now - record.mtimeMs > options.maxAgeMs;
    const overCount = index >= options.maxCount;
    if (!tooOld && !overCount) return;
    if (keep.has(record.path)) return;
    try {
      unlinkSync(record.path);
      removed.push(record.path);
    } catch {
      /* a concurrent run removed it first; retention is best-effort by design */
    }
  });
  return removed;
}
