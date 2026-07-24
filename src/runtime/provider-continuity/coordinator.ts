import { createHash, randomUUID } from "node:crypto";
import { getRecentHistory } from "../../db.js";
import { classifyProviderContinuityFailure } from "../credential-classifier.js";
import type { RuntimeLaunchPrompt } from "../message-types.js";
import { getRuntimeCompatibilityIssues } from "../provider-registry.js";
import type { RuntimeCompatibilityRequest } from "../types.js";
import {
  buildProviderContinuityContextFromPrompt,
  resumePromptFromPortableContext,
  translateProviderContinuityContext,
} from "./context.js";
import { decideProviderContinuityFailure, type ProviderContinuityEligibility } from "./decision.js";
import {
  buildProviderContinuityEffectId,
  completeProviderContinuityEffect,
  markProviderContinuityEffectAmbiguous,
  markProviderContinuityEffectStarted,
  prepareProviderContinuityEffect,
} from "./effects.js";
import { publicProviderContinuityJournal, recordProviderContinuityEvent } from "./events.js";
import { isProviderContinuityLiveEnabled, validateProviderContinuityPolicy } from "./policy.js";
import {
  acquireProviderContinuityProbeLease,
  inspectProviderContinuityTargetEligibility,
  readProviderContinuityHealth,
  recordProviderContinuityTargetFailure,
  recordProviderContinuityTargetSuccess,
} from "./recovery.js";
import {
  getActiveProviderContinuityJournalForSession,
  getProviderContinuityEffect,
  getProviderContinuityJournal,
  getProviderContinuityPolicy,
  requireProviderContinuityJournal,
  saveProviderContinuityJournal,
} from "./store.js";
import {
  PROVIDER_CONTINUITY_DEFAULT_COMPATIBILITY_REQUEST,
  PROVIDER_CONTINUITY_DEFAULTS,
  PROVIDER_CONTINUITY_LIVE_BLOCK_REASON,
  PROVIDER_CONTINUITY_SNAPSHOT,
  providerContinuityAttemptSchema,
  providerContinuityCompatibilityRequestSchema,
  providerContinuityContractHeader,
  providerContinuityDecisionSchema,
  providerContinuityJournalSchema,
  providerContinuityPromptMetadataSchema,
  type ProviderContinuityAttempt,
  type ProviderContinuityCompatibilityRequest,
  type ProviderContinuityDecision,
  type ProviderContinuityJournal,
  type ProviderContinuityPolicy,
  type ProviderContinuityPromptMetadata,
  type ProviderContinuityTarget,
} from "./types.js";

/**
 * Resolve a caller-supplied compatibility request into the concrete shape frozen in the journal.
 * Missing fields fall back to the conservative unrestricted default (skips nothing).
 */
function normalizeProviderContinuityCompatibilityRequest(
  request?: RuntimeCompatibilityRequest | null,
): ProviderContinuityCompatibilityRequest {
  return providerContinuityCompatibilityRequestSchema.parse({
    requiresMcpServers:
      request?.requiresMcpServers ?? PROVIDER_CONTINUITY_DEFAULT_COMPATIBILITY_REQUEST.requiresMcpServers,
    requiresRemoteSpawn:
      request?.requiresRemoteSpawn ?? PROVIDER_CONTINUITY_DEFAULT_COMPATIBILITY_REQUEST.requiresRemoteSpawn,
    toolAccessMode: request?.toolAccessMode ?? PROVIDER_CONTINUITY_DEFAULT_COMPATIBILITY_REQUEST.toolAccessMode,
  });
}

/**
 * Runtime-compatibility rejection reasons for routing THIS turn onto `target`. Empty means the
 * provider can serve the turn. A target whose provider is unknown/unloadable cannot serve it either,
 * so it is reported as incompatible rather than throwing and aborting the whole selection.
 */
function providerContinuityCompatibilityRejections(
  target: ProviderContinuityTarget,
  compatibility: ProviderContinuityCompatibilityRequest,
): string[] {
  try {
    return getRuntimeCompatibilityIssues(target.provider, compatibility).map((issue) => `compatibility:${issue.code}`);
  } catch {
    return ["compatibility:provider_unavailable"];
  }
}

function shortHash(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function logicalRequestIdFor(input: { agentId: string; sessionName: string; prompt: RuntimeLaunchPrompt }): string {
  const sourceId = input.prompt.context?.messageId ?? input.prompt.source?.sourceMessageId;
  return sourceId
    ? `pcr_${shortHash(`${input.agentId}\u0000${input.sessionName}\u0000${sourceId}`)}`
    : `pcr_${randomUUID().replaceAll("-", "")}`;
}

function attemptIdFor(logicalRequestId: string, sequence: number, targetIndex: number): string {
  return `pca_${shortHash(`${logicalRequestId}\u0000${sequence}\u0000${targetIndex}`)}`;
}

function deliveryIdFor(logicalRequestId: string): string {
  return `pcdly_${shortHash(`${logicalRequestId}\u0000delivery`)}`;
}

function portableHistoryForSession(sessionName: string) {
  return getRecentHistory(sessionName, 48).map((message) => {
    const createdAt = Date.parse(message.created_at);
    return {
      id: message.source_message_id?.trim() || `db-message-${message.id}`,
      role: message.role,
      content: message.content,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
    } as const;
  });
}

function policyConfigSnapshot(policy: ProviderContinuityPolicy) {
  return validateProviderContinuityPolicy({
    specVersion: policy.specVersion,
    compatibilitySnapshotId: policy.compatibilitySnapshotId,
    strategy: policy.strategy,
    targets: policy.targets,
    deadlineMs: policy.deadlineMs,
    enabled: policy.enabled,
  });
}

function promptMetadata(input: {
  journal: ProviderContinuityJournal;
  attempt: ProviderContinuityAttempt;
  probeLeaseId?: string | null;
  synthetic: boolean;
}): ProviderContinuityPromptMetadata {
  return providerContinuityPromptMetadataSchema.parse({
    logicalRequestId: input.journal.logicalRequestId,
    policyVersion: input.journal.policyVersion,
    targetIndex: input.attempt.targetIndex,
    target: input.attempt.target,
    attemptId: input.attempt.attemptId,
    contextFingerprint: input.journal.contextSnapshot.fingerprint,
    deliveryId: input.journal.deliveryId,
    probeLeaseId: input.probeLeaseId ?? input.attempt.probeLeaseId,
    synthetic: input.synthetic,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
}

function runningProbeLeaseIsCurrent(
  journal: ProviderContinuityJournal,
  attempt: ProviderContinuityAttempt,
  now: number,
): boolean {
  if (attempt.kind !== "probe") return true;
  const health = readProviderContinuityHealth({
    agentId: journal.agentId,
    target: attempt.target,
    now,
  });
  return (
    attempt.probeLeaseId !== null &&
    health.state === "half_open" &&
    health.probeLeaseId === attempt.probeLeaseId &&
    (health.probeLeaseExpiresAt ?? 0) > now
  );
}

function holdStaleRunningProbe(
  journal: ProviderContinuityJournal,
  attempt: ProviderContinuityAttempt,
  now: number,
): ProviderContinuityJournal {
  const decision = providerContinuityDecisionSchema.parse({
    decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
    logicalRequestId: journal.logicalRequestId,
    sequence: journal.decisions.length + 1,
    action: "hold",
    fromTargetIndex: attempt.targetIndex,
    toTargetIndex: null,
    reasonCode: "probe_lease_not_current",
    rejectionReasons: ["stale_or_expired_probe_lease"],
    holdReason: "stale_evidence",
    createdAt: now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  const held = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...journal,
      attempts: journal.attempts.map((candidate) =>
        candidate.attemptId === attempt.attemptId && candidate.outcome === "running"
          ? { ...candidate, completedAt: now, outcome: "hold" as const }
          : candidate,
      ),
      decisions: [...journal.decisions, decision],
      state: "hold",
      holdReason: "stale_evidence",
      terminalDetail: "probe_lease_not_current",
      updatedAt: now,
    }),
  );
  recordProviderContinuityEvent({
    logicalRequestId: held.logicalRequestId,
    agentId: held.agentId,
    type: "continuity.decision.hold",
    payload: { decision, attemptId: attempt.attemptId },
    now,
  });
  return held;
}

export function applyProviderContinuityTargetToPrompt(
  prompt: RuntimeLaunchPrompt,
  metadata: ProviderContinuityPromptMetadata,
): RuntimeLaunchPrompt {
  return {
    ...prompt,
    _runtimeProviderId: metadata.target.provider,
    _runtimeModel: metadata.target.model,
    _continuity: metadata,
  };
}

export type ProviderContinuityPreparation =
  | {
      active: false;
      reason: "no_policy" | "policy_disabled" | "live_activation_blocked";
      prompt: RuntimeLaunchPrompt;
    }
  | {
      active: true;
      ready: true;
      reason: "new_request" | "resume";
      prompt: RuntimeLaunchPrompt;
      journal: ProviderContinuityJournal;
      metadata: ProviderContinuityPromptMetadata;
    }
  | {
      active: true;
      ready: false;
      reason: "waiting" | "hold" | "terminal";
      prompt: RuntimeLaunchPrompt;
      journal: ProviderContinuityJournal;
      userMessage: string;
    };

function preparationFromExisting(
  prompt: RuntimeLaunchPrompt,
  persistedJournal: ProviderContinuityJournal,
  synthetic: boolean,
  now: number,
): ProviderContinuityPreparation {
  let journal = persistedJournal;
  if (
    journal.terminalOutcome === null &&
    journal.state === "waiting" &&
    journal.wakeAt !== null &&
    journal.wakeAt <= now
  ) {
    journal = wakeProviderContinuityJournal(journal.logicalRequestId, now).journal;
  }
  if (journal.terminalOutcome === null && now >= journal.deadlineAt) {
    journal = resumeProviderContinuityJournal(journal.logicalRequestId, now).journal;
  }
  if (journal.terminalOutcome === null && journal.state === "pending") {
    journal = resumeProviderContinuityJournal(journal.logicalRequestId, now).journal;
  }
  if (journal.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    return {
      active: true,
      ready: false,
      reason: "hold",
      prompt,
      journal,
      userMessage: "Provider continuity is on HOLD because its compatibility snapshot does not match this runtime.",
    };
  }
  if (journal.terminalOutcome !== null) {
    return {
      active: true,
      ready: false,
      reason: "terminal",
      prompt,
      journal,
      userMessage:
        journal.terminalOutcome === "success"
          ? "This logical request already completed."
          : `Provider continuity stopped: ${journal.terminalDetail ?? journal.terminalOutcome}.`,
    };
  }
  if (journal.state === "hold" || journal.state === "reconciliation_required") {
    return {
      active: true,
      ready: false,
      reason: "hold",
      prompt,
      journal,
      userMessage: `Provider continuity is on HOLD: ${journal.holdReason ?? journal.terminalDetail ?? "manual repair required"}.`,
    };
  }
  if (journal.state === "waiting") {
    return {
      active: true,
      ready: false,
      reason: "waiting",
      prompt,
      journal,
      userMessage: `Provider continuity is waiting until ${journal.wakeAt ?? journal.deadlineAt}.`,
    };
  }
  const attempt = [...journal.attempts].reverse().find((candidate) => candidate.outcome === "running");
  if (!attempt) {
    return {
      active: true,
      ready: false,
      reason: "hold",
      prompt,
      journal,
      userMessage: "Provider continuity is on HOLD because no persisted running attempt exists.",
    };
  }
  if (!runningProbeLeaseIsCurrent(journal, attempt, now)) {
    journal = holdStaleRunningProbe(journal, attempt, now);
    return {
      active: true,
      ready: false,
      reason: "hold",
      prompt,
      journal,
      userMessage: "Provider continuity is on HOLD because its persisted probe lease is no longer current.",
    };
  }
  const metadata = promptMetadata({
    journal,
    attempt,
    probeLeaseId: prompt._continuity?.probeLeaseId,
    synthetic,
  });
  return {
    active: true,
    ready: true,
    reason: "resume",
    prompt: applyProviderContinuityTargetToPrompt(prompt, metadata),
    journal,
    metadata,
  };
}

function selectInitialTarget(input: {
  agentId: string;
  policy: ProviderContinuityPolicy;
  compatibility: ProviderContinuityCompatibilityRequest;
  deadlineAt: number;
  now: number;
}): {
  index: number | null;
  probe: boolean;
  probeLeaseId: string | null;
  failback: boolean;
  eligibility: ProviderContinuityEligibility[];
  earliestWakeAt: number | null;
} {
  const eligibility: ProviderContinuityEligibility[] = [];
  let earliestWakeAt: number | null = null;
  for (const [targetIndex, target] of input.policy.targets.entries()) {
    const compatibilityRejections = providerContinuityCompatibilityRejections(target, input.compatibility);
    if (compatibilityRejections.length > 0) {
      eligibility.push({
        targetIndex,
        eligible: false,
        rejectionReasons: compatibilityRejections,
        waitUntil: null,
        probe: false,
      });
      continue;
    }
    const inspected = inspectProviderContinuityTargetEligibility({
      agentId: input.agentId,
      target,
      targetIndex,
      safeNewRequest: true,
      deadlineAt: input.deadlineAt,
      now: input.now,
    });
    if (inspected.waitUntil !== null && inspected.waitUntil < input.deadlineAt) {
      earliestWakeAt = earliestWakeAt === null ? inspected.waitUntil : Math.min(earliestWakeAt, inspected.waitUntil);
    }
    if (!inspected.eligible) {
      eligibility.push({
        targetIndex,
        eligible: false,
        rejectionReasons: inspected.rejectionReasons,
        waitUntil: inspected.waitUntil,
        probe: inspected.probe,
      });
      continue;
    }
    if (inspected.probe) {
      const lease = acquireProviderContinuityProbeLease({
        agentId: input.agentId,
        target,
        deadlineAt: input.deadlineAt,
        now: input.now,
      });
      if (!lease.acquired) {
        eligibility.push({
          targetIndex,
          eligible: false,
          rejectionReasons: [lease.reason ?? "probe_lease_unavailable"],
          waitUntil: lease.health.probeLeaseExpiresAt,
          probe: true,
        });
        continue;
      }
      eligibility.push({ targetIndex, eligible: true, rejectionReasons: [], waitUntil: null, probe: true });
      return {
        index: targetIndex,
        probe: true,
        probeLeaseId: lease.leaseId,
        failback: false,
        eligibility,
        earliestWakeAt,
      };
    }
    eligibility.push({ targetIndex, eligible: true, rejectionReasons: [], waitUntil: null, probe: false });
    const failback =
      targetIndex === 0 &&
      inspected.health.stableSince !== null &&
      inspected.health.probationSuccesses >= PROVIDER_CONTINUITY_DEFAULTS.probationSuccessesToClose &&
      input.now - inspected.health.stableSince >= PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs;
    return { index: targetIndex, probe: false, probeLeaseId: null, failback, eligibility, earliestWakeAt };
  }
  return { index: null, probe: false, probeLeaseId: null, failback: false, eligibility, earliestWakeAt };
}

function initialDecisions(input: {
  logicalRequestId: string;
  targetIndex: number | null;
  action: ProviderContinuityDecision["action"];
  reasonCode: string;
  rejectionReasons: string[];
  skippedTargets: ProviderContinuityEligibility[];
  now: number;
}): { decision: ProviderContinuityDecision; decisions: ProviderContinuityDecision[] } {
  const decisions = input.skippedTargets.map((skipped, index) =>
    providerContinuityDecisionSchema.parse({
      decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
      logicalRequestId: input.logicalRequestId,
      sequence: index + 1,
      action: "skip_target",
      fromTargetIndex: skipped.targetIndex,
      toTargetIndex: null,
      reasonCode: "target_ineligible_in_frozen_order",
      rejectionReasons: skipped.rejectionReasons,
      holdReason: null,
      createdAt: input.now,
      compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    }),
  );
  const decision = providerContinuityDecisionSchema.parse({
    decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
    logicalRequestId: input.logicalRequestId,
    sequence: decisions.length + 1,
    action: input.action,
    fromTargetIndex: null,
    toTargetIndex: input.targetIndex,
    reasonCode: input.reasonCode,
    rejectionReasons: input.rejectionReasons,
    holdReason: null,
    createdAt: input.now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  return { decision, decisions: [...decisions, decision] };
}

export function prepareProviderContinuityRequest(input: {
  agentId: string;
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  compatibility?: RuntimeCompatibilityRequest | null;
  activation?: "runtime" | "synthetic";
  now?: number;
}): ProviderContinuityPreparation {
  const now = input.now ?? Date.now();
  const synthetic = input.activation === "synthetic";
  const compatibility = normalizeProviderContinuityCompatibilityRequest(input.compatibility);
  if (input.prompt._continuity) {
    const metadata = providerContinuityPromptMetadataSchema.parse(input.prompt._continuity);
    const journal = requireProviderContinuityJournal(metadata.logicalRequestId);
    return preparationFromExisting(input.prompt, journal, synthetic || metadata.synthetic, now);
  }

  const policy = getProviderContinuityPolicy(input.agentId);
  if (!policy) return { active: false, reason: "no_policy", prompt: input.prompt };
  if (!policy.enabled) return { active: false, reason: "policy_disabled", prompt: input.prompt };
  if (!synthetic && !isProviderContinuityLiveEnabled()) {
    return { active: false, reason: "live_activation_blocked", prompt: input.prompt };
  }
  const frozenPolicy = policyConfigSnapshot(policy);
  const logicalRequestId = logicalRequestIdFor(input);
  const existing = getProviderContinuityJournal(logicalRequestId);
  if (existing) return preparationFromExisting(input.prompt, existing, synthetic, now);

  const contextSnapshot = buildProviderContinuityContextFromPrompt({
    prompt: input.prompt,
    agentId: input.agentId,
    sessionName: input.sessionName,
    historyMessages: portableHistoryForSession(input.sessionName),
    now,
  });
  const deadlineAt = now + policy.deadlineMs;
  const selection = selectInitialTarget({
    agentId: input.agentId,
    policy,
    compatibility,
    deadlineAt,
    now,
  });
  const rejectionReasons = selection.eligibility
    .filter((item) => !item.eligible)
    .flatMap((item) => item.rejectionReasons.map((reason) => `target[${item.targetIndex}]:${reason}`));
  const targetIndex = selection.index ?? 0;
  const translation = translateProviderContinuityContext({
    context: contextSnapshot,
    target: policy.targets[targetIndex]!,
  });
  const normalAttemptsRemaining: number[] = policy.targets.map(
    () => PROVIDER_CONTINUITY_DEFAULTS.normalAttemptsPerTarget,
  );
  const credentialRecoveriesRemaining: number[] = policy.targets.map(
    () => PROVIDER_CONTINUITY_DEFAULTS.credentialRecoveriesPerTarget,
  );
  const globalBudget = Math.min(policy.targets.length + 1, PROVIDER_CONTINUITY_DEFAULTS.maximumGlobalAttempts);
  const noTarget = selection.index === null || !translation.eligible;
  const wait = noTarget && selection.earliestWakeAt !== null && selection.earliestWakeAt < deadlineAt;
  const decisionSet = initialDecisions({
    logicalRequestId,
    targetIndex: selection.index,
    action: wait
      ? "wait"
      : noTarget
        ? "exhausted"
        : selection.probe
          ? "probe"
          : selection.failback
            ? "failback"
            : "start",
    reasonCode: wait
      ? "initial_targets_waiting"
      : noTarget
        ? translation.eligible
          ? "no_initial_eligible_target"
          : "forbidden_context_loss"
        : selection.probe
          ? "initial_half_open_probe"
          : selection.failback
            ? "failback_after_probation_and_dwell"
            : selection.index === 0
              ? "configured_primary"
              : "configured_order_skip",
    rejectionReasons: [...rejectionReasons, ...translation.rejectionReasons],
    skippedTargets: selection.eligibility.filter((item) => !item.eligible),
    now,
  });
  const decision = decisionSet.decision;
  const attempt = noTarget
    ? null
    : providerContinuityAttemptSchema.parse({
        attemptId: attemptIdFor(logicalRequestId, 1, targetIndex),
        targetIndex,
        target: policy.targets[targetIndex],
        kind: selection.probe ? "probe" : "normal",
        probeLeaseId: selection.probeLeaseId,
        startedAt: now,
        completedAt: null,
        outcome: "running",
        failure: null,
      });
  if (attempt) {
    normalAttemptsRemaining[targetIndex] = Math.max(0, normalAttemptsRemaining[targetIndex]! - 1);
  }
  const journal = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      logicalRequestId,
      agentId: input.agentId,
      sessionName: input.sessionName,
      policyVersion: policy.version,
      policySnapshot: frozenPolicy,
      contextSnapshot: translation.context,
      currentTargetIndex: targetIndex,
      attempts: attempt ? [attempt] : [],
      decisions: decisionSet.decisions,
      normalAttemptsRemaining,
      credentialRecoveriesRemaining,
      globalAttemptsRemaining: attempt ? globalBudget - 1 : globalBudget,
      effectBoundary: "none",
      activeEffectId: null,
      state: wait ? "waiting" : noTarget ? "exhausted" : "running",
      holdReason: translation.eligible ? null : "context_loss",
      terminalOutcome: wait ? null : noTarget ? "exhaustion" : null,
      terminalDetail: noTarget ? decision.reasonCode : null,
      deliveryId: deliveryIdFor(logicalRequestId),
      deliveryState: "pending",
      deadlineAt,
      wakeAt: wait ? selection.earliestWakeAt : null,
      createdAt: now,
      updatedAt: now,
      compatibilityRequest: compatibility,
      compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    }),
  );
  for (const recordedDecision of decisionSet.decisions) {
    recordProviderContinuityEvent({
      logicalRequestId,
      agentId: input.agentId,
      type: `continuity.decision.${recordedDecision.action}`,
      payload: {
        decision: recordedDecision,
        policyVersion: policy.version,
        contextFingerprint: translation.context.fingerprint,
      },
      now,
    });
  }
  if (!attempt) {
    const terminalReasons = [...new Set([...rejectionReasons, ...translation.rejectionReasons])];
    return {
      active: true,
      ready: false,
      reason: wait ? "waiting" : "terminal",
      prompt: input.prompt,
      journal,
      userMessage: wait
        ? `All configured provider targets are temporarily unavailable; continuity is waiting until ${journal.wakeAt}.`
        : `Provider continuity could not route this turn (${decision.reasonCode})` +
          (terminalReasons.length > 0 ? `: ${terminalReasons.join("; ")}.` : "."),
    };
  }
  const metadata = promptMetadata({
    journal,
    attempt,
    probeLeaseId: selection.probeLeaseId,
    synthetic,
  });
  return {
    active: true,
    ready: true,
    reason: "new_request",
    prompt: applyProviderContinuityTargetToPrompt(input.prompt, metadata),
    journal,
    metadata,
  };
}

export interface ProviderContinuityFailureResult {
  active: boolean;
  action: "legacy" | "recover_credential" | "switch_target" | "wait" | "hold" | "terminal";
  journal?: ProviderContinuityJournal;
  metadata?: ProviderContinuityPromptMetadata;
  target?: ProviderContinuityTarget;
  reason: string;
}

function failureJournal(input: {
  journal: ProviderContinuityJournal;
  attemptId: string;
  evidence: ReturnType<typeof classifyProviderContinuityFailure>;
  now: number;
}): ProviderContinuityJournal {
  let matched = false;
  const attempts = input.journal.attempts.map((attempt) => {
    if (attempt.attemptId !== input.attemptId || attempt.outcome !== "running") return attempt;
    matched = true;
    return providerContinuityAttemptSchema.parse({
      ...attempt,
      completedAt: input.now,
      outcome: "failed",
      failure: input.evidence,
    });
  });
  if (!matched) {
    throw new Error(`Continuity attempt '${input.attemptId}' is missing, stale, or already completed.`);
  }
  return providerContinuityJournalSchema.parse({ ...input.journal, attempts, updatedAt: input.now });
}

function synchronizeProviderContinuityEffectBoundary(
  journal: ProviderContinuityJournal,
  now: number,
): ProviderContinuityJournal {
  if (!journal.activeEffectId) return journal;
  const effect = getProviderContinuityEffect(journal.activeEffectId);
  if (!effect) return journal;
  const boundary: ProviderContinuityJournal["effectBoundary"] =
    effect.status === "intention"
      ? "intention"
      : effect.status === "started"
        ? "started"
        : effect.status === "ambiguous"
          ? "ambiguous"
          : "terminal";
  if (journal.effectBoundary === boundary) return journal;
  return saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...journal,
      effectBoundary: boundary,
      state: boundary === "ambiguous" ? "reconciliation_required" : journal.state,
      holdReason: boundary === "ambiguous" ? "effect_ambiguous" : journal.holdReason,
      updatedAt: now,
    }),
  );
}

function eligibilityForFailure(journal: ProviderContinuityJournal, now: number): ProviderContinuityEligibility[] {
  return journal.policySnapshot.targets.map((target, targetIndex) => {
    if (targetIndex <= journal.currentTargetIndex) {
      return {
        targetIndex,
        eligible: false,
        rejectionReasons: [
          targetIndex === journal.currentTargetIndex ? "current_target_failed" : "strict_order_no_reentry",
        ],
        waitUntil: null,
        probe: false,
      };
    }
    const compatibilityRejections = providerContinuityCompatibilityRejections(target, journal.compatibilityRequest);
    const translated = translateProviderContinuityContext({ context: journal.contextSnapshot, target });
    const recovery = inspectProviderContinuityTargetEligibility({
      agentId: journal.agentId,
      target,
      targetIndex,
      safeNewRequest: false,
      deadlineAt: journal.deadlineAt,
      now,
    });
    return {
      targetIndex,
      eligible: compatibilityRejections.length === 0 && translated.eligible && recovery.eligible,
      rejectionReasons: [...compatibilityRejections, ...translated.rejectionReasons, ...recovery.rejectionReasons],
      waitUntil: recovery.waitUntil,
      probe: recovery.probe,
    };
  });
}

export function handleProviderContinuityFailure(input: {
  metadata?: ProviderContinuityPromptMetadata | null;
  sessionName?: string;
  runtimeProvider: string;
  model: string;
  error?: unknown;
  rawEvent?: Record<string, unknown>;
  evidenceState?: "valid" | "missing" | "stale" | "conflicting" | "known_invalid";
  now?: number;
}): ProviderContinuityFailureResult {
  const now = input.now ?? Date.now();
  const journal = input.metadata
    ? getProviderContinuityJournal(input.metadata.logicalRequestId)
    : input.sessionName
      ? getActiveProviderContinuityJournalForSession(input.sessionName)
      : null;
  if (!journal) return { active: false, action: "legacy", reason: "no_active_continuity_journal" };
  const metadata =
    input.metadata ??
    (() => {
      const running = [...journal.attempts].reverse().find((attempt) => attempt.outcome === "running");
      return running ? promptMetadata({ journal, attempt: running, synthetic: false }) : null;
    })();
  if (!metadata) {
    return { active: true, action: "hold", journal, reason: "missing_attempt_metadata" };
  }
  const evidence = classifyProviderContinuityFailure({
    runtimeProvider: input.runtimeProvider,
    model: input.model,
    error: input.error,
    rawEvent: input.rawEvent,
    observedAt: now,
  });
  let current: ProviderContinuityJournal;
  let evidenceState = input.evidenceState ?? "valid";
  try {
    if (
      metadata.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT ||
      metadata.policyVersion !== journal.policyVersion ||
      metadata.targetIndex !== journal.currentTargetIndex
    ) {
      evidenceState = "stale";
    }
    current =
      evidenceState === "valid"
        ? failureJournal({ journal, attemptId: metadata.attemptId, evidence, now })
        : providerContinuityJournalSchema.parse({ ...journal, updatedAt: now });
  } catch {
    current = journal;
    evidenceState = "stale";
  }
  current = synchronizeProviderContinuityEffectBoundary(current, now);

  if (evidenceState === "valid") {
    recordProviderContinuityTargetFailure({
      agentId: journal.agentId,
      target: metadata.target,
      evidence,
      now,
    });
  }
  const result = decideProviderContinuityFailure({
    journal: current,
    evidence,
    eligibility: eligibilityForFailure(current, now),
    evidenceState,
    now,
  });
  const newDecisions = result.journal.decisions.slice(current.decisions.length);
  let nextJournal = result.journal;
  let nextMetadata: ProviderContinuityPromptMetadata | undefined;
  if (result.shouldInvokeProvider && result.nextTargetIndex !== null) {
    const target = nextJournal.policySnapshot.targets[result.nextTargetIndex];
    if (!target) throw new Error(`Continuity target index ${result.nextTargetIndex} is missing.`);
    const attempt = providerContinuityAttemptSchema.parse({
      attemptId: attemptIdFor(nextJournal.logicalRequestId, nextJournal.attempts.length + 1, result.nextTargetIndex),
      targetIndex: result.nextTargetIndex,
      target,
      kind: result.decision.action === "recover_credential" ? "credential_recovery" : "normal",
      probeLeaseId: null,
      startedAt: now,
      completedAt: null,
      outcome: "running",
      failure: null,
    });
    nextJournal = providerContinuityJournalSchema.parse({
      ...nextJournal,
      attempts: [...nextJournal.attempts, attempt],
      updatedAt: now,
    });
    nextMetadata = promptMetadata({
      journal: nextJournal,
      attempt,
      synthetic: metadata.synthetic,
    });
  }
  nextJournal = saveProviderContinuityJournal(nextJournal);
  for (const decision of newDecisions) {
    recordProviderContinuityEvent({
      logicalRequestId: nextJournal.logicalRequestId,
      agentId: nextJournal.agentId,
      type: `continuity.decision.${decision.action}`,
      payload: {
        decision,
        failure: evidence,
        remaining: {
          global: nextJournal.globalAttemptsRemaining,
          normal: nextJournal.normalAttemptsRemaining,
          credentialRecovery: nextJournal.credentialRecoveriesRemaining,
        },
        effectBoundary: nextJournal.effectBoundary,
      },
      now,
    });
  }
  if (result.decision.action === "recover_credential") {
    return {
      active: true,
      action: "recover_credential",
      journal: nextJournal,
      metadata: nextMetadata,
      target: nextMetadata?.target,
      reason: result.decision.reasonCode,
    };
  }
  if (result.decision.action === "switch_target" || result.decision.action === "probe") {
    return {
      active: true,
      action: "switch_target",
      journal: nextJournal,
      metadata: nextMetadata,
      target: nextMetadata?.target,
      reason: result.decision.reasonCode,
    };
  }
  if (result.decision.action === "wait") {
    return { active: true, action: "wait", journal: nextJournal, reason: result.decision.reasonCode };
  }
  if (result.decision.action === "hold" || result.decision.action === "reconcile") {
    return { active: true, action: "hold", journal: nextJournal, reason: result.decision.reasonCode };
  }
  return { active: true, action: "terminal", journal: nextJournal, reason: result.decision.reasonCode };
}

export function markProviderContinuitySuccess(input: {
  metadata?: ProviderContinuityPromptMetadata | null;
  sessionName?: string;
  now?: number;
}): ProviderContinuityJournal | null {
  const now = input.now ?? Date.now();
  const journal = input.metadata
    ? getProviderContinuityJournal(input.metadata.logicalRequestId)
    : input.sessionName
      ? getActiveProviderContinuityJournalForSession(input.sessionName)
      : null;
  if (!journal) return null;
  if (journal.terminalOutcome === "success") return journal;
  if (journal.terminalOutcome !== null) {
    throw new Error(`Logical request '${journal.logicalRequestId}' is already terminal.`);
  }
  if (journal.effectBoundary === "started" || journal.effectBoundary === "ambiguous") {
    const held = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...journal,
        state: "reconciliation_required",
        holdReason: journal.effectBoundary === "started" ? "effect_started" : "effect_ambiguous",
        terminalDetail: "turn_completed_with_unresolved_effect",
        updatedAt: now,
      }),
    );
    recordProviderContinuityEvent({
      logicalRequestId: held.logicalRequestId,
      agentId: held.agentId,
      type: "continuity.decision.reconcile",
      payload: { effectBoundary: held.effectBoundary, effectId: held.activeEffectId },
      now,
    });
    return held;
  }
  const attemptId =
    input.metadata?.attemptId ??
    [...journal.attempts].reverse().find((attempt) => attempt.outcome === "running")?.attemptId;
  if (!attemptId) return journal;
  const runningAttempt = journal.attempts.find(
    (attempt) => attempt.attemptId === attemptId && attempt.outcome === "running",
  );
  if (!runningAttempt) return journal;
  const completedAttempt = providerContinuityAttemptSchema.parse({
    ...runningAttempt,
    completedAt: now,
    outcome: "succeeded",
    failure: null,
  });
  const attempts = journal.attempts.map((attempt) => {
    return attempt.attemptId === attemptId && attempt.outcome === "running" ? completedAttempt : attempt;
  });
  recordProviderContinuityTargetSuccess({
    agentId: journal.agentId,
    target: completedAttempt.target,
    probe: completedAttempt.kind === "probe",
    leaseId: input.metadata?.probeLeaseId ?? completedAttempt.probeLeaseId,
    now,
  });
  const decision = providerContinuityDecisionSchema.parse({
    decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
    logicalRequestId: journal.logicalRequestId,
    sequence: journal.decisions.length + 1,
    action: "success",
    fromTargetIndex: completedAttempt.targetIndex,
    toTargetIndex: completedAttempt.targetIndex,
    reasonCode: "provider_turn_completed",
    rejectionReasons: [],
    holdReason: null,
    createdAt: now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  const succeeded = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...journal,
      attempts,
      decisions: [...journal.decisions, decision],
      state: "succeeded",
      holdReason: null,
      terminalOutcome: "success",
      terminalDetail: "provider_turn_completed",
      updatedAt: now,
    }),
  );
  recordProviderContinuityEvent({
    logicalRequestId: succeeded.logicalRequestId,
    agentId: succeeded.agentId,
    type: "continuity.decision.success",
    payload: { decision, deliveryId: succeeded.deliveryId, effectBoundary: succeeded.effectBoundary },
    now,
  });
  return succeeded;
}

export function markProviderContinuityToolStarted(input: {
  sessionName: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
  now?: number;
}): void {
  const journal = getActiveProviderContinuityJournalForSession(input.sessionName);
  if (!journal) return;
  const prepared = prepareProviderContinuityEffect({
    logicalRequestId: journal.logicalRequestId,
    toolCallId: input.toolCallId,
    operation: input.toolName,
    arguments: input.arguments,
    now: input.now,
  });
  if (!prepared.execute) return;
  markProviderContinuityEffectStarted(prepared.effect.effectId, input.now);
}

export function markProviderContinuityToolCompleted(input: {
  sessionName: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
  content?: unknown;
  isError?: boolean;
  now?: number;
}): void {
  const journal = getActiveProviderContinuityJournalForSession(input.sessionName);
  if (!journal) return;
  const effectId = buildProviderContinuityEffectId({
    logicalRequestId: journal.logicalRequestId,
    toolCallId: input.toolCallId,
    operation: input.toolName,
  });
  if (!getProviderContinuityEffect(effectId)) {
    const prepared = prepareProviderContinuityEffect({
      logicalRequestId: journal.logicalRequestId,
      toolCallId: input.toolCallId,
      operation: input.toolName,
      arguments: input.arguments,
      now: input.now,
    });
    if (prepared.execute) markProviderContinuityEffectStarted(effectId, input.now);
  }
  try {
    completeProviderContinuityEffect({
      effectId,
      outcome: input.isError ? "failed" : "succeeded",
      result: input.content,
      now: input.now,
    });
  } catch (error) {
    markProviderContinuityEffectAmbiguous({
      effectId,
      error,
      now: input.now,
    });
  }
}

export function markProviderContinuityDelivery(input: {
  logicalRequestId: string;
  state: ProviderContinuityJournal["deliveryState"];
  now?: number;
}): ProviderContinuityJournal {
  const now = input.now ?? Date.now();
  const current = requireProviderContinuityJournal(input.logicalRequestId);
  if (current.deliveryState === "delivered" || current.deliveryState === input.state) return current;
  const journal = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({ ...current, deliveryState: input.state, updatedAt: now }),
  );
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: `continuity.delivery.${input.state}`,
    payload: { deliveryId: journal.deliveryId },
    now,
  });
  return journal;
}

export function getProviderContinuityDecisionReadback(logicalRequestId: string) {
  const journal = requireProviderContinuityJournal(logicalRequestId);
  return {
    ...providerContinuityContractHeader(),
    journal: publicProviderContinuityJournal(journal),
    decision: journal.decisions.at(-1) ?? null,
  };
}

function appendProviderContinuityCoordinatorDecision(input: {
  journal: ProviderContinuityJournal;
  action: ProviderContinuityDecision["action"];
  fromTargetIndex?: number | null;
  toTargetIndex?: number | null;
  reasonCode: string;
  rejectionReasons?: string[];
  now: number;
}): { journal: ProviderContinuityJournal; decision: ProviderContinuityDecision } {
  const decision = providerContinuityDecisionSchema.parse({
    decisionId: `pcd_${randomUUID().replaceAll("-", "")}`,
    logicalRequestId: input.journal.logicalRequestId,
    sequence: input.journal.decisions.length + 1,
    action: input.action,
    fromTargetIndex: input.fromTargetIndex ?? null,
    toTargetIndex: input.toTargetIndex ?? null,
    reasonCode: input.reasonCode,
    rejectionReasons: input.rejectionReasons ?? [],
    holdReason: null,
    createdAt: input.now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  return {
    journal: providerContinuityJournalSchema.parse({
      ...input.journal,
      decisions: [...input.journal.decisions, decision],
      updatedAt: input.now,
    }),
    decision,
  };
}

export function resumeProviderContinuityJournal(logicalRequestId: string, now = Date.now()) {
  let journal = synchronizeProviderContinuityEffectBoundary(requireProviderContinuityJournal(logicalRequestId), now);
  if (journal.terminalOutcome !== null) {
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal,
      target: null,
      reason: `terminal_${journal.terminalOutcome}`,
    };
  }
  if (journal.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal,
      target: null,
      reason: "snapshot_conflict",
    };
  }
  const pendingAfterReconciliation =
    journal.effectBoundary === "terminal" &&
    (journal.terminalDetail === "effect_reconciled_succeeded" || journal.terminalDetail === "effect_reconciled_failed");
  if (journal.state === "pending" && journal.decisions.at(-1)?.action !== "wake" && !pendingAfterReconciliation) {
    const invalidStateDecision = appendProviderContinuityCoordinatorDecision({
      journal,
      action: "hold",
      fromTargetIndex: journal.currentTargetIndex,
      reasonCode: "invalid_pending_state",
      rejectionReasons: ["pending_without_durable_wake"],
      now,
    });
    const held = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...invalidStateDecision.journal,
        state: "hold",
        holdReason: "known_invalid_evidence",
        terminalDetail: "pending_without_durable_wake",
        updatedAt: now,
      }),
    );
    recordProviderContinuityEvent({
      logicalRequestId: held.logicalRequestId,
      agentId: held.agentId,
      type: "continuity.decision.hold",
      payload: { decision: invalidStateDecision.decision },
      now,
    });
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal: held,
      target: null,
      reason: "known_invalid_evidence",
    };
  }
  if (now >= journal.deadlineAt) {
    const terminalDecision = appendProviderContinuityCoordinatorDecision({
      journal,
      action: "exhausted",
      fromTargetIndex: journal.currentTargetIndex,
      reasonCode: "deadline_expired",
      rejectionReasons: ["deadline_expired"],
      now,
    });
    const expired = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...terminalDecision.journal,
        state: "exhausted",
        terminalOutcome: "exhaustion",
        terminalDetail: "deadline_expired",
        updatedAt: now,
      }),
    );
    recordProviderContinuityEvent({
      logicalRequestId,
      agentId: expired.agentId,
      type: "continuity.decision.exhausted",
      payload: { decision: terminalDecision.decision },
      now,
    });
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal: expired,
      target: null,
      reason: "deadline_expired",
    };
  }
  if (journal.state === "hold" || journal.state === "reconciliation_required") {
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal,
      target: null,
      reason: journal.holdReason ?? "hold",
    };
  }
  if (journal.state === "waiting" && (journal.wakeAt === null || journal.wakeAt > now)) {
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal,
      target: null,
      reason: "wait_not_due",
    };
  }

  const runningAttempt = [...journal.attempts].reverse().find((attempt) => attempt.outcome === "running");
  if (runningAttempt) {
    if (runningAttempt.targetIndex !== journal.currentTargetIndex) {
      return {
        ...providerContinuityContractHeader(),
        resumed: false,
        journal,
        target: null,
        reason: "current_target_missing",
      };
    }
    if (!runningProbeLeaseIsCurrent(journal, runningAttempt, now)) {
      const held = holdStaleRunningProbe(journal, runningAttempt, now);
      return {
        ...providerContinuityContractHeader(),
        resumed: false,
        journal: held,
        target: null,
        reason: "probe_lease_not_current",
      };
    }
    const translation = translateProviderContinuityContext({
      context: journal.contextSnapshot,
      target: runningAttempt.target,
    });
    if (!translation.eligible) {
      return {
        ...providerContinuityContractHeader(),
        resumed: false,
        journal,
        target: null,
        reason: "forbidden_context_loss",
      };
    }
    const resumed = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...journal,
        currentTargetIndex: runningAttempt.targetIndex,
        state: "running",
        wakeAt: null,
        contextSnapshot: translation.context,
        updatedAt: now,
      }),
    );
    recordProviderContinuityEvent({
      logicalRequestId: resumed.logicalRequestId,
      agentId: resumed.agentId,
      type: "continuity.journal.resumed",
      payload: { targetIndex: resumed.currentTargetIndex, contextFingerprint: resumed.contextSnapshot.fingerprint },
      now,
    });
    return {
      ...providerContinuityContractHeader(),
      resumed: true,
      journal: resumed,
      target: runningAttempt.target,
      reason: "resume_ready",
    };
  }

  const firstCandidateIndex = journal.attempts.length === 0 ? 0 : journal.currentTargetIndex + 1;
  const decisionStartIndex = journal.decisions.length;
  const rejectionReasons: string[] = [];
  const skippedTargets: Array<{ targetIndex: number; rejectionReasons: string[] }> = [];
  let earliestWakeAt: number | null = null;
  let selected:
    | {
        targetIndex: number;
        target: ProviderContinuityTarget;
        context: ProviderContinuityJournal["contextSnapshot"];
        probeLeaseId: string | null;
      }
    | undefined;
  const safeNewRequest = journal.attempts.length === 0;
  for (let targetIndex = firstCandidateIndex; targetIndex < journal.policySnapshot.targets.length; targetIndex += 1) {
    const target = journal.policySnapshot.targets[targetIndex]!;
    if ((journal.normalAttemptsRemaining[targetIndex] ?? 0) <= 0) {
      const reason = "normal_attempt_budget_exhausted";
      rejectionReasons.push(`target[${targetIndex}]:${reason}`);
      skippedTargets.push({ targetIndex, rejectionReasons: [reason] });
      continue;
    }
    const translation = translateProviderContinuityContext({ context: journal.contextSnapshot, target });
    const recovery = inspectProviderContinuityTargetEligibility({
      agentId: journal.agentId,
      target,
      targetIndex,
      safeNewRequest,
      deadlineAt: journal.deadlineAt,
      now,
    });
    const targetRejectionReasons = [...translation.rejectionReasons, ...recovery.rejectionReasons];
    rejectionReasons.push(
      ...translation.rejectionReasons.map((reason) => `target[${targetIndex}]:${reason}`),
      ...recovery.rejectionReasons.map((reason) => `target[${targetIndex}]:${reason}`),
    );
    if (recovery.waitUntil !== null && recovery.waitUntil > now && recovery.waitUntil < journal.deadlineAt) {
      earliestWakeAt = earliestWakeAt === null ? recovery.waitUntil : Math.min(earliestWakeAt, recovery.waitUntil);
    }
    if (!translation.eligible || !recovery.eligible) {
      skippedTargets.push({
        targetIndex,
        rejectionReasons: targetRejectionReasons.length > 0 ? targetRejectionReasons : ["target_ineligible"],
      });
      continue;
    }
    if (recovery.probe) {
      const lease = acquireProviderContinuityProbeLease({
        agentId: journal.agentId,
        target,
        deadlineAt: journal.deadlineAt,
        now,
      });
      if (!lease.acquired) {
        const reason = lease.reason ?? "probe_lease_unavailable";
        rejectionReasons.push(`target[${targetIndex}]:${reason}`);
        skippedTargets.push({ targetIndex, rejectionReasons: [reason] });
        const leaseWait = lease.health.probeLeaseExpiresAt;
        if (leaseWait !== null && leaseWait > now && leaseWait < journal.deadlineAt) {
          earliestWakeAt = earliestWakeAt === null ? leaseWait : Math.min(earliestWakeAt, leaseWait);
        }
        continue;
      }
      selected = {
        targetIndex,
        target,
        context: translation.context,
        probeLeaseId: lease.leaseId,
      };
      break;
    }
    selected = { targetIndex, target, context: translation.context, probeLeaseId: null };
    break;
  }
  for (const skipped of skippedTargets) {
    const skipDecision = appendProviderContinuityCoordinatorDecision({
      journal,
      action: "skip_target",
      fromTargetIndex: skipped.targetIndex,
      reasonCode: "target_ineligible_in_frozen_order",
      rejectionReasons: skipped.rejectionReasons,
      now,
    });
    journal = skipDecision.journal;
  }

  if (!selected || journal.globalAttemptsRemaining <= 0) {
    if (earliestWakeAt !== null && journal.globalAttemptsRemaining > 0) {
      const waitDecision = appendProviderContinuityCoordinatorDecision({
        journal,
        action: "wait",
        fromTargetIndex: journal.currentTargetIndex,
        reasonCode: "resume_targets_waiting",
        rejectionReasons,
        now,
      });
      const waiting = saveProviderContinuityJournal(
        providerContinuityJournalSchema.parse({
          ...waitDecision.journal,
          state: "waiting",
          wakeAt: earliestWakeAt,
          updatedAt: now,
        }),
      );
      for (const decision of waiting.decisions.slice(decisionStartIndex)) {
        recordProviderContinuityEvent({
          logicalRequestId,
          agentId: waiting.agentId,
          type: `continuity.decision.${decision.action}`,
          payload: { decision, wakeAt: earliestWakeAt },
          now,
        });
      }
      return {
        ...providerContinuityContractHeader(),
        resumed: false,
        journal: waiting,
        target: null,
        reason: "targets_waiting",
      };
    }
    const terminalDecision = appendProviderContinuityCoordinatorDecision({
      journal,
      action: "exhausted",
      fromTargetIndex: journal.currentTargetIndex,
      reasonCode:
        journal.globalAttemptsRemaining <= 0 ? "global_attempt_budget_exhausted" : "no_resume_target_eligible",
      rejectionReasons,
      now,
    });
    const exhausted = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...terminalDecision.journal,
        state: "exhausted",
        terminalOutcome: "exhaustion",
        terminalDetail: terminalDecision.decision.reasonCode,
        wakeAt: null,
        updatedAt: now,
      }),
    );
    for (const decision of exhausted.decisions.slice(decisionStartIndex)) {
      recordProviderContinuityEvent({
        logicalRequestId,
        agentId: exhausted.agentId,
        type: `continuity.decision.${decision.action}`,
        payload: { decision },
        now,
      });
    }
    return {
      ...providerContinuityContractHeader(),
      resumed: false,
      journal: exhausted,
      target: null,
      reason: terminalDecision.decision.reasonCode,
    };
  }

  const normalAttemptsRemaining = [...journal.normalAttemptsRemaining];
  normalAttemptsRemaining[selected.targetIndex] = Math.max(0, (normalAttemptsRemaining[selected.targetIndex] ?? 0) - 1);
  const nextDecision = appendProviderContinuityCoordinatorDecision({
    journal,
    action: selected.probeLeaseId ? "probe" : journal.attempts.length === 0 ? "start" : "switch_target",
    fromTargetIndex: journal.attempts.length === 0 ? null : journal.currentTargetIndex,
    toTargetIndex: selected.targetIndex,
    reasonCode: selected.probeLeaseId
      ? "resume_half_open_probe"
      : journal.attempts.length === 0
        ? "resume_initial_target"
        : "resume_first_eligible_later_target",
    rejectionReasons,
    now,
  });
  const attempt = providerContinuityAttemptSchema.parse({
    attemptId: attemptIdFor(logicalRequestId, journal.attempts.length + 1, selected.targetIndex),
    targetIndex: selected.targetIndex,
    target: selected.target,
    kind: selected.probeLeaseId ? "probe" : "normal",
    probeLeaseId: selected.probeLeaseId,
    startedAt: now,
    completedAt: null,
    outcome: "running",
    failure: null,
  });
  journal = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...nextDecision.journal,
      currentTargetIndex: selected.targetIndex,
      attempts: [...journal.attempts, attempt],
      normalAttemptsRemaining,
      globalAttemptsRemaining: journal.globalAttemptsRemaining - 1,
      state: "running",
      wakeAt: null,
      contextSnapshot: selected.context,
      updatedAt: now,
    }),
  );
  for (const decision of journal.decisions.slice(decisionStartIndex)) {
    recordProviderContinuityEvent({
      logicalRequestId: journal.logicalRequestId,
      agentId: journal.agentId,
      type: `continuity.decision.${decision.action}`,
      payload: { decision },
      now,
    });
  }
  recordProviderContinuityEvent({
    logicalRequestId: journal.logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.journal.resumed",
    payload: {
      decision: nextDecision.decision,
      targetIndex: journal.currentTargetIndex,
      contextFingerprint: journal.contextSnapshot.fingerprint,
    },
    now,
  });
  return {
    ...providerContinuityContractHeader(),
    resumed: true,
    journal,
    target: selected.target,
    reason: "resume_next_target",
  };
}

export function waitProviderContinuityJournal(logicalRequestId: string, until: number, now = Date.now()) {
  const journal = requireProviderContinuityJournal(logicalRequestId);
  if (journal.terminalOutcome !== null) throw new Error(`Logical request '${logicalRequestId}' is terminal.`);
  if (!Number.isSafeInteger(until) || until <= now || until >= journal.deadlineAt) {
    throw new Error(`Wait time must be after now and before deadline ${journal.deadlineAt}.`);
  }
  if (journal.state === "reconciliation_required") {
    throw new Error("Cannot wait while effect reconciliation is required.");
  }
  const changed = journal.state !== "waiting" || journal.wakeAt !== until;
  const waitDecision = changed
    ? appendProviderContinuityCoordinatorDecision({
        journal,
        action: "wait",
        fromTargetIndex: journal.currentTargetIndex,
        reasonCode: "operator_requested_wait",
        now,
      })
    : null;
  const updated =
    changed && waitDecision
      ? saveProviderContinuityJournal(
          providerContinuityJournalSchema.parse({
            ...waitDecision.journal,
            state: "waiting",
            wakeAt: until,
            updatedAt: now,
          }),
        )
      : journal;
  if (changed) {
    recordProviderContinuityEvent({
      logicalRequestId,
      agentId: journal.agentId,
      type: "continuity.recovery.wait",
      payload: { decision: waitDecision?.decision ?? null, wakeAt: until, deadlineAt: journal.deadlineAt },
      now,
    });
  }
  return { ...providerContinuityContractHeader(), changed, journal: updated };
}

export function wakeProviderContinuityJournal(logicalRequestId: string, now = Date.now()) {
  const journal = requireProviderContinuityJournal(logicalRequestId);
  if (journal.terminalOutcome !== null) return { ...providerContinuityContractHeader(), changed: false, journal };
  if (journal.state !== "waiting" || journal.wakeAt === null || journal.wakeAt > now) {
    return { ...providerContinuityContractHeader(), changed: false, journal };
  }
  if (now >= journal.deadlineAt) {
    const terminalDecision = appendProviderContinuityCoordinatorDecision({
      journal,
      action: "exhausted",
      fromTargetIndex: journal.currentTargetIndex,
      reasonCode: "deadline_expired",
      rejectionReasons: ["deadline_expired"],
      now,
    });
    const expired = saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...terminalDecision.journal,
        state: "exhausted",
        terminalOutcome: "exhaustion",
        terminalDetail: "deadline_expired",
        wakeAt: null,
        updatedAt: now,
      }),
    );
    recordProviderContinuityEvent({
      logicalRequestId,
      agentId: expired.agentId,
      type: "continuity.decision.exhausted",
      payload: { decision: terminalDecision.decision },
      now,
    });
    return { ...providerContinuityContractHeader(), changed: true, journal: expired };
  }
  const wakeDecision = appendProviderContinuityCoordinatorDecision({
    journal,
    action: "wake",
    fromTargetIndex: journal.currentTargetIndex,
    toTargetIndex: journal.currentTargetIndex,
    reasonCode: "durable_wake_due",
    now,
  });
  const updated = saveProviderContinuityJournal(
    providerContinuityJournalSchema.parse({
      ...wakeDecision.journal,
      state: "pending",
      wakeAt: null,
      updatedAt: now,
    }),
  );
  recordProviderContinuityEvent({
    logicalRequestId,
    agentId: journal.agentId,
    type: "continuity.recovery.wake",
    payload: { decision: wakeDecision.decision, previousWakeAt: journal.wakeAt },
    now,
  });
  return { ...providerContinuityContractHeader(), changed: true, journal: updated };
}

export function buildProviderContinuityResumePrompt(
  journal: ProviderContinuityJournal,
  base: RuntimeLaunchPrompt,
): RuntimeLaunchPrompt {
  const running = [...journal.attempts].reverse().find((attempt) => attempt.outcome === "running");
  if (!running) throw new Error(`Journal '${journal.logicalRequestId}' has no running attempt.`);
  const metadata = promptMetadata({ journal, attempt: running, synthetic: base._continuity?.synthetic ?? false });
  return applyProviderContinuityTargetToPrompt(
    {
      ...base,
      prompt: resumePromptFromPortableContext(journal.contextSnapshot),
      _resumeStashedMessages: true,
    },
    metadata,
  );
}

export function providerContinuityActivationReason(): string {
  return isProviderContinuityLiveEnabled() ? "enabled" : PROVIDER_CONTINUITY_LIVE_BLOCK_REASON;
}
