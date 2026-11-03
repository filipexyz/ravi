import { createHash } from "node:crypto";

import type { JsonRecord } from "@/server/db/schema";

import {
  assertNoSecretLikeFields,
  assertSafeReference,
  EventPlaneControlError,
  sanitizeEventPlaneSafeMetadata,
} from "./event-plane-safety";
import type {
  EventPlaneCellStatus,
  EventPlaneCredentialGrantStatus,
  EventPlaneIdentityStatus,
  EventPlaneOrgBindingStatus,
} from "./event-plane";

export const SELF_HOSTED_NATS_JWT_PROVIDER = "self_hosted_nats_jwt";
export const EVENT_PLANE_P0_REVOCATION_RTO_MS = 60_000;

type ProviderStatus = "active" | "provisioning" | "suspended" | "revoked" | "deleted" | "failed" | "quarantined";

export type EventPlaneDesiredCell = {
  id: string;
  provider: string;
  providerRef: string | null;
  environment: string;
  region: string;
  placementClass: string;
  status: EventPlaneCellStatus;
  endpointRef: string | null;
  systemAccountRef: string | null;
  resolverRef: string | null;
  capacity: JsonRecord;
  observedCapacity: JsonRecord;
  policyVersion: number;
  recordVersion: number;
};

export type EventPlaneDesiredOrgBinding = {
  id: string;
  organizationId: string;
  cellId: string;
  providerAccountRef: string | null;
  accountPublicKey: string | null;
  status: EventPlaneOrgBindingStatus;
  placementReason: string;
  quotaPolicy: JsonRecord;
  streamPolicy: JsonRecord;
  activePolicyVersion: number;
  recordVersion: number;
};

export type EventPlaneDesiredIdentity = {
  id: string;
  organizationId: string;
  bindingId: string;
  identityType: string;
  principalType: string;
  principalId: string;
  displayName: string;
  status: EventPlaneIdentityStatus;
  permissions: JsonRecord;
  policyVersion: number;
  recordVersion: number;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type EventPlaneDesiredCredentialGrant = {
  id: string;
  identityId: string;
  providerUserPublicKey: string | null;
  custodyRefPresent: boolean;
  status: EventPlaneCredentialGrantStatus;
  recordVersion: number;
  issuedAt: string | null;
  deliveredAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  safeMetadata: JsonRecord;
};

export type EventPlaneDesiredPolicyVersion = {
  id: string;
  scopeType: "global" | "cell" | "organization" | "identity";
  scopeId: string;
  version: number;
  policyHash: string;
  policy: JsonRecord;
  status: "draft" | "active" | "superseded" | "revoked";
};

export type EventPlaneDesiredCrossAccountLink = {
  id: string;
  sourceBindingId: string;
  targetBindingId: string | null;
  targetSystemService: string | null;
  linkType: "export" | "import" | "service";
  subjectPattern: string;
  responsePattern: string | null;
  status: "proposed" | "active" | "suspended" | "revoked";
  justification: string;
  policyVersion: number;
  approvedBy: string | null;
  recordVersion: number;
  expiresAt: string | null;
};

export type EventPlaneDesiredStateSnapshot = {
  version: number;
  cells: EventPlaneDesiredCell[];
  bindings: EventPlaneDesiredOrgBinding[];
  identities: EventPlaneDesiredIdentity[];
  credentialGrants: EventPlaneDesiredCredentialGrant[];
  policyVersions: EventPlaneDesiredPolicyVersion[];
  crossAccountLinks: EventPlaneDesiredCrossAccountLink[];
};

export type EventPlaneObservedAccount = {
  bindingId: string | null;
  organizationId: string | null;
  providerAccountRef: string | null;
  accountPublicKey: string | null;
  status: ProviderStatus;
  policyVersion: number | null;
  policyHash: string | null;
  quotaHash: string | null;
  streamHash: string | null;
};

export type EventPlaneObservedIdentity = {
  identityId: string | null;
  bindingId: string | null;
  providerUserPublicKey: string | null;
  status: ProviderStatus;
  permissionsHash: string | null;
  policyVersion: number | null;
};

export type EventPlaneObservedGrant = {
  grantId: string | null;
  identityId: string | null;
  providerUserPublicKey: string | null;
  status: ProviderStatus;
  revokedAt: string | null;
};

export type EventPlaneObservedPolicy = {
  policyId: string | null;
  scopeType: "global" | "cell" | "organization" | "identity";
  scopeId: string;
  version: number;
  policyHash: string;
  status: ProviderStatus;
};

export type EventPlaneObservedCrossAccountLink = {
  linkId: string | null;
  sourceBindingId: string | null;
  targetBindingId: string | null;
  targetSystemService: string | null;
  linkType: "export" | "import" | "service";
  subjectPattern: string;
  responsePattern: string | null;
  status: ProviderStatus;
  policyVersion: number | null;
};

export type EventPlaneObservedState = {
  provider: string;
  providerRef: string | null;
  cellId: string | null;
  status: "reachable" | "degraded" | "unreachable";
  observedAt: string;
  resolverRevision: string | null;
  policyBuild: string | null;
  capacity: JsonRecord;
  accounts: EventPlaneObservedAccount[];
  identities: EventPlaneObservedIdentity[];
  credentialGrants: EventPlaneObservedGrant[];
  policies: EventPlaneObservedPolicy[];
  crossAccountLinks: EventPlaneObservedCrossAccountLink[];
};

export type EventPlaneReconcileOperationType =
  | "cell.reconcile"
  | "account.ensure"
  | "account.suspend"
  | "policy.apply"
  | "identity.ensure"
  | "identity.revoke"
  | "grant.issue"
  | "grant.revoke"
  | "cross_account_link.ensure"
  | "cross_account_link.revoke"
  | "orphan.quarantine";

export type EventPlaneReconcileOperation = {
  type: EventPlaneReconcileOperationType;
  idempotencyKey: string;
  cellId: string;
  targetType: string;
  targetId: string;
  expectedVersion: number | null;
  organizationId: string | null;
  reason: string;
  desired: JsonRecord;
  observed: JsonRecord | null;
  emergencyRtoMs: number | null;
};

export type EventPlaneReconciliationDrift = {
  targetType: string;
  targetId: string;
  status: "missing" | "mismatched" | "terminal" | "orphan";
  reason: string;
};

export type EventPlaneReconciliationPlan = {
  version: 1;
  cell: JsonRecord;
  desiredHash: string;
  observedHash: string;
  planHash: string;
  generatedAt: string;
  operations: EventPlaneReconcileOperation[];
  drift: EventPlaneReconciliationDrift[];
  orphanCount: number;
  rollbackCheckpoint: JsonRecord;
};

export type EventPlaneProviderApplyResult = {
  operation: EventPlaneReconcileOperationType;
  idempotencyKey: string;
  providerResultCode: string;
  status: "applied" | "unchanged" | "quarantined" | "failed";
  observed: JsonRecord;
  delivery: JsonRecord | null;
  durationMs: number;
};

export type EventPlaneReconciliationReport = {
  version: 1;
  dryRun: boolean;
  cell: JsonRecord;
  desiredHash: string;
  observedHash: string;
  planHash: string;
  startedAt: string;
  completedAt: string;
  operationsPlanned: number;
  operationsApplied: number;
  drift: EventPlaneReconciliationDrift[];
  orphanCount: number;
  results: EventPlaneProviderApplyResult[];
  rollbackCheckpoint: JsonRecord;
};

export interface EventPlaneProviderAdapter {
  readonly provider: string;
  observeCell(input: { cell: EventPlaneDesiredCell }): Promise<EventPlaneObservedState>;
  apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult>;
}

export interface SelfHostedNatsJwtDriver {
  observeCell(input: { cell: EventPlaneDesiredCell }): Promise<EventPlaneObservedState>;
  apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult>;
}

export class SelfHostedNatsJwtProviderAdapter implements EventPlaneProviderAdapter {
  readonly provider = SELF_HOSTED_NATS_JWT_PROVIDER;

  constructor(private readonly driver: SelfHostedNatsJwtDriver) {}

  async observeCell(input: { cell: EventPlaneDesiredCell }): Promise<EventPlaneObservedState> {
    assertSelfHostedNatsJwtCell(input.cell);
    return sanitizeObservedState(await this.driver.observeCell(input));
  }

  async apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult> {
    const startedAt = Date.now();
    const result = await this.driver.apply(sanitizeOperation(operation));
    return sanitizeApplyResult({
      ...result,
      operation: operation.type,
      idempotencyKey: operation.idempotencyKey,
      durationMs: Math.max(result.durationMs, Date.now() - startedAt),
    });
  }
}

export function createSelfHostedNatsJwtProviderAdapter(
  driver: SelfHostedNatsJwtDriver,
): EventPlaneProviderAdapter {
  return new SelfHostedNatsJwtProviderAdapter(driver);
}

export async function reconcileEventPlaneCell(input: {
  adapter: EventPlaneProviderAdapter;
  cellId: string;
  desiredState: EventPlaneDesiredStateSnapshot;
  dryRun?: boolean;
  now?: Date;
  onApplied?: (
    operation: EventPlaneReconcileOperation,
    result: EventPlaneProviderApplyResult,
  ) => Promise<void> | void;
}): Promise<EventPlaneReconciliationReport> {
  const cell = findDesiredCell(input.desiredState, input.cellId);
  const startedAt = input.now ?? new Date();
  const observed = await input.adapter.observeCell({ cell });
  const plan = buildEventPlaneReconciliationPlan({
    cellId: input.cellId,
    desiredState: input.desiredState,
    observedState: observed,
    now: startedAt,
  });

  const results: EventPlaneProviderApplyResult[] = [];
  if (!input.dryRun) {
    for (const operation of plan.operations) {
      const result = await input.adapter.apply(operation);
      results.push(result);
      await input.onApplied?.(operation, result);
    }
  }

  const finalObserved = results.length > 0
    ? await input.adapter.observeCell({ cell })
    : observed;
  const finalPlan = results.length > 0
    ? buildEventPlaneReconciliationPlan({
        cellId: input.cellId,
        desiredState: input.desiredState,
        observedState: finalObserved,
        now: startedAt,
      })
    : plan;

  return sanitizeReport({
    version: 1,
    dryRun: Boolean(input.dryRun),
    cell: plan.cell,
    desiredHash: plan.desiredHash,
    observedHash: finalPlan.observedHash,
    planHash: plan.planHash,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    operationsPlanned: plan.operations.length,
    operationsApplied: results.length,
    drift: plan.drift,
    orphanCount: plan.orphanCount,
    results,
    rollbackCheckpoint: plan.rollbackCheckpoint,
  });
}

export function buildEventPlaneReconciliationPlan(input: {
  cellId: string;
  desiredState: EventPlaneDesiredStateSnapshot;
  observedState: EventPlaneObservedState;
  now?: Date;
}): EventPlaneReconciliationPlan {
  const cell = findDesiredCell(input.desiredState, input.cellId);
  assertSelfHostedNatsJwtCell(cell);
  const observed = sanitizeObservedState(input.observedState);
  const generatedAt = (input.now ?? new Date()).toISOString();
  const operations = new Map<string, EventPlaneReconcileOperation>();
  const drift: EventPlaneReconciliationDrift[] = [];

  const bindings = input.desiredState.bindings.filter((binding) => binding.cellId === cell.id);
  const bindingsById = new Map(bindings.map((binding) => [binding.id, binding]));
  const identities = input.desiredState.identities.filter((identity) => bindingsById.has(identity.bindingId));
  const identitiesById = new Map(identities.map((identity) => [identity.id, identity]));
  const organizationIds = new Set(bindings.map((binding) => binding.organizationId));
  const identityIds = new Set(identities.map((identity) => identity.id));

  addOperation(operations, drift, cellOperation(cell, observed));

  for (const policy of input.desiredState.policyVersions.filter((item) =>
    item.status === "active" && policyAppliesToCell(item, cell.id, organizationIds, identityIds)
  )) {
    addOperation(operations, drift, policyOperation(cell, policy, observed));
  }

  for (const binding of bindings) {
    const observedAccount = findObservedAccount(observed, binding);
    addOperation(operations, drift, bindingOperation(cell, binding, observedAccount));
  }

  for (const identity of identities) {
    const binding = bindingsById.get(identity.bindingId);
    if (!binding) continue;
    const observedIdentity = findObservedIdentity(observed, identity);
    addOperation(operations, drift, identityOperation(cell, binding, identity, observedIdentity));
  }

  for (const grant of input.desiredState.credentialGrants) {
    const identity = identitiesById.get(grant.identityId);
    if (!identity) continue;
    const binding = bindingsById.get(identity.bindingId);
    if (!binding) continue;
    const observedGrant = findObservedGrant(observed, grant, identity);
    addOperation(operations, drift, grantOperation(cell, binding, identity, grant, observedGrant));
  }

  for (const link of input.desiredState.crossAccountLinks) {
    const sourceBinding = bindingsById.get(link.sourceBindingId);
    if (!sourceBinding) continue;
    const observedLink = findObservedLink(observed, link);
    addOperation(operations, drift, linkOperation(cell, sourceBinding, link, observedLink));
  }

  addOrphanOperations({
    bindings,
    cell,
    desiredState: input.desiredState,
    drift,
    observed,
    operations,
  });

  const desiredHash = safeHash(selectDesiredForCell(input.desiredState, cell.id));
  const observedHash = safeHash(observed);
  const operationList = Array.from(operations.values()).map(sanitizeOperation);
  const planHash = safeHash(operationList);
  const plan = {
    version: 1 as const,
    cell: cellView(cell),
    desiredHash,
    observedHash,
    planHash,
    generatedAt,
    operations: operationList,
    drift,
    orphanCount: drift.filter((item) => item.status === "orphan").length,
    rollbackCheckpoint: sanitizeRecord({
      desiredHash,
      observedHash,
      planHash,
      cellId: cell.id,
      generatedAt,
      previousObservedStatus: observed.status,
    }, "rollback_checkpoint"),
  };
  return sanitizePlan(plan);
}

function cellOperation(
  cell: EventPlaneDesiredCell,
  observed: EventPlaneObservedState,
): EventPlaneReconcileOperation | null {
  if (cell.status === "deleted" || cell.status === "disabled") return null;
  if (
    observed.cellId === cell.id &&
    observed.provider === cell.provider &&
    observed.providerRef === cell.providerRef &&
    observed.status === "reachable"
  ) {
    return null;
  }
  return operation({
    cell,
    desired: {
      provider: cell.provider,
      providerRef: cell.providerRef,
      resolverRef: cell.resolverRef,
      systemAccountRef: cell.systemAccountRef,
      policyVersion: cell.policyVersion,
    },
    emergencyRtoMs: null,
    expectedVersion: cell.recordVersion,
    observed: {
      cellId: observed.cellId,
      provider: observed.provider,
      providerRef: observed.providerRef,
      status: observed.status,
    },
    organizationId: null,
    reason: "cell desired state differs from observed provider cell",
    targetId: cell.id,
    targetType: "event_plane_cell",
    type: "cell.reconcile",
  });
}

function bindingOperation(
  cell: EventPlaneDesiredCell,
  binding: EventPlaneDesiredOrgBinding,
  observed: EventPlaneObservedAccount | null,
): EventPlaneReconcileOperation | null {
  if (["provisioning", "active", "migrating"].includes(binding.status)) {
    if (
      observed?.status === "active" &&
      observed.policyVersion === binding.activePolicyVersion &&
      observed.quotaHash === safeHash(binding.quotaPolicy) &&
      observed.streamHash === safeHash(binding.streamPolicy)
    ) {
      return null;
    }
    return operation({
      cell,
      desired: bindingDesired(binding),
      emergencyRtoMs: null,
      expectedVersion: binding.recordVersion,
      observed: observedAccountRecord(observed),
      organizationId: binding.organizationId,
      reason: observed ? "account policy or status drift" : "account missing from provider",
      targetId: binding.id,
      targetType: "event_plane_org_binding",
      type: "account.ensure",
    });
  }

  if (binding.status === "suspended" && observed && observed.status !== "suspended") {
    return operation({
      cell,
      desired: bindingDesired(binding),
      emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
      expectedVersion: binding.recordVersion,
      observed: observedAccountRecord(observed),
      organizationId: binding.organizationId,
      reason: "suspended binding still active in provider",
      targetId: binding.id,
      targetType: "event_plane_org_binding",
      type: "account.suspend",
    });
  }

  if (["deleted", "failed"].includes(binding.status) && observed && !isContainedStatus(observed.status)) {
    return quarantineOperation({
      cell,
      observed: observedAccountRecord(observed),
      organizationId: binding.organizationId,
      reason: `terminal binding remains ${observed.status} in provider`,
      targetId: binding.id,
      targetType: "event_plane_org_binding",
    });
  }

  return null;
}

function identityOperation(
  cell: EventPlaneDesiredCell,
  binding: EventPlaneDesiredOrgBinding,
  identity: EventPlaneDesiredIdentity,
  observed: EventPlaneObservedIdentity | null,
): EventPlaneReconcileOperation | null {
  if (["provisioning", "active", "rotating"].includes(identity.status)) {
    if (
      observed?.status === "active" &&
      observed.policyVersion === identity.policyVersion &&
      observed.permissionsHash === safeHash(identity.permissions)
    ) {
      return null;
    }
    return operation({
      cell,
      desired: identityDesired(identity),
      emergencyRtoMs: null,
      expectedVersion: identity.recordVersion,
      observed: observedIdentityRecord(observed),
      organizationId: binding.organizationId,
      reason: observed ? "identity policy or status drift" : "identity missing from provider",
      targetId: identity.id,
      targetType: "event_plane_identity",
      type: "identity.ensure",
    });
  }

  if (["revoked", "expired"].includes(identity.status) && observed && !isContainedStatus(observed.status)) {
    return operation({
      cell,
      desired: identityDesired(identity),
      emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
      expectedVersion: identity.recordVersion,
      observed: observedIdentityRecord(observed),
      organizationId: binding.organizationId,
      reason: "revoked or expired identity still enabled in provider",
      targetId: identity.id,
      targetType: "event_plane_identity",
      type: "identity.revoke",
    });
  }

  return null;
}

function grantOperation(
  cell: EventPlaneDesiredCell,
  binding: EventPlaneDesiredOrgBinding,
  identity: EventPlaneDesiredIdentity,
  grant: EventPlaneDesiredCredentialGrant,
  observed: EventPlaneObservedGrant | null,
): EventPlaneReconcileOperation | null {
  const grantCanBeIssued = ["pending", "issued", "active"].includes(grant.status);
  if (
    grantCanBeIssued &&
    binding.status === "active" &&
    ["active", "rotating"].includes(identity.status)
  ) {
    if (
      observed?.status === "active" &&
      observed.providerUserPublicKey === grant.providerUserPublicKey
    ) {
      return null;
    }
    return operation({
      cell,
      desired: {
        grantId: grant.id,
        identityId: identity.id,
        bindingId: binding.id,
        providerUserPublicKey: grant.providerUserPublicKey,
        custodyRefPresent: grant.custodyRefPresent,
        status: grant.status,
        oneTimeDelivery: {
          approvedChannel: "controller_encrypted_custody",
          required: true,
        },
        safeMetadata: grant.safeMetadata,
      },
      emergencyRtoMs: null,
      expectedVersion: grant.recordVersion,
      observed: observedGrantRecord(observed),
      organizationId: binding.organizationId,
      reason: observed ? "grant user drift" : "grant user missing from provider",
      targetId: grant.id,
      targetType: "event_plane_credential_grant",
      type: "grant.issue",
    });
  }

  if (["revoked", "expired", "failed"].includes(grant.status) && observed && !isContainedStatus(observed.status)) {
    return operation({
      cell,
      desired: {
        grantId: grant.id,
        identityId: identity.id,
        bindingId: binding.id,
        providerUserPublicKey: grant.providerUserPublicKey,
        status: grant.status,
      },
      emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
      expectedVersion: grant.recordVersion,
      observed: observedGrantRecord(observed),
      organizationId: binding.organizationId,
      reason: "terminal credential grant still enabled in provider",
      targetId: grant.id,
      targetType: "event_plane_credential_grant",
      type: "grant.revoke",
    });
  }

  return null;
}

function policyOperation(
  cell: EventPlaneDesiredCell,
  policy: EventPlaneDesiredPolicyVersion,
  observed: EventPlaneObservedState,
): EventPlaneReconcileOperation | null {
  const observedPolicy = observed.policies.find((item) =>
    item.scopeType === policy.scopeType &&
    item.scopeId === policy.scopeId &&
    item.version === policy.version
  );
  if (observedPolicy?.policyHash === policy.policyHash && observedPolicy.status === "active") return null;
  return operation({
    cell,
    desired: {
      policyId: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      version: policy.version,
      policyHash: policy.policyHash,
      policy: policy.policy,
    },
    emergencyRtoMs: null,
    expectedVersion: policy.version,
    observed: observedPolicy ? {
      policyHash: observedPolicy.policyHash,
      status: observedPolicy.status,
      version: observedPolicy.version,
    } : null,
    organizationId: policy.scopeType === "organization" ? policy.scopeId : null,
    reason: "active policy version missing or drifted in provider",
    targetId: policy.id,
    targetType: "event_plane_policy_version",
    type: "policy.apply",
  });
}

function linkOperation(
  cell: EventPlaneDesiredCell,
  sourceBinding: EventPlaneDesiredOrgBinding,
  link: EventPlaneDesiredCrossAccountLink,
  observed: EventPlaneObservedCrossAccountLink | null,
): EventPlaneReconcileOperation | null {
  if (link.status === "active") {
    if (observed?.status === "active" && observed.policyVersion === link.policyVersion) {
      return null;
    }
    return operation({
      cell,
      desired: linkDesired(link),
      emergencyRtoMs: null,
      expectedVersion: link.recordVersion,
      observed: observedLinkRecord(observed),
      organizationId: sourceBinding.organizationId,
      reason: observed ? "cross-account link policy drift" : "approved cross-account link missing",
      targetId: link.id,
      targetType: "event_plane_cross_account_link",
      type: "cross_account_link.ensure",
    });
  }

  if (["suspended", "revoked"].includes(link.status) && observed && !isContainedStatus(observed.status)) {
    return operation({
      cell,
      desired: linkDesired(link),
      emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
      expectedVersion: link.recordVersion,
      observed: observedLinkRecord(observed),
      organizationId: sourceBinding.organizationId,
      reason: "inactive cross-account link still enabled in provider",
      targetId: link.id,
      targetType: "event_plane_cross_account_link",
      type: "cross_account_link.revoke",
    });
  }

  return null;
}

function addOrphanOperations(input: {
  bindings: EventPlaneDesiredOrgBinding[];
  cell: EventPlaneDesiredCell;
  desiredState: EventPlaneDesiredStateSnapshot;
  drift: EventPlaneReconciliationDrift[];
  observed: EventPlaneObservedState;
  operations: Map<string, EventPlaneReconcileOperation>;
}) {
  const liveBindingIds = new Set(
    input.bindings
      .filter((binding) => !["deleted", "failed"].includes(binding.status))
      .map((binding) => binding.id),
  );
  const liveIdentityIds = new Set(
    input.desiredState.identities
      .filter((identity) => !["revoked", "expired"].includes(identity.status))
      .map((identity) => identity.id),
  );
  const liveGrantPublicKeys = new Set(
    input.desiredState.credentialGrants
      .filter((grant) => ["pending", "issued", "active"].includes(grant.status))
      .map((grant) => grant.providerUserPublicKey)
      .filter(Boolean),
  );
  const activeLinkIds = new Set(
    input.desiredState.crossAccountLinks
      .filter((link) => link.status === "active")
      .map((link) => link.id),
  );

  for (const account of input.observed.accounts) {
    if (account.bindingId && liveBindingIds.has(account.bindingId)) continue;
    if (isContainedStatus(account.status)) continue;
    addOperation(
      input.operations,
      input.drift,
      quarantineOperation({
        cell: input.cell,
        observed: observedAccountRecord(account),
        organizationId: account.organizationId,
        reason: "provider account has no active Console binding",
        targetId: account.bindingId ?? account.providerAccountRef ?? account.accountPublicKey ?? "unknown-account",
        targetType: "event_plane_provider_account",
      }),
    );
  }

  for (const identity of input.observed.identities) {
    if (identity.identityId && liveIdentityIds.has(identity.identityId)) continue;
    if (identity.providerUserPublicKey && liveGrantPublicKeys.has(identity.providerUserPublicKey)) continue;
    if (isContainedStatus(identity.status)) continue;
    addOperation(
      input.operations,
      input.drift,
      quarantineOperation({
        cell: input.cell,
        observed: observedIdentityRecord(identity),
        organizationId: null,
        reason: "provider user has no active Console identity or grant",
        targetId: identity.identityId ?? identity.providerUserPublicKey ?? "unknown-user",
        targetType: "event_plane_provider_user",
      }),
    );
  }

  for (const link of input.observed.crossAccountLinks) {
    if (link.linkId && activeLinkIds.has(link.linkId)) continue;
    if (isContainedStatus(link.status)) continue;
    addOperation(
      input.operations,
      input.drift,
      quarantineOperation({
        cell: input.cell,
        observed: observedLinkRecord(link),
        organizationId: null,
        reason: "provider cross-account link has no active Console approval",
        targetId: link.linkId ?? safeHash(observedLinkRecord(link)),
        targetType: "event_plane_provider_cross_account_link",
      }),
    );
  }
}

function operation(input: {
  cell: EventPlaneDesiredCell;
  desired: JsonRecord;
  emergencyRtoMs: number | null;
  expectedVersion: number | null;
  observed: JsonRecord | null;
  organizationId: string | null;
  reason: string;
  targetId: string;
  targetType: string;
  type: EventPlaneReconcileOperationType;
}): EventPlaneReconcileOperation {
  const desired = sanitizeRecord(input.desired, `${input.type}_desired`);
  const observed = input.observed ? sanitizeRecord(input.observed, `${input.type}_observed`) : null;
  const idempotencyKey = operationKey({
    cellId: input.cell.id,
    desired,
    expectedVersion: input.expectedVersion,
    targetId: input.targetId,
    targetType: input.targetType,
    type: input.type,
  });
  return sanitizeOperation({
    type: input.type,
    idempotencyKey,
    cellId: input.cell.id,
    targetType: input.targetType,
    targetId: input.targetId,
    expectedVersion: input.expectedVersion,
    organizationId: input.organizationId,
    reason: input.reason,
    desired,
    observed,
    emergencyRtoMs: input.emergencyRtoMs,
  });
}

function quarantineOperation(input: {
  cell: EventPlaneDesiredCell;
  observed: JsonRecord | null;
  organizationId: string | null;
  reason: string;
  targetId: string;
  targetType: string;
}): EventPlaneReconcileOperation {
  return operation({
    cell: input.cell,
    desired: {
      containment: "quarantine",
      targetId: input.targetId,
      targetType: input.targetType,
    },
    emergencyRtoMs: EVENT_PLANE_P0_REVOCATION_RTO_MS,
    expectedVersion: null,
    observed: input.observed,
    organizationId: input.organizationId,
    reason: input.reason,
    targetId: input.targetId,
    targetType: input.targetType,
    type: "orphan.quarantine",
  });
}

function addOperation(
  operations: Map<string, EventPlaneReconcileOperation>,
  drift: EventPlaneReconciliationDrift[],
  action: EventPlaneReconcileOperation | null,
) {
  if (!action) return;
  operations.set(action.idempotencyKey, action);
  drift.push({
    targetType: action.targetType,
    targetId: action.targetId,
    status: action.type === "orphan.quarantine" ? "orphan" : action.observed ? "mismatched" : "missing",
    reason: action.reason,
  });
}

function findDesiredCell(state: EventPlaneDesiredStateSnapshot, cellId: string): EventPlaneDesiredCell {
  const cell = state.cells.find((item) => item.id === cellId);
  if (!cell) throw new EventPlaneControlError(404, "event_plane_cell_not_found");
  return cell;
}

function assertSelfHostedNatsJwtCell(cell: EventPlaneDesiredCell): void {
  assertSafeReference(cell.provider, "provider");
  if (cell.provider !== SELF_HOSTED_NATS_JWT_PROVIDER) {
    throw new EventPlaneControlError(400, "event_plane_provider_not_supported");
  }
  if (!cell.providerRef) {
    throw new EventPlaneControlError(400, "event_plane_provider_ref_required");
  }
  assertSafeReference(cell.providerRef, "provider_ref");
}

function findObservedAccount(
  observed: EventPlaneObservedState,
  binding: EventPlaneDesiredOrgBinding,
): EventPlaneObservedAccount | null {
  return observed.accounts.find((account) =>
    (account.bindingId && account.bindingId === binding.id) ||
    (binding.providerAccountRef && account.providerAccountRef === binding.providerAccountRef) ||
    (binding.accountPublicKey && account.accountPublicKey === binding.accountPublicKey)
  ) ?? null;
}

function findObservedIdentity(
  observed: EventPlaneObservedState,
  identity: EventPlaneDesiredIdentity,
): EventPlaneObservedIdentity | null {
  return observed.identities.find((item) => item.identityId === identity.id) ?? null;
}

function findObservedGrant(
  observed: EventPlaneObservedState,
  grant: EventPlaneDesiredCredentialGrant,
  identity: EventPlaneDesiredIdentity,
): EventPlaneObservedGrant | null {
  return observed.credentialGrants.find((item) =>
    (item.grantId && item.grantId === grant.id) ||
    (grant.providerUserPublicKey && item.providerUserPublicKey === grant.providerUserPublicKey)
  ) ?? null;
}

function findObservedLink(
  observed: EventPlaneObservedState,
  link: EventPlaneDesiredCrossAccountLink,
): EventPlaneObservedCrossAccountLink | null {
  return observed.crossAccountLinks.find((item) =>
    (item.linkId && item.linkId === link.id) ||
    (
      item.sourceBindingId === link.sourceBindingId &&
      item.targetBindingId === link.targetBindingId &&
      item.targetSystemService === link.targetSystemService &&
      item.linkType === link.linkType &&
      item.subjectPattern === link.subjectPattern
    )
  ) ?? null;
}

function policyAppliesToCell(
  policy: EventPlaneDesiredPolicyVersion,
  cellId: string,
  organizationIds: ReadonlySet<string>,
  identityIds: ReadonlySet<string>,
): boolean {
  return (
    policy.scopeType === "global" ||
    (policy.scopeType === "cell" && policy.scopeId === cellId) ||
    (policy.scopeType === "organization" && organizationIds.has(policy.scopeId)) ||
    (policy.scopeType === "identity" && identityIds.has(policy.scopeId))
  );
}

function isContainedStatus(status: ProviderStatus): boolean {
  return ["quarantined", "revoked", "deleted", "failed"].includes(status);
}

function bindingDesired(binding: EventPlaneDesiredOrgBinding): JsonRecord {
  return {
    bindingId: binding.id,
    organizationId: binding.organizationId,
    providerAccountRef: binding.providerAccountRef,
    accountPublicKey: binding.accountPublicKey,
    status: binding.status,
    quotaPolicy: binding.quotaPolicy,
    streamPolicy: binding.streamPolicy,
    quotaHash: safeHash(binding.quotaPolicy),
    streamHash: safeHash(binding.streamPolicy),
    activePolicyVersion: binding.activePolicyVersion,
  };
}

function identityDesired(identity: EventPlaneDesiredIdentity): JsonRecord {
  return {
    identityId: identity.id,
    bindingId: identity.bindingId,
    identityType: identity.identityType,
    principalType: identity.principalType,
    principalId: identity.principalId,
    status: identity.status,
    permissions: identity.permissions,
    permissionsHash: safeHash(identity.permissions),
    policyVersion: identity.policyVersion,
    expiresAt: identity.expiresAt,
  };
}

function linkDesired(link: EventPlaneDesiredCrossAccountLink): JsonRecord {
  return {
    linkId: link.id,
    sourceBindingId: link.sourceBindingId,
    targetBindingId: link.targetBindingId,
    targetSystemService: link.targetSystemService,
    linkType: link.linkType,
    subjectPattern: link.subjectPattern,
    responsePattern: link.responsePattern,
    status: link.status,
    policyVersion: link.policyVersion,
    expiresAt: link.expiresAt,
  };
}

function observedAccountRecord(account: EventPlaneObservedAccount | null): JsonRecord | null {
  if (!account) return null;
  return {
    bindingId: account.bindingId,
    organizationId: account.organizationId,
    providerAccountRef: account.providerAccountRef,
    accountPublicKey: account.accountPublicKey,
    status: account.status,
    policyVersion: account.policyVersion,
    policyHash: account.policyHash,
    quotaHash: account.quotaHash,
    streamHash: account.streamHash,
  };
}

function observedIdentityRecord(identity: EventPlaneObservedIdentity | null): JsonRecord | null {
  if (!identity) return null;
  return {
    identityId: identity.identityId,
    bindingId: identity.bindingId,
    providerUserPublicKey: identity.providerUserPublicKey,
    status: identity.status,
    permissionsHash: identity.permissionsHash,
    policyVersion: identity.policyVersion,
  };
}

function observedGrantRecord(grant: EventPlaneObservedGrant | null): JsonRecord | null {
  if (!grant) return null;
  return {
    grantId: grant.grantId,
    identityId: grant.identityId,
    providerUserPublicKey: grant.providerUserPublicKey,
    status: grant.status,
    revokedAt: grant.revokedAt,
  };
}

function observedLinkRecord(link: EventPlaneObservedCrossAccountLink | null): JsonRecord | null {
  if (!link) return null;
  return {
    linkId: link.linkId,
    sourceBindingId: link.sourceBindingId,
    targetBindingId: link.targetBindingId,
    targetSystemService: link.targetSystemService,
    linkType: link.linkType,
    subjectPattern: link.subjectPattern,
    responsePattern: link.responsePattern,
    status: link.status,
    policyVersion: link.policyVersion,
  };
}

function cellView(cell: EventPlaneDesiredCell): JsonRecord {
  return {
    id: cell.id,
    provider: cell.provider,
    providerRef: cell.providerRef,
    environment: cell.environment,
    region: cell.region,
    placementClass: cell.placementClass,
    status: cell.status,
    policyVersion: cell.policyVersion,
    recordVersion: cell.recordVersion,
  };
}

function selectDesiredForCell(
  state: EventPlaneDesiredStateSnapshot,
  cellId: string,
): JsonRecord {
  const bindingIds = new Set(
    state.bindings.filter((binding) => binding.cellId === cellId).map((binding) => binding.id),
  );
  const identityIds = new Set(
    state.identities.filter((identity) => bindingIds.has(identity.bindingId)).map((identity) => identity.id),
  );
  return {
    version: state.version,
    cells: state.cells.filter((cell) => cell.id === cellId),
    bindings: state.bindings.filter((binding) => bindingIds.has(binding.id)),
    identities: state.identities.filter((identity) => identityIds.has(identity.id)),
    credentialGrants: state.credentialGrants.filter((grant) => identityIds.has(grant.identityId)),
    policyVersions: state.policyVersions,
    crossAccountLinks: state.crossAccountLinks.filter((link) => bindingIds.has(link.sourceBindingId)),
  };
}

function operationKey(input: {
  cellId: string;
  desired: JsonRecord;
  expectedVersion: number | null;
  targetId: string;
  targetType: string;
  type: EventPlaneReconcileOperationType;
}): string {
  return `event-plane:${input.cellId}:${input.type}:${safeHash({
    desired: input.desired,
    expectedVersion: input.expectedVersion,
    targetId: input.targetId,
    targetType: input.targetType,
  })}`;
}

function safeHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as JsonRecord)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function sanitizeObservedState(state: EventPlaneObservedState): EventPlaneObservedState {
  return sanitizeRecord({
    provider: state.provider,
    providerRef: state.providerRef,
    cellId: state.cellId,
    status: state.status,
    observedAt: state.observedAt,
    resolverRevision: state.resolverRevision,
    policyBuild: state.policyBuild,
    capacity: state.capacity,
    accounts: state.accounts,
    identities: state.identities,
    credentialGrants: state.credentialGrants,
    policies: state.policies,
    crossAccountLinks: state.crossAccountLinks,
  }, "observed_state") as EventPlaneObservedState;
}

function sanitizeOperation(operationInput: EventPlaneReconcileOperation): EventPlaneReconcileOperation {
  return sanitizeRecord(operationInput, "reconcile_operation") as EventPlaneReconcileOperation;
}

function sanitizeApplyResult(result: EventPlaneProviderApplyResult): EventPlaneProviderApplyResult {
  return sanitizeRecord(result, "provider_apply_result") as EventPlaneProviderApplyResult;
}

function sanitizePlan(plan: EventPlaneReconciliationPlan): EventPlaneReconciliationPlan {
  return sanitizeRecord(plan, "reconciliation_plan") as EventPlaneReconciliationPlan;
}

function sanitizeReport(report: EventPlaneReconciliationReport): EventPlaneReconciliationReport {
  return sanitizeRecord(report, "reconciliation_report") as EventPlaneReconciliationReport;
}

function sanitizeRecord(value: JsonRecord, field: string): JsonRecord {
  assertNoSecretLikeFields(value, field);
  return sanitizeEventPlaneSafeMetadata(value, field);
}
