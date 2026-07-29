import { beforeAll, describe, expect, it } from "bun:test";
import {
  ApprovalConsumptionRecordSchema,
  BindingAuthorityEnvelopeClaimsSchema,
  EXECUTION_AUTHORITY_CLOCK_SKEW_TOLERANCE_MS,
  ExactExecutionEffectSchema,
  ExecutionCapabilityGrantClaimsSchema,
  LocalAuthorityAttenuationSchema,
  OperationApprovalDecisionClaimsSchema,
  OperationApprovalRequestSchema,
  SignedBindingAuthorityEnvelopeSchema,
  SignedExecutionCapabilityGrantSchema,
  SignedExecutionRouteLeaseSchema,
  SignedOperationApprovalDecisionSchema,
  TrustedAuthorityKeySetSchema,
  authorizeExecutionEffect,
  canonicalizeAuthorityPayload,
  decideOperationRecovery,
  encodeAuthorityBase64Url,
  sha256AuthorityDigest,
  validateAuthorityKeySetAdvance,
  type AuthorizeExecutionEffectInput,
  type AuthorityVerificationKey,
  type BindingAuthorityEnvelopeClaims,
  type ExactExecutionEffect,
  type ExecutionCapabilityGrantClaims,
  type ExecutionRouteLeaseClaims,
  type OperationApprovalDecisionClaims,
  type OperationApprovalRequest,
  type SignedBindingAuthorityEnvelope,
  type SignedExecutionCapabilityGrant,
  type SignedExecutionRouteLease,
  type SignedOperationApprovalDecision,
  type TrustedAuthorityKeySet,
} from "../execution-authority.js";

const fixtureDirectory = new URL(
  "./fixtures/execution-authority/",
  import.meta.url,
);
const NOW = "2026-07-26T18:01:00.000Z";
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

let signingPrivateKey: CryptoKey;
let signingPublicKey: string;
let nextPublicKey: string;

async function fixture<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, fixtureDirectory)).json() as Promise<T>;
}

async function signClaims<T>(
  claims: T,
  keyId = "hub-key-a",
): Promise<{ claims: T; proof: { algorithm: "Ed25519"; keyId: string; signature: string } }> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    signingPrivateKey,
    new TextEncoder().encode(canonicalizeAuthorityPayload(claims)),
  );
  return {
    claims,
    proof: {
      algorithm: "Ed25519",
      keyId,
      signature: encodeAuthorityBase64Url(signature),
    },
  };
}

function activeKey(
  publicKey = signingPublicKey,
  keyId = "hub-key-a",
): AuthorityVerificationKey {
  return {
    keyId,
    algorithm: "Ed25519",
    publicKey,
    status: "active",
    notBefore: "2026-07-26T16:00:00.000Z",
    notAfter: "2026-07-27T16:00:00.000Z",
  };
}

function keySet(
  keys: readonly AuthorityVerificationKey[] = [activeKey()],
  activeKeyId = "hub-key-a",
  revision = 4,
): TrustedAuthorityKeySet {
  return TrustedAuthorityKeySetSchema.parse({
    protocol: "ravi.execution.authority",
    schemaVersion: 1,
    kind: "trusted_authority_key_set",
    revision,
    issuer: "https://hub.example.test",
    audience: "runtime-a",
    activeKeyId,
    keys,
    acceptedAt: "2026-07-26T17:59:00.000Z",
  });
}

async function approvalDecision(
  request: OperationApprovalRequest,
  overrides: Partial<OperationApprovalDecisionClaims> = {},
): Promise<SignedOperationApprovalDecision> {
  const claims = OperationApprovalDecisionClaimsSchema.parse({
    protocol: "ravi.execution.authority",
    schemaVersion: 1,
    kind: "operation_approval_decision",
    request,
    decision: "approved",
    decidedBy: "principal-reviewer-a",
    decidedAt: "2026-07-26T18:00:30.000Z",
    usageLimit: 1,
    keySetRevision: 4,
    issuer: "https://hub.example.test",
    audience: "runtime-a",
    issuedAt: "2026-07-26T18:00:30.000Z",
    notBefore: "2026-07-26T18:00:30.000Z",
    expiresAt: "2026-07-26T18:03:00.000Z",
    ...overrides,
  });
  return SignedOperationApprovalDecisionSchema.parse(await signClaims(claims));
}

type ValidArtifacts = Readonly<{
  input: AuthorizeExecutionEffectInput;
  expected: ExactExecutionEffect;
  keySet: TrustedAuthorityKeySet;
  envelopeClaims: BindingAuthorityEnvelopeClaims;
  envelope: SignedBindingAuthorityEnvelope;
  leaseClaims: ExecutionRouteLeaseClaims;
  lease: SignedExecutionRouteLease;
  grantClaims: ExecutionCapabilityGrantClaims;
  grant: SignedExecutionCapabilityGrant;
  approvalRequest: OperationApprovalRequest;
  decision: SignedOperationApprovalDecision;
}>;

async function validArtifacts(): Promise<ValidArtifacts> {
  const envelopeClaims = BindingAuthorityEnvelopeClaimsSchema.parse(
    await fixture("binding-envelope-claims.json"),
  );
  const leaseClaims = SignedExecutionRouteLeaseSchema.shape.claims.parse(
    await fixture("route-lease-claims.json"),
  );
  const grantClaims = ExecutionCapabilityGrantClaimsSchema.parse(
    await fixture("execution-grant-claims.json"),
  );
  const approvalRequest = OperationApprovalRequestSchema.parse(
    await fixture("approval-request.json"),
  );
  const envelope = SignedBindingAuthorityEnvelopeSchema.parse(
    await signClaims(envelopeClaims),
  );
  const lease = SignedExecutionRouteLeaseSchema.parse(
    await signClaims(leaseClaims),
  );
  const grant = SignedExecutionCapabilityGrantSchema.parse(
    await signClaims(grantClaims),
  );
  const decision = await approvalDecision(approvalRequest);
  const trustedKeys = keySet();
  const expected = ExactExecutionEffectSchema.parse({
    issuer: envelopeClaims.issuer,
    audience: envelopeClaims.audience,
    minimumKeySetRevision: 4,
    envelopeId: envelopeClaims.envelopeId,
    bindingId: envelopeClaims.bindingId,
    bindingRevision: envelopeClaims.bindingRevision,
    runtimeKeyId: envelopeClaims.runtimeKeyId,
    authorityDomain: envelopeClaims.authorityDomain,
    channelMode: envelopeClaims.channelMode,
    recoveryMode: envelopeClaims.recoveryMode,
    policyRevision: envelopeClaims.policyRevision,
    principalId: grantClaims.principalId,
    executionId: grantClaims.executionId,
    operationId: grantClaims.operationId,
    routeScope: leaseClaims.routeScope,
    routeLeaseId: leaseClaims.leaseId,
    routeEpoch: leaseClaims.routeEpoch,
    highestAcceptedRouteEpoch: leaseClaims.routeEpoch,
    capability: grantClaims.capabilities[0],
    resourceScopes: grantClaims.resourceScopes,
    resourceMappingId: grantClaims.resourceMappingId,
    requestDigest: grantClaims.requestDigest,
    replayClass: grantClaims.replayClass,
  });
  const attenuation = LocalAuthorityAttenuationSchema.parse({
    envelopeId: envelopeClaims.envelopeId,
    bindingId: envelopeClaims.bindingId,
    bindingRevision: envelopeClaims.bindingRevision,
    attenuationRevision: 2,
    capabilities: envelopeClaims.capabilities,
    resourceScopes: envelopeClaims.resourceScopes,
    acceptedAt: "2026-07-26T17:10:00.000Z",
    expiresAt: "2026-07-26T19:00:00.000Z",
  });

  return {
    expected,
    keySet: trustedKeys,
    envelopeClaims,
    envelope,
    leaseClaims,
    lease,
    grantClaims,
    grant,
    approvalRequest,
    decision,
    input: {
      now: NOW,
      expected,
      keySet: trustedKeys,
      acceptedEnvelope: envelope,
      localAttenuation: attenuation,
      routeLease: lease,
      grant,
      localPolicyAllowed: true,
      runtimeConstraintsAllowed: true,
      approval: {
        required: true,
        decision,
        consumedApprovalIds: new Set(),
      },
    },
  };
}

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  signingPrivateKey = keyPair.privateKey;
  signingPublicKey = encodeAuthorityBase64Url(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  );
  const nextKeyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  nextPublicKey = encodeAuthorityBase64Url(
    await crypto.subtle.exportKey("spki", nextKeyPair.publicKey),
  );
});

describe("execution authority public contract", () => {
  it("parses canonical public fixtures without product or local-runtime vocabulary", async () => {
    const fixtures = [
      BindingAuthorityEnvelopeClaimsSchema.parse(
        await fixture("binding-envelope-claims.json"),
      ),
      SignedExecutionRouteLeaseSchema.shape.claims.parse(
        await fixture("route-lease-claims.json"),
      ),
      ExecutionCapabilityGrantClaimsSchema.parse(
        await fixture("execution-grant-claims.json"),
      ),
      OperationApprovalRequestSchema.parse(
        await fixture("approval-request.json"),
      ),
    ];
    const serialized = JSON.stringify(fixtures);

    expect(serialized).not.toMatch(
      /role|organization|bot|conversation|agent|workspace|path|prompt|content|provider/i,
    );
  });

  it("keeps security-critical schemas strict, bounded, and set-like", async () => {
    const envelope = await fixture<Record<string, unknown>>(
      "binding-envelope-claims.json",
    );

    expect(
      BindingAuthorityEnvelopeClaimsSchema.safeParse({
        ...envelope,
        role: "admin",
      }).success,
    ).toBe(false);
    expect(
      BindingAuthorityEnvelopeClaimsSchema.safeParse({
        ...envelope,
        capabilities: ["data.read", "data.read"],
      }).success,
    ).toBe(false);
    expect(
      BindingAuthorityEnvelopeClaimsSchema.safeParse({
        ...envelope,
        expiresAt: "2026-07-28T17:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("canonicalizes claims deterministically and produces an explicit digest", async () => {
    expect(canonicalizeAuthorityPayload({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalizeAuthorityPayload({ a: { c: 3, d: 2 }, b: 1 }),
    );
    await expect(sha256AuthorityDigest({ b: 1, a: 2 })).resolves.toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("allows only the exact signed effect and returns an atomic approval consumption", async () => {
    const { input } = await validArtifacts();
    const result = await authorizeExecutionEffect(input);

    expect(result).toMatchObject({
      allowed: true,
      grantId: "grant-a",
      routeLeaseId: "lease-a",
      routeEpoch: 7,
      approvalConsumption: {
        approvalId: "approval-a",
        challengeId: "challenge-a",
        operationId: "operation-a",
      },
    });
    if (result.allowed && result.approvalConsumption !== undefined) {
      expect(
        ApprovalConsumptionRecordSchema.safeParse({
          ...result.approvalConsumption,
          consumedAt: NOW,
        }).success,
      ).toBe(true);
    }
  });

  it("tolerates bounded issuer clock skew without extending expiration", async () => {
    const artifacts = await validArtifacts();
    const authorityNow = "2026-07-26T18:01:00.000Z";
    const runtimeNow = "2026-07-26T18:00:59.700Z";
    const envelopeClaims = BindingAuthorityEnvelopeClaimsSchema.parse({
      ...artifacts.envelopeClaims,
      issuedAt: authorityNow,
      notBefore: authorityNow,
    });
    const leaseClaims = SignedExecutionRouteLeaseSchema.shape.claims.parse({
      ...artifacts.leaseClaims,
      issuedAt: authorityNow,
      notBefore: authorityNow,
    });
    const grantClaims = ExecutionCapabilityGrantClaimsSchema.parse({
      ...artifacts.grantClaims,
      issuedAt: authorityNow,
      notBefore: authorityNow,
    });
    const approvalRequest = OperationApprovalRequestSchema.parse({
      ...artifacts.approvalRequest,
      issuedAt: authorityNow,
      notBefore: authorityNow,
    });
    const decision = await approvalDecision(approvalRequest, {
      decidedAt: authorityNow,
      issuedAt: authorityNow,
      notBefore: authorityNow,
    });
    const skewedKeySet = TrustedAuthorityKeySetSchema.parse({
      ...keySet([
        {
          ...activeKey(),
          notBefore: authorityNow,
        },
      ]),
      acceptedAt: authorityNow,
    });

    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        now: runtimeNow,
        keySet: skewedKeySet,
        acceptedEnvelope: await signClaims(envelopeClaims),
        routeLease: await signClaims(leaseClaims),
        grant: await signClaims(grantClaims),
        approval: {
          required: true,
          decision,
          consumedApprovalIds: new Set(),
        },
      }),
    ).resolves.toMatchObject({ allowed: true });

    const beyondTolerance = new Date(
      Date.parse(NOW) + EXECUTION_AUTHORITY_CLOCK_SKEW_TOLERANCE_MS + 1,
    ).toISOString();
    const futureGrantClaims = ExecutionCapabilityGrantClaimsSchema.parse({
      ...artifacts.grantClaims,
      issuedAt: NOW,
      notBefore: beyondTolerance,
    });
    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        grant: await signClaims(futureGrantClaims),
      }),
    ).resolves.toEqual({ allowed: false, reason: "not_yet_valid" });

    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        now: artifacts.grantClaims.expiresAt,
      }),
    ).resolves.toEqual({ allowed: false, reason: "expired" });

    const nextKeySet = TrustedAuthorityKeySetSchema.parse({
      ...keySet(
        [
          {
            ...activeKey(),
            status: "retiring",
            retiredAt: authorityNow,
            acceptUntil: "2026-07-26T18:06:00.000Z",
          },
          {
            ...activeKey(nextPublicKey, "hub-key-b"),
            notBefore: authorityNow,
          },
        ],
        "hub-key-b",
        5,
      ),
      acceptedAt: authorityNow,
    });
    expect(
      validateAuthorityKeySetAdvance(
        artifacts.keySet,
        nextKeySet,
        runtimeNow,
      ),
    ).toEqual({ accepted: true });
    expect(
      validateAuthorityKeySetAdvance(
        artifacts.keySet,
        nextKeySet,
        new Date(
          Date.parse(authorityNow) -
            EXECUTION_AUTHORITY_CLOCK_SKEW_TOLERANCE_MS -
            1,
        ).toISOString(),
      ),
    ).toEqual({ accepted: false, reason: "active_key_invalid" });
  });

  it("fails closed for every exact-effect mismatch", async () => {
    const { input, expected } = await validArtifacts();
    const scenarios: readonly [
      Partial<ExactExecutionEffect>,
      string,
    ][] = [
      [{ audience: "runtime-b" }, "audience_mismatch"],
      [{ bindingId: "binding-b" }, "binding_mismatch"],
      [{ bindingRevision: 4 }, "binding_revision_mismatch"],
      [{ runtimeKeyId: "runtime-key-b" }, "runtime_key_mismatch"],
      [{ authorityDomain: "authority-b" }, "authority_domain_mismatch"],
      [{ channelMode: "receive_only" }, "channel_mode_mismatch"],
      [{ recoveryMode: "checkpoint" }, "recovery_mode_mismatch"],
      [{ policyRevision: 12 }, "policy_revision_mismatch"],
      [{ principalId: "principal-b" }, "principal_mismatch"],
      [{ executionId: "execution-b" }, "execution_mismatch"],
      [{ operationId: "operation-b" }, "operation_mismatch"],
      [{ requestDigest: OTHER_DIGEST }, "request_digest_mismatch"],
      [{ replayClass: "idempotent" }, "replay_class_mismatch"],
      [{ routeScope: "route-b" }, "route_scope_mismatch"],
      [{ routeLeaseId: "lease-b" }, "route_lease_mismatch"],
      [{ highestAcceptedRouteEpoch: 8 }, "stale_epoch"],
      [{ highestAcceptedRouteEpoch: 6 }, "epoch_not_persisted"],
      [{ capability: "external.issue.delete" }, "capability_missing"],
      [
        {
          resourceScopes: [
            { kind: "resource", resourceId: "resource-b" },
          ],
        },
        "scope_missing",
      ],
      [{ resourceMappingId: "mapping-b" }, "resource_mapping_mismatch"],
    ];

    for (const [override, reason] of scenarios) {
      await expect(
        authorizeExecutionEffect({
          ...input,
          expected: { ...expected, ...override },
        }),
      ).resolves.toEqual({ allowed: false, reason });
    }
  });

  it("rejects tampering, unknown keys, expired leases, and both local denies", async () => {
    const { input, grant } = await validArtifacts();
    const tamperedSignature =
      `${grant.proof.signature[0] === "A" ? "B" : "A"}${grant.proof.signature.slice(1)}`;

    await expect(
      authorizeExecutionEffect({
        ...input,
        grant: {
          ...grant,
          proof: { ...grant.proof, signature: tamperedSignature },
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: "signature_invalid" });
    await expect(
      authorizeExecutionEffect({
        ...input,
        grant: {
          ...grant,
          proof: { ...grant.proof, keyId: "unknown-key" },
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: "key_unknown" });
    await expect(
      authorizeExecutionEffect({
        ...input,
        now: "2026-07-26T18:05:00.000Z",
      }),
    ).resolves.toEqual({ allowed: false, reason: "expired" });
    await expect(
      authorizeExecutionEffect({
        ...input,
        localPolicyAllowed: false,
      }),
    ).resolves.toEqual({ allowed: false, reason: "local_policy_denied" });
    await expect(
      authorizeExecutionEffect({
        ...input,
        runtimeConstraintsAllowed: false,
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "runtime_constraint_denied",
    });
  });

  it("rejects authority amplification in either the grant or local attenuation", async () => {
    const { input, grantClaims } = await validArtifacts();
    const amplifiedGrant = SignedExecutionCapabilityGrantSchema.parse(
      await signClaims({
        ...grantClaims,
        capabilities: [
          ...grantClaims.capabilities,
          "external.issue.delete",
        ],
      }),
    );
    await expect(
      authorizeExecutionEffect({ ...input, grant: amplifiedGrant }),
    ).resolves.toEqual({
      allowed: false,
      reason: "capability_outside_envelope",
    });

    const localAttenuation = input.localAttenuation as Record<string, unknown>;
    await expect(
      authorizeExecutionEffect({
        ...input,
        localAttenuation: {
          ...localAttenuation,
          capabilities: [
            ...((localAttenuation.capabilities as string[]) ?? []),
            "external.issue.delete",
          ],
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: "attenuation_invalid" });
  });

  it("allows grant reuse only for the same signed logical delivery", async () => {
    const { input } = await validArtifacts();
    const first = await authorizeExecutionEffect(input);
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected an allowed fixture");

    await expect(
      authorizeExecutionEffect({
        ...input,
        priorGrantUse: first.grantUse,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      authorizeExecutionEffect({
        ...input,
        priorGrantUse: {
          ...first.grantUse,
          authorizationDigest: OTHER_DIGEST,
        },
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: "grant_reuse_conflict",
    });
  });

  it("binds approval to exact arguments, principal, epoch, capability, replay class, and one use", async () => {
    const { input, approvalRequest } = await validArtifacts();
    const mutations: readonly Partial<OperationApprovalRequest>[] = [
      { requestDigest: OTHER_DIGEST },
      { principalId: "principal-b" },
      { routeEpoch: 8 },
      { requiredCapability: "data.read" },
      { replayClass: "idempotent" },
    ];

    for (const mutation of mutations) {
      const request = OperationApprovalRequestSchema.parse({
        ...approvalRequest,
        ...mutation,
      });
      const decision = await approvalDecision(request);
      await expect(
        authorizeExecutionEffect({
          ...input,
          approval: {
            required: true,
            decision,
            consumedApprovalIds: new Set(),
          },
        }),
      ).resolves.toEqual({ allowed: false, reason: "approval_invalid" });
    }

    await expect(
      authorizeExecutionEffect({
        ...input,
        approval: {
          ...(input.approval ?? { required: true }),
          consumedApprovalIds: new Set(["approval-a"]),
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: "approval_replayed" });

    const deniedDecision = await approvalDecision(approvalRequest, {
      decision: "denied",
    });
    await expect(
      authorizeExecutionEffect({
        ...input,
        approval: {
          required: true,
          decision: deniedDecision,
        },
      }),
    ).resolves.toEqual({ allowed: false, reason: "approval_denied" });
  });

  it("accepts bounded key overlap, rejects downgrade/removal, and stops retired-key issuance", async () => {
    const artifacts = await validArtifacts();
    const retiringKey: AuthorityVerificationKey = {
      ...activeKey(),
      status: "retiring",
      retiredAt: "2026-07-26T18:00:30.000Z",
      acceptUntil: "2026-07-26T18:05:00.000Z",
    };
    const rotated = keySet(
      [retiringKey, activeKey(nextPublicKey, "hub-key-b")],
      "hub-key-b",
      5,
    );

    expect(
      validateAuthorityKeySetAdvance(
        artifacts.keySet,
        rotated,
        "2026-07-26T18:01:00.000Z",
      ),
    ).toEqual({ accepted: true });
    expect(
      validateAuthorityKeySetAdvance(
        artifacts.keySet,
        artifacts.keySet,
        NOW,
      ),
    ).toEqual({ accepted: false, reason: "revision_not_monotonic" });
    expect(
      validateAuthorityKeySetAdvance(
        artifacts.keySet,
        keySet([activeKey(nextPublicKey, "hub-key-b")], "hub-key-b", 5),
        NOW,
      ),
    ).toEqual({ accepted: false, reason: "key_removed_early" });

    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        keySet: rotated,
      }),
    ).resolves.toMatchObject({ allowed: true });

    const lateGrantClaims = ExecutionCapabilityGrantClaimsSchema.parse({
      ...artifacts.grantClaims,
      issuedAt: "2026-07-26T18:01:00.000Z",
      notBefore: "2026-07-26T18:01:00.000Z",
      expiresAt: "2026-07-26T18:03:00.000Z",
      keySetRevision: 5,
    });
    const lateGrant = SignedExecutionCapabilityGrantSchema.parse(
      await signClaims(lateGrantClaims),
    );
    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        now: "2026-07-26T18:02:00.000Z",
        keySet: rotated,
        grant: lateGrant,
      }),
    ).resolves.toEqual({ allowed: false, reason: "key_inactive" });

    const revoked = keySet(
      [
        {
          ...activeKey(),
          status: "revoked",
          revokedAt: "2026-07-26T18:00:30.000Z",
        },
        activeKey(nextPublicKey, "hub-key-b"),
      ],
      "hub-key-b",
      5,
    );
    await expect(
      authorizeExecutionEffect({
        ...artifacts.input,
        keySet: revoked,
      }),
    ).resolves.toEqual({ allowed: false, reason: "key_revoked" });
  });

  it("distinguishes FAILED from OUTCOME_UNKNOWN and never auto-repeats an ambiguous non-repeatable effect", () => {
    expect(
      decideOperationRecovery({
        replayClass: "non_repeatable",
        outcome: "failed",
      }),
    ).toBe("none");
    expect(
      decideOperationRecovery({
        replayClass: "non_repeatable",
        outcome: "outcome_unknown",
      }),
    ).toBe("manual_resolution");
    expect(
      decideOperationRecovery({
        replayClass: "non_repeatable",
        outcome: "in_progress",
      }),
    ).toBe("manual_resolution");
    expect(
      decideOperationRecovery({
        replayClass: "readback_required",
        outcome: "in_progress",
      }),
    ).toBe("readback");
    expect(
      decideOperationRecovery({
        replayClass: "idempotent",
        outcome: "outcome_unknown",
      }),
    ).toBe("retry_same_identity");
    expect(
      decideOperationRecovery({
        replayClass: "readback_required",
        outcome: "outcome_unknown",
      }),
    ).toBe("readback");
    expect(
      decideOperationRecovery({
        replayClass: "readback_required",
        outcome: "outcome_unknown",
        readback: "not_applied",
      }),
    ).toBe("retry_same_identity");
    expect(
      decideOperationRecovery({
        replayClass: "readback_required",
        outcome: "outcome_unknown",
        readback: "applied",
      }),
    ).toBe("reconcile_terminal");
    expect(
      decideOperationRecovery({
        replayClass: "readback_required",
        outcome: "outcome_unknown",
        readback: "inconclusive",
      }),
    ).toBe("manual_resolution");
  });
});
