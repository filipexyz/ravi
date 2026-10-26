/**
 * `ravi storage summary` — read-only aggregation of the receipt ledger.
 *
 * Only receipts inside the window are counted. A malformed receipt is reported
 * (never silently ignored) and never breaks the aggregation.
 */

import type { DiskUsage } from "./disk.js";
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
  classes: Record<string, StorageSummaryClass>;
  disk: DiskUsage | null;
  receiptDir: string;
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
  const receipts = readStorageReceipts(options.receiptDir, issues).filter(
    (receipt) => Date.parse(receipt.createdAt) >= cutoff,
  );

  const classes: Record<string, StorageSummaryClass> = {};
  let freedBytes = 0;
  let executedRuns = 0;
  for (const receipt of receipts) {
    if (!receipt.dryRun) executedRuns += 1;
    freedBytes += receipt.freedBytes;
    const entries = Object.entries(receipt.classes);
    for (const [id, summary] of entries) {
      const bucket = (classes[id] ??= { freedBytes: 0, runs: 0 });
      bucket.freedBytes += summary.freedBytes;
      bucket.runs += 1;
    }
  }

  return {
    success: issues.invalid.length === 0,
    op: "storage summary",
    generatedAt: new Date(options.now).toISOString(),
    since: options.since,
    sinceMs: options.sinceMs,
    windowStart: new Date(cutoff).toISOString(),
    runs: receipts.length,
    executedRuns,
    freedBytes,
    classes,
    disk: options.disk,
    receiptDir: options.receiptDir,
    invalidReceipts: issues.invalid,
  };
}
