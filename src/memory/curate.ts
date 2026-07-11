/**
 * Deterministic curation pipeline (guard-only, LLM-free).
 *
 * The full spec (memory/curation/deterministic-loop) delegates JUDGMENT to
 * the `curador-memoria` task profile — an LLM decides WHAT to save. This
 * module owns the DETERMINISTIC PART of the pipeline that runs before and
 * after the LLM: scan → cap → atomic write → telemetry. All invariants that
 * do not require judgment (R2 best-effort, R3 cap, R6/R9/R9b/R10/R11/R22) go
 * through here.
 *
 * `applyDeterministicGuard` returns a decision alongside the sanitized
 * content, telemetry counters, and a machine-readable reason enum. The
 * curator task uses this from the CLI (via `ravi memory ...` — future work)
 * or the caller (test / eval harness) invokes it directly.
 */

import { checkCap } from "./cap.js";
import { atomicWrite } from "./atomic-write.js";
import { evictOldestDiaryRows } from "./evict.js";
import { scanInjection } from "./scan-injection.js";
import { scanSecret } from "./scan-secret.js";
import type { CurationSkipReason } from "./telemetry.js";
import { emitCurationCycleEvent } from "./telemetry.js";
import { DEFAULT_CONSOLIDATION_MAX_ATTEMPTS, DEFAULT_MEMORY_FILE_CAP_CHARS, type MemoryStoreKind } from "./types.js";

export type GuardDecision =
  | { outcome: "written"; finalContent: string; finalChars: number }
  | { outcome: "rejected"; reason: CurationSkipReason; detail: string }
  | { outcome: "drift"; backupPath?: string; detail: string };

export interface GuardCandidate {
  content: string;
}

export interface ApplyGuardInput {
  targetPath: string;
  expectedPriorContent?: string;
  candidate: GuardCandidate;
  currentContent: string;
  capChars?: number;
  /**
   * R17 — which store this write targets. Emitted in telemetry so downstream
   * counts stay independent for MEMORY.md vs USER.md. Defaults to `"memory"`.
   */
  store?: MemoryStoreKind;
  /**
   * R11 — 1-indexed consolidation attempt within the current curator turn.
   * When the caller retries after an overflow, it MUST bump this counter.
   * Once the attempt exceeds `consolidationMaxAttempts` (default 3) the guard
   * stops asking the LLM to consolidate and applies the deterministic FIFO
   * eviction fallback (R11:evicted); only a store with nothing safe to evict
   * yields the terminal `R11:consolidation-thrash`.
   */
  consolidationAttempt?: number;
  consolidationMaxAttempts?: number;
  telemetry?: {
    agentId: string;
    cadenceTurn: number;
    sessionKey?: string;
    sessionName?: string;
    hadUserCorrection?: boolean;
    hookId?: string;
    taskId?: string;
    dryRun?: boolean;
  };
}

export interface ApplyGuardResult {
  decision: GuardDecision;
  scans: {
    secret: {
      hadSecret: boolean;
      isCredentialOnly: boolean;
      matchCount: number;
    };
    injection: {
      hadInjection: boolean;
      matchCount: number;
    };
  };
  cap: {
    ok: boolean;
    proposedChars: number;
    cap: number;
    overflowChars: number;
  };
}

/**
 * Run the deterministic guard end-to-end against a single candidate.
 *
 * Order matches the spec:
 *   1. R9b — secret / PII scan; a candidate whose entire value is a
 *      credential is REJECTED here and never touches disk. Otherwise the
 *      content is redacted-at-source before proceeding.
 *   2. R9 — injection scan; the wrapped copy is what will land on disk
 *      (keep-visible policy: the raw would still be readable, but the
 *      curator's write-back always carries the [BLOCKED:...] markers so a
 *      later prompt build cannot dodge them).
 *   3. R3 — cap check on the full projected file (current tail + new
 *      candidate). Overflow REJECTS with `R11:consolidation-thrash` while the
 *      curator still has consolidation attempts left. Once it exhausts
 *      `consolidationMaxAttempts` the runtime evicts the oldest Diário rows
 *      FIFO (R11 deterministic fallback, emits `R11:evicted`) so the store
 *      never freezes silently; if there is nothing safe to evict it keeps the
 *      honest terminal `R11:consolidation-thrash`.
 *   4. R10 / R26 — atomic write with drift detection. Drift returns without
 *      writing and drops a `.bak` next to the target.
 *   5. R22 — best-effort telemetry emission with the counters.
 */
export async function applyDeterministicGuard(input: ApplyGuardInput): Promise<ApplyGuardResult> {
  // WRITE cap = the file cap (decoupled from the read/injection cap, L1). The
  // caller (user store) still overrides via capChars; the memory store defaults
  // to the generous file cap so the index never blocks a write on size alone.
  const cap = input.capChars ?? DEFAULT_MEMORY_FILE_CAP_CHARS;
  const attempt = input.consolidationAttempt ?? 1;
  const maxAttempts = input.consolidationMaxAttempts ?? DEFAULT_CONSOLIDATION_MAX_ATTEMPTS;

  const secret = scanSecret(input.candidate.content);
  if (secret.isCredentialOnly) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "rejected",
        reason: "R9b:credential-rejected",
        detail: "Candidate value is a credential; refusing to persist even in redacted form",
      },
      scans: {
        secret: { hadSecret: true, isCredentialOnly: true, matchCount: secret.matches.length },
        injection: { hadInjection: false, matchCount: 0 },
      },
      // n13: cap was not evaluated (rejected at R9b before the cap check).
      // Report ok:false for consistency with the R11 pre-check above — never
      // signal a passing cap for a write that never happened.
      cap: { ok: false, proposedChars: 0, cap, overflowChars: 0 },
    };
    await emitTelemetry(input, result, "R9b:credential-rejected");
    return result;
  }

  const secretRedactedContent = secret.hasSecret ? secret.redacted : input.candidate.content;
  const injection = scanInjection(secretRedactedContent);
  const injectionWrapped = injection.hasInjection ? injection.wrapped : secretRedactedContent;

  const projectedContent = joinIndex(input.currentContent, injectionWrapped);
  const capVerdict = checkCap({
    currentContent: input.currentContent,
    proposedContent: projectedContent,
    capChars: cap,
  });

  const scans = {
    secret: {
      hadSecret: secret.hasSecret,
      isCredentialOnly: false,
      matchCount: secret.matches.length,
    },
    injection: { hadInjection: injection.hasInjection, matchCount: injection.matches.length },
  } as const;

  // Eviction state threads through the write path so telemetry can report the
  // R11:evicted counter and the on-disk content reflects the trimmed store.
  let effectiveProjected = projectedContent;
  let effectiveVerdict = capVerdict;
  let evictedRows = 0;

  if (!capVerdict.ok) {
    // While the LLM curator still has consolidation attempts left, reject and
    // let it try to shrink its own proposal (R11 judgment path). Only once it
    // exhausts `consolidationMaxAttempts` does the runtime take over with a
    // deterministic FIFO eviction so the store can never freeze silently.
    if (attempt <= maxAttempts) {
      const result: ApplyGuardResult = {
        decision: {
          outcome: "rejected",
          reason: "R11:consolidation-thrash",
          detail: capVerdict.reason ?? `Projected write exceeds cap ${cap} by ${capVerdict.overflowChars}`,
        },
        scans,
        cap: {
          ok: false,
          proposedChars: capVerdict.proposedChars,
          cap: capVerdict.cap,
          overflowChars: capVerdict.overflowChars,
        },
      };
      await emitTelemetry(input, result, "R11:consolidation-thrash");
      return result;
    }

    const eviction = evictOldestDiaryRows(input.currentContent, capVerdict.overflowChars);
    const evictedProjected = joinIndex(eviction.content, injectionWrapped);
    const evictedVerdict = checkCap({
      currentContent: eviction.content,
      proposedContent: evictedProjected,
      capChars: cap,
    });

    // Eviction only helps when there was a Diário table to trim AND the trim
    // actually brings the projected write under cap. Otherwise keep the honest
    // terminal outcome rather than corrupting the store to force a write.
    if (eviction.evictedRows === 0 || !evictedVerdict.ok) {
      const result: ApplyGuardResult = {
        decision: {
          outcome: "rejected",
          reason: "R11:consolidation-thrash",
          detail:
            eviction.evictedRows === 0
              ? `R11: consolidation exhausted (attempt ${attempt} > ${maxAttempts}) and no Diário rows to evict — leaving memory unchanged`
              : `R11: evicted ${eviction.evictedRows} Diário row(s) but projected write still exceeds cap ${cap}`,
        },
        scans,
        cap: {
          ok: false,
          proposedChars: capVerdict.proposedChars,
          cap: capVerdict.cap,
          overflowChars: capVerdict.overflowChars,
        },
      };
      await emitTelemetry(input, result, "R11:consolidation-thrash");
      return result;
    }

    effectiveProjected = evictedProjected;
    effectiveVerdict = evictedVerdict;
    evictedRows = eviction.evictedRows;
  }

  if (input.telemetry?.dryRun) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "written",
        finalContent: effectiveProjected,
        finalChars: effectiveProjected.length,
      },
      scans,
      cap: {
        ok: true,
        proposedChars: effectiveVerdict.proposedChars,
        cap: effectiveVerdict.cap,
        overflowChars: 0,
      },
    };
    await emitTelemetry(input, result, undefined, evictedRows);
    return result;
  }

  const writeResult = atomicWrite({
    targetPath: input.targetPath,
    newContent: effectiveProjected,
    ...(input.expectedPriorContent !== undefined ? { expectedPriorContent: input.expectedPriorContent } : {}),
  });

  if (!writeResult.written) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "drift",
        ...(writeResult.backupPath ? { backupPath: writeResult.backupPath } : {}),
        detail: writeResult.reason ?? "R10 drift refused write",
      },
      scans,
      cap: {
        ok: true,
        proposedChars: effectiveVerdict.proposedChars,
        cap: effectiveVerdict.cap,
        overflowChars: 0,
      },
    };
    await emitTelemetry(input, result, "R10:drift-refused");
    return result;
  }

  const result: ApplyGuardResult = {
    decision: {
      outcome: "written",
      finalContent: effectiveProjected,
      finalChars: writeResult.finalChars,
    },
    scans,
    cap: {
      ok: true,
      proposedChars: effectiveVerdict.proposedChars,
      cap: effectiveVerdict.cap,
      overflowChars: 0,
    },
  };
  await emitTelemetry(input, result, undefined, evictedRows);
  return result;
}

function joinIndex(currentContent: string, addition: string): string {
  if (!currentContent) {
    return addition;
  }
  const separator = currentContent.endsWith("\n") ? "" : "\n";
  return `${currentContent}${separator}${addition}`;
}

async function emitTelemetry(
  input: ApplyGuardInput,
  result: ApplyGuardResult,
  skipReason?: CurationSkipReason,
  evictedRows = 0,
): Promise<void> {
  if (!input.telemetry) {
    return;
  }
  const saved = result.decision.outcome === "written" ? 1 : 0;
  const skipped = skipReason ? 1 : 0;
  const stagedHitl = result.decision.outcome === "drift" ? 1 : 0;
  // R11:evicted is an observability counter, not a skip: a successful write
  // that had to trim the store still reports saved=1 while surfacing the trim.
  const skipReasons: Partial<Record<CurationSkipReason, number>> = {};
  if (skipReason) {
    skipReasons[skipReason] = 1;
  }
  if (evictedRows > 0) {
    skipReasons["R11:evicted"] = evictedRows;
  }
  const hasSkipReasons = Object.keys(skipReasons).length > 0;
  await emitCurationCycleEvent({
    agentId: input.telemetry.agentId,
    cadenceTurn: input.telemetry.cadenceTurn,
    proposed: 1,
    saved,
    skipped,
    stagedHitl,
    consolidations: 0,
    ...(input.telemetry.sessionKey ? { sessionKey: input.telemetry.sessionKey } : {}),
    ...(input.telemetry.sessionName ? { sessionName: input.telemetry.sessionName } : {}),
    ...(input.telemetry.hookId ? { hookId: input.telemetry.hookId } : {}),
    ...(input.telemetry.taskId ? { taskId: input.telemetry.taskId } : {}),
    ...(input.telemetry.dryRun !== undefined ? { dryRun: input.telemetry.dryRun } : {}),
    ...(input.telemetry.hadUserCorrection !== undefined
      ? { hadUserCorrection: input.telemetry.hadUserCorrection }
      : {}),
    driftDetected: result.decision.outcome === "drift",
    capBytesLimit: result.cap.cap,
    capBytesAfter: result.decision.outcome === "written" ? result.decision.finalChars : undefined,
    ...(hasSkipReasons ? { skipReasons } : {}),
  });
}
