/**
 * `ravi storage summary` — read-only aggregation of the receipt ledger.
 *
 * Only receipts inside the window are counted, and only *executed* receipts
 * contribute freed bytes: a dry-run records an estimate (`wouldFreeBytes`), so
 * summing it as "freed" would count the same space twice and report space that
 * was never released. A malformed receipt is reported (never silently ignored)
 * and a receipt recorded under a different policy hash is surfaced as drift
 * instead of being mixed into the current aggregate.
 */

import type { DiskUsage } from "./disk.js";
import { computeStoragePolicyHash } from "./policy.js";
import { readStorageReceipts, type ParseIssues } from "./receipts.js";

export interface StorageSummaryClass {
  freedBytes: number;
  runs: number;
}

export interface StorageSummary {
  success: boolean;
  op: "storage summary";
  generatedAt: string;
  since: string;
  sinceMs: number;
  windowStart: string;
  runs: number;
  executedRuns: number;
  freedBytes: number;
  /** Bytes the executed runs estimated before their execute-time gate. */
  wouldFreeBytes: number;
  classes: Record<string, StorageSummaryClass>;
  disk: DiskUsage | null;
  receiptDir: string;
  /** Receipts written under a different policy hash: excluded from the totals. */
  driftedReceipts: string[];
  invalidReceipts: string[];
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** Parse `7d`, `24h`, `90m`, `1w`, `500ms`. Returns null when invalid. */
export function parseStorageSince(value: string): { ms: number; normalized: string } | null {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "";
  const factor = DURATION_UNITS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || !factor) return null;
  return { ms: amount * factor, normalized: `${amount}${unit}` };
}

export interface BuildStorageSummaryOptions {
  receiptDir: string;
  sinceMs: number;
  since: string;
  now: number;
  disk: DiskUsage | null;
}

export function buildStorageSummary(options: BuildStorageSummaryOptions): StorageSummary {
  const issues: ParseIssues = { files: 0, invalid: [] };
  const cutoff = options.now - options.sinceMs;
  const policyHash = computeStoragePolicyHash();
  const windowed = readStorageReceipts(options.receiptDir, issues).filter(
    (receipt) => Date.parse(receipt.createdAt) >= cutoff,
  );
  const driftedReceipts = windowed.filter((receipt) => receipt.policyHash !== policyHash).map((receipt) => receipt.id);
  const receipts = windowed.filter((receipt) => receipt.policyHash === policyHash);

  const classes: Record<string, StorageSummaryClass> = {};
  let freedBytes = 0;
  let wouldFreeBytes = 0;
  let executedRuns = 0;
  for (const receipt of receipts) {
    // A dry-run records only an estimate; counting it as "freed" would report
    // space that was never released and double count a later execute.
    if (receipt.dryRun) continue;
    executedRuns += 1;
    freedBytes += receipt.freedBytes;
    wouldFreeBytes += receipt.wouldFreeBytes;
    const entries = Object.entries(receipt.classes);
    for (const [id, summary] of entries) {
      const bucket = (classes[id] ??= { freedBytes: 0, runs: 0 });
      bucket.freedBytes += summary.freedBytes;
      bucket.runs += 1;
    }
  }

  return {
    success: issues.invalid.length === 0 && driftedReceipts.length === 0,
    op: "storage summary",
    generatedAt: new Date(options.now).toISOString(),
    since: options.since,
    sinceMs: options.sinceMs,
    windowStart: new Date(cutoff).toISOString(),
    runs: receipts.length,
    executedRuns,
    freedBytes,
    wouldFreeBytes,
    classes,
    disk: options.disk,
    receiptDir: options.receiptDir,
    driftedReceipts,
    invalidReceipts: issues.invalid,
  };
}
