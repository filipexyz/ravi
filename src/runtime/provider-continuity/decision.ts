import { randomUUID } from "node:crypto";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  providerContinuityDecisionSchema,
  providerContinuityJournalSchema,
  type ProviderContinuityDecision,
  type ProviderContinuityFailureEvidence,
  type ProviderContinuityHoldReason,
  type ProviderContinuityJournal,
} from "./types.js";

export interface ProviderContinuityEligibility {
  targetIndex: number;
  eligible: boolean;
  rejectionReasons: string[];
  waitUntil?: number | null;
  probe?: boolean;
}

export interface ProviderContinuityDecisionResult {
  journal: ProviderContinuityJournal;
  decision: ProviderContinuityDecision;
  nextTargetIndex: number | null;
  shouldInvokeProvider: boolean;
}

function nextDecision(input: {
  journal: ProviderContinuityJournal;
  action: ProviderContinuityDecision["action"];
  fromTargetIndex?: number | null;
  toTargetIndex?: number | null;
  reasonCode: string;
  rejectionReasons?: string[];
  holdReason?: ProviderContinuityHoldReason | null;
  now: number;
}): ProviderContinuityDecision {
  return providerContinuityDecisionSchema.parse({
    decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
    logicalRequestId: input.journal.logicalRequestId,
    sequence: input.journal.decisions.length + 1,
    action: input.action,
    fromTargetIndex: input.fromTargetIndex ?? null,
    toTargetIndex: input.toTargetIndex ?? null,
    reasonCode: input.reasonCode,
    rejectionReasons: input.rejectionReasons ?? [],
    holdReason: input.holdReason ?? null,
    createdAt: input.now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
}

function withDecision(
  journal: ProviderContinuityJournal,
  decision: ProviderContinuityDecision,
  patch: Partial<ProviderContinuityJournal>,
): ProviderContinuityJournal {
  return providerContinuityJournalSchema.parse({
    ...journal,
    ...patch,
    decisions: [...journal.decisions, decision],
    updatedAt: decision.createdAt,
  });
}

function hold(
  journal: ProviderContinuityJournal,
  now: number,
  reason: ProviderContinuityHoldReason,
  reasonCode: string,
  rejectionReasons: string[] = [],
): ProviderContinuityDecisionResult {
  const decision = nextDecision({
    journal,
    action: reason === "effect_started" || reason === "effect_ambiguous" ? "reconcile" : "hold",
    fromTargetIndex: journal.currentTargetIndex,
    reasonCode,
    rejectionReasons,
    holdReason: reason,
    now,
  });
  const requiresReconciliation = reason === "effect_started" || reason === "effect_ambiguous";
  return {
    journal: withDecision(journal, decision, {
      state: requiresReconciliation ? "reconciliation_required" : "hold",
      holdReason: reason,
      terminalOutcome: null,
      terminalDetail: reasonCode,
    }),
    decision,
    nextTargetIndex: null,
    shouldInvokeProvider: false,
  };
}

function terminal(
  journal: ProviderContinuityJournal,
  now: number,
  action: "composed_failure" | "exhausted",
  reasonCode: string,
  rejectionReasons: string[],
): ProviderContinuityDecisionResult {
  const decision = nextDecision({
    journal,
    action,
    fromTargetIndex: journal.currentTargetIndex,
    reasonCode,
    rejectionReasons,
    now,
  });
  return {
    journal: withDecision(journal, decision, {
      state: action === "exhausted" ? "exhausted" : "failed",
      holdReason: null,
      terminalOutcome: action === "exhausted" ? "exhaustion" : "failure",
      terminalDetail: reasonCode,
    }),
    decision,
    nextTargetIndex: null,
    shouldInvokeProvider: false,
  };
}

export function decideProviderContinuityFailure(input: {
  journal: ProviderContinuityJournal;
  evidence?: ProviderContinuityFailureEvidence | null;
  eligibility: ProviderContinuityEligibility[];
  evidenceState?: "valid" | "missing" | "stale" | "conflicting" | "known_invalid";
  now?: number;
}): ProviderContinuityDecisionResult {
  const now = input.now ?? Date.now();
  const journal = providerContinuityJournalSchema.parse(input.journal);
  if (journal.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    return hold(journal, now, "snapshot_conflict", "compatibility_snapshot_mismatch");
  }
  if (journal.terminalOutcome !== null) {
    throw new Error(
      `Logical request '${journal.logicalRequestId}' already has terminal outcome '${journal.terminalOutcome}'.`,
    );
  }
  if (now >= journal.deadlineAt) {
    return terminal(journal, now, "exhausted", "deadline_expired", ["deadline_expired"]);
  }
  if (journal.effectBoundary === "started") {
    return hold(journal, now, "effect_started", "external_effect_started");
  }
  if (journal.effectBoundary === "ambiguous") {
    return hold(journal, now, "effect_ambiguous", "external_effect_ambiguous");
  }
  if (journal.effectBoundary === "terminal") {
    return terminal(journal, now, "composed_failure", "provider_failed_after_terminal_effect", [
      journal.activeEffectId ?? "terminal_effect",
    ]);
  }

  const evidenceState = input.evidenceState ?? (input.evidence ? "valid" : "missing");
  if (evidenceState !== "valid") {
    const reasonMap = {
      missing: "missing_evidence",
      stale: "stale_evidence",
      conflicting: "conflicting_evidence",
      known_invalid: "known_invalid_evidence",
    } as const;
    return hold(journal, now, reasonMap[evidenceState], `failure_evidence_${evidenceState}`);
  }
  const evidence = input.evidence;
  if (!evidence) return hold(journal, now, "missing_evidence", "failure_evidence_missing");
  if (evidence.kind === "unknown" || evidence.confidence === "low") {
    return hold(journal, now, "unknown_evidence", "failure_evidence_unknown");
  }
  if (evidence.kind === "permanent_request" || evidence.kind === "cancellation") {
    return terminal(journal, now, "composed_failure", `non_retryable_${evidence.kind}`, [
      evidence.code,
      evidence.fingerprint,
    ]);
  }
  if (journal.globalAttemptsRemaining <= 0) {
    return terminal(journal, now, "exhausted", "global_attempt_budget_exhausted", [
      `target:${journal.currentTargetIndex}`,
    ]);
  }

  const currentIndex = journal.currentTargetIndex;
  const credentialRemaining = journal.credentialRecoveriesRemaining[currentIndex] ?? 0;
  if (evidence.credentialRecoveryEligible && credentialRemaining > 0) {
    const nextCredentialBudget = [...journal.credentialRecoveriesRemaining];
    nextCredentialBudget[currentIndex] = credentialRemaining - 1;
    const decision = nextDecision({
      journal,
      action: "recover_credential",
      fromTargetIndex: currentIndex,
      toTargetIndex: currentIndex,
      reasonCode: `credential_recovery_${evidence.kind}`,
      now,
    });
    return {
      journal: withDecision(journal, decision, {
        state: "running",
        credentialRecoveriesRemaining: nextCredentialBudget,
        globalAttemptsRemaining: journal.globalAttemptsRemaining - 1,
      }),
      decision,
      nextTargetIndex: currentIndex,
      shouldInvokeProvider: true,
    };
  }

  const later = input.eligibility
    .filter((candidate) => candidate.targetIndex > currentIndex)
    .sort((left, right) => left.targetIndex - right.targetIndex);
  const next = later.find(
    (candidate) =>
      candidate.eligible &&
      (journal.normalAttemptsRemaining[candidate.targetIndex] ?? 0) > 0 &&
      journal.globalAttemptsRemaining > 0,
  );
  if (evidence.safeToSwitch && next) {
    let decisionJournal = journal;
    for (const candidate of later.filter((item) => item.targetIndex < next.targetIndex)) {
      const rejectionReasons = [...candidate.rejectionReasons];
      if ((journal.normalAttemptsRemaining[candidate.targetIndex] ?? 0) <= 0) {
        rejectionReasons.push("normal_attempt_budget_exhausted");
      }
      const skipDecision = nextDecision({
        journal: decisionJournal,
        action: "skip_target",
        fromTargetIndex: candidate.targetIndex,
        reasonCode: "target_ineligible_in_frozen_order",
        rejectionReasons,
        now,
      });
      decisionJournal = withDecision(decisionJournal, skipDecision, {});
    }
    const normalRemaining = [...journal.normalAttemptsRemaining];
    normalRemaining[next.targetIndex] = Math.max(0, (normalRemaining[next.targetIndex] ?? 0) - 1);
    const skipped = later
      .filter((candidate) => candidate.targetIndex < next.targetIndex)
      .flatMap((candidate) => candidate.rejectionReasons.map((reason) => `target[${candidate.targetIndex}]:${reason}`));
    const decision = nextDecision({
      journal: decisionJournal,
      action: next.probe ? "probe" : "switch_target",
      fromTargetIndex: currentIndex,
      toTargetIndex: next.targetIndex,
      reasonCode: `safe_switch_${evidence.kind}`,
      rejectionReasons: skipped,
      now,
    });
    return {
      journal: withDecision(decisionJournal, decision, {
        currentTargetIndex: next.targetIndex,
        state: "running",
        normalAttemptsRemaining: normalRemaining,
        globalAttemptsRemaining: journal.globalAttemptsRemaining - 1,
      }),
      decision,
      nextTargetIndex: next.targetIndex,
      shouldInvokeProvider: true,
    };
  }

  const waitCandidates = later
    .map((candidate) => candidate.waitUntil)
    .filter(
      (value): value is number => value !== null && value !== undefined && value > now && value < journal.deadlineAt,
    )
    .sort((left, right) => left - right);
  const wakeAt = waitCandidates[0];
  if (evidence.safeToSwitch && wakeAt !== undefined) {
    const decision = nextDecision({
      journal,
      action: "wait",
      fromTargetIndex: currentIndex,
      reasonCode: "eligible_target_wait",
      rejectionReasons: later.flatMap((candidate) =>
        candidate.rejectionReasons.map((reason) => `target[${candidate.targetIndex}]:${reason}`),
      ),
      now,
    });
    return {
      journal: withDecision(journal, decision, {
        state: "waiting",
        wakeAt,
      }),
      decision,
      nextTargetIndex: null,
      shouldInvokeProvider: false,
    };
  }

  return terminal(
    journal,
    now,
    "exhausted",
    evidence.safeToSwitch ? "no_eligible_target" : "failure_not_safe_to_switch",
    input.eligibility.flatMap((candidate) =>
      candidate.rejectionReasons.map((reason) => `target[${candidate.targetIndex}]:${reason}`),
    ),
  );
}
