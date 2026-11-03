import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { canAccessProject, type ProjectAuthorizationCheck } from "@/server/console/project-access";
import { isUuidRef } from "@/server/console/ref";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { ManagedRuntimeError } from "./managed-runtime";
import { resolveManagedRuntimeRetrySafeInput } from "./managed-runtime-retry";

const OPERATION_ACTIONS = [
  "create",
  "start",
  "stop",
  "restart",
  "retry",
  "delete",
  "backup",
  "restore",
  "rotate_controller",
] as const;
const MUTATION_ACTIONS = [
  "start",
  "stop",
  "restart",
  "retry",
  "delete",
  "backup",
  "restore",
  "rotate_controller",
] as const;
const HOST_BOUND_MAINTENANCE_ACTIONS = [
  "start",
  "stop",
  "restart",
  "delete",
  "backup",
  "restore",
  "rotate_controller",
] as const;
const OBSERVED_STATES = [
  "provisioning",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "restarting",
  "degraded",
  "deleting",
  "deleted",
  "failed",
] as const;
const CONNECTION_KINDS = ["private_ravi_sdk", "remote_relay"] as const;
const CONNECTION_STATUSES = [
  "connecting",
  "online",
  "stale",
  "offline",
  "revoked",
] as const;
const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const BACKUP_REF_PATTERN = /^mbk_[a-f0-9]{32}$/;
const CONTENT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_ENDPOINT_REF_PATTERN = /^endpoint_[A-Za-z0-9._:-]{1,120}$/;
const OPAQUE_CREDENTIAL_REF_PATTERN = /^cred_[A-Za-z0-9._:-]{1,120}$/;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|credential|password|private.?key|secret|token)/i;
const MAX_SAFE_JSON_BYTES = 16 * 1024;

type DesiredState =
  (typeof schema.managedRuntimeInstances.$inferSelect)["desiredState"];
type ObservedState =
  (typeof schema.managedRuntimeInstances.$inferSelect)["observedState"];
type OperationAction =
  (typeof schema.managedRuntimeOperations.$inferSelect)["action"];
type OperationStatus =
  (typeof schema.managedRuntimeOperations.$inferSelect)["status"];
type ConnectionKind =
  (typeof schema.managedRuntimeConnections.$inferSelect)["kind"];
type ConnectionStatus =
  (typeof schema.managedRuntimeConnections.$inferSelect)["status"];
type InstanceRecord = typeof schema.managedRuntimeInstances.$inferSelect;
type OperationRecord = typeof schema.managedRuntimeOperations.$inferSelect;
type ConnectionRecord = typeof schema.managedRuntimeConnections.$inferSelect;
type ProjectRecord = Pick<
  typeof schema.projects.$inferSelect,
  "id" | "organizationId"
>;
type ProjectMembershipRecord = Pick<
  typeof schema.projectMemberships.$inferSelect,
  "role" | "status"
>;

export type ManagedInstanceAggregate = {
  instance: InstanceRecord;
  operations: OperationRecord[];
  connections: ConnectionRecord[];
};

type Actor = {
  id: string;
  type: "anonymous" | "user";
};

type CreateInstanceRepositoryInput = {
  actor: Actor;
  displayName: string;
  idempotencyKey: string;
  organizationId: string;
  placementClass: string;
  projectId: string;
  requestId: string;
  runtimeModel: string | null;
  safeInput: JsonRecord;
};

type EnqueueOperationRepositoryInput = {
  action: Exclude<OperationAction, "create">;
  actor: Actor;
  idempotencyKey: string;
  instanceId: string;
  nextDesiredState: DesiredState;
  organizationId: string;
  projectId: string;
  requestId: string;
  safeInput: JsonRecord;
};

type ClaimOperationRepositoryInput = {
  actions: OperationAction[] | null;
  claimOwner: string;
  claimTtlSeconds: number;
  placement: {
    hostId: string;
    imageId: string;
  } | null;
  now: Date;
};

type ReportOperationRepositoryInput = {
  claimOwner: string;
  connection: {
    credentialRef: string | null;
    kind: ConnectionKind;
    protocolVersion: string;
    safeEndpointRef: string | null;
    status: ConnectionStatus;
  } | null;
  failureCode: string | null;
  observedState: ObservedState | null;
  operationId: string;
  phase: string | null;
  progressPercent: number;
  provisioningPhase: string | null;
  runtimeVersion: string | null;
  safeResult: JsonRecord | null;
  status: Extract<OperationStatus, "running" | "succeeded" | "failed">;
};

export type ManagedInstancesRepository = {
  authorizeProject?: ProjectAuthorizationCheck;
  claimOperation(
    input: ClaimOperationRepositoryInput,
  ): Promise<ManagedInstanceAggregate | null>;
  createInstance(
    input: CreateInstanceRepositoryInput,
  ): Promise<ManagedInstanceAggregate>;
  enqueueOperation(
    input: EnqueueOperationRepositoryInput,
  ): Promise<ManagedInstanceAggregate>;
  findProjectByRef(
    organizationId: string,
    projectRef: string,
  ): Promise<ProjectRecord | null>;
  findProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<ProjectMembershipRecord | null>;
  findOperationByIdempotency(input: {
    action: OperationAction;
    idempotencyKey: string;
    organizationId: string;
  }): Promise<ManagedInstanceAggregate | null>;
  getInstance(input: {
    instanceId: string;
    organizationId: string;
    projectId: string;
  }): Promise<ManagedInstanceAggregate | null>;
  listInstances(input: {
    organizationId: string;
    projectId: string;
  }): Promise<ManagedInstanceAggregate[]>;
  reportOperation(
    input: ReportOperationRepositoryInput,
  ): Promise<ManagedInstanceAggregate>;
};

const idempotencyKeySchema = z.string().trim().regex(IDEMPOTENCY_PATTERN);
const placementClassSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const runtimeModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .nullable()
  .optional();
const createInstanceSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    idempotencyKey: idempotencyKeySchema,
    placementClass: placementClassSchema.default("shared-small"),
    provider: z.literal("codex").default("codex"),
    runtimeModel: runtimeModelSchema,
    sizePreset: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .default("small"),
  })
  .strict();
const enqueueOperationSchema = z
  .object({
    action: z.enum(MUTATION_ACTIONS),
    backupRef: z
      .string()
      .trim()
      .regex(BACKUP_REF_PATTERN)
      .nullable()
      .optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
const claimOperationSchema = z
  .object({
    actions: z
      .array(z.enum(OPERATION_ACTIONS))
      .min(1)
      .max(OPERATION_ACTIONS.length)
      .optional(),
    claimOwner: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    claimTtlSeconds: z.number().int().min(15).max(300).default(60),
    hostId: z.string().uuid().optional(),
    imageId: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.hostId) === Boolean(value.imageId), {
    message: "hostId and imageId must be provided together",
  })
  .strict();
const connectionReportSchema = z
  .object({
    credentialRef: z
      .string()
      .trim()
      .regex(OPAQUE_CREDENTIAL_REF_PATTERN)
      .nullable()
      .optional(),
    kind: z.enum(CONNECTION_KINDS),
    protocolVersion: z.string().trim().min(1).max(40),
    safeEndpointRef: z
      .string()
      .trim()
      .regex(OPAQUE_ENDPOINT_REF_PATTERN)
      .nullable()
      .optional(),
    status: z.enum(CONNECTION_STATUSES),
  })
  .strict();
const reportOperationSchema = z
  .object({
    claimOwner: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    connection: connectionReportSchema.nullable().optional(),
    failureCode: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .nullable()
      .optional(),
    observedState: z.enum(OBSERVED_STATES).nullable().optional(),
    operationId: z.string().uuid(),
    phase: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .nullable()
      .optional(),
    progressPercent: z.number().int().min(0).max(100),
    provisioningPhase: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .nullable()
      .optional(),
    runtimeVersion: z.string().trim().min(1).max(120).nullable().optional(),
    safeResult: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(["running", "succeeded", "failed"]),
  })
  .strict();

export async function listManagedInstances(input: {
  projectRef: string;
  repository?: ManagedInstancesRepository;
  workspace: ConsoleWorkspace;
}) {
  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const project = await requireProject(
    input.workspace,
    input.projectRef,
    "read",
    repository,
  );
  const items = await repository.listInstances({
    organizationId: input.workspace.organization.id,
    projectId: project.id,
  });
  return { version: 1 as const, items: items.map(managedInstanceView) };
}

export async function getManagedInstance(input: {
  instanceId: string;
  projectRef: string;
  repository?: ManagedInstancesRepository;
  workspace: ConsoleWorkspace;
}) {
  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const project = await requireProject(
    input.workspace,
    input.projectRef,
    "read",
    repository,
  );
  const aggregate = await repository.getInstance({
    instanceId: input.instanceId,
    organizationId: input.workspace.organization.id,
    projectId: project.id,
  });
  if (!aggregate)
    throw new ConsoleApiError(404, {
      error: "managed_runtime_instance_not_found",
    });
  return { version: 1 as const, ...managedInstanceView(aggregate) };
}

export async function createManagedInstance(input: {
  body: unknown;
  projectRef: string;
  repository?: ManagedInstancesRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const parsed = parseConsole(createInstanceSchema, input.body);
  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const project = await requireProject(
    input.workspace,
    input.projectRef,
    "write",
    repository,
  );
  const aggregate = await repository.createInstance({
    actor: workspaceActor(input.workspace),
    displayName: parsed.displayName,
    idempotencyKey: parsed.idempotencyKey,
    organizationId: input.workspace.organization.id,
    placementClass: parsed.placementClass,
    projectId: project.id,
    requestId: input.requestId,
    runtimeModel: parsed.runtimeModel ?? null,
    safeInput: { sizePreset: parsed.sizePreset },
  });
  return { version: 1 as const, ...managedInstanceView(aggregate) };
}

export async function enqueueManagedInstanceOperation(input: {
  body: unknown;
  instanceId: string;
  projectRef: string;
  repository?: ManagedInstancesRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const parsed = parseConsole(enqueueOperationSchema, input.body);
  if (parsed.action === "restore" && !parsed.backupRef) {
    throw new ConsoleApiError(400, {
      error: "managed_runtime_backup_ref_required",
    });
  }
  if (parsed.action !== "restore" && parsed.backupRef) {
    throw new ConsoleApiError(400, {
      error: "managed_runtime_backup_ref_not_allowed",
    });
  }

  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const project = await requireProject(
    input.workspace,
    input.projectRef,
    "write",
    repository,
  );
  const current = await repository.getInstance({
    instanceId: input.instanceId,
    organizationId: input.workspace.organization.id,
    projectId: project.id,
  });
  if (!current)
    throw new ConsoleApiError(404, {
      error: "managed_runtime_instance_not_found",
    });

  const replay = await repository.findOperationByIdempotency({
    action: parsed.action,
    idempotencyKey: parsed.idempotencyKey,
    organizationId: input.workspace.organization.id,
  });
  if (replay) {
    if (replay.instance.id !== current.instance.id) {
      throw new ConsoleApiError(409, {
        error: "managed_runtime_idempotency_conflict",
      });
    }
    const replayOperation = replay.operations.find(
      (operation) =>
        operation.action === parsed.action &&
        operation.idempotencyKey === parsed.idempotencyKey,
    );
    const replayBackupRef = replayOperation?.safeInputJson.backupRef;
    if (
      parsed.action === "restore" &&
      replayBackupRef !== parsed.backupRef
    ) {
      throw new ConsoleApiError(409, {
        error: "managed_runtime_idempotency_conflict",
      });
    }
    return { version: 1 as const, ...managedInstanceView(replay) };
  }

  if (
    parsed.action === "restore" &&
    !managedBackupViews(current.operations).some(
      (backup) => backup.backupRef === parsed.backupRef,
    )
  ) {
    throw new ConsoleApiError(404, {
      error: "managed_runtime_backup_not_found",
    });
  }

  const nextDesiredState = desiredStateForAction(
    parsed.action,
    current.instance,
  );
  const safeInput = parsed.action === "retry"
    ? retryOperationSafeInput(current.operations)
    : parsed.backupRef
      ? { backupRef: parsed.backupRef }
      : {};
  const aggregate = await repository.enqueueOperation({
    action: parsed.action,
    actor: workspaceActor(input.workspace),
    idempotencyKey: parsed.idempotencyKey,
    instanceId: current.instance.id,
    nextDesiredState,
    organizationId: input.workspace.organization.id,
    projectId: project.id,
    requestId: input.requestId,
    safeInput,
  });
  return { version: 1 as const, ...managedInstanceView(aggregate) };
}

export async function claimManagedInstanceOperation(input: {
  body: unknown;
  repository?: ManagedInstancesRepository;
}) {
  const parsed = parseInternal(claimOperationSchema, input.body);
  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const aggregate = await repository.claimOperation({
    actions: parsed.actions ?? null,
    claimOwner: parsed.claimOwner,
    claimTtlSeconds: parsed.claimTtlSeconds,
    placement:
      parsed.hostId && parsed.imageId
        ? { hostId: parsed.hostId, imageId: parsed.imageId }
        : null,
    now: new Date(),
  });
  return {
    version: 1 as const,
    claimed: Boolean(aggregate),
    operation: aggregate ? runtimeControlOperationView(aggregate) : null,
  };
}

export async function reportManagedInstanceOperation(input: {
  body: unknown;
  repository?: ManagedInstancesRepository;
}) {
  const parsed = parseInternal(reportOperationSchema, input.body);
  const safeResult = parsed.safeResult
    ? validateSafeRecord(parsed.safeResult)
    : null;
  if (parsed.status === "failed" && !parsed.failureCode) {
    throw new ManagedRuntimeError(400, "managed_runtime_failure_code_required");
  }
  if (parsed.status !== "failed" && parsed.failureCode) {
    throw new ManagedRuntimeError(
      400,
      "managed_runtime_failure_code_not_allowed",
    );
  }
  if (parsed.observedState === "ready") {
    if (
      parsed.status !== "succeeded" ||
      parsed.connection?.kind !== "private_ravi_sdk" ||
      parsed.connection.status !== "online"
    ) {
      throw new ManagedRuntimeError(
        409,
        "managed_runtime_ready_evidence_required",
      );
    }
  }

  const repository = input.repository ?? managedInstancesRepositoryForDb();
  const aggregate = await repository.reportOperation({
    claimOwner: parsed.claimOwner,
    connection: parsed.connection
      ? {
          credentialRef: parsed.connection.credentialRef ?? null,
          kind: parsed.connection.kind,
          protocolVersion: parsed.connection.protocolVersion,
          safeEndpointRef: parsed.connection.safeEndpointRef ?? null,
          status: parsed.connection.status,
        }
      : null,
    failureCode: parsed.failureCode ?? null,
    observedState: parsed.observedState ?? null,
    operationId: parsed.operationId,
    phase: parsed.phase ?? null,
    progressPercent: parsed.progressPercent,
    provisioningPhase: parsed.provisioningPhase ?? null,
    runtimeVersion: parsed.runtimeVersion ?? null,
    safeResult,
    status: parsed.status,
  });
  return {
    version: 1 as const,
    operation: runtimeControlOperationView(aggregate),
  };
}

export function managedInstancesRepositoryForDb(): ManagedInstancesRepository {
  return {
    authorizeProject: canAccessProject,
    async createInstance(input) {
      const findExisting = () =>
        findAggregateByIdempotency(
          input.organizationId,
          "create",
          input.idempotencyKey,
        );
      const existing = await findExisting();
      if (existing) return existing;

      try {
        return await db.transaction(async (tx) => {
          const [instance] = await tx
            .insert(schema.managedRuntimeInstances)
            .values({
              organizationId: input.organizationId,
              projectId: input.projectId,
              displayName: input.displayName,
              desiredState: "running",
              observedState: "provisioning",
              provisioningPhase: "queued",
              runtimeProvider: "codex",
              runtimeModel: input.runtimeModel,
              placementClass: input.placementClass,
              status: "provisioning",
              safeMetadataJson: input.safeInput,
            })
            .returning();
          if (!instance)
            throw new Error("managed_runtime_instance_create_failed");

          const [operation] = await tx
            .insert(schema.managedRuntimeOperations)
            .values({
              organizationId: input.organizationId,
              projectId: input.projectId,
              instanceId: instance.id,
              actorType: input.actor.type,
              actorId: input.actor.id,
              action: "create",
              idempotencyKey: input.idempotencyKey,
              status: "pending",
              phase: "queued",
              progressPercent: 0,
              safeInputJson: input.safeInput,
            })
            .returning();
          if (!operation)
            throw new Error("managed_runtime_operation_create_failed");

          await tx.insert(schema.auditEvents).values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            targetType: "managed_runtime_instance",
            targetId: instance.id,
            action: "managed_runtime.instance.create_requested",
            requestId: input.requestId,
            afterJson: safeInstanceAuditState(instance),
            metadataJson: { operationId: operation.id },
          });
          return { instance, operations: [operation], connections: [] };
        });
      } catch (error) {
        const replay = await findExisting();
        if (replay) return replay;
        throw error;
      }
    },

    async enqueueOperation(input) {
      const findExisting = () =>
        findAggregateByIdempotency(
          input.organizationId,
          input.action,
          input.idempotencyKey,
        );
      const existing = await findExisting();
      if (existing) {
        if (existing.instance.id !== input.instanceId) {
          throw new ConsoleApiError(409, {
            error: "managed_runtime_idempotency_conflict",
          });
        }
        return existing;
      }

      try {
        return await db.transaction(async (tx) => {
          const [before] = await tx
            .select()
            .from(schema.managedRuntimeInstances)
            .where(
              and(
                eq(schema.managedRuntimeInstances.id, input.instanceId),
                eq(
                  schema.managedRuntimeInstances.organizationId,
                  input.organizationId,
                ),
                eq(schema.managedRuntimeInstances.projectId, input.projectId),
              ),
            )
            .limit(1)
            .for("update");
          if (!before)
            throw new ConsoleApiError(404, {
              error: "managed_runtime_instance_not_found",
            });

          const [instance] = await tx
            .update(schema.managedRuntimeInstances)
            .set({
              desiredState: input.nextDesiredState,
              updatedAt: new Date(),
            })
            .where(eq(schema.managedRuntimeInstances.id, before.id))
            .returning();
          if (!instance)
            throw new Error("managed_runtime_instance_update_failed");

          const [operation] = await tx
            .insert(schema.managedRuntimeOperations)
            .values({
              organizationId: input.organizationId,
              projectId: input.projectId,
              instanceId: instance.id,
              actorType: input.actor.type,
              actorId: input.actor.id,
              action: input.action,
              idempotencyKey: input.idempotencyKey,
              status: "pending",
              phase: "queued",
              progressPercent: 0,
              safeInputJson: input.safeInput,
            })
            .returning();
          if (!operation)
            throw new Error("managed_runtime_operation_create_failed");

          await tx.insert(schema.auditEvents).values({
            organizationId: input.organizationId,
            projectId: input.projectId,
            actorType: input.actor.type,
            actorId: input.actor.id,
            targetType: "managed_runtime_instance",
            targetId: instance.id,
            action: `managed_runtime.instance.${input.action}_requested`,
            requestId: input.requestId,
            beforeJson: safeInstanceAuditState(before),
            afterJson: safeInstanceAuditState(instance),
            metadataJson: { operationId: operation.id },
          });
          const connections = await tx
            .select()
            .from(schema.managedRuntimeConnections)
            .where(
              eq(schema.managedRuntimeConnections.instanceId, instance.id),
            );
          const operations = await tx
            .select()
            .from(schema.managedRuntimeOperations)
            .where(eq(schema.managedRuntimeOperations.instanceId, instance.id))
            .orderBy(desc(schema.managedRuntimeOperations.createdAt));
          return { instance, operations, connections };
        });
      } catch (error) {
        const replay = await findExisting();
        if (replay) return replay;
        throw error;
      }
    },

    async findProjectByRef(organizationId, projectRef) {
      const refPredicate = isUuidRef(projectRef)
        ? or(
            eq(schema.projects.id, projectRef),
            eq(schema.projects.slug, projectRef),
          )
        : eq(schema.projects.slug, projectRef);
      const [project] = await db
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
        })
        .from(schema.projects)
        .where(
          and(eq(schema.projects.organizationId, organizationId), refPredicate),
        )
        .limit(1);
      return project ?? null;
    },

    async findProjectMembership(projectId, userId) {
      const [membership] = await db
        .select({
          role: schema.projectMemberships.role,
          status: schema.projectMemberships.status,
        })
        .from(schema.projectMemberships)
        .where(
          and(
            eq(schema.projectMemberships.projectId, projectId),
            eq(schema.projectMemberships.userId, userId),
            eq(schema.projectMemberships.status, "active"),
          ),
        )
        .limit(1);
      return membership ?? null;
    },

    async findOperationByIdempotency(input) {
      return findAggregateByIdempotency(
        input.organizationId,
        input.action,
        input.idempotencyKey,
      );
    },

    async listInstances(input) {
      const instances = await db
        .select()
        .from(schema.managedRuntimeInstances)
        .where(
          and(
            eq(
              schema.managedRuntimeInstances.organizationId,
              input.organizationId,
            ),
            eq(schema.managedRuntimeInstances.projectId, input.projectId),
          ),
        )
        .orderBy(desc(schema.managedRuntimeInstances.updatedAt));
      return hydrateAggregates(instances);
    },

    async getInstance(input) {
      const [instance] = await db
        .select()
        .from(schema.managedRuntimeInstances)
        .where(
          and(
            eq(schema.managedRuntimeInstances.id, input.instanceId),
            eq(
              schema.managedRuntimeInstances.organizationId,
              input.organizationId,
            ),
            eq(schema.managedRuntimeInstances.projectId, input.projectId),
          ),
        )
        .limit(1);
      if (!instance) return null;
      return (await hydrateAggregates([instance]))[0] ?? null;
    },

    async claimOperation(input) {
      return db.transaction(async (tx) => {
        const eligible = or(
          eq(schema.managedRuntimeOperations.status, "pending"),
          and(
            inArray(schema.managedRuntimeOperations.status, [
              "claimed",
              "running",
            ]),
            lte(schema.managedRuntimeOperations.claimExpiresAt, input.now),
          ),
        );
        const actionPredicate = input.actions?.length
          ? inArray(schema.managedRuntimeOperations.action, input.actions)
          : undefined;
        const placementPredicate = input.placement
          ? or(
              and(
                isNull(schema.managedRuntimeInstances.hostId),
                isNull(schema.managedRuntimeInstances.imageId),
                inArray(schema.managedRuntimeOperations.action, [
                  "create",
                  "retry",
                  "delete",
                ]),
              ),
              and(
                eq(
                  schema.managedRuntimeInstances.hostId,
                  input.placement.hostId,
                ),
                or(
                  eq(
                    schema.managedRuntimeInstances.imageId,
                    input.placement.imageId,
                  ),
                  inArray(
                    schema.managedRuntimeOperations.action,
                    HOST_BOUND_MAINTENANCE_ACTIONS,
                  ),
                ),
              ),
            )
          : undefined;
        const [candidate] = await tx
          .select({
            attemptCount: schema.managedRuntimeOperations.attemptCount,
            id: schema.managedRuntimeOperations.id,
          })
          .from(schema.managedRuntimeOperations)
          .innerJoin(
            schema.managedRuntimeInstances,
            eq(
              schema.managedRuntimeInstances.id,
              schema.managedRuntimeOperations.instanceId,
            ),
          )
          .where(and(eligible, actionPredicate, placementPredicate))
          .orderBy(asc(schema.managedRuntimeOperations.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!candidate) return null;

        const claimExpiresAt = new Date(
          input.now.getTime() + input.claimTtlSeconds * 1000,
        );
        const [claimed] = await tx
          .update(schema.managedRuntimeOperations)
          .set({
            attemptCount: candidate.attemptCount + 1,
            claimExpiresAt,
            claimOwner: input.claimOwner,
            status: "claimed",
            updatedAt: input.now,
          })
          .where(eq(schema.managedRuntimeOperations.id, candidate.id))
          .returning();
        if (!claimed)
          throw new ManagedRuntimeError(
            409,
            "managed_runtime_operation_claim_failed",
          );
        const [currentInstance] = await tx
          .select()
          .from(schema.managedRuntimeInstances)
          .where(eq(schema.managedRuntimeInstances.id, claimed.instanceId))
          .limit(1);
        if (!currentInstance)
          throw new ManagedRuntimeError(
            409,
            "managed_runtime_instance_missing",
          );
        let instance = currentInstance;
        if (input.placement) {
          const [host] = await tx
            .select({ id: schema.runtimeHosts.id })
            .from(schema.runtimeHosts)
            .where(
              and(
                eq(schema.runtimeHosts.id, input.placement.hostId),
                eq(schema.runtimeHosts.status, "active"),
              ),
            )
            .limit(1);
          if (!host) {
            throw new ManagedRuntimeError(
              409,
              "managed_runtime_placement_host_unavailable",
            );
          }

          const [image] = await tx
            .select({
              id: schema.runtimeImages.id,
              providerSupportJson: schema.runtimeImages.providerSupportJson,
            })
            .from(schema.runtimeImages)
            .where(
              and(
                eq(schema.runtimeImages.id, input.placement.imageId),
                eq(schema.runtimeImages.status, "active"),
              ),
            )
            .limit(1);
          if (!image || image.providerSupportJson.codex !== true) {
            throw new ManagedRuntimeError(
              409,
              "managed_runtime_placement_image_unavailable",
            );
          }
          const provisioningClaim =
            claimed.action === "create" || claimed.action === "retry";
          if (
            (currentInstance.hostId &&
              currentInstance.hostId !== input.placement.hostId) ||
            (provisioningClaim &&
              currentInstance.imageId &&
              currentInstance.imageId !== input.placement.imageId)
          ) {
            throw new ManagedRuntimeError(
              409,
              "managed_runtime_placement_conflict",
            );
          }

          if (
            provisioningClaim &&
            !currentInstance.hostId &&
            !currentInstance.imageId
          ) {
            const [placed] = await tx
              .update(schema.managedRuntimeInstances)
              .set({
                hostId: input.placement.hostId,
                imageId: input.placement.imageId,
                updatedAt: input.now,
              })
              .where(eq(schema.managedRuntimeInstances.id, currentInstance.id))
              .returning();
            if (!placed) {
              throw new ManagedRuntimeError(
                409,
                "managed_runtime_placement_failed",
              );
            }
            instance = placed;
          } else if (
            Boolean(currentInstance.hostId) !== Boolean(currentInstance.imageId)
          ) {
            throw new ManagedRuntimeError(
              409,
              "managed_runtime_placement_conflict",
            );
          }
        }
        const connections = await tx
          .select()
          .from(schema.managedRuntimeConnections)
          .where(eq(schema.managedRuntimeConnections.instanceId, instance.id));
        return { instance, operations: [claimed], connections };
      });
    },

    async reportOperation(input) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [operation] = await tx
          .select()
          .from(schema.managedRuntimeOperations)
          .where(eq(schema.managedRuntimeOperations.id, input.operationId))
          .limit(1)
          .for("update");
        if (!operation)
          throw new ManagedRuntimeError(
            404,
            "managed_runtime_operation_not_found",
          );
        assertClaimCanReport(operation, input, now);

        const nextProgress =
          input.status === "succeeded" ? 100 : input.progressPercent;
        const [updatedOperation] = await tx
          .update(schema.managedRuntimeOperations)
          .set({
            claimExpiresAt:
              input.status === "running"
                ? new Date(now.getTime() + 60_000)
                : null,
            completedAt: input.status === "running" ? null : now,
            failureCode: input.failureCode,
            phase: input.phase,
            progressPercent: nextProgress,
            safeResultJson: input.safeResult,
            startedAt: operation.startedAt ?? now,
            status: input.status,
            updatedAt: now,
          })
          .where(eq(schema.managedRuntimeOperations.id, operation.id))
          .returning();
        if (!updatedOperation)
          throw new ManagedRuntimeError(
            409,
            "managed_runtime_operation_report_failed",
          );

        const instanceUpdate: Partial<
          typeof schema.managedRuntimeInstances.$inferInsert
        > = {
          ...(input.failureCode !== null
            ? { failureCode: input.failureCode }
            : {}),
          ...(input.observedState !== null
            ? {
                observedState: input.observedState,
                status: legacyStatusForObservedState(input.observedState),
              }
            : {}),
          ...(input.provisioningPhase !== null
            ? { provisioningPhase: input.provisioningPhase }
            : {}),
          ...(input.runtimeVersion !== null
            ? { runtimeVersion: input.runtimeVersion }
            : {}),
          updatedAt: now,
        };
        if (input.status === "succeeded") instanceUpdate.failureCode = null;
        const [instance] = await tx
          .update(schema.managedRuntimeInstances)
          .set(instanceUpdate)
          .where(eq(schema.managedRuntimeInstances.id, operation.instanceId))
          .returning();
        if (!instance)
          throw new ManagedRuntimeError(
            409,
            "managed_runtime_instance_update_failed",
          );

        if (input.connection) {
          await tx
            .insert(schema.managedRuntimeConnections)
            .values({
              organizationId: operation.organizationId,
              instanceId: operation.instanceId,
              kind: input.connection.kind,
              status: input.connection.status,
              protocolVersion: input.connection.protocolVersion,
              safeEndpointRef: input.connection.safeEndpointRef,
              credentialRef: input.connection.credentialRef,
              lastConnectedAt:
                input.connection.status === "online" ? now : null,
              lastHeartbeatAt: now,
              revokedAt: input.connection.status === "revoked" ? now : null,
            })
            .onConflictDoUpdate({
              target: [
                schema.managedRuntimeConnections.instanceId,
                schema.managedRuntimeConnections.kind,
              ],
              set: {
                status: input.connection.status,
                protocolVersion: input.connection.protocolVersion,
                safeEndpointRef: input.connection.safeEndpointRef,
                credentialRef: input.connection.credentialRef,
                lastConnectedAt:
                  input.connection.status === "online" ? now : undefined,
                lastHeartbeatAt: now,
                revokedAt: input.connection.status === "revoked" ? now : null,
                updatedAt: now,
              },
            });
        }

        if (input.status !== "running") {
          await tx.insert(schema.auditEvents).values({
            organizationId: operation.organizationId,
            projectId: operation.projectId,
            actorType: "system",
            actorId: input.claimOwner,
            targetType: "managed_runtime_operation",
            targetId: operation.id,
            action: `managed_runtime.operation.${input.status}`,
            metadataJson: {
              action: operation.action,
              failureCode: input.failureCode,
              instanceId: operation.instanceId,
            },
          });
        }

        const operations = await tx
          .select()
          .from(schema.managedRuntimeOperations)
          .where(eq(schema.managedRuntimeOperations.instanceId, instance.id))
          .orderBy(desc(schema.managedRuntimeOperations.createdAt));
        const connections = await tx
          .select()
          .from(schema.managedRuntimeConnections)
          .where(eq(schema.managedRuntimeConnections.instanceId, instance.id));
        return { instance, operations, connections };
      });
    },
  };
}

function parseConsole<T extends z.ZodTypeAny>(
  schemaDef: T,
  body: unknown,
): z.infer<T> {
  const result = schemaDef.safeParse(body);
  if (!result.success)
    throw new ConsoleApiError(400, {
      error: "managed_runtime_payload_invalid",
    });
  return result.data;
}

function parseInternal<T extends z.ZodTypeAny>(
  schemaDef: T,
  body: unknown,
): z.infer<T> {
  const result = schemaDef.safeParse(body);
  if (!result.success)
    throw new ManagedRuntimeError(400, "managed_runtime_payload_invalid");
  return result.data;
}

async function requireProject(
  workspace: ConsoleWorkspace,
  projectRef: string,
  action: "read" | "write",
  repository: ManagedInstancesRepository,
) {
  const project = await repository.findProjectByRef(
    workspace.organization.id,
    projectRef,
  );
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  if (await repository.authorizeProject?.(workspace, project.id, action)) {
    return project;
  }
  throw new ConsoleApiError(403, { error: "project_forbidden" });
}

function workspaceActor(workspace: ConsoleWorkspace): Actor {
  return {
    id: workspace.user.id,
    type: workspace.mode === "anonymous" ? "anonymous" : "user",
  };
}

function desiredStateForAction(
  action: Exclude<OperationAction, "create">,
  instance: InstanceRecord,
): DesiredState {
  if (
    instance.observedState === "deleted" ||
    (instance.desiredState === "deleted" && action !== "delete")
  ) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_instance_deleted",
    });
  }
  if (action === "start") {
    if (instance.desiredState === "running")
      throw new ConsoleApiError(409, {
        error: "managed_runtime_already_running",
      });
    return "running";
  }
  if (action === "stop") {
    if (instance.desiredState === "stopped")
      throw new ConsoleApiError(409, {
        error: "managed_runtime_already_stopped",
      });
    return "stopped";
  }
  if (action === "delete") return "deleted";
  if (action === "restore" && instance.observedState !== "stopped") {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_restore_requires_stopped",
    });
  }
  if (
    action === "backup" &&
    instance.observedState !== "ready" &&
    instance.observedState !== "stopped"
  ) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_backup_state_invalid",
    });
  }
  if (
    action === "retry" &&
    instance.observedState !== "failed" &&
    instance.observedState !== "degraded"
  ) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_retry_state_invalid",
    });
  }
  return instance.desiredState;
}

function retryOperationSafeInput(operations: OperationRecord[]): JsonRecord {
  const resolution = resolveManagedRuntimeRetrySafeInput(operations);
  if (!resolution.ok) {
    throw new ConsoleApiError(409, { error: resolution.error });
  }
  return resolution.safeInput;
}

function managedInstanceView(aggregate: ManagedInstanceAggregate) {
  const latestOperation =
    [...aggregate.operations].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0] ?? null;
  return {
    instance: {
      id: aggregate.instance.id,
      projectId: aggregate.instance.projectId,
      displayName: aggregate.instance.displayName,
      desiredState: aggregate.instance.desiredState,
      observedState: aggregate.instance.observedState,
      provisioningPhase: aggregate.instance.provisioningPhase,
      failureCode: aggregate.instance.failureCode,
      runtimeProvider: aggregate.instance.runtimeProvider,
      runtimeModel: aggregate.instance.runtimeModel,
      runtimeVersion: aggregate.instance.runtimeVersion,
      placementClass: aggregate.instance.placementClass,
      lastHeartbeatAt:
        aggregate.instance.lastHeartbeatAt?.toISOString() ?? null,
      createdAt: aggregate.instance.createdAt.toISOString(),
      updatedAt: aggregate.instance.updatedAt.toISOString(),
    },
    latestOperation: latestOperation
      ? publicOperationView(latestOperation)
      : null,
    connections: aggregate.connections.map(publicConnectionView),
    backups: managedBackupViews(aggregate.operations),
  };
}

const managedBackupProjectionSchema = z
  .object({
    backupRef: z.string().regex(BACKUP_REF_PATTERN),
    contentDigest: z.string().regex(CONTENT_DIGEST_PATTERN),
    createdAt: z.string().datetime({ offset: true }),
    sizeBytes: z.number().int().nonnegative(),
    sourceVmId: z.string().trim().min(1).max(160).regex(SAFE_REF_PATTERN),
  })
  .strict();

function managedBackupViews(operations: OperationRecord[]) {
  return operations
    .flatMap((operation) => {
      if (operation.action !== "backup" || operation.status !== "succeeded") {
        return [];
      }
      const result = operation.safeResultJson;
      const parsed = managedBackupProjectionSchema.safeParse(result?.backup);
      const expectedRef = `mbk_${operation.id.replaceAll("-", "").toLowerCase()}`;
      if (!parsed.success || parsed.data.backupRef !== expectedRef) return [];
      return [{ ...parsed.data, operationId: operation.id }];
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function publicOperationView(operation: OperationRecord) {
  return {
    id: operation.id,
    action: operation.action,
    status: operation.status,
    phase: operation.phase,
    progressPercent: operation.progressPercent,
    attemptCount: operation.attemptCount,
    failureCode: operation.failureCode,
    startedAt: operation.startedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

function publicConnectionView(connection: ConnectionRecord) {
  return {
    id: connection.id,
    kind: connection.kind,
    status: connection.status,
    protocolVersion: connection.protocolVersion,
    lastConnectedAt: connection.lastConnectedAt?.toISOString() ?? null,
    lastHeartbeatAt: connection.lastHeartbeatAt?.toISOString() ?? null,
    revokedAt: connection.revokedAt?.toISOString() ?? null,
  };
}

function runtimeControlOperationView(aggregate: ManagedInstanceAggregate) {
  const operation = aggregate.operations[0];
  if (!operation)
    throw new ManagedRuntimeError(409, "managed_runtime_operation_missing");
  return {
    id: operation.id,
    organizationId: operation.organizationId,
    projectId: operation.projectId,
    instanceId: operation.instanceId,
    action: operation.action,
    status: operation.status,
    phase: operation.phase,
    progressPercent: operation.progressPercent,
    attemptCount: operation.attemptCount,
    claimExpiresAt: operation.claimExpiresAt?.toISOString() ?? null,
    safeInput: operation.safeInputJson,
    instance: {
      displayName: aggregate.instance.displayName,
      desiredState: aggregate.instance.desiredState,
      observedState: aggregate.instance.observedState,
      placementClass: aggregate.instance.placementClass,
      runtimeProvider: aggregate.instance.runtimeProvider,
      runtimeModel: aggregate.instance.runtimeModel,
      imageId: aggregate.instance.imageId,
      hostId: aggregate.instance.hostId,
    },
  };
}

async function hydrateAggregates(
  instances: InstanceRecord[],
): Promise<ManagedInstanceAggregate[]> {
  if (instances.length === 0) return [];
  const ids = instances.map((instance) => instance.id);
  const [operations, connections] = await Promise.all([
    db
      .select()
      .from(schema.managedRuntimeOperations)
      .where(inArray(schema.managedRuntimeOperations.instanceId, ids))
      .orderBy(desc(schema.managedRuntimeOperations.createdAt)),
    db
      .select()
      .from(schema.managedRuntimeConnections)
      .where(inArray(schema.managedRuntimeConnections.instanceId, ids)),
  ]);
  return instances.map((instance) => ({
    instance,
    operations: operations.filter(
      (operation) => operation.instanceId === instance.id,
    ),
    connections: connections.filter(
      (connection) => connection.instanceId === instance.id,
    ),
  }));
}

async function findAggregateByIdempotency(
  organizationId: string,
  action: OperationAction,
  idempotencyKey: string,
) {
  const [operation] = await db
    .select()
    .from(schema.managedRuntimeOperations)
    .where(
      and(
        eq(schema.managedRuntimeOperations.organizationId, organizationId),
        eq(schema.managedRuntimeOperations.action, action),
        eq(schema.managedRuntimeOperations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!operation) return null;
  const [instance] = await db
    .select()
    .from(schema.managedRuntimeInstances)
    .where(eq(schema.managedRuntimeInstances.id, operation.instanceId))
    .limit(1);
  if (!instance) return null;
  const connections = await db
    .select()
    .from(schema.managedRuntimeConnections)
    .where(eq(schema.managedRuntimeConnections.instanceId, instance.id));
  const operations = await db
    .select()
    .from(schema.managedRuntimeOperations)
    .where(eq(schema.managedRuntimeOperations.instanceId, instance.id))
    .orderBy(desc(schema.managedRuntimeOperations.createdAt));
  return { instance, operations, connections };
}

function assertClaimCanReport(
  operation: OperationRecord,
  input: ReportOperationRepositoryInput,
  now: Date,
) {
  if (TERMINAL_OPERATION_STATUSES.has(operation.status)) {
    throw new ManagedRuntimeError(409, "managed_runtime_operation_terminal");
  }
  if (operation.claimOwner !== input.claimOwner) {
    throw new ManagedRuntimeError(
      409,
      "managed_runtime_operation_claim_owner_mismatch",
    );
  }
  if (!operation.claimExpiresAt || operation.claimExpiresAt <= now) {
    throw new ManagedRuntimeError(
      409,
      "managed_runtime_operation_claim_expired",
    );
  }
  if (input.progressPercent < (operation.progressPercent ?? 0)) {
    throw new ManagedRuntimeError(
      409,
      "managed_runtime_operation_progress_regressed",
    );
  }
  if (input.status === "succeeded" && input.progressPercent < 100) {
    throw new ManagedRuntimeError(
      409,
      "managed_runtime_operation_success_incomplete",
    );
  }
}

function validateSafeRecord(value: Record<string, unknown>): JsonRecord {
  const encoded = JSON.stringify(value);
  if (
    Buffer.byteLength(encoded, "utf8") > MAX_SAFE_JSON_BYTES ||
    hasSensitiveKey(value)
  ) {
    throw new ManagedRuntimeError(400, "managed_runtime_safe_result_invalid");
  }
  return value as JsonRecord;
}

function hasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => SENSITIVE_KEY_PATTERN.test(key) || hasSensitiveKey(child),
  );
}

function safeInstanceAuditState(instance: InstanceRecord): JsonRecord {
  return {
    desiredState: instance.desiredState,
    observedState: instance.observedState,
    placementClass: instance.placementClass,
    runtimeProvider: instance.runtimeProvider,
  };
}

function legacyStatusForObservedState(
  state: ObservedState,
): InstanceRecord["status"] {
  if (state === "ready") return "active";
  if (state === "degraded" || state === "failed") return "degraded";
  if (state === "stopping" || state === "deleting") return "draining";
  if (state === "stopped") return "disabled";
  if (state === "deleted") return "deleted";
  return "provisioning";
}
