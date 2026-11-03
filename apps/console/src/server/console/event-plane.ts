import { and, asc, count, eq, like, max, ne, or, sql } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  assertNoSecretLikeFields,
  assertSafeReference,
  assertSafeSecretRef,
  EVENT_PLANE_MAX_TEXT_LENGTH,
  EventPlaneControlError,
  sanitizeEventPlaneSafeMetadata,
} from "./event-plane-safety";

export {
  assertNoSecretLikeFields,
  assertSafeReference,
  assertSafeSecretRef,
  EventPlaneControlError,
  sanitizeEventPlaneSafeMetadata,
} from "./event-plane-safety";

const MIN_CONTROL_TOKEN_LENGTH = 24;
const MAX_TEXT_LENGTH = EVENT_PLANE_MAX_TEXT_LENGTH;
const DEFAULT_CONTROL_ACTOR_ID = "event-plane-control-service";

const actorTypeSchema = z.enum(["user", "agent", "api_key", "cli", "system", "anonymous"]);
const uuidSchema = z.string().uuid();
const nullableTextSchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH).nullable().optional();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const optionalDateSchema = z.string().datetime().nullable().optional();
const jsonRecordSchema = z.record(z.string(), z.unknown()).default({});

const actorSchema = z.object({
  actorType: actorTypeSchema.default("system"),
  actorId: z.string().trim().min(1).max(240).nullable().optional(),
});

const mutationEnvelopeSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  expectedVersion: z.number().int().positive().optional(),
});

const eventPlaneCellStatusSchema = z.enum([
  "provisioning",
  "active",
  "degraded",
  "draining",
  "disabled",
  "deleted",
]);

const eventPlaneOrgBindingStatusSchema = z.enum([
  "provisioning",
  "active",
  "suspended",
  "migrating",
  "failed",
  "deleted",
]);

const eventPlaneIdentityTypeSchema = z.enum([
  "control_service",
  "managed_runtime",
  "bridge",
  "enterprise_client",
]);

const eventPlaneIdentityStatusSchema = z.enum([
  "provisioning",
  "active",
  "rotating",
  "revoked",
  "expired",
  "failed",
]);

const eventPlaneCredentialGrantStatusSchema = z.enum([
  "pending",
  "issued",
  "active",
  "revoked",
  "expired",
  "failed",
]);

const eventPlanePolicyScopeTypeSchema = z.enum([
  "global",
  "cell",
  "organization",
  "identity",
]);

const eventPlaneCrossAccountLinkTypeSchema = z.enum(["export", "import", "service"]);
const eventPlaneCrossAccountLinkStatusSchema = z.enum([
  "proposed",
  "active",
  "suspended",
  "revoked",
]);

const registerCellSchema = mutationEnvelopeSchema.extend({
  capacity: jsonRecordSchema.optional(),
  endpointRef: nullableTextSchema,
  environment: z.string().trim().min(1).max(80),
  observedCapacity: jsonRecordSchema.optional(),
  placementClass: z.string().trim().min(1).max(80),
  policyVersion: z.number().int().positive().default(1),
  provider: z.string().trim().min(1).max(80),
  providerRef: nullableTextSchema,
  region: z.string().trim().min(1).max(80),
  resolverRef: nullableTextSchema,
  status: eventPlaneCellStatusSchema.default("provisioning"),
  systemAccountRef: nullableTextSchema,
});

const ensureBindingSchema = mutationEnvelopeSchema.extend({
  accountPublicKey: nullableTextSchema,
  activePolicyVersion: z.number().int().positive().default(1),
  cellId: uuidSchema,
  organizationId: uuidSchema,
  placementReason: z.string().trim().min(1).max(500),
  providerAccountRef: nullableTextSchema,
  quotaPolicy: jsonRecordSchema.optional(),
  status: eventPlaneOrgBindingStatusSchema.default("provisioning"),
  streamPolicy: jsonRecordSchema.optional(),
});

const transitionBindingSchema = mutationEnvelopeSchema.extend({
  bindingId: uuidSchema,
  reason: z.string().trim().min(1).max(500),
  status: eventPlaneOrgBindingStatusSchema,
});

const ensureIdentitySchema = mutationEnvelopeSchema.extend({
  bindingId: uuidSchema,
  displayName: z.string().trim().min(1).max(160),
  expiresAt: optionalDateSchema,
  identityType: eventPlaneIdentityTypeSchema,
  permissions: jsonRecordSchema.optional(),
  policyVersion: z.number().int().positive().default(1),
  principalId: z.string().trim().min(1).max(240),
  principalType: z.string().trim().min(1).max(80),
  status: eventPlaneIdentityStatusSchema.default("provisioning"),
});

const recordCredentialGrantSchema = mutationEnvelopeSchema.extend({
  grantId: uuidSchema.optional(),
  deliveredAt: optionalDateSchema,
  expiresAt: optionalDateSchema,
  identityId: uuidSchema,
  issuedAt: optionalDateSchema,
  providerUserPublicKey: nullableTextSchema,
  revokedAt: optionalDateSchema,
  safeMetadata: jsonRecordSchema.optional(),
  secretRef: nullableTextSchema,
  status: eventPlaneCredentialGrantStatusSchema.default("pending"),
});

const activatePolicyVersionSchema = mutationEnvelopeSchema.extend({
  approvedBy: z.string().trim().min(1).max(240).nullable().optional(),
  policy: jsonRecordSchema,
  scopeId: z.string().trim().min(1).max(240),
  scopeType: eventPlanePolicyScopeTypeSchema,
  version: z.number().int().positive(),
});

const ensureCrossAccountLinkSchema = mutationEnvelopeSchema.extend({
  approvedBy: z.string().trim().min(1).max(240).nullable().optional(),
  expiresAt: optionalDateSchema,
  justification: z.string().trim().min(1).max(500),
  linkType: eventPlaneCrossAccountLinkTypeSchema,
  policyVersion: z.number().int().positive(),
  responsePattern: nullableTextSchema,
  sourceBindingId: uuidSchema,
  status: eventPlaneCrossAccountLinkStatusSchema.default("proposed"),
  subjectPattern: z.string().trim().min(1).max(500),
  targetBindingId: uuidSchema.nullable().optional(),
  targetSystemService: z.string().trim().min(1).max(160).nullable().optional(),
});

const reconciliationReportResultSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  operation: z.string().trim().min(1).max(120),
  providerResultCode: z.string().trim().min(1).max(160),
  status: z.string().trim().min(1).max(80),
});

const reconciliationReportDriftSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  status: z.string().trim().min(1).max(80),
  targetId: z.string().trim().min(1).max(240),
  targetType: z.string().trim().min(1).max(120),
});

const recordReconciliationReportSchema = mutationEnvelopeSchema.extend({
  cellId: uuidSchema,
  completedAt: z.string().datetime(),
  desiredHash: z.string().trim().min(1).max(160),
  drift: z.array(reconciliationReportDriftSchema).max(500).default([]),
  dryRun: z.boolean().default(false),
  observedHash: z.string().trim().min(1).max(160),
  observedStatus: z.enum(["reachable", "degraded", "unreachable"]),
  operationsApplied: z.number().int().nonnegative(),
  operationsPlanned: z.number().int().nonnegative(),
  orphanCount: z.number().int().nonnegative(),
  planHash: z.string().trim().min(1).max(160),
  policyBuild: nullableTextSchema,
  providerResultCode: z.string().trim().min(1).max(160).default("ok"),
  resolverRevision: nullableTextSchema,
  results: z.array(reconciliationReportResultSchema).max(500).default([]),
  rollbackCheckpoint: jsonRecordSchema.optional(),
  startedAt: z.string().datetime(),
});

export type EventPlaneOrgBindingStatus = z.infer<typeof eventPlaneOrgBindingStatusSchema>;
export type EventPlaneIdentityStatus = z.infer<typeof eventPlaneIdentityStatusSchema>;
export type EventPlaneCredentialGrantStatus = z.infer<typeof eventPlaneCredentialGrantStatusSchema>;
export type EventPlaneCellStatus = z.infer<typeof eventPlaneCellStatusSchema>;
export type EventPlaneControlActor = z.infer<typeof actorSchema>;

type EventPlaneMutationInput = {
  actor?: EventPlaneControlActor;
  body: unknown;
  requestId: string;
};

export type EventPlaneIdempotencyRecord<T extends JsonRecord> = {
  requestHash: string;
  response: T | null;
  status: "started" | "completed" | "failed";
};

export function getEventPlaneControlToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RAVI_EVENT_PLANE_CONTROL_TOKEN?.trim();
  return value && value.length >= MIN_CONTROL_TOKEN_LENGTH ? value : null;
}

export function getEventPlaneControlActor(env: NodeJS.ProcessEnv = process.env): EventPlaneControlActor {
  const actorId = env.RAVI_EVENT_PLANE_CONTROL_ACTOR_ID?.trim() || DEFAULT_CONTROL_ACTOR_ID;
  assertSafeReference(actorId, "control_actor");
  return { actorType: "system", actorId };
}

export function authorizeEventPlaneControlRequest(
  request: Request,
  expectedToken = getEventPlaneControlToken(),
): boolean {
  if (!expectedToken) return false;
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  if (!bearer || bearer.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(bearer), Buffer.from(expectedToken));
}

export function resolveEventPlaneControlActor(actor?: EventPlaneControlActor): EventPlaneControlActor {
  return actor ?? getEventPlaneControlActor();
}

export function assertEventPlaneCellAllowsBindingStatus(
  cell: { status: EventPlaneCellStatus },
  bindingStatus: EventPlaneOrgBindingStatus,
): void {
  if (bindingStatus === "active" && cell.status !== "active") {
    throw new EventPlaneControlError(409, "event_plane_cell_not_active");
  }
  if (!["active", "provisioning"].includes(cell.status)) {
    throw new EventPlaneControlError(409, "event_plane_cell_unavailable");
  }
}

export function assertEventPlaneBindingTransition(
  current: EventPlaneOrgBindingStatus,
  next: EventPlaneOrgBindingStatus,
): void {
  if (current === next) return;
  const allowed: Record<EventPlaneOrgBindingStatus, readonly EventPlaneOrgBindingStatus[]> = {
    provisioning: ["active", "failed", "deleted"],
    active: ["suspended", "migrating", "failed", "deleted"],
    suspended: ["active", "deleted"],
    migrating: ["active", "suspended", "failed", "deleted"],
    failed: ["provisioning", "deleted"],
    deleted: [],
  };
  if (!allowed[current].includes(next)) {
    throw new EventPlaneControlError(409, "event_plane_invalid_binding_transition");
  }
}

export function assertEventPlaneIdentityTransition(
  current: EventPlaneIdentityStatus,
  next: EventPlaneIdentityStatus,
): void {
  if (current === next) return;
  const allowed: Record<EventPlaneIdentityStatus, readonly EventPlaneIdentityStatus[]> = {
    provisioning: ["active", "failed", "revoked"],
    active: ["rotating", "revoked", "expired", "failed"],
    rotating: ["active", "revoked", "expired", "failed"],
    revoked: [],
    expired: [],
    failed: ["provisioning", "revoked"],
  };
  if (!allowed[current].includes(next)) {
    throw new EventPlaneControlError(409, "event_plane_invalid_identity_transition");
  }
}

export function assertEventPlaneCredentialGrantAllowed(input: {
  bindingStatus: EventPlaneOrgBindingStatus;
  identityStatus: EventPlaneIdentityStatus;
  grantStatus: EventPlaneCredentialGrantStatus;
  secretRef?: string | null;
}): void {
  const isBookkeepingStatus = ["revoked", "expired", "failed"].includes(input.grantStatus);
  if (!isBookkeepingStatus && input.bindingStatus !== "active") {
    throw new EventPlaneControlError(409, "event_plane_binding_not_active");
  }
  if (!isBookkeepingStatus && !["active", "rotating"].includes(input.identityStatus)) {
    throw new EventPlaneControlError(409, "event_plane_identity_not_active");
  }
  if (["issued", "active"].includes(input.grantStatus) && !input.secretRef) {
    throw new EventPlaneControlError(400, "event_plane_secret_ref_required");
  }
}

export function assertEventPlaneCredentialGrantTransition(
  current: EventPlaneCredentialGrantStatus,
  next: EventPlaneCredentialGrantStatus,
): void {
  if (current === next) return;
  const allowed: Record<EventPlaneCredentialGrantStatus, readonly EventPlaneCredentialGrantStatus[]> = {
    pending: ["issued", "active", "revoked", "expired", "failed"],
    issued: ["active", "revoked", "expired", "failed"],
    active: ["revoked", "expired", "failed"],
    revoked: [],
    expired: [],
    failed: [],
  };
  if (!allowed[current].includes(next)) {
    throw new EventPlaneControlError(409, "event_plane_invalid_grant_transition");
  }
}

export function isReusableEventPlaneIdentityStatus(status: EventPlaneIdentityStatus): boolean {
  return ["provisioning", "active", "rotating", "failed"].includes(status);
}

export function eventPlaneApprovalActor(actor: EventPlaneControlActor): string {
  return safeReference(actor.actorId ?? actor.actorType, "approved_by");
}

export function assertNoPayloadApprovedBy(value: string | null | undefined): void {
  if (value !== undefined && value !== null) {
    throw new EventPlaneControlError(400, "event_plane_payload_approved_by_not_accepted");
  }
}

export function assertEventPlanePolicyVersionImmutable(
  existing: { policyHash: string } | null,
  policyHash: string,
): void {
  if (existing && existing.policyHash !== policyHash) {
    throw new EventPlaneControlError(409, "event_plane_policy_version_immutable");
  }
}

export function assertOneActiveEventPlaneBinding(
  bindings: readonly { id: string; organizationId: string; status: EventPlaneOrgBindingStatus }[],
): void {
  const activeByOrg = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.status !== "active") continue;
    const existing = activeByOrg.get(binding.organizationId);
    if (existing && existing !== binding.id) {
      throw new EventPlaneControlError(409, "event_plane_active_binding_conflict");
    }
    activeByOrg.set(binding.organizationId, binding.id);
  }
}

export function resolveEventPlaneIdempotentResult<T extends JsonRecord>(
  existing: EventPlaneIdempotencyRecord<T> | null,
  requestHash: string,
): { replay: true; response: T } | { replay: false } {
  if (!existing) return { replay: false };
  if (existing.requestHash !== requestHash) {
    throw new EventPlaneControlError(409, "event_plane_idempotency_conflict");
  }
  if (existing.status === "completed" && existing.response) {
    return { replay: true, response: existing.response };
  }
  throw new EventPlaneControlError(409, "event_plane_operation_in_progress");
}

export function eventPlaneCredentialGrantView(
  grant: Pick<
    typeof schema.eventPlaneCredentialGrants.$inferSelect,
    | "id"
    | "identityId"
    | "providerUserPublicKey"
    | "secretRef"
    | "status"
    | "version"
    | "issuedAt"
    | "deliveredAt"
    | "expiresAt"
    | "revokedAt"
    | "safeMetadataJson"
    | "createdAt"
    | "updatedAt"
  >,
) {
  return {
    custodyRefPresent: Boolean(grant.secretRef),
    deliveredAt: grant.deliveredAt?.toISOString() ?? null,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    id: grant.id,
    identityId: grant.identityId,
    issuedAt: grant.issuedAt?.toISOString() ?? null,
    providerUserPublicKey: grant.providerUserPublicKey,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    safeMetadata: sanitizeEventPlaneSafeMetadata(grant.safeMetadataJson),
    status: grant.status,
    recordVersion: grant.version,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

export async function registerEventPlaneCell(input: EventPlaneMutationInput) {
  const parsed = parse(registerCellSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  validateEventPlaneCellRefs(parsed);
  const requestHash = eventPlaneRequestHash("cell.register", parsed);
  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "cell.register",
    organizationId: null,
    requestHash,
    requestId: input.requestId,
    scopeKey: "global",
    targetType: "event_plane_cell",
  }, async (tx) => {
    const now = new Date();
    const existing = await findExistingCell(tx, parsed);
    const before = existing ? eventPlaneCellView(existing) : null;
    const cell = existing
      ? await updateEventPlaneCell(tx, existing, parsed, now)
      : await insertEventPlaneCell(tx, parsed, now);

    const response = {
      version: 1,
      cell: eventPlaneCellView(cell),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.cell.register",
      actor,
      after: response.cell,
      before,
      metadata: { operation: "cell.register", provider: parsed.provider },
      organizationId: null,
      requestId: input.requestId,
      targetId: cell.id,
      targetType: "event_plane_cell",
    });
    return response;
  });
}

export async function ensureEventPlaneOrgBinding(input: EventPlaneMutationInput) {
  const parsed = parse(ensureBindingSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  validateEventPlaneBindingRefs(parsed);
  const requestHash = eventPlaneRequestHash("organization.bind", parsed);
  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "organization.bind",
    organizationId: parsed.organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: `org:${parsed.organizationId}`,
    targetType: "event_plane_org_binding",
  }, async (tx) => {
    const now = new Date();
    const cell = await getCell(tx, parsed.cellId);
    assertEventPlaneCellAllowsBindingStatus(cell, parsed.status);
    const existing = await findExistingBinding(tx, parsed.organizationId, parsed.cellId);
    const before = existing ? eventPlaneOrgBindingView(existing) : null;
    if (parsed.status === "active") {
      await assertNoOtherActiveBinding(tx, parsed.organizationId, existing?.id ?? null);
    }
    const binding = existing
      ? await updateEventPlaneOrgBinding(tx, existing, parsed, now)
      : await insertEventPlaneOrgBinding(tx, parsed, now);

    const response = {
      version: 1,
      binding: eventPlaneOrgBindingView(binding),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.organization.bind",
      actor,
      after: response.binding,
      before,
      metadata: {
        cellId: parsed.cellId,
        operation: "organization.bind",
        resultingStatus: binding.status,
      },
      organizationId: parsed.organizationId,
      requestId: input.requestId,
      targetId: binding.id,
      targetType: "event_plane_org_binding",
    });
    return response;
  });
}

export async function transitionEventPlaneOrgBinding(input: EventPlaneMutationInput) {
  const parsed = parse(transitionBindingSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  safeText(parsed.reason);
  const requestHash = eventPlaneRequestHash("organization.binding.transition", parsed);
  const binding = await db.query.eventPlaneOrgBindings.findFirst({
    where: eq(schema.eventPlaneOrgBindings.id, parsed.bindingId),
  });
  if (!binding) throw new EventPlaneControlError(404, "event_plane_binding_not_found");

  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "organization.binding.transition",
    organizationId: binding.organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: `org:${binding.organizationId}`,
    targetId: binding.id,
    targetType: "event_plane_org_binding",
  }, async (tx) => {
    const fresh = await getBinding(tx, parsed.bindingId);
    const expectedVersion = assertExpectedVersion(fresh.version, parsed.expectedVersion);
    assertEventPlaneBindingTransition(fresh.status, parsed.status);
    if (parsed.status === "active") {
      const cell = await getCell(tx, fresh.cellId);
      assertEventPlaneCellAllowsBindingStatus(cell, parsed.status);
      await assertNoOtherActiveBinding(tx, fresh.organizationId, fresh.id);
    }
    const now = new Date();
    const before = eventPlaneOrgBindingView(fresh);
    const [updated] = await tx
      .update(schema.eventPlaneOrgBindings)
      .set({
        status: parsed.status,
        version: fresh.version + 1,
        activatedAt: parsed.status === "active" ? now : fresh.activatedAt,
        suspendedAt: parsed.status === "suspended" ? now : fresh.suspendedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.eventPlaneOrgBindings.id, fresh.id),
          eq(schema.eventPlaneOrgBindings.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw new EventPlaneControlError(409, "event_plane_binding_update_failed");
    const response = {
      version: 1,
      binding: eventPlaneOrgBindingView(updated),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.organization_binding.transition",
      actor,
      after: response.binding,
      before,
      metadata: {
        operation: "organization.binding.transition",
        priorStatus: fresh.status,
        reason: parsed.reason,
        resultingStatus: updated.status,
      },
      organizationId: updated.organizationId,
      requestId: input.requestId,
      targetId: updated.id,
      targetType: "event_plane_org_binding",
    });
    return response;
  });
}

export async function ensureEventPlaneIdentity(input: EventPlaneMutationInput) {
  const parsed = parse(ensureIdentitySchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  validateEventPlaneIdentityRefs(parsed);
  const requestHash = eventPlaneRequestHash("identity.ensure", parsed);
  const binding = await db.query.eventPlaneOrgBindings.findFirst({
    where: eq(schema.eventPlaneOrgBindings.id, parsed.bindingId),
  });
  if (!binding) throw new EventPlaneControlError(404, "event_plane_binding_not_found");

  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "identity.ensure",
    organizationId: binding.organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: `org:${binding.organizationId}`,
    targetType: "event_plane_identity",
  }, async (tx) => {
    const freshBinding = await getBinding(tx, parsed.bindingId);
    if (["deleted", "failed"].includes(freshBinding.status)) {
      throw new EventPlaneControlError(409, "event_plane_binding_unavailable");
    }
    const now = new Date();
    const existing = await findExistingIdentity(tx, parsed);
    const before = existing ? eventPlaneIdentityView(existing) : null;
    if (existing) assertEventPlaneIdentityTransition(existing.status, parsed.status);
    const identity = existing
      ? await updateEventPlaneIdentity(tx, existing, parsed, now)
      : await insertEventPlaneIdentity(tx, freshBinding.organizationId, parsed, now);
    const response = {
      version: 1,
      identity: eventPlaneIdentityView(identity),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.identity.ensure",
      actor,
      after: response.identity,
      before,
      metadata: {
        bindingId: parsed.bindingId,
        identityType: parsed.identityType,
        operation: "identity.ensure",
        principalType: parsed.principalType,
        resultingStatus: identity.status,
      },
      organizationId: identity.organizationId,
      requestId: input.requestId,
      targetId: identity.id,
      targetType: "event_plane_identity",
    });
    return response;
  });
}

export async function recordEventPlaneCredentialGrant(input: EventPlaneMutationInput) {
  const parsed = parse(recordCredentialGrantSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  validateEventPlaneCredentialGrantRefs(parsed);
  const safeMetadata = sanitizeEventPlaneSafeMetadata(parsed.safeMetadata);
  if (parsed.secretRef) assertSafeSecretRef(parsed.secretRef);
  const requestHash = eventPlaneRequestHash("identity.grant.record", {
    ...parsed,
    safeMetadata,
  });
  const identity = await db.query.eventPlaneIdentities.findFirst({
    where: eq(schema.eventPlaneIdentities.id, parsed.identityId),
  });
  if (!identity) throw new EventPlaneControlError(404, "event_plane_identity_not_found");

  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "identity.grant.record",
    organizationId: identity.organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: `org:${identity.organizationId}`,
    targetType: "event_plane_credential_grant",
  }, async (tx) => {
    const freshIdentity = await getIdentity(tx, parsed.identityId);
    const binding = await getBinding(tx, freshIdentity.bindingId);
    assertEventPlaneCredentialGrantAllowed({
      bindingStatus: binding.status,
      grantStatus: parsed.status,
      identityStatus: freshIdentity.status,
      secretRef: parsed.secretRef ?? null,
    });
    const now = new Date();
    const existingGrant = parsed.grantId ? await getCredentialGrant(tx, parsed.grantId) : null;
    if (existingGrant && existingGrant.identityId !== parsed.identityId) {
      throw new EventPlaneControlError(409, "event_plane_grant_identity_mismatch");
    }
    const before = existingGrant ? eventPlaneCredentialGrantView(existingGrant) : null;
    const grant = existingGrant
      ? await updateEventPlaneCredentialGrant(tx, existingGrant, parsed, safeMetadata, now)
      : await insertEventPlaneCredentialGrant(tx, parsed, safeMetadata, now);
    const response = {
      version: 1,
      grant: eventPlaneCredentialGrantView(grant),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.credential_grant.record",
      actor,
      after: response.grant,
      before,
      metadata: {
        bindingId: binding.id,
        identityId: parsed.identityId,
        operation: "identity.grant.record",
        resultingStatus: grant.status,
      },
      organizationId: freshIdentity.organizationId,
      requestId: input.requestId,
      targetId: grant.id,
      targetType: "event_plane_credential_grant",
    });
    return response;
  });
}

export async function activateEventPlanePolicyVersion(input: EventPlaneMutationInput) {
  const parsed = parse(activatePolicyVersionSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  assertNoPayloadApprovedBy(parsed.approvedBy);
  validateEventPlanePolicyRefs(parsed);
  const policy = sanitizeEventPlaneSafeMetadata(parsed.policy, "policy");
  const requestHash = eventPlaneRequestHash("policy.activate", { ...parsed, policy });
  const organizationId = parsed.scopeType === "organization" ? parsed.scopeId : null;
  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "policy.activate",
    organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: scopeKeyForPolicy(parsed.scopeType, parsed.scopeId),
    targetType: "event_plane_policy_version",
  }, async (tx) => {
    const now = new Date();
    const policyHash = stableHash(policy);
    const approvedBy = eventPlaneApprovalActor(actor);
    const existingVersion = await findPolicyVersion(tx, parsed.scopeType, parsed.scopeId, parsed.version);
    assertEventPlanePolicyVersionImmutable(existingVersion, policyHash);
    if (existingVersion?.status === "active") {
      const response = {
        version: 1,
        policyVersion: eventPlanePolicyVersionView(existingVersion),
      };
      await auditEventPlaneMutation(tx, {
        action: "event_plane.policy.activate",
        actor,
        after: response.policyVersion,
        before: response.policyVersion,
        metadata: {
          operation: "policy.activate",
          policyHash,
          replayed: true,
          scopeId: parsed.scopeId,
          scopeType: parsed.scopeType,
        },
        organizationId,
        requestId: input.requestId,
        targetId: existingVersion.id,
        targetType: "event_plane_policy_version",
      });
      return response;
    }
    const activePolicy = await findActivePolicyVersion(tx, parsed.scopeType, parsed.scopeId);
    if (activePolicy && activePolicy.id !== existingVersion?.id) {
      const expectedVersion = assertExpectedVersion(activePolicy.version, parsed.expectedVersion);
      const [superseded] = await tx
        .update(schema.eventPlanePolicyVersions)
        .set({ status: "superseded" })
        .where(
          and(
            eq(schema.eventPlanePolicyVersions.id, activePolicy.id),
            eq(schema.eventPlanePolicyVersions.version, expectedVersion),
            eq(schema.eventPlanePolicyVersions.status, "active"),
          ),
        )
        .returning({ id: schema.eventPlanePolicyVersions.id });
      if (!superseded) throw new EventPlaneControlError(409, "event_plane_policy_update_failed");
    }
    const policyVersion = existingVersion
      ? await reactivateEventPlanePolicyVersion(tx, existingVersion, approvedBy, now)
      : await insertEventPlanePolicyVersion(tx, parsed, policy, policyHash, approvedBy, now);
    if (!policyVersion) throw new EventPlaneControlError(503, "event_plane_policy_activate_failed");
    const response = {
      version: 1,
      policyVersion: eventPlanePolicyVersionView(policyVersion),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.policy.activate",
      actor,
      after: response.policyVersion,
      before: null,
      metadata: {
        operation: "policy.activate",
        policyHash,
        scopeId: parsed.scopeId,
        scopeType: parsed.scopeType,
      },
      organizationId,
      requestId: input.requestId,
      targetId: policyVersion.id,
      targetType: "event_plane_policy_version",
    });
    return response;
  });
}

export async function ensureEventPlaneCrossAccountLink(input: EventPlaneMutationInput) {
  const parsed = parse(ensureCrossAccountLinkSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  assertNoPayloadApprovedBy(parsed.approvedBy);
  validateEventPlaneCrossAccountRefs(parsed);
  if (!parsed.targetBindingId && !parsed.targetSystemService) {
    throw new EventPlaneControlError(400, "event_plane_link_target_required");
  }
  if (parsed.targetBindingId && parsed.targetSystemService) {
    throw new EventPlaneControlError(400, "event_plane_link_target_ambiguous");
  }
  assertNoBroadSubjectPattern(parsed.subjectPattern);
  if (parsed.responsePattern) assertNoBroadSubjectPattern(parsed.responsePattern);
  const requestHash = eventPlaneRequestHash("cross_account_link.ensure", parsed);
  const sourceBinding = await db.query.eventPlaneOrgBindings.findFirst({
    where: eq(schema.eventPlaneOrgBindings.id, parsed.sourceBindingId),
  });
  if (!sourceBinding) throw new EventPlaneControlError(404, "event_plane_source_binding_not_found");

  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "cross_account_link.ensure",
    organizationId: sourceBinding.organizationId,
    requestHash,
    requestId: input.requestId,
    scopeKey: `org:${sourceBinding.organizationId}`,
    targetType: "event_plane_cross_account_link",
  }, async (tx) => {
    const source = await getBinding(tx, parsed.sourceBindingId);
    if (!["active", "migrating"].includes(source.status)) {
      throw new EventPlaneControlError(409, "event_plane_source_binding_unavailable");
    }
    if (parsed.targetBindingId) {
      const target = await getBinding(tx, parsed.targetBindingId);
      if (!["active", "migrating"].includes(target.status)) {
        throw new EventPlaneControlError(409, "event_plane_target_binding_unavailable");
      }
    }
    const now = new Date();
    const existing = await findExistingCrossAccountLink(tx, parsed);
    const before = existing ? eventPlaneCrossAccountLinkView(existing) : null;
    const link = existing
      ? await updateEventPlaneCrossAccountLink(tx, existing, parsed, actor, now)
      : await insertEventPlaneCrossAccountLink(tx, parsed, actor);
    const response = {
      version: 1,
      link: eventPlaneCrossAccountLinkView(link),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.cross_account_link.ensure",
      actor,
      after: response.link,
      before,
      metadata: {
        linkType: parsed.linkType,
        operation: "cross_account_link.ensure",
        policyVersion: parsed.policyVersion,
        resultingStatus: link.status,
      },
      organizationId: source.organizationId,
      requestId: input.requestId,
      targetId: link.id,
      targetType: "event_plane_cross_account_link",
    });
    return response;
  });
}

export async function getEventPlaneDesiredState(input: {
  organizationId?: string | null;
}) {
  const organizationId = input.organizationId ?? null;
  const [cells, bindings, identities, grants, policyVersions, links] = await Promise.all([
    db.select().from(schema.eventPlaneCells).orderBy(asc(schema.eventPlaneCells.createdAt)),
    db
      .select()
      .from(schema.eventPlaneOrgBindings)
      .where(organizationId ? eq(schema.eventPlaneOrgBindings.organizationId, organizationId) : undefined)
      .orderBy(asc(schema.eventPlaneOrgBindings.createdAt)),
    db
      .select()
      .from(schema.eventPlaneIdentities)
      .where(organizationId ? eq(schema.eventPlaneIdentities.organizationId, organizationId) : undefined)
      .orderBy(asc(schema.eventPlaneIdentities.createdAt)),
    db
      .select({
        grant: schema.eventPlaneCredentialGrants,
        identity: schema.eventPlaneIdentities,
      })
      .from(schema.eventPlaneCredentialGrants)
      .innerJoin(
        schema.eventPlaneIdentities,
        eq(schema.eventPlaneCredentialGrants.identityId, schema.eventPlaneIdentities.id),
      )
      .where(organizationId ? eq(schema.eventPlaneIdentities.organizationId, organizationId) : undefined)
      .orderBy(asc(schema.eventPlaneCredentialGrants.createdAt)),
    db
      .select()
      .from(schema.eventPlanePolicyVersions)
      .where(
        organizationId
          ? or(
              and(
                eq(schema.eventPlanePolicyVersions.scopeType, "organization"),
                eq(schema.eventPlanePolicyVersions.scopeId, organizationId),
              ),
              eq(schema.eventPlanePolicyVersions.scopeType, "global"),
            )
          : undefined,
      )
      .orderBy(asc(schema.eventPlanePolicyVersions.createdAt)),
    db
      .select({
        link: schema.eventPlaneCrossAccountLinks,
        source: schema.eventPlaneOrgBindings,
      })
      .from(schema.eventPlaneCrossAccountLinks)
      .innerJoin(
        schema.eventPlaneOrgBindings,
        eq(schema.eventPlaneCrossAccountLinks.sourceBindingId, schema.eventPlaneOrgBindings.id),
      )
      .where(organizationId ? eq(schema.eventPlaneOrgBindings.organizationId, organizationId) : undefined)
      .orderBy(asc(schema.eventPlaneCrossAccountLinks.createdAt)),
  ]);

  const hasSelfHostedNatsJwtCell = cells.some((cell) =>
    cell.provider === "self_hosted_nats_jwt" && cell.status !== "deleted"
  );

  return {
    version: 1,
    cells: cells.map(eventPlaneCellView),
    bindings: bindings.map(eventPlaneOrgBindingView),
    identities: identities.map(eventPlaneIdentityView),
    credentialGrants: grants.map(({ grant }) => eventPlaneCredentialGrantView(grant)),
    policyVersions: policyVersions.map(eventPlanePolicyVersionView),
    crossAccountLinks: links.map(({ link }) => eventPlaneCrossAccountLinkView(link)),
    operational: hasSelfHostedNatsJwtCell,
    providerAdapter: hasSelfHostedNatsJwtCell
      ? {
          provider: "self_hosted_nats_jwt",
          boundary: "isolated_event_plane_controller",
          rolloutState: "p0_synthetic_only",
          custody: "external_encrypted_controller_boundary",
        }
      : null,
  };
}

export async function getEventPlaneAuditSummary() {
  const rows = await db
    .select({
      action: schema.auditEvents.action,
      eventCount: count(),
      latestAt: max(schema.auditEvents.createdAt),
    })
    .from(schema.auditEvents)
    .where(like(schema.auditEvents.action, "event_plane.%"))
    .groupBy(schema.auditEvents.action)
    .orderBy(asc(schema.auditEvents.action));

  return eventPlaneAuditSummaryView(rows);
}

export function eventPlaneAuditSummaryView(
  rows: readonly {
    action: string;
    eventCount: number;
    latestAt: Date | null;
  }[],
) {
  const actions = rows.map((row) => ({
    action: row.action,
    count: row.eventCount,
    latestAt: row.latestAt?.toISOString() ?? null,
  }));
  const latestAt = rows.reduce<Date | null>((latest, row) => {
    if (!row.latestAt) return latest;
    return !latest || row.latestAt > latest ? row.latestAt : latest;
  }, null);

  return {
    version: 1,
    total: actions.reduce((total, action) => total + action.count, 0),
    latestAt: latestAt?.toISOString() ?? null,
    actions,
  };
}

export async function recordEventPlaneReconciliationReport(input: EventPlaneMutationInput) {
  const parsed = parse(recordReconciliationReportSchema, input.body);
  const actor = resolveEventPlaneControlActor(input.actor);
  const requestHash = eventPlaneRequestHash("cell.reconcile.report", parsed);

  return runEventPlaneMutation({
    actor,
    idempotencyKey: parsed.idempotencyKey,
    operation: "cell.reconcile.report",
    organizationId: null,
    requestHash,
    requestId: input.requestId,
    scopeKey: `cell:${parsed.cellId}`,
    targetId: parsed.cellId,
    targetType: "event_plane_cell",
  }, async (tx) => {
    const cell = await getCell(tx, parsed.cellId);
    const expectedVersion = assertExpectedVersion(cell.version, parsed.expectedVersion);
    const now = new Date();
    const before = eventPlaneCellView(cell);
    const observedCapacity = eventPlaneObservedCapacityAfterReconciliation(cell.observedCapacityJson, parsed, now);
    const nextStatus = cellStatusFromObserved(parsed.observedStatus, cell.status);
    const [updated] = await tx
      .update(schema.eventPlaneCells)
      .set({
        observedCapacityJson: observedCapacity,
        status: nextStatus,
        version: cell.version + 1,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.eventPlaneCells.id, cell.id),
          eq(schema.eventPlaneCells.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw new EventPlaneControlError(409, "event_plane_reconciliation_report_conflict");

    const response = {
      version: 1,
      cell: eventPlaneCellView(updated),
      report: eventPlaneReconciliationReportView(parsed, now),
    };
    await auditEventPlaneMutation(tx, {
      action: "event_plane.cell.reconciliation_report",
      actor,
      after: response.cell,
      before,
      metadata: {
        driftCount: parsed.drift.length,
        operation: "cell.reconcile.report",
        operationsApplied: parsed.operationsApplied,
        operationsPlanned: parsed.operationsPlanned,
        orphanCount: parsed.orphanCount,
        planHash: parsed.planHash,
        providerResultCode: parsed.providerResultCode,
        resultingStatus: updated.status,
      },
      organizationId: null,
      requestId: input.requestId,
      targetId: updated.id,
      targetType: "event_plane_cell",
    });
    return response;
  });
}

type DbExecutor = Pick<typeof db, "insert" | "select" | "update">;

async function runEventPlaneMutation<T extends JsonRecord>(
  operationInput: {
    actor: EventPlaneControlActor;
    idempotencyKey: string;
    operation: string;
    organizationId: string | null;
    requestHash: string;
    requestId: string;
    scopeKey: string;
    targetId?: string | null;
    targetType: string;
  },
  mutate: (tx: DbExecutor) => Promise<T>,
): Promise<T & { idempotentReplay: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await reserveEventPlaneOperation(tx, operationInput);
    const idempotent = resolveEventPlaneIdempotentResult<T>(
      existing as EventPlaneIdempotencyRecord<T> | null,
      operationInput.requestHash,
    );
    if (idempotent.replay) return { ...idempotent.response, idempotentReplay: true };

    const response = await mutate(tx);
    await tx
      .update(schema.eventPlaneControlOperations)
      .set({
        responseJson: response,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.eventPlaneControlOperations.scopeKey, operationInput.scopeKey),
          eq(schema.eventPlaneControlOperations.operation, operationInput.operation),
          eq(schema.eventPlaneControlOperations.idempotencyKey, operationInput.idempotencyKey),
        ),
      );
    return { ...response, idempotentReplay: false };
  });
}

async function reserveEventPlaneOperation(
  tx: DbExecutor,
  input: {
    actor: EventPlaneControlActor;
    idempotencyKey: string;
    operation: string;
    organizationId: string | null;
    requestHash: string;
    requestId: string;
    scopeKey: string;
    targetId?: string | null;
    targetType: string;
  },
): Promise<EventPlaneIdempotencyRecord<JsonRecord> | null> {
  const [inserted] = await tx
    .insert(schema.eventPlaneControlOperations)
    .values({
      scopeKey: input.scopeKey,
      organizationId: input.organizationId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
      requestId: input.requestId,
    })
    .onConflictDoNothing()
    .returning({
      id: schema.eventPlaneControlOperations.id,
    });

  if (inserted) return null;

  const [operation] = await tx
    .select({
      requestHash: schema.eventPlaneControlOperations.requestHash,
      responseJson: schema.eventPlaneControlOperations.responseJson,
      status: schema.eventPlaneControlOperations.status,
    })
    .from(schema.eventPlaneControlOperations)
    .where(
      and(
        eq(schema.eventPlaneControlOperations.scopeKey, input.scopeKey),
        eq(schema.eventPlaneControlOperations.operation, input.operation),
        eq(schema.eventPlaneControlOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);

  if (!operation) throw new EventPlaneControlError(409, "event_plane_operation_race");
  return {
    requestHash: operation.requestHash,
    response: operation.responseJson ?? null,
    status: operation.status,
  };
}

async function auditEventPlaneMutation(
  tx: DbExecutor,
  input: {
    action: string;
    actor: EventPlaneControlActor;
    after: JsonRecord | null;
    before: JsonRecord | null;
    metadata: JsonRecord;
    organizationId: string | null;
    requestId: string;
    targetId: string | null;
    targetType: string;
  },
) {
  const metadata = sanitizeEventPlaneSafeMetadata({
    ...input.metadata,
    authorizationDecision: "allowed",
  }, "audit_metadata");
  await tx.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId ?? null,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    requestId: input.requestId,
    beforeJson: input.before ?? undefined,
    afterJson: input.after ?? undefined,
    metadataJson: metadata,
  });
}

function parse<T extends z.ZodTypeAny>(schemaDef: T, value: unknown): z.infer<T> {
  const result = schemaDef.safeParse(value);
  if (!result.success) {
    throw new EventPlaneControlError(400, "event_plane_payload_invalid");
  }
  return result.data;
}

function validateEventPlaneCellRefs(input: z.infer<typeof registerCellSchema>): void {
  safeReference(input.provider, "provider");
  safeOptionalReference(input.providerRef, "provider_ref");
  safeReference(input.environment, "environment");
  safeReference(input.region, "region");
  safeReference(input.placementClass, "placement_class");
  safeOptionalReference(input.endpointRef, "endpoint_ref");
  safeOptionalReference(input.systemAccountRef, "system_account_ref");
  safeOptionalReference(input.resolverRef, "resolver_ref");
}

function validateEventPlaneBindingRefs(input: z.infer<typeof ensureBindingSchema>): void {
  safeOptionalReference(input.providerAccountRef, "provider_account_ref");
  safeOptionalReference(input.accountPublicKey, "account_public_key");
  safeText(input.placementReason);
}

function validateEventPlaneIdentityRefs(input: z.infer<typeof ensureIdentitySchema>): void {
  safeReference(input.principalType, "principal_type");
  safeReference(input.principalId, "principal_id");
  safeText(input.displayName);
}

function validateEventPlaneCredentialGrantRefs(input: z.infer<typeof recordCredentialGrantSchema>): void {
  safeOptionalReference(input.providerUserPublicKey, "provider_user_public_key");
  if (input.secretRef) assertSafeSecretRef(input.secretRef);
}

function validateEventPlanePolicyRefs(input: z.infer<typeof activatePolicyVersionSchema>): void {
  safeReference(input.scopeId, "scope_id");
}

function validateEventPlaneCrossAccountRefs(input: z.infer<typeof ensureCrossAccountLinkSchema>): void {
  safeOptionalReference(input.targetSystemService, "target_system_service");
  safeReference(input.subjectPattern, "subject_pattern");
  safeOptionalReference(input.responsePattern, "response_pattern");
  safeText(input.justification);
}

async function findExistingCell(tx: DbExecutor, input: z.infer<typeof registerCellSchema>) {
  const providerRefPredicate = input.providerRef
    ? and(
        eq(schema.eventPlaneCells.provider, input.provider),
        eq(schema.eventPlaneCells.providerRef, input.providerRef),
      )
    : and(
        eq(schema.eventPlaneCells.provider, input.provider),
        eq(schema.eventPlaneCells.environment, input.environment),
        eq(schema.eventPlaneCells.region, input.region),
        eq(schema.eventPlaneCells.placementClass, input.placementClass),
        ne(schema.eventPlaneCells.status, "deleted"),
      );
  const [cell] = await tx
    .select()
    .from(schema.eventPlaneCells)
    .where(providerRefPredicate)
    .limit(1);
  return cell ?? null;
}

async function insertEventPlaneCell(
  tx: DbExecutor,
  input: z.infer<typeof registerCellSchema>,
  now: Date,
) {
  const [cell] = await tx
    .insert(schema.eventPlaneCells)
    .values({
      provider: safeReference(input.provider, "provider"),
      providerRef: safeOptionalReference(input.providerRef, "provider_ref"),
      environment: safeReference(input.environment, "environment"),
      region: safeReference(input.region, "region"),
      placementClass: safeReference(input.placementClass, "placement_class"),
      status: input.status,
      endpointRef: safeOptionalReference(input.endpointRef, "endpoint_ref"),
      systemAccountRef: safeOptionalReference(input.systemAccountRef, "system_account_ref"),
      resolverRef: safeOptionalReference(input.resolverRef, "resolver_ref"),
      capacityJson: sanitizeEventPlaneSafeMetadata(input.capacity, "capacity"),
      observedCapacityJson: sanitizeEventPlaneSafeMetadata(input.observedCapacity, "observed_capacity"),
      policyVersion: input.policyVersion,
      lastHeartbeatAt: now,
    })
    .returning();
  if (!cell) throw new EventPlaneControlError(503, "event_plane_cell_create_failed");
  return cell;
}

async function updateEventPlaneCell(
  tx: DbExecutor,
  existing: typeof schema.eventPlaneCells.$inferSelect,
  input: z.infer<typeof registerCellSchema>,
  now: Date,
) {
  const expectedVersion = assertExpectedVersion(existing.version, input.expectedVersion);
  const [cell] = await tx
    .update(schema.eventPlaneCells)
    .set({
      status: input.status,
      endpointRef: safeOptionalReference(input.endpointRef, "endpoint_ref") ?? existing.endpointRef,
      systemAccountRef: safeOptionalReference(input.systemAccountRef, "system_account_ref") ?? existing.systemAccountRef,
      resolverRef: safeOptionalReference(input.resolverRef, "resolver_ref") ?? existing.resolverRef,
      capacityJson: sanitizeEventPlaneSafeMetadata(input.capacity, "capacity"),
      observedCapacityJson: sanitizeEventPlaneSafeMetadata(input.observedCapacity, "observed_capacity"),
      policyVersion: input.policyVersion,
      version: existing.version + 1,
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlaneCells.id, existing.id),
        eq(schema.eventPlaneCells.version, expectedVersion),
      ),
    )
    .returning();
  if (!cell) throw new EventPlaneControlError(409, "event_plane_cell_update_failed");
  return cell;
}

async function getCell(tx: DbExecutor, cellId: string) {
  const [cell] = await tx
    .select()
    .from(schema.eventPlaneCells)
    .where(eq(schema.eventPlaneCells.id, cellId))
    .limit(1);
  if (!cell) throw new EventPlaneControlError(404, "event_plane_cell_not_found");
  return cell;
}

async function getBinding(tx: DbExecutor, bindingId: string) {
  const [binding] = await tx
    .select()
    .from(schema.eventPlaneOrgBindings)
    .where(eq(schema.eventPlaneOrgBindings.id, bindingId))
    .limit(1);
  if (!binding) throw new EventPlaneControlError(404, "event_plane_binding_not_found");
  return binding;
}

async function getIdentity(tx: DbExecutor, identityId: string) {
  const [identity] = await tx
    .select()
    .from(schema.eventPlaneIdentities)
    .where(eq(schema.eventPlaneIdentities.id, identityId))
    .limit(1);
  if (!identity) throw new EventPlaneControlError(404, "event_plane_identity_not_found");
  return identity;
}

async function getCredentialGrant(tx: DbExecutor, grantId: string) {
  const [grant] = await tx
    .select()
    .from(schema.eventPlaneCredentialGrants)
    .where(eq(schema.eventPlaneCredentialGrants.id, grantId))
    .limit(1);
  if (!grant) throw new EventPlaneControlError(404, "event_plane_grant_not_found");
  return grant;
}

async function findActivePolicyVersion(
  tx: DbExecutor,
  scopeType: z.infer<typeof eventPlanePolicyScopeTypeSchema>,
  scopeId: string,
) {
  const [policy] = await tx
    .select()
    .from(schema.eventPlanePolicyVersions)
    .where(
      and(
        eq(schema.eventPlanePolicyVersions.scopeType, scopeType),
        eq(schema.eventPlanePolicyVersions.scopeId, scopeId),
        eq(schema.eventPlanePolicyVersions.status, "active"),
      ),
    )
    .limit(1);
  return policy ?? null;
}

async function findPolicyVersion(
  tx: DbExecutor,
  scopeType: z.infer<typeof eventPlanePolicyScopeTypeSchema>,
  scopeId: string,
  version: number,
) {
  const [policy] = await tx
    .select()
    .from(schema.eventPlanePolicyVersions)
    .where(
      and(
        eq(schema.eventPlanePolicyVersions.scopeType, scopeType),
        eq(schema.eventPlanePolicyVersions.scopeId, scopeId),
        eq(schema.eventPlanePolicyVersions.version, version),
      ),
    )
    .limit(1);
  return policy ?? null;
}

async function assertNoOtherActiveBinding(
  tx: DbExecutor,
  organizationId: string,
  allowedBindingId: string | null,
) {
  const [active] = await tx
    .select({ id: schema.eventPlaneOrgBindings.id })
    .from(schema.eventPlaneOrgBindings)
    .where(
      and(
        eq(schema.eventPlaneOrgBindings.organizationId, organizationId),
        eq(schema.eventPlaneOrgBindings.status, "active"),
      ),
    )
    .limit(1);
  if (active && active.id !== allowedBindingId) {
    throw new EventPlaneControlError(409, "event_plane_active_binding_conflict");
  }
}

async function findExistingBinding(tx: DbExecutor, organizationId: string, cellId: string) {
  const [binding] = await tx
    .select()
    .from(schema.eventPlaneOrgBindings)
    .where(
      and(
        eq(schema.eventPlaneOrgBindings.organizationId, organizationId),
        eq(schema.eventPlaneOrgBindings.cellId, cellId),
        ne(schema.eventPlaneOrgBindings.status, "deleted"),
      ),
    )
    .limit(1);
  return binding ?? null;
}

async function insertEventPlaneOrgBinding(
  tx: DbExecutor,
  input: z.infer<typeof ensureBindingSchema>,
  now: Date,
) {
  const [binding] = await tx
    .insert(schema.eventPlaneOrgBindings)
    .values({
      organizationId: input.organizationId,
      cellId: input.cellId,
      providerAccountRef: safeOptionalReference(input.providerAccountRef, "provider_account_ref"),
      accountPublicKey: safeOptionalReference(input.accountPublicKey, "account_public_key"),
      status: input.status,
      placementReason: safeText(input.placementReason),
      quotaPolicyJson: sanitizeEventPlaneSafeMetadata(input.quotaPolicy, "quota_policy"),
      streamPolicyJson: sanitizeEventPlaneSafeMetadata(input.streamPolicy, "stream_policy"),
      activePolicyVersion: input.activePolicyVersion,
      activatedAt: input.status === "active" ? now : null,
      suspendedAt: input.status === "suspended" ? now : null,
    })
    .returning();
  if (!binding) throw new EventPlaneControlError(503, "event_plane_binding_create_failed");
  return binding;
}

async function updateEventPlaneOrgBinding(
  tx: DbExecutor,
  existing: typeof schema.eventPlaneOrgBindings.$inferSelect,
  input: z.infer<typeof ensureBindingSchema>,
  now: Date,
) {
  const expectedVersion = assertExpectedVersion(existing.version, input.expectedVersion);
  assertEventPlaneBindingTransition(existing.status, input.status);
  const [binding] = await tx
    .update(schema.eventPlaneOrgBindings)
    .set({
      providerAccountRef: safeOptionalReference(input.providerAccountRef, "provider_account_ref") ?? existing.providerAccountRef,
      accountPublicKey: safeOptionalReference(input.accountPublicKey, "account_public_key") ?? existing.accountPublicKey,
      status: input.status,
      placementReason: safeText(input.placementReason),
      quotaPolicyJson: sanitizeEventPlaneSafeMetadata(input.quotaPolicy, "quota_policy"),
      streamPolicyJson: sanitizeEventPlaneSafeMetadata(input.streamPolicy, "stream_policy"),
      activePolicyVersion: input.activePolicyVersion,
      version: existing.version + 1,
      activatedAt: input.status === "active" ? existing.activatedAt ?? now : existing.activatedAt,
      suspendedAt: input.status === "suspended" ? now : existing.suspendedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlaneOrgBindings.id, existing.id),
        eq(schema.eventPlaneOrgBindings.version, expectedVersion),
      ),
    )
    .returning();
  if (!binding) throw new EventPlaneControlError(409, "event_plane_binding_update_failed");
  return binding;
}

async function findExistingIdentity(tx: DbExecutor, input: z.infer<typeof ensureIdentitySchema>) {
  const [identity] = await tx
    .select()
    .from(schema.eventPlaneIdentities)
    .where(
      and(
        eq(schema.eventPlaneIdentities.bindingId, input.bindingId),
        eq(schema.eventPlaneIdentities.identityType, input.identityType),
        eq(schema.eventPlaneIdentities.principalType, input.principalType),
        eq(schema.eventPlaneIdentities.principalId, input.principalId),
        sql`${schema.eventPlaneIdentities.status} IN ('provisioning', 'active', 'rotating', 'failed')`,
      ),
    )
    .limit(1);
  return identity ?? null;
}

async function insertEventPlaneIdentity(
  tx: DbExecutor,
  organizationId: string,
  input: z.infer<typeof ensureIdentitySchema>,
  now: Date,
) {
  const [identity] = await tx
    .insert(schema.eventPlaneIdentities)
    .values({
      organizationId,
      bindingId: input.bindingId,
      identityType: input.identityType,
      principalType: safeReference(input.principalType, "principal_type"),
      principalId: safeReference(input.principalId, "principal_id"),
      displayName: safeText(input.displayName),
      status: input.status,
      permissionsJson: sanitizeEventPlaneSafeMetadata(input.permissions, "permissions"),
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      revokedAt: input.status === "revoked" ? now : null,
    })
    .returning();
  if (!identity) throw new EventPlaneControlError(503, "event_plane_identity_create_failed");
  return identity;
}

async function updateEventPlaneIdentity(
  tx: DbExecutor,
  existing: typeof schema.eventPlaneIdentities.$inferSelect,
  input: z.infer<typeof ensureIdentitySchema>,
  now: Date,
) {
  const expectedVersion = assertExpectedVersion(existing.version, input.expectedVersion);
  const [identity] = await tx
    .update(schema.eventPlaneIdentities)
    .set({
      displayName: safeText(input.displayName),
      status: input.status,
      permissionsJson: sanitizeEventPlaneSafeMetadata(input.permissions, "permissions"),
      policyVersion: input.policyVersion,
      version: existing.version + 1,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : existing.expiresAt,
      revokedAt: input.status === "revoked" ? now : existing.revokedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlaneIdentities.id, existing.id),
        eq(schema.eventPlaneIdentities.version, expectedVersion),
      ),
    )
    .returning();
  if (!identity) throw new EventPlaneControlError(409, "event_plane_identity_update_failed");
  return identity;
}

async function insertEventPlaneCredentialGrant(
  tx: DbExecutor,
  input: z.infer<typeof recordCredentialGrantSchema>,
  safeMetadata: JsonRecord,
  now: Date,
) {
  const [grant] = await tx
    .insert(schema.eventPlaneCredentialGrants)
    .values({
      identityId: input.identityId,
      providerUserPublicKey: safeOptionalReference(input.providerUserPublicKey, "provider_user_public_key"),
      secretRef: input.secretRef ? safeSecretRef(input.secretRef) : null,
      status: input.status,
      issuedAt: input.issuedAt ? new Date(input.issuedAt) : input.status === "issued" || input.status === "active" ? now : null,
      deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : input.status === "expired" ? now : null,
      revokedAt: input.revokedAt ? new Date(input.revokedAt) : input.status === "revoked" ? now : null,
      safeMetadataJson: safeMetadata,
    })
    .returning();
  if (!grant) throw new EventPlaneControlError(503, "event_plane_grant_create_failed");
  return grant;
}

async function updateEventPlaneCredentialGrant(
  tx: DbExecutor,
  existing: typeof schema.eventPlaneCredentialGrants.$inferSelect,
  input: z.infer<typeof recordCredentialGrantSchema>,
  safeMetadata: JsonRecord,
  now: Date,
) {
  const expectedVersion = assertExpectedVersion(existing.version, input.expectedVersion);
  assertEventPlaneCredentialGrantTransition(existing.status, input.status);
  const [grant] = await tx
    .update(schema.eventPlaneCredentialGrants)
    .set({
      providerUserPublicKey: safeOptionalReference(input.providerUserPublicKey, "provider_user_public_key") ?? existing.providerUserPublicKey,
      secretRef: input.secretRef ? safeSecretRef(input.secretRef) : existing.secretRef,
      status: input.status,
      version: existing.version + 1,
      issuedAt: input.issuedAt ? new Date(input.issuedAt) : ["issued", "active"].includes(input.status) ? existing.issuedAt ?? now : existing.issuedAt,
      deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : existing.deliveredAt,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : input.status === "expired" ? existing.expiresAt ?? now : existing.expiresAt,
      revokedAt: input.revokedAt ? new Date(input.revokedAt) : input.status === "revoked" ? existing.revokedAt ?? now : existing.revokedAt,
      safeMetadataJson: safeMetadata,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlaneCredentialGrants.id, existing.id),
        eq(schema.eventPlaneCredentialGrants.version, expectedVersion),
      ),
    )
    .returning();
  if (!grant) throw new EventPlaneControlError(409, "event_plane_grant_update_failed");
  return grant;
}

async function insertEventPlanePolicyVersion(
  tx: DbExecutor,
  input: z.infer<typeof activatePolicyVersionSchema>,
  policy: JsonRecord,
  policyHash: string,
  approvedBy: string,
  now: Date,
) {
  const [policyVersion] = await tx
    .insert(schema.eventPlanePolicyVersions)
    .values({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      version: input.version,
      policyHash,
      policyJson: policy,
      status: "active",
      approvedBy,
      activatedAt: now,
    })
    .returning();
  return policyVersion ?? null;
}

async function reactivateEventPlanePolicyVersion(
  tx: DbExecutor,
  existing: typeof schema.eventPlanePolicyVersions.$inferSelect,
  approvedBy: string,
  now: Date,
) {
  const [policyVersion] = await tx
    .update(schema.eventPlanePolicyVersions)
    .set({
      status: "active",
      approvedBy,
      activatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlanePolicyVersions.id, existing.id),
        eq(schema.eventPlanePolicyVersions.policyHash, existing.policyHash),
      ),
    )
    .returning();
  return policyVersion ?? null;
}

async function findExistingCrossAccountLink(
  tx: DbExecutor,
  input: z.infer<typeof ensureCrossAccountLinkSchema>,
) {
  const [link] = await tx
    .select()
    .from(schema.eventPlaneCrossAccountLinks)
    .where(
      and(
        eq(schema.eventPlaneCrossAccountLinks.sourceBindingId, input.sourceBindingId),
        input.targetBindingId
          ? eq(schema.eventPlaneCrossAccountLinks.targetBindingId, input.targetBindingId)
          : sql`${schema.eventPlaneCrossAccountLinks.targetBindingId} IS NULL`,
        input.targetSystemService
          ? eq(schema.eventPlaneCrossAccountLinks.targetSystemService, input.targetSystemService)
          : sql`${schema.eventPlaneCrossAccountLinks.targetSystemService} IS NULL`,
        eq(schema.eventPlaneCrossAccountLinks.linkType, input.linkType),
        eq(schema.eventPlaneCrossAccountLinks.subjectPattern, input.subjectPattern),
        ne(schema.eventPlaneCrossAccountLinks.status, "revoked"),
      ),
    )
    .limit(1);
  return link ?? null;
}

async function insertEventPlaneCrossAccountLink(
  tx: DbExecutor,
  input: z.infer<typeof ensureCrossAccountLinkSchema>,
  actor: EventPlaneControlActor,
) {
  const [link] = await tx
    .insert(schema.eventPlaneCrossAccountLinks)
    .values({
      sourceBindingId: input.sourceBindingId,
      targetBindingId: input.targetBindingId ?? null,
      targetSystemService: safeOptionalReference(input.targetSystemService, "target_system_service"),
      linkType: input.linkType,
      subjectPattern: safeReference(input.subjectPattern, "subject_pattern"),
      responsePattern: safeOptionalReference(input.responsePattern, "response_pattern"),
      status: input.status,
      justification: safeText(input.justification),
      policyVersion: input.policyVersion,
      approvedBy: eventPlaneApprovalActor(actor),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    })
    .returning();
  if (!link) throw new EventPlaneControlError(503, "event_plane_link_create_failed");
  return link;
}

async function updateEventPlaneCrossAccountLink(
  tx: DbExecutor,
  existing: typeof schema.eventPlaneCrossAccountLinks.$inferSelect,
  input: z.infer<typeof ensureCrossAccountLinkSchema>,
  actor: EventPlaneControlActor,
  now: Date,
) {
  const expectedVersion = assertExpectedVersion(existing.version, input.expectedVersion);
  const [link] = await tx
    .update(schema.eventPlaneCrossAccountLinks)
    .set({
      responsePattern: safeOptionalReference(input.responsePattern, "response_pattern") ?? existing.responsePattern,
      status: input.status,
      justification: safeText(input.justification),
      policyVersion: input.policyVersion,
      approvedBy: eventPlaneApprovalActor(actor),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : existing.expiresAt,
      version: existing.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.eventPlaneCrossAccountLinks.id, existing.id),
        eq(schema.eventPlaneCrossAccountLinks.version, expectedVersion),
      ),
    )
    .returning();
  if (!link) throw new EventPlaneControlError(409, "event_plane_link_update_failed");
  return link;
}

function eventPlaneCellView(cell: typeof schema.eventPlaneCells.$inferSelect): JsonRecord {
  return {
    id: cell.id,
    provider: safeReference(cell.provider, "provider"),
    providerRef: safeOptionalReference(cell.providerRef, "provider_ref"),
    environment: safeReference(cell.environment, "environment"),
    region: safeReference(cell.region, "region"),
    placementClass: safeReference(cell.placementClass, "placement_class"),
    status: cell.status,
    endpointRef: safeOptionalReference(cell.endpointRef, "endpoint_ref"),
    systemAccountRef: safeOptionalReference(cell.systemAccountRef, "system_account_ref"),
    resolverRef: safeOptionalReference(cell.resolverRef, "resolver_ref"),
    capacity: sanitizeEventPlaneSafeMetadata(cell.capacityJson, "capacity"),
    observedCapacity: sanitizeEventPlaneSafeMetadata(cell.observedCapacityJson, "observed_capacity"),
    policyVersion: cell.policyVersion,
    recordVersion: cell.version,
    lastHeartbeatAt: cell.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: cell.createdAt.toISOString(),
    updatedAt: cell.updatedAt.toISOString(),
  };
}

export function eventPlaneReconciliationReportView(
  report: z.infer<typeof recordReconciliationReportSchema>,
  reportedAt = new Date(),
): JsonRecord {
  return sanitizeEventPlaneSafeMetadata({
    cellId: report.cellId,
    completedAt: report.completedAt,
    desiredHash: safeReference(report.desiredHash, "desired_hash"),
    drift: report.drift.map((item) => ({
      reason: safeText(item.reason),
      status: safeReference(item.status, "drift_status"),
      targetId: safeReference(item.targetId, "drift_target_id"),
      targetType: safeReference(item.targetType, "drift_target_type"),
    })),
    driftCount: report.drift.length,
    dryRun: report.dryRun,
    observedHash: safeReference(report.observedHash, "observed_hash"),
    observedStatus: report.observedStatus,
    operationsApplied: report.operationsApplied,
    operationsPlanned: report.operationsPlanned,
    orphanCount: report.orphanCount,
    planHash: safeReference(report.planHash, "plan_hash"),
    policyBuild: safeOptionalReference(report.policyBuild, "policy_build"),
    providerResultCode: safeReference(report.providerResultCode, "provider_result_code"),
    reportedAt: reportedAt.toISOString(),
    resolverRevision: safeOptionalReference(report.resolverRevision, "resolver_revision"),
    results: report.results.map((item) => ({
      durationMs: item.durationMs,
      idempotencyKey: safeReference(item.idempotencyKey, "result_idempotency_key"),
      operation: safeReference(item.operation, "result_operation"),
      providerResultCode: safeReference(item.providerResultCode, "result_provider_code"),
      status: safeReference(item.status, "result_status"),
    })),
    rollbackCheckpoint: sanitizeEventPlaneSafeMetadata(
      report.rollbackCheckpoint ?? {},
      "rollback_checkpoint",
    ),
    startedAt: report.startedAt,
  }, "reconciliation_report");
}

export function eventPlaneObservedCapacityAfterReconciliation(
  existingObservedCapacity: unknown,
  report: z.infer<typeof recordReconciliationReportSchema>,
  reportedAt = new Date(),
): JsonRecord {
  const existing = sanitizeEventPlaneSafeMetadata(existingObservedCapacity, "observed_capacity");
  return sanitizeEventPlaneSafeMetadata({
    ...existing,
    reconciliation: eventPlaneReconciliationReportView(report, reportedAt),
  }, "observed_capacity");
}

function eventPlaneOrgBindingView(binding: typeof schema.eventPlaneOrgBindings.$inferSelect): JsonRecord {
  return {
    id: binding.id,
    organizationId: binding.organizationId,
    cellId: binding.cellId,
    providerAccountRef: safeOptionalReference(binding.providerAccountRef, "provider_account_ref"),
    accountPublicKey: safeOptionalReference(binding.accountPublicKey, "account_public_key"),
    status: binding.status,
    placementReason: binding.placementReason,
    quotaPolicy: sanitizeEventPlaneSafeMetadata(binding.quotaPolicyJson, "quota_policy"),
    streamPolicy: sanitizeEventPlaneSafeMetadata(binding.streamPolicyJson, "stream_policy"),
    activePolicyVersion: binding.activePolicyVersion,
    recordVersion: binding.version,
    activatedAt: binding.activatedAt?.toISOString() ?? null,
    suspendedAt: binding.suspendedAt?.toISOString() ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

function eventPlaneIdentityView(identity: typeof schema.eventPlaneIdentities.$inferSelect): JsonRecord {
  return {
    id: identity.id,
    organizationId: identity.organizationId,
    bindingId: identity.bindingId,
    identityType: identity.identityType,
    principalType: safeReference(identity.principalType, "principal_type"),
    principalId: safeReference(identity.principalId, "principal_id"),
    displayName: safeText(identity.displayName),
    status: identity.status,
    permissions: sanitizeEventPlaneSafeMetadata(identity.permissionsJson, "permissions"),
    policyVersion: identity.policyVersion,
    recordVersion: identity.version,
    expiresAt: identity.expiresAt?.toISOString() ?? null,
    lastUsedAt: identity.lastUsedAt?.toISOString() ?? null,
    revokedAt: identity.revokedAt?.toISOString() ?? null,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt.toISOString(),
  };
}

function eventPlanePolicyVersionView(policy: typeof schema.eventPlanePolicyVersions.$inferSelect): JsonRecord {
  return {
    id: policy.id,
    scopeType: policy.scopeType,
    scopeId: safeReference(policy.scopeId, "scope_id"),
    version: policy.version,
    policyHash: policy.policyHash,
    policy: sanitizeEventPlaneSafeMetadata(policy.policyJson, "policy"),
    status: policy.status,
    approvedBy: safeOptionalReference(policy.approvedBy, "approved_by"),
    activatedAt: policy.activatedAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
  };
}

function eventPlaneCrossAccountLinkView(link: typeof schema.eventPlaneCrossAccountLinks.$inferSelect): JsonRecord {
  return {
    id: link.id,
    sourceBindingId: link.sourceBindingId,
    targetBindingId: link.targetBindingId,
    targetSystemService: safeOptionalReference(link.targetSystemService, "target_system_service"),
    linkType: link.linkType,
    subjectPattern: safeReference(link.subjectPattern, "subject_pattern"),
    responsePattern: safeOptionalReference(link.responsePattern, "response_pattern"),
    status: link.status,
    justification: safeText(link.justification),
    policyVersion: link.policyVersion,
    approvedBy: safeOptionalReference(link.approvedBy, "approved_by"),
    recordVersion: link.version,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
  };
}

export function eventPlaneRequestHash(operation: string, parsed: unknown): string {
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const { actor: _actor, idempotencyKey: _idempotencyKey, expectedVersion: _expectedVersion, ...body } = record;
  return stableHash({ operation, body });
}

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as JsonRecord)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function safeText(value: string): string {
  return safeReference(value, "text");
}

function safeReference(value: string, field: string): string {
  assertSafeReference(value, field);
  return value;
}

function safeOptionalReference(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  return safeReference(value, field);
}

function safeSecretRef(value: string): string {
  assertSafeSecretRef(value);
  return value;
}

function assertNoBroadSubjectPattern(pattern: string) {
  if (pattern === ">" || pattern.includes(">") || pattern.includes("*")) {
    throw new EventPlaneControlError(400, "event_plane_broad_cross_account_subject");
  }
  if (pattern.startsWith("$SYS") || pattern.startsWith("$JS.API")) {
    throw new EventPlaneControlError(400, "event_plane_system_subject_forbidden");
  }
}

export function assertExpectedVersion(actual: number, expected: number | undefined): number {
  if (expected === undefined) {
    throw new EventPlaneControlError(409, "event_plane_expected_version_required");
  }
  if (actual !== expected) {
    throw new EventPlaneControlError(409, "event_plane_version_conflict");
  }
  return expected;
}

function cellStatusFromObserved(
  observedStatus: z.infer<typeof recordReconciliationReportSchema>["observedStatus"],
  currentStatus: EventPlaneCellStatus,
): EventPlaneCellStatus {
  if (currentStatus === "deleted" || currentStatus === "disabled" || currentStatus === "draining") return currentStatus;
  if (observedStatus === "reachable") return "active";
  return "degraded";
}

function scopeKeyForPolicy(scopeType: string, scopeId: string): string {
  return scopeType === "organization" ? `org:${scopeId}` : `${scopeType}:${scopeId}`;
}
