import { z } from "zod";

export const EXECUTION_AUTHORITY_PROTOCOL = "ravi.execution.authority" as const;
export const EXECUTION_AUTHORITY_SCHEMA_VERSION = 1 as const;

export const MAX_EXECUTION_AUTHORITY_CAPABILITIES = 128;
export const MAX_EXECUTION_AUTHORITY_RESOURCE_SCOPES = 256;
export const MAX_EXECUTION_AUTHORITY_KEYS = 16;
export const MAX_BINDING_AUTHORITY_LIFETIME_MS = 86_400_000;
export const MAX_EXECUTION_GRANT_LIFETIME_MS = 300_000;
export const MAX_ROUTE_LEASE_LIFETIME_MS = 300_000;
export const MAX_APPROVAL_LIFETIME_MS = 900_000;
export const MAX_AUTHORITY_KEY_OVERLAP_MS = 900_000;

const textEncoder = new TextEncoder();

function boundedString(maxBytes: number, label: string) {
  return z
    .string()
    .refine(
      (value) => textEncoder.encode(value).byteLength >= 1,
      `${label} must not be empty`,
    )
    .refine(
      (value) => textEncoder.encode(value).byteLength <= maxBytes,
      `${label} exceeds ${maxBytes} UTF-8 bytes`,
    );
}

export const ExecutionAuthorityOpaqueIdSchema = boundedString(
  128,
  "identifier",
).regex(
  /^[A-Za-z0-9][A-Za-z0-9._~-]*$/,
  "must be an opaque URL-safe identifier",
);

export const ExecutionAuthorityPartySchema = boundedString(
  256,
  "authority party",
).regex(
  /^[A-Za-z0-9][A-Za-z0-9:/._~-]*$/,
  "must be a stable authority party identifier",
);

export const SemanticCapabilitySchema = boundedString(
  128,
  "semantic capability",
).regex(
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/,
  "must be a lowercase semantic capability",
);

export const AuthorityResourceKindSchema = boundedString(
  96,
  "resource kind",
).regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  "must be a lowercase resource kind",
);

export const AuthorityResourceScopeSchema = z
  .object({
    kind: AuthorityResourceKindSchema,
    resourceId: ExecutionAuthorityOpaqueIdSchema,
  })
  .strict();

export const OperationReplayClassSchema = z.enum([
  "idempotent",
  "readback_required",
  "non_repeatable",
]);

export const RecoveryModeSchema = z.enum(["none", "replay", "checkpoint"]);

export const AuthorityChannelModeSchema = z.enum([
  "receive_only",
  "bidirectional",
]);

export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");

const IsoTimestampSchema = z.iso.datetime({ offset: true });
const PositiveRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeEpochSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

function uniqueStrings<T extends z.ZodType<string>>(
  item: T,
  max: number,
  label: string,
) {
  return z
    .array(item)
    .min(1)
    .max(max)
    .refine(
      (values) => new Set(values).size === values.length,
      `${label} must be unique`,
    );
}

function scopeKey(scope: z.infer<typeof AuthorityResourceScopeSchema>): string {
  return `${scope.kind}\u0000${scope.resourceId}`;
}

export const SemanticCapabilitiesSchema = uniqueStrings(
  SemanticCapabilitySchema,
  MAX_EXECUTION_AUTHORITY_CAPABILITIES,
  "semantic capabilities",
);

export const AuthorityResourceScopesSchema = z
  .array(AuthorityResourceScopeSchema)
  .min(1)
  .max(MAX_EXECUTION_AUTHORITY_RESOURCE_SCOPES)
  .refine(
    (scopes) => new Set(scopes.map(scopeKey)).size === scopes.length,
    "resource scopes must be unique",
  );

function validateTimeWindow(
  value: {
    issuedAt: string;
    notBefore: string;
    expiresAt: string;
  },
  context: z.RefinementCtx,
  maxLifetimeMs: number,
): void {
  const issuedAt = Date.parse(value.issuedAt);
  const notBefore = Date.parse(value.notBefore);
  const expiresAt = Date.parse(value.expiresAt);

  if (issuedAt > notBefore) {
    context.addIssue({
      code: "custom",
      path: ["notBefore"],
      message: "notBefore must not precede issuedAt",
    });
  }
  if (notBefore >= expiresAt) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must follow notBefore",
    });
  }
  if (expiresAt - issuedAt > maxLifetimeMs) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: `authority lifetime exceeds ${maxLifetimeMs}ms`,
    });
  }
}

export const BindingAuthorityEnvelopeClaimsSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("binding_authority_envelope"),
    envelopeId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    runtimeKeyId: ExecutionAuthorityOpaqueIdSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    authorityDomain: ExecutionAuthorityOpaqueIdSchema,
    policyRevision: PositiveRevisionSchema,
    keySetRevision: PositiveRevisionSchema,
    capabilities: SemanticCapabilitiesSchema,
    resourceScopes: AuthorityResourceScopesSchema,
    resourceMappingId: ExecutionAuthorityOpaqueIdSchema.optional(),
    channelMode: AuthorityChannelModeSchema,
    recoveryMode: RecoveryModeSchema,
    issuedAt: IsoTimestampSchema,
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateTimeWindow(
      value,
      context,
      MAX_BINDING_AUTHORITY_LIFETIME_MS,
    );
  });

export const ExecutionRouteLeaseClaimsSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("execution_route_lease"),
    leaseId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    routeScope: ExecutionAuthorityOpaqueIdSchema,
    routeEpoch: NonNegativeEpochSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    authorityDomain: ExecutionAuthorityOpaqueIdSchema,
    keySetRevision: PositiveRevisionSchema,
    issuedAt: IsoTimestampSchema,
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateTimeWindow(value, context, MAX_ROUTE_LEASE_LIFETIME_MS);
  });

export const ExecutionCapabilityGrantClaimsSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("execution_capability_grant"),
    grantId: ExecutionAuthorityOpaqueIdSchema,
    principalId: ExecutionAuthorityOpaqueIdSchema,
    envelopeId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    executionId: ExecutionAuthorityOpaqueIdSchema,
    operationId: ExecutionAuthorityOpaqueIdSchema.optional(),
    routeScope: ExecutionAuthorityOpaqueIdSchema,
    routeLeaseId: ExecutionAuthorityOpaqueIdSchema,
    routeEpoch: NonNegativeEpochSchema,
    capabilities: SemanticCapabilitiesSchema,
    resourceScopes: AuthorityResourceScopesSchema,
    resourceMappingId: ExecutionAuthorityOpaqueIdSchema.optional(),
    requestDigest: Sha256DigestSchema,
    replayClass: OperationReplayClassSchema,
    policyRevision: PositiveRevisionSchema,
    keySetRevision: PositiveRevisionSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    issuedAt: IsoTimestampSchema,
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateTimeWindow(value, context, MAX_EXECUTION_GRANT_LIFETIME_MS);
  });

export const OperationApprovalRequestSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("operation_approval_request"),
    approvalId: ExecutionAuthorityOpaqueIdSchema,
    challengeId: ExecutionAuthorityOpaqueIdSchema,
    principalId: ExecutionAuthorityOpaqueIdSchema,
    envelopeId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    executionId: ExecutionAuthorityOpaqueIdSchema,
    operationId: ExecutionAuthorityOpaqueIdSchema,
    routeScope: ExecutionAuthorityOpaqueIdSchema,
    routeLeaseId: ExecutionAuthorityOpaqueIdSchema,
    routeEpoch: NonNegativeEpochSchema,
    requiredCapability: SemanticCapabilitySchema,
    resourceScopes: AuthorityResourceScopesSchema,
    resourceMappingId: ExecutionAuthorityOpaqueIdSchema.optional(),
    requestDigest: Sha256DigestSchema,
    replayClass: OperationReplayClassSchema,
    policyRevision: PositiveRevisionSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    issuedAt: IsoTimestampSchema,
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateTimeWindow(value, context, MAX_APPROVAL_LIFETIME_MS);
  });

export const OperationApprovalDecisionClaimsSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("operation_approval_decision"),
    request: OperationApprovalRequestSchema,
    decision: z.enum(["approved", "denied"]),
    decidedBy: ExecutionAuthorityOpaqueIdSchema,
    decidedAt: IsoTimestampSchema,
    usageLimit: z.literal(1),
    keySetRevision: PositiveRevisionSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    issuedAt: IsoTimestampSchema,
    notBefore: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    validateTimeWindow(value, context, MAX_APPROVAL_LIFETIME_MS);
    const requestStart = Date.parse(value.request.notBefore);
    const requestExpiry = Date.parse(value.request.expiresAt);
    const decidedAt = Date.parse(value.decidedAt);
    const decisionExpiry = Date.parse(value.expiresAt);

    if (decidedAt < requestStart || decidedAt >= requestExpiry) {
      context.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "decision must occur within the approval request window",
      });
    }
    if (decisionExpiry > requestExpiry) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "decision must not outlive its approval request",
      });
    }
  });

const Base64UrlSchema = z.string().regex(
  /^[A-Za-z0-9_-]+$/,
  "must be unpadded base64url",
);

function decodedBase64UrlLength(value: string): number {
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  const padding = remainder === 0 ? 0 : 4 - remainder;
  return Math.floor(((value.length + padding) * 3) / 4) - padding;
}

export const Ed25519SpkiPublicKeySchema = Base64UrlSchema.refine(
  (value) => decodedBase64UrlLength(value) === 44,
  "must encode a 44-byte Ed25519 SPKI public key",
);

export const Ed25519SignatureSchema = Base64UrlSchema.refine(
  (value) => decodedBase64UrlLength(value) === 64,
  "must encode a 64-byte Ed25519 signature",
);

export const AuthoritySignatureProofSchema = z
  .object({
    algorithm: z.literal("Ed25519"),
    keyId: ExecutionAuthorityOpaqueIdSchema,
    signature: Ed25519SignatureSchema,
  })
  .strict();

function signedSchema<T extends z.ZodType>(claims: T) {
  return z
    .object({
      claims,
      proof: AuthoritySignatureProofSchema,
    })
    .strict();
}

export const SignedBindingAuthorityEnvelopeSchema = signedSchema(
  BindingAuthorityEnvelopeClaimsSchema,
);
export const SignedExecutionRouteLeaseSchema = signedSchema(
  ExecutionRouteLeaseClaimsSchema,
);
export const SignedExecutionCapabilityGrantSchema = signedSchema(
  ExecutionCapabilityGrantClaimsSchema,
);
export const SignedOperationApprovalDecisionSchema = signedSchema(
  OperationApprovalDecisionClaimsSchema,
);

export const AuthorityVerificationKeySchema = z
  .object({
    keyId: ExecutionAuthorityOpaqueIdSchema,
    algorithm: z.literal("Ed25519"),
    publicKey: Ed25519SpkiPublicKeySchema,
    status: z.enum(["active", "retiring", "revoked"]),
    notBefore: IsoTimestampSchema,
    notAfter: IsoTimestampSchema,
    retiredAt: IsoTimestampSchema.optional(),
    acceptUntil: IsoTimestampSchema.optional(),
    revokedAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const notBefore = Date.parse(value.notBefore);
    const notAfter = Date.parse(value.notAfter);
    if (notBefore >= notAfter) {
      context.addIssue({
        code: "custom",
        path: ["notAfter"],
        message: "key notAfter must follow notBefore",
      });
    }

    if (
      value.status === "active" &&
      (value.retiredAt !== undefined ||
        value.acceptUntil !== undefined ||
        value.revokedAt !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "active keys cannot carry retirement or revocation fields",
      });
    }

    if (value.status === "retiring") {
      if (
        value.retiredAt === undefined ||
        value.acceptUntil === undefined ||
        value.revokedAt !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "retiring keys require retiredAt and acceptUntil only",
        });
      } else {
        const retiredAt = Date.parse(value.retiredAt);
        const acceptUntil = Date.parse(value.acceptUntil);
        if (
          retiredAt < notBefore ||
          acceptUntil <= retiredAt ||
          acceptUntil > notAfter ||
          acceptUntil - retiredAt > MAX_AUTHORITY_KEY_OVERLAP_MS
        ) {
          context.addIssue({
            code: "custom",
            path: ["acceptUntil"],
            message: "retiring key overlap is invalid or exceeds the limit",
          });
        }
      }
    }

    if (
      value.status === "revoked" &&
      (value.revokedAt === undefined ||
        value.retiredAt !== undefined ||
        value.acceptUntil !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "revoked keys require revokedAt and no overlap fields",
      });
    }
    if (
      value.status === "revoked" &&
      value.revokedAt !== undefined &&
      (Date.parse(value.revokedAt) < notBefore ||
        Date.parse(value.revokedAt) > notAfter)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revocation must fall within the key validity window",
      });
    }
  });

export const TrustedAuthorityKeySetSchema = z
  .object({
    protocol: z.literal(EXECUTION_AUTHORITY_PROTOCOL),
    schemaVersion: z.literal(EXECUTION_AUTHORITY_SCHEMA_VERSION),
    kind: z.literal("trusted_authority_key_set"),
    revision: PositiveRevisionSchema,
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    activeKeyId: ExecutionAuthorityOpaqueIdSchema,
    keys: z
      .array(AuthorityVerificationKeySchema)
      .min(1)
      .max(MAX_EXECUTION_AUTHORITY_KEYS),
    acceptedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.keys.map((key) => key.keyId)).size !== value.keys.length) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "authority key identifiers must be unique",
      });
    }
    if (
      new Set(value.keys.map((key) => key.publicKey)).size !==
      value.keys.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "authority public keys must be unique",
      });
    }
    const activeKeys = value.keys.filter((key) => key.status === "active");
    if (
      activeKeys.length !== 1 ||
      activeKeys[0]?.keyId !== value.activeKeyId
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeKeyId"],
        message: "key set must identify its single active key",
      });
    }
  });

export const LocalAuthorityAttenuationSchema = z
  .object({
    envelopeId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    attenuationRevision: PositiveRevisionSchema,
    capabilities: SemanticCapabilitiesSchema,
    resourceScopes: AuthorityResourceScopesSchema,
    acceptedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.acceptedAt) >= Date.parse(value.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "attenuation expiry must follow local acceptance",
      });
    }
  });

export const ExactExecutionEffectSchema = z
  .object({
    issuer: ExecutionAuthorityPartySchema,
    audience: ExecutionAuthorityPartySchema,
    minimumKeySetRevision: PositiveRevisionSchema,
    envelopeId: ExecutionAuthorityOpaqueIdSchema,
    bindingId: ExecutionAuthorityOpaqueIdSchema,
    bindingRevision: PositiveRevisionSchema,
    runtimeKeyId: ExecutionAuthorityOpaqueIdSchema,
    authorityDomain: ExecutionAuthorityOpaqueIdSchema,
    channelMode: AuthorityChannelModeSchema,
    recoveryMode: RecoveryModeSchema,
    policyRevision: PositiveRevisionSchema,
    principalId: ExecutionAuthorityOpaqueIdSchema,
    executionId: ExecutionAuthorityOpaqueIdSchema,
    operationId: ExecutionAuthorityOpaqueIdSchema.optional(),
    routeScope: ExecutionAuthorityOpaqueIdSchema,
    routeLeaseId: ExecutionAuthorityOpaqueIdSchema,
    routeEpoch: NonNegativeEpochSchema,
    highestAcceptedRouteEpoch: NonNegativeEpochSchema,
    capability: SemanticCapabilitySchema,
    resourceScopes: AuthorityResourceScopesSchema,
    resourceMappingId: ExecutionAuthorityOpaqueIdSchema.optional(),
    requestDigest: Sha256DigestSchema,
    replayClass: OperationReplayClassSchema,
  })
  .strict();

export const ApprovalConsumptionRecordSchema = z
  .object({
    approvalId: ExecutionAuthorityOpaqueIdSchema,
    challengeId: ExecutionAuthorityOpaqueIdSchema,
    operationId: ExecutionAuthorityOpaqueIdSchema,
    decisionDigest: Sha256DigestSchema,
    consumedAt: IsoTimestampSchema,
  })
  .strict();

export const ExecutionGrantUseRecordSchema = z
  .object({
    grantId: ExecutionAuthorityOpaqueIdSchema,
    authorizationDigest: Sha256DigestSchema,
    executionId: ExecutionAuthorityOpaqueIdSchema,
    operationId: ExecutionAuthorityOpaqueIdSchema.optional(),
    requestDigest: Sha256DigestSchema,
    routeScope: ExecutionAuthorityOpaqueIdSchema,
    routeEpoch: NonNegativeEpochSchema,
    replayClass: OperationReplayClassSchema,
    recordedAt: IsoTimestampSchema,
  })
  .strict();

export const OperationOutcomeStateSchema = z.enum([
  "not_started",
  "in_progress",
  "succeeded",
  "failed",
  "outcome_unknown",
  "manual_resolution",
]);

export const OperationReadbackResultSchema = z.enum([
  "not_applied",
  "applied",
  "inconclusive",
]);

export const OperationRecoveryActionSchema = z.enum([
  "start",
  "resume",
  "retry_same_identity",
  "readback",
  "reconcile_terminal",
  "manual_resolution",
  "none",
]);

export const ExecutionAuthorityDenialReasonSchema = z.enum([
  "invalid_input",
  "key_set_downgrade",
  "key_unknown",
  "key_revoked",
  "key_inactive",
  "signature_invalid",
  "issuer_mismatch",
  "audience_mismatch",
  "not_yet_valid",
  "expired",
  "envelope_mismatch",
  "binding_mismatch",
  "binding_revision_mismatch",
  "runtime_key_mismatch",
  "authority_domain_mismatch",
  "channel_mode_mismatch",
  "recovery_mode_mismatch",
  "policy_revision_mismatch",
  "attenuation_invalid",
  "capability_missing",
  "capability_outside_envelope",
  "scope_missing",
  "scope_outside_envelope",
  "resource_mapping_mismatch",
  "principal_mismatch",
  "execution_mismatch",
  "operation_mismatch",
  "request_digest_mismatch",
  "replay_class_mismatch",
  "route_scope_mismatch",
  "route_lease_mismatch",
  "stale_epoch",
  "epoch_not_persisted",
  "local_policy_denied",
  "runtime_constraint_denied",
  "approval_required",
  "approval_invalid",
  "approval_denied",
  "approval_replayed",
  "grant_reuse_conflict",
]);

export type BindingAuthorityEnvelopeClaims = z.infer<
  typeof BindingAuthorityEnvelopeClaimsSchema
>;
export type AuthorityResourceScope = z.infer<
  typeof AuthorityResourceScopeSchema
>;
export type ExecutionRouteLeaseClaims = z.infer<
  typeof ExecutionRouteLeaseClaimsSchema
>;
export type ExecutionCapabilityGrantClaims = z.infer<
  typeof ExecutionCapabilityGrantClaimsSchema
>;
export type OperationApprovalRequest = z.infer<
  typeof OperationApprovalRequestSchema
>;
export type OperationApprovalDecisionClaims = z.infer<
  typeof OperationApprovalDecisionClaimsSchema
>;
export type AuthoritySignatureProof = z.infer<
  typeof AuthoritySignatureProofSchema
>;
export type SignedBindingAuthorityEnvelope = z.infer<
  typeof SignedBindingAuthorityEnvelopeSchema
>;
export type SignedExecutionRouteLease = z.infer<
  typeof SignedExecutionRouteLeaseSchema
>;
export type SignedExecutionCapabilityGrant = z.infer<
  typeof SignedExecutionCapabilityGrantSchema
>;
export type SignedOperationApprovalDecision = z.infer<
  typeof SignedOperationApprovalDecisionSchema
>;
export type AuthorityVerificationKey = z.infer<
  typeof AuthorityVerificationKeySchema
>;
export type TrustedAuthorityKeySet = z.infer<
  typeof TrustedAuthorityKeySetSchema
>;
export type LocalAuthorityAttenuation = z.infer<
  typeof LocalAuthorityAttenuationSchema
>;
export type ExactExecutionEffect = z.infer<typeof ExactExecutionEffectSchema>;
export type ApprovalConsumptionRecord = z.infer<
  typeof ApprovalConsumptionRecordSchema
>;
export type ExecutionGrantUseRecord = z.infer<
  typeof ExecutionGrantUseRecordSchema
>;
export type OperationReplayClass = z.infer<typeof OperationReplayClassSchema>;
export type OperationOutcomeState = z.infer<typeof OperationOutcomeStateSchema>;
export type OperationReadbackResult = z.infer<
  typeof OperationReadbackResultSchema
>;
export type OperationRecoveryAction = z.infer<
  typeof OperationRecoveryActionSchema
>;
export type ExecutionAuthorityDenialReason = z.infer<
  typeof ExecutionAuthorityDenialReasonSchema
>;

export const EXECUTION_AUTHORITY_PUBLIC_SCHEMAS = Object.freeze({
  ApprovalConsumptionRecord: ApprovalConsumptionRecordSchema,
  AuthorityResourceScope: AuthorityResourceScopeSchema,
  AuthoritySignatureProof: AuthoritySignatureProofSchema,
  AuthorityVerificationKey: AuthorityVerificationKeySchema,
  BindingAuthorityEnvelopeClaims: BindingAuthorityEnvelopeClaimsSchema,
  ExactExecutionEffect: ExactExecutionEffectSchema,
  ExecutionAuthorityDenialReason: ExecutionAuthorityDenialReasonSchema,
  ExecutionCapabilityGrantClaims: ExecutionCapabilityGrantClaimsSchema,
  ExecutionGrantUseRecord: ExecutionGrantUseRecordSchema,
  ExecutionRouteLeaseClaims: ExecutionRouteLeaseClaimsSchema,
  LocalAuthorityAttenuation: LocalAuthorityAttenuationSchema,
  OperationApprovalDecisionClaims: OperationApprovalDecisionClaimsSchema,
  OperationApprovalRequest: OperationApprovalRequestSchema,
  OperationOutcomeState: OperationOutcomeStateSchema,
  OperationReadbackResult: OperationReadbackResultSchema,
  OperationRecoveryAction: OperationRecoveryActionSchema,
  OperationReplayClass: OperationReplayClassSchema,
  SignedBindingAuthorityEnvelope: SignedBindingAuthorityEnvelopeSchema,
  SignedExecutionCapabilityGrant: SignedExecutionCapabilityGrantSchema,
  SignedExecutionRouteLease: SignedExecutionRouteLeaseSchema,
  SignedOperationApprovalDecision: SignedOperationApprovalDecisionSchema,
  TrustedAuthorityKeySet: TrustedAuthorityKeySetSchema,
});

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function canonicalJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("authority payload contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  throw new TypeError("authority payload is not canonical JSON");
}

export function canonicalizeAuthorityPayload(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalAuthorityPayloadBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalizeAuthorityPayload(value));
}

export function encodeAuthorityBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes =
    value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeAuthorityBase64Url(value: string): Uint8Array {
  const remainder = value.length % 4;
  if (remainder === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("invalid base64url");
  }
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    (remainder === 0 ? "" : "=".repeat(4 - remainder));
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function authorityArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function sha256AuthorityDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    authorityArrayBuffer(canonicalAuthorityPayloadBytes(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export type AuthoritySignatureVerificationInput = Readonly<{
  key: AuthorityVerificationKey;
  payload: Uint8Array;
  signature: Uint8Array;
}>;

export type AuthoritySignatureVerifier = (
  input: AuthoritySignatureVerificationInput,
) => boolean | Promise<boolean>;

export const verifyEd25519AuthoritySignature: AuthoritySignatureVerifier =
  async ({ key, payload, signature }) => {
    try {
      const publicKey = await crypto.subtle.importKey(
        "spki",
        authorityArrayBuffer(decodeAuthorityBase64Url(key.publicKey)),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        authorityArrayBuffer(signature),
        authorityArrayBuffer(payload),
      );
    } catch {
      return false;
    }
  };

type SignedAuthorityArtifact = Readonly<{
  claims: Readonly<{
    issuer: string;
    audience: string;
    keySetRevision: number;
    issuedAt: string;
    notBefore: string;
    expiresAt: string;
  }>;
  proof: AuthoritySignatureProof;
}>;

function checkArtifactTime(
  artifact: SignedAuthorityArtifact,
  nowMs: number,
): ExecutionAuthorityDenialReason | undefined {
  if (nowMs < Date.parse(artifact.claims.notBefore)) return "not_yet_valid";
  if (nowMs >= Date.parse(artifact.claims.expiresAt)) return "expired";
  return undefined;
}

async function verifyArtifact(
  artifact: SignedAuthorityArtifact,
  keySet: TrustedAuthorityKeySet,
  nowMs: number,
  verifier: AuthoritySignatureVerifier,
): Promise<ExecutionAuthorityDenialReason | undefined> {
  if (artifact.claims.keySetRevision > keySet.revision) {
    return "key_set_downgrade";
  }
  const key = keySet.keys.find(
    (candidate) => candidate.keyId === artifact.proof.keyId,
  );
  if (key === undefined) return "key_unknown";
  if (key.status === "revoked") return "key_revoked";

  const keyStart = Date.parse(key.notBefore);
  const keyEnd = Date.parse(key.notAfter);
  const artifactIssuedAt = Date.parse(artifact.claims.issuedAt);
  if (
    nowMs < keyStart ||
    nowMs >= keyEnd ||
    artifactIssuedAt < keyStart ||
    artifactIssuedAt >= keyEnd
  ) {
    return "key_inactive";
  }
  if (
    key.status === "retiring" &&
    (key.retiredAt === undefined ||
      key.acceptUntil === undefined ||
      artifactIssuedAt > Date.parse(key.retiredAt) ||
      nowMs >= Date.parse(key.acceptUntil))
  ) {
    return "key_inactive";
  }

  const valid = await verifier({
    key,
    payload: canonicalAuthorityPayloadBytes(artifact.claims),
    signature: decodeAuthorityBase64Url(artifact.proof.signature),
  });
  return valid ? undefined : "signature_invalid";
}

function sameScopes(
  left: readonly z.infer<typeof AuthorityResourceScopeSchema>[],
  right: readonly z.infer<typeof AuthorityResourceScopeSchema>[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(scopeKey));
  return left.every((scope) => rightKeys.has(scopeKey(scope)));
}

function isSubset<T>(
  subset: readonly T[],
  superset: readonly T[],
  key: (value: T) => string,
): boolean {
  const allowed = new Set(superset.map(key));
  return subset.every((value) => allowed.has(key(value)));
}

function optionalEqual(left: string | undefined, right: string | undefined) {
  return left === right;
}

export type EffectApprovalInput = Readonly<{
  required: boolean;
  decision?: unknown;
  consumedApprovalIds?: ReadonlySet<string>;
}>;

export type AuthorizeExecutionEffectInput = Readonly<{
  now: string;
  expected: unknown;
  keySet: unknown;
  acceptedEnvelope: unknown;
  localAttenuation: unknown;
  routeLease: unknown;
  grant: unknown;
  localPolicyAllowed: boolean;
  runtimeConstraintsAllowed: boolean;
  approval?: EffectApprovalInput;
  priorGrantUse?: unknown;
  verifySignature?: AuthoritySignatureVerifier;
}>;

export type ExecutionEffectAuthorization =
  | Readonly<{
      allowed: true;
      grantId: string;
      routeLeaseId: string;
      routeEpoch: number;
      grantUse: ExecutionGrantUseRecord;
      approvalConsumption?: Readonly<{
        approvalId: string;
        challengeId: string;
        operationId: string;
        decisionDigest: string;
      }>;
    }>
  | Readonly<{
      allowed: false;
      reason: ExecutionAuthorityDenialReason;
    }>;

function denied(
  reason: ExecutionAuthorityDenialReason,
): ExecutionEffectAuthorization {
  return { allowed: false, reason };
}

async function verifyApproval(
  rawDecision: unknown,
  expected: ExactExecutionEffect,
  keySet: TrustedAuthorityKeySet,
  nowMs: number,
  consumedApprovalIds: ReadonlySet<string>,
  verifier: AuthoritySignatureVerifier,
): Promise<
  | Readonly<{
      allowed: true;
      approvalId: string;
      challengeId: string;
      operationId: string;
      decisionDigest: string;
    }>
  | Readonly<{
      allowed: false;
      reason: ExecutionAuthorityDenialReason;
    }>
> {
  const parsed = SignedOperationApprovalDecisionSchema.safeParse(rawDecision);
  if (!parsed.success) return { allowed: false, reason: "approval_invalid" };
  const decision = parsed.data;

  const timeFailure = checkArtifactTime(decision, nowMs);
  if (timeFailure !== undefined) {
    return { allowed: false, reason: "approval_invalid" };
  }
  const proofFailure = await verifyArtifact(
    decision,
    keySet,
    nowMs,
    verifier,
  );
  if (proofFailure !== undefined) {
    return { allowed: false, reason: "approval_invalid" };
  }
  if (
    decision.claims.issuer !== expected.issuer ||
    decision.claims.request.issuer !== expected.issuer ||
    decision.claims.audience !== expected.audience ||
    decision.claims.request.audience !== expected.audience
  ) {
    return { allowed: false, reason: "approval_invalid" };
  }
  if (decision.claims.decision !== "approved") {
    return { allowed: false, reason: "approval_denied" };
  }

  const request = decision.claims.request;
  if (
    request.envelopeId !== expected.envelopeId ||
    request.bindingId !== expected.bindingId ||
    request.bindingRevision !== expected.bindingRevision ||
    request.principalId !== expected.principalId ||
    request.executionId !== expected.executionId ||
    request.operationId !== expected.operationId ||
    request.routeScope !== expected.routeScope ||
    request.routeLeaseId !== expected.routeLeaseId ||
    request.routeEpoch !== expected.routeEpoch ||
    request.requiredCapability !== expected.capability ||
    request.requestDigest !== expected.requestDigest ||
    request.replayClass !== expected.replayClass ||
    request.policyRevision !== expected.policyRevision ||
    !optionalEqual(request.resourceMappingId, expected.resourceMappingId) ||
    !sameScopes(request.resourceScopes, expected.resourceScopes)
  ) {
    return { allowed: false, reason: "approval_invalid" };
  }
  if (consumedApprovalIds.has(request.approvalId)) {
    return { allowed: false, reason: "approval_replayed" };
  }

  return {
    allowed: true,
    approvalId: request.approvalId,
    challengeId: request.challengeId,
    operationId: request.operationId,
    decisionDigest: await sha256AuthorityDigest(decision.claims),
  };
}

/**
 * Evaluates the complete effect boundary. Callers must invoke this immediately
 * before each observable effect and atomically persist any returned approval
 * consumption with their local operation journal.
 */
export async function authorizeExecutionEffect(
  input: AuthorizeExecutionEffectInput,
): Promise<ExecutionEffectAuthorization> {
  const now = IsoTimestampSchema.safeParse(input.now);
  const expected = ExactExecutionEffectSchema.safeParse(input.expected);
  const keySet = TrustedAuthorityKeySetSchema.safeParse(input.keySet);
  const envelope = SignedBindingAuthorityEnvelopeSchema.safeParse(
    input.acceptedEnvelope,
  );
  const attenuation = LocalAuthorityAttenuationSchema.safeParse(
    input.localAttenuation,
  );
  const routeLease = SignedExecutionRouteLeaseSchema.safeParse(input.routeLease);
  const grant = SignedExecutionCapabilityGrantSchema.safeParse(input.grant);
  if (
    !now.success ||
    !expected.success ||
    !keySet.success ||
    !envelope.success ||
    !attenuation.success ||
    !routeLease.success ||
    !grant.success
  ) {
    return denied("invalid_input");
  }

  const nowMs = Date.parse(now.data);
  const exact = expected.data;
  const trustedKeys = keySet.data;
  const acceptedEnvelope = envelope.data;
  const localAttenuation = attenuation.data;
  const lease = routeLease.data;
  const executionGrant = grant.data;
  const verifier = input.verifySignature ?? verifyEd25519AuthoritySignature;

  if (trustedKeys.revision < exact.minimumKeySetRevision) {
    return denied("key_set_downgrade");
  }
  if (nowMs < Date.parse(trustedKeys.acceptedAt)) {
    return denied("key_inactive");
  }
  if (
    trustedKeys.issuer !== exact.issuer ||
    acceptedEnvelope.claims.issuer !== exact.issuer ||
    lease.claims.issuer !== exact.issuer ||
    executionGrant.claims.issuer !== exact.issuer
  ) {
    return denied("issuer_mismatch");
  }
  if (
    trustedKeys.audience !== exact.audience ||
    acceptedEnvelope.claims.audience !== exact.audience ||
    lease.claims.audience !== exact.audience ||
    executionGrant.claims.audience !== exact.audience
  ) {
    return denied("audience_mismatch");
  }

  for (const artifact of [acceptedEnvelope, lease, executionGrant]) {
    const timeFailure = checkArtifactTime(artifact, nowMs);
    if (timeFailure !== undefined) return denied(timeFailure);
    const proofFailure = await verifyArtifact(
      artifact,
      trustedKeys,
      nowMs,
      verifier,
    );
    if (proofFailure !== undefined) return denied(proofFailure);
  }

  const envelopeClaims = acceptedEnvelope.claims;
  const leaseClaims = lease.claims;
  const grantClaims = executionGrant.claims;

  if (
    envelopeClaims.envelopeId !== exact.envelopeId ||
    grantClaims.envelopeId !== exact.envelopeId
  ) {
    return denied("envelope_mismatch");
  }
  if (
    envelopeClaims.bindingId !== exact.bindingId ||
    leaseClaims.bindingId !== exact.bindingId ||
    grantClaims.bindingId !== exact.bindingId ||
    localAttenuation.bindingId !== exact.bindingId
  ) {
    return denied("binding_mismatch");
  }
  if (
    envelopeClaims.bindingRevision !== exact.bindingRevision ||
    leaseClaims.bindingRevision !== exact.bindingRevision ||
    grantClaims.bindingRevision !== exact.bindingRevision ||
    localAttenuation.bindingRevision !== exact.bindingRevision
  ) {
    return denied("binding_revision_mismatch");
  }
  if (envelopeClaims.runtimeKeyId !== exact.runtimeKeyId) {
    return denied("runtime_key_mismatch");
  }
  if (
    envelopeClaims.authorityDomain !== exact.authorityDomain ||
    leaseClaims.authorityDomain !== exact.authorityDomain
  ) {
    return denied("authority_domain_mismatch");
  }
  if (envelopeClaims.channelMode !== exact.channelMode) {
    return denied("channel_mode_mismatch");
  }
  if (envelopeClaims.recoveryMode !== exact.recoveryMode) {
    return denied("recovery_mode_mismatch");
  }
  if (
    envelopeClaims.policyRevision !== exact.policyRevision ||
    grantClaims.policyRevision !== exact.policyRevision
  ) {
    return denied("policy_revision_mismatch");
  }
  if (
    localAttenuation.envelopeId !== exact.envelopeId ||
    nowMs < Date.parse(localAttenuation.acceptedAt) ||
    nowMs >= Date.parse(localAttenuation.expiresAt)
  ) {
    return denied("attenuation_invalid");
  }
  if (
    !isSubset(
      localAttenuation.capabilities,
      envelopeClaims.capabilities,
      (capability) => capability,
    ) ||
    !isSubset(
      localAttenuation.resourceScopes,
      envelopeClaims.resourceScopes,
      scopeKey,
    )
  ) {
    return denied("attenuation_invalid");
  }
  if (
    !isSubset(
      grantClaims.capabilities,
      envelopeClaims.capabilities,
      (capability) => capability,
    ) ||
    !isSubset(
      grantClaims.capabilities,
      localAttenuation.capabilities,
      (capability) => capability,
    )
  ) {
    return denied("capability_outside_envelope");
  }
  if (!grantClaims.capabilities.includes(exact.capability)) {
    return denied("capability_missing");
  }
  if (
    !envelopeClaims.capabilities.includes(exact.capability) ||
    !localAttenuation.capabilities.includes(exact.capability)
  ) {
    return denied("capability_outside_envelope");
  }
  if (
    !isSubset(
      grantClaims.resourceScopes,
      envelopeClaims.resourceScopes,
      scopeKey,
    ) ||
    !isSubset(
      grantClaims.resourceScopes,
      localAttenuation.resourceScopes,
      scopeKey,
    )
  ) {
    return denied("scope_outside_envelope");
  }
  if (
    !isSubset(exact.resourceScopes, grantClaims.resourceScopes, scopeKey)
  ) {
    return denied("scope_missing");
  }
  if (
    !isSubset(exact.resourceScopes, envelopeClaims.resourceScopes, scopeKey) ||
    !isSubset(exact.resourceScopes, localAttenuation.resourceScopes, scopeKey)
  ) {
    return denied("scope_outside_envelope");
  }
  if (
    !optionalEqual(
      envelopeClaims.resourceMappingId,
      exact.resourceMappingId,
    ) ||
    !optionalEqual(grantClaims.resourceMappingId, exact.resourceMappingId)
  ) {
    return denied("resource_mapping_mismatch");
  }
  if (grantClaims.principalId !== exact.principalId) {
    return denied("principal_mismatch");
  }
  if (grantClaims.executionId !== exact.executionId) {
    return denied("execution_mismatch");
  }
  if (!optionalEqual(grantClaims.operationId, exact.operationId)) {
    return denied("operation_mismatch");
  }
  if (grantClaims.requestDigest !== exact.requestDigest) {
    return denied("request_digest_mismatch");
  }
  if (grantClaims.replayClass !== exact.replayClass) {
    return denied("replay_class_mismatch");
  }
  if (
    leaseClaims.routeScope !== exact.routeScope ||
    grantClaims.routeScope !== exact.routeScope
  ) {
    return denied("route_scope_mismatch");
  }
  if (
    leaseClaims.leaseId !== exact.routeLeaseId ||
    grantClaims.routeLeaseId !== exact.routeLeaseId
  ) {
    return denied("route_lease_mismatch");
  }
  if (
    leaseClaims.routeEpoch !== exact.routeEpoch ||
    grantClaims.routeEpoch !== exact.routeEpoch ||
    exact.routeEpoch < exact.highestAcceptedRouteEpoch
  ) {
    return denied("stale_epoch");
  }
  if (exact.routeEpoch > exact.highestAcceptedRouteEpoch) {
    return denied("epoch_not_persisted");
  }

  const authorizationDigest = await sha256AuthorityDigest(grantClaims);
  const grantUse = ExecutionGrantUseRecordSchema.parse({
    grantId: grantClaims.grantId,
    authorizationDigest,
    executionId: grantClaims.executionId,
    operationId: grantClaims.operationId,
    requestDigest: grantClaims.requestDigest,
    routeScope: grantClaims.routeScope,
    routeEpoch: grantClaims.routeEpoch,
    replayClass: grantClaims.replayClass,
    recordedAt: now.data,
  });
  if (input.priorGrantUse !== undefined) {
    const priorGrantUse = ExecutionGrantUseRecordSchema.safeParse(
      input.priorGrantUse,
    );
    if (
      !priorGrantUse.success ||
      priorGrantUse.data.grantId !== grantUse.grantId ||
      priorGrantUse.data.authorizationDigest !==
        grantUse.authorizationDigest ||
      priorGrantUse.data.executionId !== grantUse.executionId ||
      !optionalEqual(
        priorGrantUse.data.operationId,
        grantUse.operationId,
      ) ||
      priorGrantUse.data.requestDigest !== grantUse.requestDigest ||
      priorGrantUse.data.routeScope !== grantUse.routeScope ||
      priorGrantUse.data.routeEpoch !== grantUse.routeEpoch ||
      priorGrantUse.data.replayClass !== grantUse.replayClass
    ) {
      return denied("grant_reuse_conflict");
    }
  }
  if (!input.localPolicyAllowed) return denied("local_policy_denied");
  if (!input.runtimeConstraintsAllowed) {
    return denied("runtime_constraint_denied");
  }

  let approvalConsumption:
    | Readonly<{
        approvalId: string;
        challengeId: string;
        operationId: string;
        decisionDigest: string;
      }>
    | undefined;
  if (input.approval?.required === true) {
    if (input.approval.decision === undefined) {
      return denied("approval_required");
    }
    if (exact.operationId === undefined) {
      return denied("approval_invalid");
    }
    const approvalResult = await verifyApproval(
      input.approval.decision,
      exact,
      trustedKeys,
      nowMs,
      input.approval.consumedApprovalIds ?? new Set(),
      verifier,
    );
    if (!approvalResult.allowed) return denied(approvalResult.reason);
    approvalConsumption = {
      approvalId: approvalResult.approvalId,
      challengeId: approvalResult.challengeId,
      operationId: approvalResult.operationId,
      decisionDigest: approvalResult.decisionDigest,
    };
  }

  return {
    allowed: true,
    grantId: grantClaims.grantId,
    routeLeaseId: leaseClaims.leaseId,
    routeEpoch: leaseClaims.routeEpoch,
    grantUse,
    ...(approvalConsumption === undefined ? {} : { approvalConsumption }),
  };
}

export type AuthorityKeySetAdvanceResult =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      reason:
        | "invalid"
        | "revision_not_monotonic"
        | "party_mismatch"
        | "key_mutated"
        | "key_removed_early"
        | "status_regression"
        | "active_key_invalid";
    }>;

export function validateAuthorityKeySetAdvance(
  currentInput: unknown,
  nextInput: unknown,
  now: string,
): AuthorityKeySetAdvanceResult {
  const current = TrustedAuthorityKeySetSchema.safeParse(currentInput);
  const next = TrustedAuthorityKeySetSchema.safeParse(nextInput);
  const parsedNow = IsoTimestampSchema.safeParse(now);
  if (!current.success || !next.success || !parsedNow.success) {
    return { accepted: false, reason: "invalid" };
  }
  if (next.data.revision <= current.data.revision) {
    return { accepted: false, reason: "revision_not_monotonic" };
  }
  if (
    next.data.issuer !== current.data.issuer ||
    next.data.audience !== current.data.audience
  ) {
    return { accepted: false, reason: "party_mismatch" };
  }

  const nowMs = Date.parse(parsedNow.data);
  const nextKeys = new Map(next.data.keys.map((key) => [key.keyId, key]));
  for (const currentKey of current.data.keys) {
    const nextKey = nextKeys.get(currentKey.keyId);
    const retainUntil =
      currentKey.status === "retiring" && currentKey.acceptUntil !== undefined
        ? Date.parse(currentKey.acceptUntil)
        : Date.parse(currentKey.notAfter);
    if (nextKey === undefined) {
      if (nowMs < retainUntil) {
        return { accepted: false, reason: "key_removed_early" };
      }
      continue;
    }
    if (
      nextKey.algorithm !== currentKey.algorithm ||
      nextKey.publicKey !== currentKey.publicKey ||
      nextKey.notBefore !== currentKey.notBefore ||
      nextKey.notAfter !== currentKey.notAfter
    ) {
      return { accepted: false, reason: "key_mutated" };
    }
    if (
      (currentKey.status === "retiring" && nextKey.status === "active") ||
      (currentKey.status === "revoked" && nextKey.status !== "revoked")
    ) {
      return { accepted: false, reason: "status_regression" };
    }
  }

  const activeKey = next.data.keys.find(
    (key) => key.keyId === next.data.activeKeyId,
  );
  if (
    activeKey === undefined ||
    activeKey.status !== "active" ||
    nowMs < Date.parse(activeKey.notBefore) ||
    nowMs >= Date.parse(activeKey.notAfter)
  ) {
    return { accepted: false, reason: "active_key_invalid" };
  }
  return { accepted: true };
}

export function decideOperationRecovery(input: Readonly<{
  replayClass: OperationReplayClass;
  outcome: OperationOutcomeState;
  readback?: OperationReadbackResult;
}>): OperationRecoveryAction {
  const replayClass = OperationReplayClassSchema.parse(input.replayClass);
  const outcome = OperationOutcomeStateSchema.parse(input.outcome);
  const readback =
    input.readback === undefined
      ? undefined
      : OperationReadbackResultSchema.parse(input.readback);

  if (outcome === "succeeded" || outcome === "failed") return "none";
  if (outcome === "manual_resolution") return "manual_resolution";
  if (outcome === "not_started") return "start";
  if (outcome === "in_progress") {
    if (replayClass === "idempotent") return "retry_same_identity";
    if (replayClass === "readback_required") return "readback";
    return "manual_resolution";
  }
  if (replayClass === "idempotent") return "retry_same_identity";
  if (replayClass === "non_repeatable") return "manual_resolution";
  if (readback === undefined) return "readback";
  if (readback === "not_applied") return "retry_same_identity";
  if (readback === "applied") return "reconcile_terminal";
  return "manual_resolution";
}
