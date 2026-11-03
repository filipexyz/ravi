import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

const MIN_CONTROL_TOKEN_LENGTH = 24;
const DEFAULT_LEASE_TTL_SECONDS = 15 * 60;
const MAX_LEASE_TTL_SECONDS = 24 * 60 * 60;
const TERMINAL_EVENT_TYPES = new Set([
  "turn.complete",
  "turn.failed",
  "runtime.completed",
  "runtime.failed",
  "sandbox.completed",
  "sandbox.failed",
]);

const jsonRecordSchema = z.record(z.string(), z.unknown()).default({});
const uuidSchema = z.string().uuid();
const optionalUuidSchema = uuidSchema.nullish().transform((value) => value ?? null);

const runtimeHostStatusSchema = z.enum([
  "provisioning",
  "active",
  "degraded",
  "draining",
  "disabled",
]);

const runtimeImageStatusSchema = z.enum([
  "building",
  "active",
  "deprecated",
  "disabled",
]);

const runtimeLeaseStatusSchema = z.enum([
  "requested",
  "assigned",
  "booting",
  "running",
  "draining",
  "completed",
  "failed",
  "expired",
  "revoked",
]);

const managedRuntimeEventSeveritySchema = z.enum([
  "debug",
  "info",
  "warning",
  "error",
]);

const runtimeHostRegistrationSchema = z.object({
  capacity: jsonRecordSchema.optional(),
  displayName: z.string().trim().min(1).max(160),
  environment: z.enum(["development", "preview", "production"]).default("development"),
  health: jsonRecordSchema.optional(),
  hostname: z.string().trim().min(1).max(240),
  placementClasses: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  provider: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(80).nullable().optional(),
  status: runtimeHostStatusSchema.default("active"),
});

const runtimeHostHeartbeatSchema = z.object({
  capacity: jsonRecordSchema.optional(),
  health: jsonRecordSchema.optional(),
  hostId: uuidSchema.optional(),
  hostname: z.string().trim().min(1).max(240).optional(),
  placementClasses: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  status: runtimeHostStatusSchema.default("active"),
}).refine((value) => value.hostId || value.hostname, {
  message: "hostId or hostname is required",
});

const runtimeImageRegistrationSchema = z.object({
  architecture: z.string().trim().min(1).max(40),
  baseOs: z.string().trim().min(1).max(120),
  digest: z.string().trim().min(1).max(240),
  kernelRef: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(160),
  providerSupport: jsonRecordSchema.optional(),
  rootfsRef: z.string().trim().min(1).max(240),
  status: runtimeImageStatusSchema.default("active"),
  version: z.string().trim().min(1).max(120),
});

const runtimeLeaseRequestSchema = z.object({
  agentId: z.string().trim().min(1).max(160).nullable().optional(),
  hostId: optionalUuidSchema.optional(),
  imageId: uuidSchema,
  leaseTtlSeconds: z.number().int().min(30).max(MAX_LEASE_TTL_SECONDS).default(DEFAULT_LEASE_TTL_SECONDS),
  limits: jsonRecordSchema.optional(),
  managedRuntimeInstanceId: optionalUuidSchema.optional(),
  organizationId: uuidSchema,
  placement: z.literal("cloud").default("cloud"),
  projectId: optionalUuidSchema.optional(),
  runtimeModel: z.string().trim().min(1).max(160).nullable().optional(),
  runtimeProvider: z.string().trim().min(1).max(80),
  safeMetadata: jsonRecordSchema.optional(),
  sessionKey: z.string().trim().min(1).max(512).nullable().optional(),
});

const runtimeLeaseClaimSchema = z.object({
  hostId: uuidSchema,
  leaseToken: z.string().trim().min(1),
  sandboxId: z.string().trim().min(1).max(160).nullable().optional(),
});

const runtimeLeaseValidateSchema = z.object({
  leaseToken: z.string().trim().min(1),
  sandboxId: z.string().trim().min(1).max(160).nullable().optional(),
});

const runtimeLeaseRevokeSchema = z.object({
  failureCode: z.string().trim().min(1).max(120).nullable().optional(),
  leaseId: uuidSchema,
});

const managedRuntimeEventInputSchema = z.object({
  eventType: z.string().trim().min(1).max(160),
  safePayload: jsonRecordSchema.optional(),
  sequence: z.number().int().positive(),
  severity: managedRuntimeEventSeveritySchema.default("info"),
  sourceEventId: z.string().trim().min(1).max(240).nullable().optional(),
});

const managedRuntimeEventsIngestSchema = z.object({
  events: z.array(managedRuntimeEventInputSchema).min(1).max(500),
  leaseToken: z.string().trim().min(1),
  sandboxId: z.string().trim().min(1).max(160).nullable().optional(),
});

export class ManagedRuntimeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ManagedRuntimeError";
  }
}

export type RuntimeLeaseBootstrap = {
  imageRef: string;
  lease: RuntimeLeaseView;
  managedRuntimeSessionId: string;
  version: 1;
};

export type RuntimeLeaseView = {
  id: string;
  organizationId: string;
  projectId: string | null;
  agentId: string | null;
  sessionKey: string | null;
  managedRuntimeInstanceId: string | null;
  runtimeProvider: string;
  runtimeModel: string | null;
  placement: string;
  hostId: string | null;
  imageId: string;
  sandboxId: string | null;
  status: string;
  leaseExpiresAt: string;
  limits: JsonRecord;
  safeMetadata: JsonRecord;
};

export function getRuntimeControlToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.RAVI_RUNTIME_CONTROL_TOKEN?.trim();
  return value && value.length >= MIN_CONTROL_TOKEN_LENGTH ? value : null;
}

export function authorizeRuntimeControlRequest(
  request: Request,
  expectedToken = getRuntimeControlToken(),
): boolean {
  if (!expectedToken) return false;
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  if (!bearer || bearer.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(bearer), Buffer.from(expectedToken));
}

export function generateRuntimeLeaseToken() {
  return `ravi_rlt_${randomBytes(48).toString("base64url")}`;
}

export function hashRuntimeToken(token: string) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export async function registerRuntimeHost(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeHostRegistrationSchema, input.body);
  const now = new Date();
  const [host] = await db
    .insert(schema.runtimeHosts)
    .values({
      provider: parsed.provider,
      displayName: parsed.displayName,
      hostname: parsed.hostname,
      region: parsed.region ?? null,
      environment: parsed.environment,
      status: parsed.status,
      placementClassesJson: parsed.placementClasses,
      capacityJson: toJsonRecord(parsed.capacity),
      healthJson: toJsonRecord(parsed.health),
      lastHeartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: schema.runtimeHosts.hostname,
      set: {
        provider: parsed.provider,
        displayName: parsed.displayName,
        region: parsed.region ?? null,
        environment: parsed.environment,
        status: parsed.status,
        placementClassesJson: parsed.placementClasses,
        capacityJson: toJsonRecord(parsed.capacity),
        healthJson: toJsonRecord(parsed.health),
        lastHeartbeatAt: now,
        updatedAt: now,
      },
    })
    .returning();

  if (!host) throw new ManagedRuntimeError(503, "runtime_host_register_failed");
  return {
    version: 1 as const,
    host: runtimeHostView(host),
  };
}

export async function heartbeatRuntimeHost(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeHostHeartbeatSchema, input.body);
  const now = new Date();
  const predicates = parsed.hostId
    ? eq(schema.runtimeHosts.id, parsed.hostId)
    : eq(schema.runtimeHosts.hostname, parsed.hostname as string);
  const [host] = await db
    .update(schema.runtimeHosts)
    .set({
      ...(parsed.capacity ? { capacityJson: toJsonRecord(parsed.capacity) } : {}),
      ...(parsed.health ? { healthJson: toJsonRecord(parsed.health) } : {}),
      ...(parsed.placementClasses ? { placementClassesJson: parsed.placementClasses } : {}),
      status: parsed.status,
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(predicates)
    .returning();

  if (!host) throw new ManagedRuntimeError(404, "runtime_host_not_found");
  return {
    version: 1 as const,
    host: runtimeHostView(host),
  };
}

export async function registerRuntimeImage(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeImageRegistrationSchema, input.body);
  const now = new Date();
  const [image] = await db
    .insert(schema.runtimeImages)
    .values({
      name: parsed.name,
      version: parsed.version,
      architecture: parsed.architecture,
      baseOs: parsed.baseOs,
      providerSupportJson: toJsonRecord(parsed.providerSupport),
      kernelRef: parsed.kernelRef,
      rootfsRef: parsed.rootfsRef,
      digest: parsed.digest,
      status: parsed.status,
    })
    .onConflictDoUpdate({
      target: schema.runtimeImages.digest,
      set: {
        name: parsed.name,
        version: parsed.version,
        architecture: parsed.architecture,
        baseOs: parsed.baseOs,
        providerSupportJson: toJsonRecord(parsed.providerSupport),
        kernelRef: parsed.kernelRef,
        rootfsRef: parsed.rootfsRef,
        status: parsed.status,
        updatedAt: now,
      },
    })
    .returning();

  if (!image) throw new ManagedRuntimeError(503, "runtime_image_register_failed");
  return {
    version: 1 as const,
    image: runtimeImageView(image),
  };
}

export async function requestRuntimeLease(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeLeaseRequestSchema, input.body);
  await assertRuntimeImageUsable(parsed.imageId);
  if (parsed.hostId) await assertRuntimeHostUsable(parsed.hostId);

  const leaseToken = generateRuntimeLeaseToken();
  const leaseTokenHash = hashRuntimeToken(leaseToken);
  const now = new Date();
  const [lease] = await db
    .insert(schema.runtimeLeases)
    .values({
      organizationId: parsed.organizationId,
      projectId: parsed.projectId ?? null,
      agentId: parsed.agentId ?? null,
      sessionKey: parsed.sessionKey ?? null,
      managedRuntimeInstanceId: parsed.managedRuntimeInstanceId ?? null,
      runtimeProvider: parsed.runtimeProvider,
      runtimeModel: parsed.runtimeModel ?? null,
      placement: parsed.placement,
      hostId: parsed.hostId ?? null,
      imageId: parsed.imageId,
      status: parsed.hostId ? "assigned" : "requested",
      leaseTokenHash,
      leaseExpiresAt: new Date(now.getTime() + parsed.leaseTtlSeconds * 1000),
      limitsJson: toJsonRecord(parsed.limits),
      safeMetadataJson: toJsonRecord(parsed.safeMetadata),
    })
    .returning();

  if (!lease) throw new ManagedRuntimeError(503, "runtime_lease_request_failed");
  return {
    version: 1 as const,
    lease: runtimeLeaseView(lease),
    leaseToken,
  };
}

export async function claimRuntimeLease(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeLeaseClaimSchema, input.body);
  await assertRuntimeHostUsable(parsed.hostId);
  const lease = await resolveUsableLeaseByToken(parsed.leaseToken);
  const now = new Date();
  const [updated] = await db
    .update(schema.runtimeLeases)
    .set({
      hostId: parsed.hostId,
      sandboxId: parsed.sandboxId ?? lease.sandboxId,
      status: "booting",
      claimedAt: lease.claimedAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.runtimeLeases.id, lease.id))
    .returning();

  if (!updated) throw new ManagedRuntimeError(409, "runtime_lease_claim_failed");
  return {
    version: 1 as const,
    lease: runtimeLeaseView(updated),
  };
}

export async function validateRuntimeLease(input: {
  body: unknown;
  requestId: string;
}): Promise<RuntimeLeaseBootstrap> {
  const parsed = parse(runtimeLeaseValidateSchema, input.body);
  const lease = await resolveUsableLeaseByToken(parsed.leaseToken);
  const now = new Date();
  const [updated] = await db
    .update(schema.runtimeLeases)
    .set({
      sandboxId: parsed.sandboxId ?? lease.sandboxId,
      status: "running",
      startedAt: lease.startedAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.runtimeLeases.id, lease.id))
    .returning();

  if (!updated) throw new ManagedRuntimeError(409, "runtime_lease_validate_failed");
  const session = await ensureManagedRuntimeSessionForLease(updated, now);
  const image = await getRuntimeImage(updated.imageId);

  return {
    version: 1,
    imageRef: `${image.name}:${image.version}@${image.digest}`,
    managedRuntimeSessionId: session.id,
    lease: runtimeLeaseView(updated),
  };
}

export async function revokeRuntimeLease(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(runtimeLeaseRevokeSchema, input.body);
  const now = new Date();
  const [lease] = await db
    .update(schema.runtimeLeases)
    .set({
      status: "revoked",
      failureCode: parsed.failureCode ?? null,
      revokedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.runtimeLeases.id, parsed.leaseId))
    .returning();

  if (!lease) throw new ManagedRuntimeError(404, "runtime_lease_not_found");
  await updateManagedRuntimeSessionForLease(lease, now);
  return {
    version: 1 as const,
    lease: runtimeLeaseView(lease),
  };
}

export async function ingestManagedRuntimeEvents(input: {
  body: unknown;
  requestId: string;
}) {
  const parsed = parse(managedRuntimeEventsIngestSchema, input.body);
  const lease = await resolveUsableLeaseByToken(parsed.leaseToken, {
    allowTerminal: true,
  });
  const now = new Date();
  const session = await ensureManagedRuntimeSessionForLease(lease, now);
  let accepted = 0;
  let duplicates = 0;

  for (const event of parsed.events) {
    const [row] = await db
      .insert(schema.managedRuntimeEvents)
      .values({
        organizationId: lease.organizationId,
        sessionId: session.id,
        leaseId: lease.id,
        hostId: lease.hostId,
        sandboxId: parsed.sandboxId ?? lease.sandboxId,
        sourceEventId: event.sourceEventId ?? null,
        eventType: event.eventType,
        sequence: event.sequence,
        severity: event.severity,
        safePayloadJson: toJsonRecord(event.safePayload),
      })
      .onConflictDoNothing()
      .returning({ id: schema.managedRuntimeEvents.id });

    if (row) accepted += 1;
    else duplicates += 1;
  }

  const terminalEvent = parsed.events.find((event) => TERMINAL_EVENT_TYPES.has(event.eventType));
  if (terminalEvent) {
    await db
      .update(schema.runtimeLeases)
      .set({
        status: terminalEvent.eventType.includes("failed") ? "failed" : "completed",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.runtimeLeases.id, lease.id));
    await updateManagedRuntimeSessionForLease(
      {
        ...lease,
        status: terminalEvent.eventType.includes("failed") ? "failed" : "completed",
        completedAt: now,
      },
      now,
    );
  }

  return {
    version: 1 as const,
    accepted,
    duplicates,
    leaseId: lease.id,
    managedRuntimeSessionId: session.id,
  };
}

function parse<T extends z.ZodTypeAny>(schemaDef: T, value: unknown): z.infer<T> {
  const result = schemaDef.safeParse(value);
  if (!result.success) {
    throw new ManagedRuntimeError(400, "runtime_payload_invalid");
  }
  return result.data;
}

async function assertRuntimeImageUsable(imageId: string) {
  const image = await getRuntimeImage(imageId);
  if (image.status === "disabled" || image.status === "deprecated") {
    throw new ManagedRuntimeError(409, "runtime_image_unavailable");
  }
}

async function assertRuntimeHostUsable(hostId: string) {
  const [host] = await db
    .select()
    .from(schema.runtimeHosts)
    .where(eq(schema.runtimeHosts.id, hostId))
    .limit(1);
  if (!host) throw new ManagedRuntimeError(404, "runtime_host_not_found");
  if (host.status === "disabled" || host.status === "draining") {
    throw new ManagedRuntimeError(409, "runtime_host_unavailable");
  }
}

async function getRuntimeImage(imageId: string) {
  const [image] = await db
    .select()
    .from(schema.runtimeImages)
    .where(eq(schema.runtimeImages.id, imageId))
    .limit(1);
  if (!image) throw new ManagedRuntimeError(404, "runtime_image_not_found");
  return image;
}

async function resolveUsableLeaseByToken(
  leaseToken: string,
  options: { allowTerminal?: boolean } = {},
) {
  const [lease] = await db
    .select()
    .from(schema.runtimeLeases)
    .where(eq(schema.runtimeLeases.leaseTokenHash, hashRuntimeToken(leaseToken)))
    .limit(1);

  if (!lease) throw new ManagedRuntimeError(401, "runtime_lease_invalid");

  const now = new Date();
  if (lease.leaseExpiresAt <= now && lease.status !== "expired") {
    await db
      .update(schema.runtimeLeases)
      .set({ status: "expired", updatedAt: now })
      .where(eq(schema.runtimeLeases.id, lease.id));
    throw new ManagedRuntimeError(401, "runtime_lease_expired");
  }

  const terminal = ["completed", "failed", "expired", "revoked"].includes(lease.status);
  if (terminal && !options.allowTerminal) {
    throw new ManagedRuntimeError(409, `runtime_lease_${lease.status}`);
  }

  return lease;
}

async function ensureManagedRuntimeSessionForLease(
  lease: typeof schema.runtimeLeases.$inferSelect,
  now: Date,
) {
  const [existing] = await db
    .select()
    .from(schema.managedRuntimeSessions)
    .where(eq(schema.managedRuntimeSessions.leaseId, lease.id))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(schema.managedRuntimeSessions)
      .set({
        hostId: lease.hostId,
        sandboxId: lease.sandboxId,
        status: lease.status === "running" ? "active" : existing.status,
        startedAt: existing.startedAt ?? lease.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.managedRuntimeSessions.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [session] = await db
    .insert(schema.managedRuntimeSessions)
    .values({
      organizationId: lease.organizationId,
      projectId: lease.projectId,
      instanceId: lease.managedRuntimeInstanceId,
      leaseId: lease.id,
      hostId: lease.hostId,
      sandboxId: lease.sandboxId,
      sessionKey: lease.sessionKey,
      runtimeProvider: lease.runtimeProvider,
      runtimeModel: lease.runtimeModel,
      status: lease.status === "running" ? "active" : "starting",
      startedAt: lease.startedAt ?? now,
    })
    .returning();

  if (!session) throw new ManagedRuntimeError(503, "managed_runtime_session_create_failed");
  return session;
}

async function updateManagedRuntimeSessionForLease(
  lease: typeof schema.runtimeLeases.$inferSelect,
  now: Date,
) {
  const sessionStatus =
    lease.status === "completed"
      ? "completed"
      : lease.status === "failed"
        ? "failed"
        : lease.status === "revoked"
          ? "interrupted"
          : lease.status === "expired"
            ? "expired"
            : null;
  if (!sessionStatus) return;

  await db
    .update(schema.managedRuntimeSessions)
    .set({
      status: sessionStatus,
      endedAt: lease.completedAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.managedRuntimeSessions.leaseId, lease.id));
}

function runtimeHostView(host: typeof schema.runtimeHosts.$inferSelect) {
  return {
    id: host.id,
    provider: host.provider,
    displayName: host.displayName,
    hostname: host.hostname,
    region: host.region,
    environment: host.environment,
    status: host.status,
    placementClasses: host.placementClassesJson,
    capacity: host.capacityJson,
    health: host.healthJson,
    lastHeartbeatAt: host.lastHeartbeatAt?.toISOString() ?? null,
    updatedAt: host.updatedAt.toISOString(),
  };
}

function runtimeImageView(image: typeof schema.runtimeImages.$inferSelect) {
  return {
    id: image.id,
    name: image.name,
    version: image.version,
    architecture: image.architecture,
    baseOs: image.baseOs,
    providerSupport: image.providerSupportJson,
    kernelRef: image.kernelRef,
    rootfsRef: image.rootfsRef,
    digest: image.digest,
    status: image.status,
    updatedAt: image.updatedAt.toISOString(),
  };
}

function runtimeLeaseView(lease: typeof schema.runtimeLeases.$inferSelect): RuntimeLeaseView {
  return {
    id: lease.id,
    organizationId: lease.organizationId,
    projectId: lease.projectId,
    agentId: lease.agentId,
    sessionKey: lease.sessionKey,
    managedRuntimeInstanceId: lease.managedRuntimeInstanceId,
    runtimeProvider: lease.runtimeProvider,
    runtimeModel: lease.runtimeModel,
    placement: lease.placement,
    hostId: lease.hostId,
    imageId: lease.imageId,
    sandboxId: lease.sandboxId,
    status: lease.status,
    leaseExpiresAt: lease.leaseExpiresAt.toISOString(),
    limits: lease.limitsJson,
    safeMetadata: lease.safeMetadataJson,
  };
}

function toJsonRecord(value: Record<string, unknown> | undefined | null): JsonRecord {
  return value ? { ...value } : {};
}
