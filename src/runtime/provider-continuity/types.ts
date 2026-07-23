import { z } from "zod";

export const PROVIDER_CONTINUITY_SPEC_VERSION = "1.0.0" as const;
export const PROVIDER_CONTINUITY_SNAPSHOT = "provider-continuity-1.0.0" as const;
export const PROVIDER_CONTINUITY_TRANSLATION_VERSION = "ravi-portable-context-v1" as const;

export const PROVIDER_CONTINUITY_LIVE_GATE_ENV = "RAVI_PROVIDER_CONTINUITY_LIVE";
export const PROVIDER_CONTINUITY_LIVE_BLOCK_REASON =
  "Live provider continuity is blocked pending approved owner/steward, retention, deletion proof, and incident path.";

export const PROVIDER_CONTINUITY_DEFAULTS = {
  normalAttemptsPerTarget: 1,
  credentialRecoveriesPerTarget: 1,
  maximumGlobalAttempts: 4,
  qualifiedFailuresToOpen: 3,
  halfOpenProbeLimit: 1,
  probationSuccessesToClose: 3,
  failbackDwellMs: 5 * 60_000,
  deadlineMs: 2 * 60_000,
  batchPlanTtlMs: 10 * 60_000,
} as const;

const nonEmptyString = z.string().trim().min(1);
const timestampSchema = z.number().int().nonnegative();

export type ProviderContinuityJsonValue =
  | null
  | boolean
  | number
  | string
  | ProviderContinuityJsonValue[]
  | { [key: string]: ProviderContinuityJsonValue };

export const providerContinuityJsonValueSchema: z.ZodType<ProviderContinuityJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(providerContinuityJsonValueSchema),
    z.record(z.string(), providerContinuityJsonValueSchema),
  ]),
);

export const providerContinuityTargetSchema = z
  .object({
    provider: nonEmptyString,
    model: nonEmptyString,
  })
  .strict();
export type ProviderContinuityTarget = z.infer<typeof providerContinuityTargetSchema>;

export const providerContinuityPolicyConfigSchema = z
  .object({
    specVersion: z.literal(PROVIDER_CONTINUITY_SPEC_VERSION),
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
    strategy: z.literal("ordered"),
    targets: z.array(providerContinuityTargetSchema).min(1),
    deadlineMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60_000)
      .default(PROVIDER_CONTINUITY_DEFAULTS.deadlineMs),
    enabled: z.boolean().default(true),
  })
  .strict();
export type ProviderContinuityPolicyConfig = z.infer<typeof providerContinuityPolicyConfigSchema>;

export const providerContinuityPolicySchema = providerContinuityPolicyConfigSchema
  .extend({
    agentId: nonEmptyString,
    version: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type ProviderContinuityPolicy = z.infer<typeof providerContinuityPolicySchema>;

export const providerContinuityHoldReasonSchema = z.enum([
  "unknown_evidence",
  "missing_evidence",
  "stale_evidence",
  "conflicting_evidence",
  "known_invalid_evidence",
  "effect_started",
  "effect_ambiguous",
  "context_loss",
  "snapshot_conflict",
  "deadline_expired",
  "idempotency_collision",
]);
export type ProviderContinuityHoldReason = z.infer<typeof providerContinuityHoldReasonSchema>;

export const providerContinuityFailureKindSchema = z.enum([
  "quota",
  "rate_limit",
  "authentication",
  "timeout",
  "overload",
  "network",
  "permanent_request",
  "cancellation",
  "unknown",
]);
export type ProviderContinuityFailureKind = z.infer<typeof providerContinuityFailureKindSchema>;

export const providerContinuityFailureEvidenceSchema = z
  .object({
    kind: providerContinuityFailureKindSchema,
    confidence: z.enum(["high", "medium", "low"]),
    safeToRetry: z.boolean(),
    safeToSwitch: z.boolean(),
    credentialRecoveryEligible: z.boolean(),
    qualifiedForCircuit: z.boolean(),
    code: nonEmptyString,
    message: nonEmptyString,
    retryAfterMs: z.number().int().nonnegative().nullable(),
    observedAt: timestampSchema,
    fingerprint: nonEmptyString,
  })
  .strict();
export type ProviderContinuityFailureEvidence = z.infer<typeof providerContinuityFailureEvidenceSchema>;

export const providerContinuityContextMessageSchema = z
  .object({
    id: nonEmptyString,
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    createdAt: timestampSchema.nullable(),
  })
  .strict();

export const providerContinuityToolRecordSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: providerContinuityJsonValueSchema,
    output: providerContinuityJsonValueSchema,
    inputFingerprint: nonEmptyString.nullable(),
    outputFingerprint: nonEmptyString.nullable(),
    status: z.enum(["requested", "started", "succeeded", "failed", "ambiguous"]),
  })
  .strict();

export const providerContinuityAttachmentSchema = z
  .object({
    id: nonEmptyString,
    reference: nonEmptyString,
    mediaType: nonEmptyString.nullable(),
    fingerprint: nonEmptyString.nullable(),
  })
  .strict();

export const providerContinuityTransformationSchema = z
  .object({
    path: nonEmptyString,
    action: z.enum(["preserved", "rewritten", "dropped"]),
    reason: nonEmptyString,
    approvedLoss: z.boolean(),
  })
  .strict();

export const providerContinuityPortableContextSchema = z
  .object({
    translationVersion: z.literal(PROVIDER_CONTINUITY_TRANSLATION_VERSION),
    fingerprint: nonEmptyString,
    messages: z.array(providerContinuityContextMessageSchema),
    toolRecords: z.array(providerContinuityToolRecordSchema),
    attachments: z.array(providerContinuityAttachmentSchema),
    safetyControls: z.record(z.string(), providerContinuityJsonValueSchema),
    runtimeControls: z.record(z.string(), providerContinuityJsonValueSchema),
    transformations: z.array(providerContinuityTransformationSchema),
    forbiddenLosses: z.array(nonEmptyString),
    createdAt: timestampSchema,
  })
  .strict();
export type ProviderContinuityPortableContext = z.infer<typeof providerContinuityPortableContextSchema>;

export const providerContinuityAttemptSchema = z
  .object({
    attemptId: nonEmptyString,
    targetIndex: z.number().int().nonnegative(),
    target: providerContinuityTargetSchema,
    kind: z.enum(["normal", "credential_recovery", "probe"]),
    probeLeaseId: nonEmptyString.nullable(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    outcome: z.enum(["running", "succeeded", "failed", "skipped", "hold"]),
    failure: providerContinuityFailureEvidenceSchema.nullable(),
  })
  .strict();
export type ProviderContinuityAttempt = z.infer<typeof providerContinuityAttemptSchema>;

export const providerContinuityDecisionActionSchema = z.enum([
  "start",
  "retry_same_target",
  "recover_credential",
  "switch_target",
  "skip_target",
  "wait",
  "wake",
  "probe",
  "failback",
  "hold",
  "success",
  "composed_failure",
  "exhausted",
  "reconcile",
]);
export type ProviderContinuityDecisionAction = z.infer<typeof providerContinuityDecisionActionSchema>;

export const providerContinuityDecisionSchema = z
  .object({
    decisionId: nonEmptyString,
    logicalRequestId: nonEmptyString,
    sequence: z.number().int().positive(),
    action: providerContinuityDecisionActionSchema,
    fromTargetIndex: z.number().int().nonnegative().nullable(),
    toTargetIndex: z.number().int().nonnegative().nullable(),
    reasonCode: nonEmptyString,
    rejectionReasons: z.array(nonEmptyString),
    holdReason: providerContinuityHoldReasonSchema.nullable(),
    createdAt: timestampSchema,
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityDecision = z.infer<typeof providerContinuityDecisionSchema>;

export const providerContinuityJournalStateSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "hold",
  "reconciliation_required",
  "succeeded",
  "failed",
  "exhausted",
]);
export type ProviderContinuityJournalState = z.infer<typeof providerContinuityJournalStateSchema>;

export const providerContinuityEffectBoundarySchema = z.enum(["none", "intention", "started", "terminal", "ambiguous"]);

export const providerContinuityJournalSchema = z
  .object({
    logicalRequestId: nonEmptyString,
    agentId: nonEmptyString,
    sessionName: nonEmptyString,
    policyVersion: z.number().int().positive(),
    policySnapshot: providerContinuityPolicyConfigSchema,
    contextSnapshot: providerContinuityPortableContextSchema,
    currentTargetIndex: z.number().int().nonnegative(),
    attempts: z.array(providerContinuityAttemptSchema),
    decisions: z.array(providerContinuityDecisionSchema),
    normalAttemptsRemaining: z.array(z.number().int().nonnegative()),
    credentialRecoveriesRemaining: z.array(z.number().int().nonnegative()),
    globalAttemptsRemaining: z.number().int().nonnegative(),
    effectBoundary: providerContinuityEffectBoundarySchema,
    activeEffectId: nonEmptyString.nullable(),
    state: providerContinuityJournalStateSchema,
    holdReason: providerContinuityHoldReasonSchema.nullable(),
    terminalOutcome: z.enum(["success", "failure", "exhaustion", "hold"]).nullable(),
    terminalDetail: nonEmptyString.nullable(),
    deliveryId: nonEmptyString,
    deliveryState: z.enum(["pending", "started", "delivered", "failed", "ambiguous"]),
    deadlineAt: timestampSchema,
    wakeAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityJournal = z.infer<typeof providerContinuityJournalSchema>;

export const providerContinuityPromptMetadataSchema = z
  .object({
    logicalRequestId: nonEmptyString,
    policyVersion: z.number().int().positive(),
    targetIndex: z.number().int().nonnegative(),
    target: providerContinuityTargetSchema,
    attemptId: nonEmptyString,
    contextFingerprint: nonEmptyString,
    deliveryId: nonEmptyString,
    probeLeaseId: nonEmptyString.nullable(),
    synthetic: z.boolean(),
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityPromptMetadata = z.infer<typeof providerContinuityPromptMetadataSchema>;

export const providerContinuityCircuitStateSchema = z.enum(["closed", "open", "half_open"]);
export type ProviderContinuityCircuitState = z.infer<typeof providerContinuityCircuitStateSchema>;

export const providerContinuityHealthSchema = z
  .object({
    agentId: nonEmptyString,
    provider: nonEmptyString,
    model: nonEmptyString,
    state: providerContinuityCircuitStateSchema,
    consecutiveQualifiedFailures: z.number().int().nonnegative(),
    probationSuccesses: z.number().int().nonnegative(),
    openedAt: timestampSchema.nullable(),
    probeEligibleAt: timestampSchema.nullable(),
    probeLeaseId: nonEmptyString.nullable(),
    probeLeaseExpiresAt: timestampSchema.nullable(),
    stableSince: timestampSchema.nullable(),
    lastFailureAt: timestampSchema.nullable(),
    lastSuccessAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();
export type ProviderContinuityHealth = z.infer<typeof providerContinuityHealthSchema>;

export const providerContinuityEffectStatusSchema = z.enum([
  "intention",
  "started",
  "succeeded",
  "failed",
  "ambiguous",
  "reconciled",
]);
export type ProviderContinuityEffectStatus = z.infer<typeof providerContinuityEffectStatusSchema>;

export const providerContinuityEffectSchema = z
  .object({
    effectId: nonEmptyString,
    logicalRequestId: nonEmptyString,
    toolCallId: nonEmptyString,
    operation: nonEmptyString,
    inputFingerprint: nonEmptyString,
    status: providerContinuityEffectStatusSchema,
    result: providerContinuityJsonValueSchema,
    evidenceFingerprint: nonEmptyString.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityEffect = z.infer<typeof providerContinuityEffectSchema>;

export const providerContinuityPolicyActionSchema = z.enum(["create", "update", "no_op", "clear"]);
export type ProviderContinuityPolicyAction = z.infer<typeof providerContinuityPolicyActionSchema>;

export const providerContinuityAgentPlanSchema = z
  .object({
    agentId: nonEmptyString,
    beforeVersion: z.number().int().nonnegative(),
    action: providerContinuityPolicyActionSchema,
    valid: z.boolean(),
    errors: z.array(nonEmptyString),
  })
  .strict();

export const providerContinuityPlanSchema = z
  .object({
    planId: nonEmptyString,
    planHash: nonEmptyString,
    selector: z
      .object({
        kind: z.enum(["single", "selected", "all"]),
        agentIds: z.array(nonEmptyString),
      })
      .strict(),
    exactAgentIds: z.array(nonEmptyString),
    desiredPolicy: providerContinuityPolicyConfigSchema.nullable(),
    items: z.array(providerContinuityAgentPlanSchema),
    expiresAt: timestampSchema,
    createdAt: timestampSchema,
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityPlan = z.infer<typeof providerContinuityPlanSchema>;

export const providerContinuityApplyOutcomeSchema = z.enum([
  "applied",
  "no_op",
  "invalid",
  "stale",
  "temporary_failure",
  "permanent_failure",
]);
export type ProviderContinuityApplyOutcome = z.infer<typeof providerContinuityApplyOutcomeSchema>;

export const providerContinuityApplyItemSchema = z
  .object({
    agentId: nonEmptyString,
    outcome: providerContinuityApplyOutcomeSchema,
    beforeVersion: z.number().int().nonnegative(),
    afterVersion: z.number().int().nonnegative(),
    message: nonEmptyString,
  })
  .strict();

export const providerContinuityBatchStatusSchema = z.enum([
  "preview",
  "success",
  "partial_success",
  "failed",
  "stale",
  "expired",
]);
export type ProviderContinuityBatchStatus = z.infer<typeof providerContinuityBatchStatusSchema>;

export const providerContinuityBatchSchema = z
  .object({
    batchId: nonEmptyString,
    plan: providerContinuityPlanSchema,
    status: providerContinuityBatchStatusSchema,
    approvalRef: nonEmptyString.nullable(),
    idempotencyKey: nonEmptyString.nullable(),
    requestFingerprint: nonEmptyString.nullable(),
    outcomes: z.array(providerContinuityApplyItemSchema),
    createdAt: timestampSchema,
    appliedAt: timestampSchema.nullable(),
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityBatch = z.infer<typeof providerContinuityBatchSchema>;

export const providerContinuityEventSchema = z
  .object({
    eventId: z.number().int().positive(),
    logicalRequestId: nonEmptyString.nullable(),
    agentId: nonEmptyString.nullable(),
    type: nonEmptyString,
    payload: z.record(z.string(), providerContinuityJsonValueSchema),
    createdAt: timestampSchema,
    specVersion: z.literal(PROVIDER_CONTINUITY_SPEC_VERSION),
    compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
  })
  .strict();
export type ProviderContinuityEvent = z.infer<typeof providerContinuityEventSchema>;

export const providerContinuityErrorEnvelopeSchema = z
  .object({
    error: nonEmptyString,
    code: nonEmptyString,
    details: providerContinuityJsonValueSchema.optional(),
  })
  .strict();

const contractHeader = {
  specVersion: z.literal(PROVIDER_CONTINUITY_SPEC_VERSION),
  compatibilitySnapshotId: z.literal(PROVIDER_CONTINUITY_SNAPSHOT),
};

export const providerContinuityPolicyShowReturnSchema = z
  .object({
    ...contractHeader,
    policy: providerContinuityPolicySchema.nullable(),
    health: z.array(providerContinuityHealthSchema),
    liveActivation: z
      .object({
        enabled: z.boolean(),
        gate: nonEmptyString,
        reason: nonEmptyString.nullable(),
      })
      .strict(),
  })
  .strict();

export const providerContinuityExplainReturnSchema = z
  .object({
    ...contractHeader,
    agentId: nonEmptyString,
    policyVersion: z.number().int().nonnegative(),
    enabled: z.boolean(),
    orderedTargets: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          target: providerContinuityTargetSchema,
          eligible: z.boolean(),
          recovery: providerContinuityHealthSchema.nullable(),
          rejectionReasons: z.array(nonEmptyString),
        })
        .strict(),
    ),
    selectedTargetIndex: z.number().int().nonnegative().nullable(),
    decision: nonEmptyString,
  })
  .strict();

export const providerContinuityPreviewReturnSchema = z
  .object({
    ...contractHeader,
    plan: providerContinuityPlanSchema,
  })
  .strict();

export const providerContinuityMutationReturnSchema = z
  .object({
    ...contractHeader,
    changed: z.boolean(),
    outcome: providerContinuityApplyOutcomeSchema,
    policy: providerContinuityPolicySchema.nullable(),
    plan: providerContinuityPlanSchema.nullable(),
  })
  .strict();

export const providerContinuityBatchReturnSchema = z
  .object({
    ...contractHeader,
    batch: providerContinuityBatchSchema,
  })
  .strict();

export const providerContinuityDecisionReturnSchema = z
  .object({
    ...contractHeader,
    journal: providerContinuityJournalSchema,
    decision: providerContinuityDecisionSchema.nullable(),
  })
  .strict();

export const providerContinuityResumeReturnSchema = z
  .object({
    ...contractHeader,
    resumed: z.boolean(),
    journal: providerContinuityJournalSchema,
    target: providerContinuityTargetSchema.nullable(),
    reason: nonEmptyString,
  })
  .strict();

export const providerContinuityWaitWakeReturnSchema = z
  .object({
    ...contractHeader,
    changed: z.boolean(),
    journal: providerContinuityJournalSchema,
  })
  .strict();

export const providerContinuityEffectReturnSchema = z
  .object({
    ...contractHeader,
    changed: z.boolean(),
    effect: providerContinuityEffectSchema,
    journal: providerContinuityJournalSchema,
  })
  .strict();

export const providerContinuityTraceReturnSchema = z
  .object({
    ...contractHeader,
    logicalRequestId: nonEmptyString,
    journal: providerContinuityJournalSchema,
    events: z.array(providerContinuityEventSchema),
    pagination: z
      .object({
        limit: z.number().int().positive(),
        cursor: nonEmptyString.nullable(),
        nextCursor: nonEmptyString.nullable(),
        hasMore: z.boolean(),
      })
      .strict(),
  })
  .strict();

export function providerContinuityContractHeader() {
  return {
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  } as const;
}
