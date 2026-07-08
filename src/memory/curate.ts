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
import { scanInjection } from "./scan-injection.js";
import { scanSecret } from "./scan-secret.js";
import type { CurationSkipReason } from "./telemetry.js";
import { emitCurationCycleEvent } from "./telemetry.js";
import { DEFAULT_MEMORY_CAP_CHARS } from "./types.js";

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
 *      candidate). Overflow REJECTS with `R11:consolidation-thrash` — the
 *      LLM curator must consolidate before retrying.
 *   4. R10 / R26 — atomic write with drift detection. Drift returns without
 *      writing and drops a `.bak` next to the target.
 *   5. R22 — best-effort telemetry emission with the counters.
 */
export async function applyDeterministicGuard(input: ApplyGuardInput): Promise<ApplyGuardResult> {
  const cap = input.capChars ?? DEFAULT_MEMORY_CAP_CHARS;

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
      cap: { ok: true, proposedChars: 0, cap, overflowChars: 0 },
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

  if (!capVerdict.ok) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "rejected",
        reason: "R11:consolidation-thrash",
        detail: capVerdict.reason ?? `Projected write exceeds cap ${cap} by ${capVerdict.overflowChars}`,
      },
      scans: {
        secret: {
          hadSecret: secret.hasSecret,
          isCredentialOnly: false,
          matchCount: secret.matches.length,
        },
        injection: { hadInjection: injection.hasInjection, matchCount: injection.matches.length },
      },
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

  if (input.telemetry?.dryRun) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "written",
        finalContent: projectedContent,
        finalChars: projectedContent.length,
      },
      scans: {
        secret: {
          hadSecret: secret.hasSecret,
          isCredentialOnly: false,
          matchCount: secret.matches.length,
        },
        injection: { hadInjection: injection.hasInjection, matchCount: injection.matches.length },
      },
      cap: {
        ok: true,
        proposedChars: capVerdict.proposedChars,
        cap: capVerdict.cap,
        overflowChars: 0,
      },
    };
    await emitTelemetry(input, result);
    return result;
  }

  const writeResult = atomicWrite({
    targetPath: input.targetPath,
    newContent: projectedContent,
    ...(input.expectedPriorContent !== undefined ? { expectedPriorContent: input.expectedPriorContent } : {}),
  });

  if (!writeResult.written) {
    const result: ApplyGuardResult = {
      decision: {
        outcome: "drift",
        ...(writeResult.backupPath ? { backupPath: writeResult.backupPath } : {}),
        detail: writeResult.reason ?? "R10 drift refused write",
      },
      scans: {
        secret: {
          hadSecret: secret.hasSecret,
          isCredentialOnly: false,
          matchCount: secret.matches.length,
        },
        injection: { hadInjection: injection.hasInjection, matchCount: injection.matches.length },
      },
      cap: {
        ok: true,
        proposedChars: capVerdict.proposedChars,
        cap: capVerdict.cap,
        overflowChars: 0,
      },
    };
    await emitTelemetry(input, result, "R10:drift-refused");
    return result;
  }

  const result: ApplyGuardResult = {
    decision: {
      outcome: "written",
      finalContent: projectedContent,
      finalChars: writeResult.finalChars,
    },
    scans: {
      secret: {
        hadSecret: secret.hasSecret,
        isCredentialOnly: false,
        matchCount: secret.matches.length,
      },
      injection: { hadInjection: injection.hasInjection, matchCount: injection.matches.length },
    },
    cap: {
      ok: true,
      proposedChars: capVerdict.proposedChars,
      cap: capVerdict.cap,
      overflowChars: 0,
    },
  };
  await emitTelemetry(input, result);
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
): Promise<void> {
  if (!input.telemetry) {
    return;
  }
  const saved = result.decision.outcome === "written" ? 1 : 0;
  const skipped = skipReason ? 1 : 0;
  const stagedHitl = result.decision.outcome === "drift" ? 1 : 0;
  const skipReasons = skipReason ? { [skipReason]: 1 } : undefined;
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
    ...(skipReasons ? { skipReasons } : {}),
  });
}
