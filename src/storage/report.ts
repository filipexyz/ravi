/**
 * `ravi storage report` — read-only accounting of every class.
 *
 * The report answers the operator's question *before* any cleanup: how many
 * bytes live in each class, how much is eligible, and how much is in doubt
 * (unresolved signal, not merely "too young"). It writes nothing: no receipt,
 * no lock, no directory.
 */

import type { DiskUsage } from "./disk.js";
import { scanAllAreas, type ScanAllOptions } from "./eligibility.js";
import { STORAGE_CLASS_TIER, type StorageClassId, type StoragePolicy, type StorageTier } from "./policy.js";
import type { AreaScan } from "./types.js";

export interface StorageClassReport {
  id: StorageClassId;
  tier: StorageTier;
  /** Every byte the class considered (eligible + preserved). */
  scopeBytes: number;
  eligibleBytes: number;
  inDoubtBytes: number;
  preservedBytes: number;
  candidates: number;
  preserved: number;
  limitations: string[];
}

export interface StorageReport {
  success: boolean;
  op: "storage report";
  generatedAt: string;
  policyVersion: string;
  policyHash: string;
  classes: StorageClassReport[];
  totals: {
    scopeBytes: number;
    eligibleBytes: number;
    inDoubtBytes: number;
    preservedBytes: number;
    candidates: number;
    preserved: number;
  };
  disk: DiskUsage | null;
  limitations: string[];
}

function summarizeScan(scan: AreaScan): StorageClassReport {
  let scopeBytes = 0;
  let eligibleBytes = 0;
  let inDoubtBytes = 0;
  let preservedBytes = 0;
  let candidates = 0;
  let preserved = 0;
  for (const entry of scan.entries) {
    scopeBytes += entry.bytes;
    if (entry.decision === "candidate") {
      candidates += 1;
      eligibleBytes += entry.bytes;
      continue;
    }
    preserved += 1;
    preservedBytes += entry.bytes;
    if (entry.doubt) inDoubtBytes += entry.bytes;
  }
  return {
    id: scan.area as StorageClassId,
    tier: STORAGE_CLASS_TIER[scan.area as StorageClassId],
    scopeBytes,
    eligibleBytes,
    inDoubtBytes,
    preservedBytes,
    candidates,
    preserved,
    limitations: scan.limitations,
  };
}

export function buildStorageReport(
  policy: StoragePolicy,
  options: Omit<ScanAllOptions, "now"> & { now: number; disk: DiskUsage | null },
): StorageReport {
  const scans = scanAllAreas(policy, options);
  const classes = scans.map(summarizeScan);
  const totals = classes.reduce(
    (acc, entry) => ({
      scopeBytes: acc.scopeBytes + entry.scopeBytes,
      eligibleBytes: acc.eligibleBytes + entry.eligibleBytes,
      inDoubtBytes: acc.inDoubtBytes + entry.inDoubtBytes,
      preservedBytes: acc.preservedBytes + entry.preservedBytes,
      candidates: acc.candidates + entry.candidates,
      preserved: acc.preserved + entry.preserved,
    }),
    { scopeBytes: 0, eligibleBytes: 0, inDoubtBytes: 0, preservedBytes: 0, candidates: 0, preserved: 0 },
  );
  const limitations = classes.flatMap((entry) => entry.limitations);
  return {
    success: true,
    op: "storage report",
    generatedAt: new Date(options.now).toISOString(),
    policyVersion: policy.version,
    policyHash: policy.hash,
    classes,
    totals,
    disk: options.disk,
    limitations,
  };
}
