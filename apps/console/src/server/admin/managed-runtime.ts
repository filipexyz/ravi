import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  resolveManagedRuntimeRetrySafeInput,
  type ManagedRuntimeRetryResolution,
} from "@/server/console/managed-runtime-retry";

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const rotateControllerBodySchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    instanceId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const enqueueOperationBodySchema = z
  .object({
    action: z.enum(["start", "stop", "restart", "retry"]),
    idempotencyKey: idempotencyKeySchema,
    instanceId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

type AdminOperationAction = "restart" | "retry" | "rotate_controller" | "start" | "stop";

type InstanceAuthority = {
  desiredState: "running" | "stopped" | "deleted";
  id: string;
  observedState: string;
  organizationId: string;
  projectId: string | null;
};

type AdminOperation = {
  action: AdminOperationAction;
  id: string;
  idempotencyKey: string;
  instanceId: string;
  status: string;
};

export type AdminManagedRuntimeRepository = {
  enqueueOperation(input: {
    action: AdminOperationAction;
    idempotencyKey: string;
    instance: InstanceAuthority;
    reason: string;
    requestId: string;
    safeInput: JsonRecord;
  }): Promise<{ operation: AdminOperation; replayed: boolean }>;
  findInstance(instanceId: string): Promise<InstanceAuthority | null>;
  findOperation(input: {
    action: AdminOperationAction;
    idempotencyKey: string;
    organizationId: string;
  }): Promise<AdminOperation | null>;
  resolveRetrySafeInput(instanceId: string): Promise<ManagedRuntimeRetryResolution>;
};

export async function rotateAdminManagedRuntimeController(input: {
  body: unknown;
  repository?: AdminManagedRuntimeRepository;
  requestId: string;
}) {
  const body = parseRotateControllerBody(input.body);
  const repository = input.repository ?? adminManagedRuntimeRepositoryForDb();
  const instance = await repository.findInstance(body.instanceId);
  if (!instance) {
    return { status: "not_found" as const, code: "managed_runtime_instance_not_found" };
  }
  if (instance.desiredState === "deleted" || instance.observedState === "deleted") {
    return { status: "blocked" as const, code: "managed_runtime_instance_deleted" };
  }
  if (!instance.projectId) {
    return { status: "blocked" as const, code: "managed_runtime_project_binding_missing" };
  }

  const result = await repository.enqueueOperation({
    action: "rotate_controller",
    idempotencyKey: body.idempotencyKey,
    instance,
    reason: body.reason,
    requestId: input.requestId,
    safeInput: {},
  });
  return {
    status: "ok" as const,
    instance: {
      id: instance.id,
      observedState: instance.observedState,
      projectId: instance.projectId,
    },
    operation: result.operation,
    replayed: result.replayed,
  };
}

export async function enqueueAdminManagedRuntimeOperation(input: {
  body: unknown;
  repository?: AdminManagedRuntimeRepository;
  requestId: string;
}) {
  const body = parseEnqueueOperationBody(input.body);
  const repository = input.repository ?? adminManagedRuntimeRepositoryForDb();
  const instance = await repository.findInstance(body.instanceId);
  if (!instance) {
    return { status: "not_found" as const, code: "managed_runtime_instance_not_found" };
  }
  if (instance.desiredState === "deleted" || instance.observedState === "deleted") {
    return { status: "blocked" as const, code: "managed_runtime_instance_deleted" };
  }
  if (!instance.projectId) {
    return { status: "blocked" as const, code: "managed_runtime_project_binding_missing" };
  }
  const existing = await repository.findOperation({
    action: body.action,
    idempotencyKey: body.idempotencyKey,
    organizationId: instance.organizationId,
  });
  if (existing) {
    if (existing.instanceId !== instance.id) {
      throw adminManagedRuntimeError("managed_runtime_idempotency_conflict");
    }
    return {
      status: "ok" as const,
      instance: {
        id: instance.id,
        observedState: instance.observedState,
        projectId: instance.projectId,
      },
      operation: existing,
      replayed: true,
    };
  }
  if (body.action === "start" && instance.desiredState === "running") {
    return { status: "blocked" as const, code: "managed_runtime_already_running" };
  }
  if (body.action === "stop" && instance.desiredState === "stopped") {
    return { status: "blocked" as const, code: "managed_runtime_already_stopped" };
  }
  if (body.action === "retry" && !new Set(["degraded", "failed"]).has(instance.observedState)) {
    return { status: "blocked" as const, code: "managed_runtime_retry_state_invalid" };
  }
  const retryResolution = body.action === "retry"
    ? await repository.resolveRetrySafeInput(instance.id)
    : { ok: true as const, safeInput: {} };
  if (!retryResolution.ok) {
    throw adminManagedRuntimeError(retryResolution.error);
  }

  const result = await repository.enqueueOperation({
    action: body.action,
    idempotencyKey: body.idempotencyKey,
    instance,
    reason: body.reason,
    requestId: input.requestId,
    safeInput: retryResolution.safeInput,
  });
  return {
    status: "ok" as const,
    instance: {
      id: instance.id,
      observedState: instance.observedState,
      projectId: instance.projectId,
    },
    operation: result.operation,
    replayed: result.replayed,
  };
}

export function parseRotateControllerBody(body: unknown) {
  const result = rotateControllerBodySchema.safeParse(body);
  if (!result.success) {
    const error = new Error("invalid_body");
    error.name = "AdminManagedRuntimeError";
    throw error;
  }
  return result.data;
}

export function parseEnqueueOperationBody(body: unknown) {
  const result = enqueueOperationBodySchema.safeParse(body);
  if (!result.success) throw adminManagedRuntimeError("invalid_body");
  return result.data;
}

function adminManagedRuntimeRepositoryForDb(): AdminManagedRuntimeRepository {
  return {
    async findInstance(instanceId) {
      const [instance] = await db
        .select({
          desiredState: schema.managedRuntimeInstances.desiredState,
          id: schema.managedRuntimeInstances.id,
          observedState: schema.managedRuntimeInstances.observedState,
          organizationId: schema.managedRuntimeInstances.organizationId,
          projectId: schema.managedRuntimeInstances.projectId,
        })
        .from(schema.managedRuntimeInstances)
        .where(eq(schema.managedRuntimeInstances.id, instanceId))
        .limit(1);
      return instance ?? null;
    },

    async findOperation(input) {
      const [operation] = await db
        .select({
          action: schema.managedRuntimeOperations.action,
          id: schema.managedRuntimeOperations.id,
          idempotencyKey: schema.managedRuntimeOperations.idempotencyKey,
          instanceId: schema.managedRuntimeOperations.instanceId,
          status: schema.managedRuntimeOperations.status,
        })
        .from(schema.managedRuntimeOperations)
        .where(
          and(
            eq(schema.managedRuntimeOperations.organizationId, input.organizationId),
            eq(schema.managedRuntimeOperations.action, input.action),
            eq(schema.managedRuntimeOperations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return operation ? adminOperationView(operation) : null;
    },

    async resolveRetrySafeInput(instanceId) {
      const operations = await db
        .select({
          action: schema.managedRuntimeOperations.action,
          createdAt: schema.managedRuntimeOperations.createdAt,
          id: schema.managedRuntimeOperations.id,
          safeInputJson: schema.managedRuntimeOperations.safeInputJson,
          status: schema.managedRuntimeOperations.status,
        })
        .from(schema.managedRuntimeOperations)
        .where(
          and(
            eq(schema.managedRuntimeOperations.instanceId, instanceId),
            eq(schema.managedRuntimeOperations.status, "failed"),
          ),
        )
        .orderBy(desc(schema.managedRuntimeOperations.createdAt))
        .limit(1);
      return resolveManagedRuntimeRetrySafeInput(operations);
    },

    async enqueueOperation(input) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            desiredState: schema.managedRuntimeInstances.desiredState,
            id: schema.managedRuntimeInstances.id,
            observedState: schema.managedRuntimeInstances.observedState,
            organizationId: schema.managedRuntimeInstances.organizationId,
            projectId: schema.managedRuntimeInstances.projectId,
          })
          .from(schema.managedRuntimeInstances)
          .where(eq(schema.managedRuntimeInstances.id, input.instance.id))
          .limit(1)
          .for("update");
        if (!current) throw adminManagedRuntimeError("managed_runtime_instance_not_found");
        if (current.desiredState === "deleted" || current.observedState === "deleted") {
          throw adminManagedRuntimeError("managed_runtime_instance_deleted");
        }
        if (!current.projectId) {
          throw adminManagedRuntimeError("managed_runtime_project_binding_missing");
        }
        const [existing] = await tx
          .select({
            action: schema.managedRuntimeOperations.action,
            id: schema.managedRuntimeOperations.id,
            idempotencyKey: schema.managedRuntimeOperations.idempotencyKey,
            instanceId: schema.managedRuntimeOperations.instanceId,
            status: schema.managedRuntimeOperations.status,
          })
          .from(schema.managedRuntimeOperations)
          .where(
            and(
              eq(schema.managedRuntimeOperations.organizationId, current.organizationId),
              eq(schema.managedRuntimeOperations.action, input.action),
              eq(schema.managedRuntimeOperations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.instanceId !== current.id) {
            throw adminManagedRuntimeError("managed_runtime_idempotency_conflict");
          }
          return { operation: adminOperationView(existing), replayed: true };
        }
        if (input.action === "start" && current.desiredState === "running") {
          throw adminManagedRuntimeError("managed_runtime_already_running");
        }
        if (input.action === "stop" && current.desiredState === "stopped") {
          throw adminManagedRuntimeError("managed_runtime_already_stopped");
        }
        if (input.action === "retry" && !new Set(["degraded", "failed"]).has(current.observedState)) {
          throw adminManagedRuntimeError("managed_runtime_retry_state_invalid");
        }

        const nextDesiredState = input.action === "start"
          ? "running"
          : input.action === "stop"
            ? "stopped"
            : current.desiredState;
        if (current.desiredState !== nextDesiredState) {
          await tx
            .update(schema.managedRuntimeInstances)
            .set({ desiredState: nextDesiredState, updatedAt: new Date() })
            .where(eq(schema.managedRuntimeInstances.id, current.id));
        }

        const [operation] = await tx
          .insert(schema.managedRuntimeOperations)
          .values({
            action: input.action,
            actorId: null,
            actorType: "system",
            idempotencyKey: input.idempotencyKey,
            instanceId: current.id,
            organizationId: current.organizationId,
            phase: "queued",
            progressPercent: 0,
            projectId: current.projectId,
            safeInputJson: input.safeInput,
            status: "pending",
          })
          .returning({
            action: schema.managedRuntimeOperations.action,
            id: schema.managedRuntimeOperations.id,
            idempotencyKey: schema.managedRuntimeOperations.idempotencyKey,
            instanceId: schema.managedRuntimeOperations.instanceId,
            status: schema.managedRuntimeOperations.status,
          });
        if (!operation) throw new Error("managed_runtime_admin_operation_create_failed");

        await tx.insert(schema.auditEvents).values({
          action: input.action === "rotate_controller"
            ? "admin.managed_runtime.controller_rotation_requested"
            : `admin.managed_runtime.${input.action}_requested`,
          actorId: null,
          actorType: "system",
          metadataJson: {
            operationId: operation.id,
            reason: input.reason,
            source: "admin_control",
          },
          organizationId: current.organizationId,
          projectId: current.projectId,
          requestId: input.requestId,
          targetId: current.id,
          targetType: "managed_runtime_instance",
        });

        return { operation: adminOperationView(operation), replayed: false };
      });
    },
  };
}

function adminOperationView(input: {
  action: string;
  id: string;
  idempotencyKey: string;
  instanceId: string;
  status: string;
}): AdminOperation {
  if (!new Set<AdminOperationAction>(["restart", "retry", "rotate_controller", "start", "stop"]).has(input.action as AdminOperationAction)) {
    throw adminManagedRuntimeError("managed_runtime_operation_action_invalid");
  }
  return {
    action: input.action as AdminOperationAction,
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    instanceId: input.instanceId,
    status: input.status,
  };
}

function adminManagedRuntimeError(code: string) {
  const error = new Error(code);
  error.name = "AdminManagedRuntimeError";
  return error;
}
