import { describe, expect, test } from "bun:test";

import {
  enqueueAdminManagedRuntimeOperation,
  rotateAdminManagedRuntimeController,
  type AdminManagedRuntimeRepository,
} from "./managed-runtime";

const INSTANCE_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";

describe("admin managed runtime controller rotation", () => {
  test("queues an audited controller rotation through the operation ledger", async () => {
    const calls: unknown[] = [];
    const result = await rotateAdminManagedRuntimeController({
      body: validBody(),
      repository: repositoryForTest(calls),
      requestId: "request-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      replayed: false,
      operation: {
        action: "rotate_controller",
        instanceId: INSTANCE_ID,
        status: "pending",
      },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        idempotencyKey: "repair-controller-20260716",
        reason: "Repair primary session capability",
        requestId: "request-1",
      }),
    ]);
  });

  test("fails closed for unknown, deleted, or unbound instances", async () => {
    const missing = await rotateAdminManagedRuntimeController({
      body: validBody(),
      repository: repositoryForTest([], null),
      requestId: "request-2",
    });
    expect(missing).toEqual({
      status: "not_found",
      code: "managed_runtime_instance_not_found",
    });

    const deleted = await rotateAdminManagedRuntimeController({
      body: validBody(),
      repository: repositoryForTest([], {
        desiredState: "deleted",
        id: INSTANCE_ID,
        observedState: "deleted",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: PROJECT_ID,
      }),
      requestId: "request-3",
    });
    expect(deleted).toEqual({
      status: "blocked",
      code: "managed_runtime_instance_deleted",
    });

    const unbound = await rotateAdminManagedRuntimeController({
      body: validBody(),
      repository: repositoryForTest([], {
        desiredState: "running",
        id: INSTANCE_ID,
        observedState: "ready",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: null,
      }),
      requestId: "request-4",
    });
    expect(unbound).toEqual({
      status: "blocked",
      code: "managed_runtime_project_binding_missing",
    });
  });

  test("rejects invalid repair input", async () => {
    await expect(
      rotateAdminManagedRuntimeController({
        body: { instanceId: INSTANCE_ID, reason: "x" },
        repository: repositoryForTest([]),
        requestId: "request-5",
      }),
    ).rejects.toMatchObject({ name: "AdminManagedRuntimeError", message: "invalid_body" });
  });
});

describe("admin managed runtime lifecycle operations", () => {
  test("queues start through the normal operation ledger", async () => {
    const calls: unknown[] = [];
    const result = await enqueueAdminManagedRuntimeOperation({
      body: lifecycleBody("start"),
      repository: repositoryForTest(calls, {
        desiredState: "stopped",
        id: INSTANCE_ID,
        observedState: "stopped",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: PROJECT_ID,
      }),
      requestId: "request-start",
    });

    expect(result).toMatchObject({
      status: "ok",
      replayed: false,
      operation: { action: "start", instanceId: INSTANCE_ID, status: "pending" },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        action: "start",
        reason: "Recover verified managed instance",
        requestId: "request-start",
      }),
    ]);
  });

  test("returns an idempotent retry replay after the instance becomes ready", async () => {
    const operation = {
      action: "retry" as const,
      id: "10000000-0000-4000-8000-000000000002",
      idempotencyKey: "recover-instance-20260716",
      instanceId: INSTANCE_ID,
      status: "succeeded",
    };
    const result = await enqueueAdminManagedRuntimeOperation({
      body: lifecycleBody("retry"),
      repository: repositoryForTest([], undefined, operation),
      requestId: "request-replay",
    });

    expect(result).toMatchObject({ status: "ok", replayed: true, operation });
  });

  test("queues retry with the canonical failed operation envelope", async () => {
    const calls: unknown[] = [];
    const result = await enqueueAdminManagedRuntimeOperation({
      body: lifecycleBody("retry"),
      repository: repositoryForTest(calls, {
        desiredState: "stopped",
        id: INSTANCE_ID,
        observedState: "failed",
        organizationId: "30000000-0000-4000-8000-000000000001",
        projectId: PROJECT_ID,
      }),
      requestId: "request-retry-envelope",
    });

    expect(result).toMatchObject({
      status: "ok",
      operation: { action: "retry", status: "pending" },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        safeInput: {
          retryAction: "create",
          retryOperationId: "10000000-0000-4000-8000-000000000099",
        },
      }),
    ]);
  });

  test("fails closed for incoherent lifecycle actions", async () => {
    const organizationId = "30000000-0000-4000-8000-000000000001";
    const alreadyRunning = await enqueueAdminManagedRuntimeOperation({
      body: lifecycleBody("start"),
      repository: repositoryForTest([], {
        desiredState: "running",
        id: INSTANCE_ID,
        observedState: "ready",
        organizationId,
        projectId: PROJECT_ID,
      }),
      requestId: "request-running",
    });
    expect(alreadyRunning).toEqual({
      status: "blocked",
      code: "managed_runtime_already_running",
    });

    const invalidRetry = await enqueueAdminManagedRuntimeOperation({
      body: lifecycleBody("retry"),
      repository: repositoryForTest([], {
        desiredState: "running",
        id: INSTANCE_ID,
        observedState: "ready",
        organizationId,
        projectId: PROJECT_ID,
      }),
      requestId: "request-retry",
    });
    expect(invalidRetry).toEqual({
      status: "blocked",
      code: "managed_runtime_retry_state_invalid",
    });
  });
});

function validBody() {
  return {
    idempotencyKey: "repair-controller-20260716",
    instanceId: INSTANCE_ID,
    reason: "Repair primary session capability",
  };
}

function lifecycleBody(action: "restart" | "retry" | "start" | "stop") {
  return {
    action,
    idempotencyKey: "recover-instance-20260716",
    instanceId: INSTANCE_ID,
    reason: "Recover verified managed instance",
  };
}

function repositoryForTest(
  calls: unknown[],
  instance:
    | Awaited<ReturnType<AdminManagedRuntimeRepository["findInstance"]>>
    | undefined = {
      desiredState: "running",
      id: INSTANCE_ID,
      observedState: "ready",
      organizationId: "30000000-0000-4000-8000-000000000001",
      projectId: PROJECT_ID,
    },
  existingOperation: Awaited<ReturnType<AdminManagedRuntimeRepository["findOperation"]>> = null,
): AdminManagedRuntimeRepository {
  return {
    async findInstance() {
      return instance ?? null;
    },
    async findOperation() {
      return existingOperation;
    },
    async resolveRetrySafeInput() {
      return {
        ok: true,
        safeInput: {
          retryAction: "create",
          retryOperationId: "10000000-0000-4000-8000-000000000099",
        },
      };
    },
    async enqueueOperation(input) {
      calls.push(input);
      return {
        operation: {
          action: input.action,
          id: "10000000-0000-4000-8000-000000000001",
          idempotencyKey: input.idempotencyKey,
          instanceId: input.instance.id,
          status: "pending",
        },
        replayed: false,
      };
    },
  };
}
