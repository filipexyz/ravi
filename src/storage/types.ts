/**
 * Shared storage types. Kept free of scan logic so every class module and the
 * orchestrator can depend on it without an import cycle.
 */

import type { StorageClassId } from "./policy.js";

export type StorageArea = StorageClassId;
export type StorageDecision = "candidate" | "preserved";

export interface StorageEntry {
  area: StorageArea;
  /** The allowlist root this entry was found under (containment boundary). */
  root: string;
  path: string;
  bytes: number;
  decision: StorageDecision;
  reason: string;
  /**
   * True when the outcome is not a deterministic policy answer (too young,
   * newest of type, protected) but an unresolved ambiguity — unreadable
   * metadata, missing reference source, unmatched external id. `report` sums
   * these bytes as "in doubt" so an operator can see what needs attention.
   */
  doubt?: boolean;
}

export interface AreaScan {
  area: StorageArea;
  entries: StorageEntry[];
  limitations: string[];
}

/** Tri-state liveness: unknown is never treated as inactive. */
export type CodexSessionLiveness = "live" | "not-live" | "unknown";

export interface CodexProbe {
  processRunning(): boolean;
  sessionLiveness(sessionId: string): CodexSessionLiveness;
}

/** One status@broadcast media row read from the canonical Omni surface. */
export interface OmniBroadcastMedia {
  externalId: string;
  /** Path relative to the Omni media root, as stored by Omni. */
  localPath: string;
  /** Message timestamp in epoch ms. */
  postedAt: number;
}

export interface OmniBroadcastProbeResult {
  rows: OmniBroadcastMedia[];
  error?: string;
}

export interface OmniBroadcastProbe {
  listStatusBroadcastMedia(): OmniBroadcastProbeResult;
}
