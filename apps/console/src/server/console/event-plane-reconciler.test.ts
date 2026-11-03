import { describe, expect, test } from "bun:test";

import { EventPlaneControlError } from "./event-plane";
import {
  buildEventPlaneReconciliationPlan,
  createSelfHostedNatsJwtProviderAdapter,
  EVENT_PLANE_P0_REVOCATION_RTO_MS,
  reconcileEventPlaneCell,
  SELF_HOSTED_NATS_JWT_PROVIDER,
} from "./event-plane-reconciler";
import type {
  EventPlaneDesiredStateSnapshot,
  EventPlaneObservedState,
  EventPlaneProviderApplyResult,
  EventPlaneReconcileOperation,
  SelfHostedNatsJwtDriver,
} from "./event-plane-reconciler";

const CELL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const IDENTITY_ID = "44444444-4444-4444-8444-444444444444";
const GRANT_ID = "55555555-5555-4555-8555-555555555555";
const POLICY_ID = "66666666-6666-4666-8666-666666666666";
const LINK_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_IDENTITY_ID = "88888888-8888-4888-8888-888888888888";
const SECOND_GRANT_ID = "99999999-9999-4999-8999-999999999999";

describe("Event Plane reconciler", () => {
  test("plans the self-hosted NATS/JWT resources without secret material", () => {
    const desiredState = syntheticDesiredState();
    const observedState = emptyObservedState();

    const plan = buildEventPlaneReconciliationPlan({
      cellId: CELL_ID,
      desiredState,
      observedState,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      "cell.reconcile",
      "policy.apply",
      "account.ensure",
      "identity.ensure",
      "grant.issue",
      "cross_account_link.ensure",
    ]);
    expect(plan.operations.every((operation) => operation.idempotencyKey.startsWith("event-plane:"))).toBe(true);
    expect(plan.operations.find((operation) => operation.type === "grant.issue")?.desired).toMatchObject({
      custodyRefPresent: true,
      oneTimeDelivery: {
        approvedChannel: "controller_encrypted_custody",
        required: true,
      },
    });
    expect(JSON.stringify(plan)).not.toMatch(/seed|secretRef|BEGIN NATS|Bearer/i);
  });

  test("applies provider operations once and becomes a no-op after observed state converges", async () => {
    const desiredState = syntheticDesiredState();
    const driver = new MemoryNatsJwtDriver(emptyObservedState());
    const adapter = createSelfHostedNatsJwtProviderAdapter(driver);

    const first = await reconcileEventPlaneCell({
      adapter,
      cellId: CELL_ID,
      desiredState,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(first.operationsPlanned).toBe(6);
    expect(first.operationsApplied).toBe(6);
    expect(first.results.every((result) => result.status === "applied")).toBe(true);

    const second = await reconcileEventPlaneCell({
      adapter,
      cellId: CELL_ID,
      desiredState,
      now: new Date("2026-07-15T12:01:00.000Z"),
    });
    expect(second.operationsPlanned).toBe(0);
    expect(second.operationsApplied).toBe(0);
    expect(second.orphanCount).toBe(0);
  });

  test("invokes the applied-operation hook without exposing provider material", async () => {
    const applied: Array<{ operation: string; status: string }> = [];
    const report = await reconcileEventPlaneCell({
      adapter: createSelfHostedNatsJwtProviderAdapter(new MemoryNatsJwtDriver(emptyObservedState())),
      cellId: CELL_ID,
      desiredState: syntheticDesiredState(),
      onApplied(operation, result) {
        applied.push({ operation: operation.type, status: result.status });
      },
    });

    expect(applied).toHaveLength(report.operationsApplied);
    expect(applied[0]).toEqual({ operation: "cell.reconcile", status: "applied" });
    expect(JSON.stringify(applied)).not.toMatch(/seed|credential|BEGIN NATS|Bearer/i);
  });

  test("quarantines provider orphans instead of adopting them", () => {
    const plan = buildEventPlaneReconciliationPlan({
      cellId: CELL_ID,
      desiredState: syntheticDesiredState(),
      observedState: {
        ...emptyObservedState(),
        accounts: [
          {
            accountPublicKey: "AD_ORPHAN_PUBLIC",
            bindingId: null,
            organizationId: null,
            policyHash: null,
            policyVersion: null,
            providerAccountRef: "nats://p0/accounts/orphan",
            quotaHash: null,
            status: "active",
            streamHash: null,
          },
        ],
      },
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    const quarantine = plan.operations.find((operation) => operation.type === "orphan.quarantine");
    expect(quarantine).toMatchObject({
      emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
      targetType: "event_plane_provider_account",
    });
    expect(plan.orphanCount).toBe(1);
  });

  test("plans emergency revocation when a terminal grant remains active", () => {
    const desiredState = syntheticDesiredState({
      grantStatus: "revoked",
      identityStatus: "revoked",
    });
    const observedState = emptyObservedState();
    observedState.credentialGrants.push({
      grantId: GRANT_ID,
      identityId: IDENTITY_ID,
      providerUserPublicKey: "UD_P0_APP",
      revokedAt: null,
      status: "active",
    });
    observedState.identities.push({
      bindingId: BINDING_ID,
      identityId: IDENTITY_ID,
      permissionsHash: null,
      policyVersion: 1,
      providerUserPublicKey: "UD_P0_APP",
      status: "active",
    });

    const plan = buildEventPlaneReconciliationPlan({
      cellId: CELL_ID,
      desiredState,
      observedState,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
        targetId: GRANT_ID,
        type: "grant.revoke",
      }),
    );
  });

  test("rejects unsafe driver results before they become controller reports", async () => {
    const adapter = createSelfHostedNatsJwtProviderAdapter(new UnsafeNatsJwtDriver());
    const operation = buildEventPlaneReconciliationPlan({
      cellId: CELL_ID,
      desiredState: syntheticDesiredState(),
      observedState: emptyObservedState(),
    }).operations[0];

    expect(operation).toBeDefined();
    await expect(adapter.apply(operation!)).rejects.toBeInstanceOf(EventPlaneControlError);
  });

  test("does not project organization or identity policies from another cell", () => {
    const desiredState = syntheticDesiredState();
    desiredState.policyVersions.push(
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        policy: { publish: ["org.synthetic.other.>"] },
        policyHash: "sha256:other-org",
        scopeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        scopeType: "organization",
        status: "active",
        version: 1,
      },
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        policy: { publish: ["org.synthetic.other.>"] },
        policyHash: "sha256:other-identity",
        scopeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        scopeType: "identity",
        status: "active",
        version: 1,
      },
    );

    const plan = buildEventPlaneReconciliationPlan({
      cellId: CELL_ID,
      desiredState,
      observedState: emptyObservedState(),
    });

    expect(
      plan.operations.filter((operation) => operation.type === "policy.apply").map((operation) => operation.targetId),
    ).toEqual([POLICY_ID]);
  });

  test("matches identities by canonical identity id instead of binding policy coincidence", () => {
    const desiredState = syntheticDesiredState();
    desiredState.identities.push({
      ...desiredState.identities[0]!,
      id: SECOND_IDENTITY_ID,
      principalId: "runtime-p0-second",
    });
    const observedState = emptyObservedState();
    observedState.identities.push({
      bindingId: BINDING_ID,
      identityId: IDENTITY_ID,
      permissionsHash: "sha256:not-used-for-canonical-match",
      policyVersion: 1,
      providerUserPublicKey: "UD_FIRST",
      status: "active",
    });

    const plan = buildEventPlaneReconciliationPlan({ cellId: CELL_ID, desiredState, observedState });

    expect(plan.operations).toContainEqual(
      expect.objectContaining({ targetId: SECOND_IDENTITY_ID, type: "identity.ensure" }),
    );
  });

  test("does not revoke a replacement grant merely because it shares an identity", () => {
    const desiredState = syntheticDesiredState({ grantStatus: "revoked" });
    desiredState.credentialGrants[0]!.providerUserPublicKey = "UD_OLD";
    desiredState.credentialGrants.push({
      ...desiredState.credentialGrants[0]!,
      id: SECOND_GRANT_ID,
      providerUserPublicKey: "UD_REPLACEMENT",
      revokedAt: null,
      status: "active",
    });
    const observedState = emptyObservedState();
    observedState.credentialGrants.push({
      grantId: SECOND_GRANT_ID,
      identityId: IDENTITY_ID,
      providerUserPublicKey: "UD_REPLACEMENT",
      revokedAt: null,
      status: "active",
    });

    const plan = buildEventPlaneReconciliationPlan({ cellId: CELL_ID, desiredState, observedState });

    expect(plan.operations).not.toContainEqual(
      expect.objectContaining({ targetId: GRANT_ID, type: "grant.revoke" }),
    );
  });
});

class MemoryNatsJwtDriver implements SelfHostedNatsJwtDriver {
  constructor(private observedState: EventPlaneObservedState) {}

  async observeCell(): Promise<EventPlaneObservedState> {
    return clone(this.observedState);
  }

  async apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult> {
    applyObserved(this.observedState, operation);
    return {
      operation: operation.type,
      idempotencyKey: operation.idempotencyKey,
      providerResultCode: "ok",
      status: operation.type === "orphan.quarantine" ? "quarantined" : "applied",
      observed: operation.observed ?? {},
      delivery: operation.type === "grant.issue"
        ? {
            deliveryRef: `ravi-secret://event-plane/deliveries/${operation.targetId}`,
            deliveredOnce: true,
            grantId: operation.targetId,
          }
        : null,
      durationMs: 1,
    };
  }
}

class UnsafeNatsJwtDriver implements SelfHostedNatsJwtDriver {
  async observeCell(): Promise<EventPlaneObservedState> {
    return emptyObservedState();
  }

  async apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult> {
    return {
      operation: operation.type,
      idempotencyKey: operation.idempotencyKey,
      providerResultCode: "ok",
      status: "applied",
      observed: {
        seed: `S${"U"}${"A".repeat(60)}`,
      },
      delivery: null,
      durationMs: 1,
    };
  }
}

function applyObserved(state: EventPlaneObservedState, operation: EventPlaneReconcileOperation) {
  if (operation.type === "cell.reconcile") {
    state.cellId = operation.cellId;
    state.provider = SELF_HOSTED_NATS_JWT_PROVIDER;
    state.providerRef = "ovh://ravi-runtime-ovh-1/nats-p0";
    state.status = "reachable";
    return;
  }

  if (operation.type === "policy.apply") {
    const desired = operation.desired as Record<string, unknown>;
    state.policies = state.policies.filter((policy) => policy.policyId !== operation.targetId);
    state.policies.push({
      policyHash: String(desired.policyHash),
      policyId: operation.targetId,
      scopeId: String(desired.scopeId),
      scopeType: desired.scopeType as "global" | "cell" | "organization" | "identity",
      status: "active",
      version: Number(desired.version),
    });
    return;
  }

  if (operation.type === "account.ensure") {
    const desired = operation.desired as Record<string, unknown>;
    state.accounts = state.accounts.filter((account) => account.bindingId !== operation.targetId);
    state.accounts.push({
      accountPublicKey: desired.accountPublicKey as string | null,
      bindingId: operation.targetId,
      organizationId: operation.organizationId,
      policyHash: null,
      policyVersion: Number(desired.activePolicyVersion),
      providerAccountRef: desired.providerAccountRef as string | null,
      quotaHash: desired.quotaHash as string,
      status: "active",
      streamHash: desired.streamHash as string,
    });
    return;
  }

  if (operation.type === "identity.ensure") {
    const desired = operation.desired as Record<string, unknown>;
    state.identities = state.identities.filter((identity) => identity.identityId !== operation.targetId);
    state.identities.push({
      bindingId: desired.bindingId as string,
      identityId: operation.targetId,
      permissionsHash: desired.permissionsHash as string,
      policyVersion: Number(desired.policyVersion),
      providerUserPublicKey: null,
      status: "active",
    });
    return;
  }

  if (operation.type === "grant.issue") {
    const desired = operation.desired as Record<string, unknown>;
    state.credentialGrants = state.credentialGrants.filter((grant) => grant.grantId !== operation.targetId);
    state.credentialGrants.push({
      grantId: operation.targetId,
      identityId: desired.identityId as string,
      providerUserPublicKey: desired.providerUserPublicKey as string,
      revokedAt: null,
      status: "active",
    });
    return;
  }

  if (operation.type === "cross_account_link.ensure") {
    const desired = operation.desired as Record<string, unknown>;
    state.crossAccountLinks = state.crossAccountLinks.filter((link) => link.linkId !== operation.targetId);
    state.crossAccountLinks.push({
      linkId: operation.targetId,
      linkType: desired.linkType as "export" | "import" | "service",
      policyVersion: Number(desired.policyVersion),
      responsePattern: desired.responsePattern as string | null,
      sourceBindingId: desired.sourceBindingId as string,
      status: "active",
      subjectPattern: desired.subjectPattern as string,
      targetBindingId: desired.targetBindingId as string | null,
      targetSystemService: desired.targetSystemService as string | null,
    });
  }
}

function syntheticDesiredState(overrides: {
  grantStatus?: "pending" | "issued" | "active" | "revoked" | "expired" | "failed";
  identityStatus?: "provisioning" | "active" | "rotating" | "revoked" | "expired" | "failed";
} = {}): EventPlaneDesiredStateSnapshot {
  return {
    version: 1,
    cells: [
      {
        capacity: { maxAccounts: 100 },
        endpointRef: "nats://p0-loopback",
        environment: "p0",
        id: CELL_ID,
        observedCapacity: {},
        placementClass: "synthetic",
        policyVersion: 1,
        provider: SELF_HOSTED_NATS_JWT_PROVIDER,
        providerRef: "ovh://ravi-runtime-ovh-1/nats-p0",
        recordVersion: 1,
        region: "ovh-rbx",
        resolverRef: "resolver://nats-p0",
        status: "active",
        systemAccountRef: "nats-account://SYS",
      },
    ],
    bindings: [
      {
        accountPublicKey: "AD_P0_ORG_A",
        activePolicyVersion: 1,
        cellId: CELL_ID,
        id: BINDING_ID,
        organizationId: ORG_ID,
        placementReason: "synthetic-p0",
        providerAccountRef: "nats://p0/accounts/ORG_A",
        quotaPolicy: { maxConnections: 5 },
        recordVersion: 3,
        status: "active",
        streamPolicy: { replicas: 3, storage: "file" },
      },
    ],
    identities: [
      {
        bindingId: BINDING_ID,
        displayName: "P0 synthetic app",
        expiresAt: null,
        id: IDENTITY_ID,
        identityType: "managed_runtime",
        organizationId: ORG_ID,
        permissions: {
          publish: ["events.p0.orga.>"],
          subscribe: ["events.p0.orga.>", "_INBOX.>"],
        },
        policyVersion: 1,
        principalId: "runtime-p0",
        principalType: "managed_runtime_instance",
        recordVersion: 4,
        revokedAt: overrides.identityStatus === "revoked" ? "2026-07-15T12:00:00.000Z" : null,
        status: overrides.identityStatus ?? "active",
      },
    ],
    credentialGrants: [
      {
        custodyRefPresent: true,
        deliveredAt: null,
        expiresAt: null,
        id: GRANT_ID,
        identityId: IDENTITY_ID,
        issuedAt: null,
        providerUserPublicKey: "UD_P0_APP",
        recordVersion: 5,
        revokedAt: overrides.grantStatus === "revoked" ? "2026-07-15T12:00:00.000Z" : null,
        safeMetadata: { rotation: "initial" },
        status: overrides.grantStatus ?? "pending",
      },
    ],
    policyVersions: [
      {
        id: POLICY_ID,
        policy: { subjectProfile: "p0-app" },
        policyHash: "sha256:policy-v1",
        scopeId: ORG_ID,
        scopeType: "organization",
        status: "active",
        version: 1,
      },
    ],
    crossAccountLinks: [
      {
        approvedBy: "event-plane-control-service:p0",
        expiresAt: null,
        id: LINK_ID,
        justification: "synthetic p0 service request",
        linkType: "service",
        policyVersion: 1,
        recordVersion: 2,
        responsePattern: null,
        sourceBindingId: BINDING_ID,
        status: "active",
        subjectPattern: "ravi.services.p0.requests.health",
        targetBindingId: null,
        targetSystemService: "p0_health",
      },
    ],
  };
}

function emptyObservedState(): EventPlaneObservedState {
  return {
    accounts: [],
    capacity: {},
    cellId: null,
    credentialGrants: [],
    crossAccountLinks: [],
    identities: [],
    observedAt: "2026-07-15T12:00:00.000Z",
    policies: [],
    policyBuild: null,
    provider: SELF_HOSTED_NATS_JWT_PROVIDER,
    providerRef: "ovh://ravi-runtime-ovh-1/nats-p0",
    resolverRevision: null,
    status: "degraded",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
