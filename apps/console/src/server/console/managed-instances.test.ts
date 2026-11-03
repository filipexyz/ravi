import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "./authorization/fixture-policy";

import { ConsoleApiError } from "@/server/console/api-error";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import {
  claimManagedInstanceOperation,
  createManagedInstance,
  enqueueManagedInstanceOperation,
  getManagedInstance,
  reportManagedInstanceOperation,
  type ManagedInstanceAggregate,
  type ManagedInstancesRepository,
} from "./managed-instances";
import { ManagedRuntimeError } from "./managed-runtime";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const HOST_ID = "40000000-0000-4000-8000-000000000001";
const IMAGE_ID = "50000000-0000-4000-8000-000000000001";

describe("managed instance foundation", () => {
  test("creates only Codex instances and replays the same idempotent request", async () => {
    const repository = inMemoryRepository();
    const input = {
      body: {
        displayName: "Ravi financeiro",
        idempotencyKey: "create:ravi-financeiro:1",
        provider: "codex",
        sizePreset: "small",
      },
      projectRef: "core",
      repository,
      requestId: "req_create_1",
      workspace: workspace(),
    };

    const first = await createManagedInstance(input);
    const replay = await createManagedInstance({ ...input, requestId: "req_create_2" });

    expect(first.instance.id).toBe(replay.instance.id);
    expect(first.instance).toMatchObject({
      desiredState: "running",
      observedState: "provisioning",
      runtimeProvider: "codex",
    });
    expect(first.latestOperation).toMatchObject({ action: "create", status: "pending" });
    expect(repository.aggregates.size).toBe(1);

    await expect(
      createManagedInstance({
        ...input,
        body: { ...input.body, idempotencyKey: "create:other-provider:1", provider: "claude" },
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });

  test("enforces project authorization and organization isolation", async () => {
    const repository = inMemoryRepository();

    await expect(
      createManagedInstance({
        body: {
          displayName: "Blocked",
          idempotencyKey: "create:blocked:1",
          provider: "codex",
        },
        projectRef: "core",
        repository,
        requestId: "req_blocked",
        workspace: workspace({ role: "viewer" }),
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      createManagedInstance({
        body: {
          displayName: "Wrong org",
          idempotencyKey: "create:wrong-org:1",
          provider: "codex",
        },
        projectRef: "core",
        repository,
        requestId: "req_wrong_org",
        workspace: workspace({ organizationId: "10000000-0000-4000-8000-000000000099" }),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("records desired state changes and replays operation idempotency", async () => {
    const repository = inMemoryRepository();
    const created = await seedInstance(repository);
    const input = {
      body: { action: "stop", idempotencyKey: "stop:ravi-financeiro:1" },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_stop_1",
      workspace: workspace(),
    };

    const first = await enqueueManagedInstanceOperation(input);
    const replay = await enqueueManagedInstanceOperation({ ...input, requestId: "req_stop_2" });

    expect(first.instance.desiredState).toBe("stopped");
    expect(first.latestOperation).toMatchObject({ action: "stop", status: "pending" });
    expect(replay.latestOperation?.id).toBe(first.latestOperation?.id);
  });

  test("allows delete to be retried until observed state converges", async () => {
    const repository = inMemoryRepository();
    const created = await seedInstance(repository);
    const first = await enqueueManagedInstanceOperation({
      body: { action: "delete", idempotencyKey: "delete:ravi-financeiro:1" },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_delete_1",
      workspace: workspace(),
    });
    const aggregate = repository.only();
    const failedDelete = aggregate.operations.find(
      (item) => item.id === first.latestOperation?.id,
    );
    if (!failedDelete) throw new Error("missing delete operation");
    failedDelete.status = "failed";
    aggregate.instance.observedState = "deleting";

    const retried = await enqueueManagedInstanceOperation({
      body: { action: "delete", idempotencyKey: "delete:ravi-financeiro:2" },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_delete_2",
      workspace: workspace(),
    });
    expect(retried.latestOperation).toMatchObject({
      action: "delete",
      status: "pending",
    });
    expect(retried.latestOperation?.id).not.toBe(first.latestOperation?.id);

    aggregate.instance.observedState = "deleted";
    await expect(
      enqueueManagedInstanceOperation({
        body: { action: "delete", idempotencyKey: "delete:ravi-financeiro:3" },
        instanceId: created.instance.id,
        projectRef: "core",
        repository,
        requestId: "req_delete_3",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "managed_runtime_instance_deleted" },
      status: 409,
    });
  });

  test("projects only completed backups and restores only a backup from the same instance", async () => {
    const repository = inMemoryRepository();
    const created = await seedInstance(repository);
    const aggregate = repository.only();
    aggregate.instance.observedState = "ready";

    await enqueueManagedInstanceOperation({
      body: { action: "backup", idempotencyKey: "backup:ravi-financeiro:1" },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_backup_1",
      workspace: workspace(),
    });
    const backupOperation = aggregate.operations[0];
    if (!backupOperation) throw new Error("missing backup operation");
    const backupRef = `mbk_${backupOperation.id.replaceAll("-", "")}`;
    backupOperation.status = "succeeded";
    backupOperation.safeResultJson = {
      backup: {
        backupRef,
        contentDigest: `sha256:${"a".repeat(64)}`,
        createdAt: "2026-07-15T12:05:00.000Z",
        sizeBytes: 1_048_576,
        sourceVmId: "vm_ravi-financeiro_01",
      },
    };

    const view = await getManagedInstance({
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      workspace: workspace(),
    });
    expect(view.backups).toEqual([
      expect.objectContaining({ backupRef, operationId: backupOperation.id }),
    ]);

    aggregate.instance.observedState = "stopped";
    aggregate.instance.desiredState = "stopped";
    await expect(
      enqueueManagedInstanceOperation({
        body: {
          action: "restore",
          backupRef: `mbk_${"f".repeat(32)}`,
          idempotencyKey: "restore:ravi-financeiro:missing",
        },
        instanceId: created.instance.id,
        projectRef: "core",
        repository,
        requestId: "req_restore_missing",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "managed_runtime_backup_not_found" },
      status: 404,
    });

    const restored = await enqueueManagedInstanceOperation({
      body: {
        action: "restore",
        backupRef,
        idempotencyKey: "restore:ravi-financeiro:1",
      },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_restore_1",
      workspace: workspace(),
    });
    expect(restored.latestOperation).toMatchObject({
      action: "restore",
      status: "pending",
    });
    expect(aggregate.operations[0]?.safeInputJson).toEqual({ backupRef });

    const failedRestore = aggregate.operations[0];
    if (!failedRestore) throw new Error("missing restore operation");
    failedRestore.status = "failed";
    failedRestore.failureCode = "managed_runtime_operation_progress_regressed";
    aggregate.instance.observedState = "failed";
    const retry = await enqueueManagedInstanceOperation({
      body: {
        action: "retry",
        idempotencyKey: "retry:ravi-financeiro:restore:1",
      },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_retry_restore_1",
      workspace: workspace(),
    });
    expect(retry.latestOperation).toMatchObject({
      action: "retry",
      status: "pending",
    });
    expect(aggregate.operations[0]?.safeInputJson).toEqual({
      backupRef,
      retryAction: "restore",
      retryOperationId: failedRestore.id,
    });

    await expect(
      enqueueManagedInstanceOperation({
        body: {
          action: "restore",
          backupRef: `mbk_${"e".repeat(32)}`,
          idempotencyKey: "restore:ravi-financeiro:1",
        },
        instanceId: created.instance.id,
        projectRef: "core",
        repository,
        requestId: "req_restore_conflict",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "managed_runtime_idempotency_conflict" },
      status: 409,
    });
  });

  test("requires online private Ravi SDK evidence before reporting ready", async () => {
    const repository = inMemoryRepository();
    await seedInstance(repository);
    const claim = await claimManagedInstanceOperation({
      body: {
        actions: ["create"],
        claimOwner: "deck-hostd-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
        imageId: IMAGE_ID,
      },
      repository,
    });
    const operationId = claim.operation?.id;
    expect(operationId).toBeString();
    expect(claim.operation?.instance).toMatchObject({
      hostId: HOST_ID,
      imageId: IMAGE_ID,
    });

    await expect(
      reportManagedInstanceOperation({
        body: {
          claimOwner: "deck-hostd-01",
          observedState: "ready",
          operationId,
          progressPercent: 100,
          status: "succeeded",
        },
        repository,
      }),
    ).rejects.toMatchObject({
      code: "managed_runtime_ready_evidence_required",
      status: 409,
    });

    await expect(
      reportManagedInstanceOperation({
        body: {
          claimOwner: "deck-hostd-01",
          operationId,
          progressPercent: 50,
          safeResult: { apiToken: "must-not-be-recorded" },
          status: "running",
        },
        repository,
      }),
    ).rejects.toMatchObject({
      code: "managed_runtime_safe_result_invalid",
      status: 400,
    });

    await reportManagedInstanceOperation({
      body: {
        claimOwner: "deck-hostd-01",
        connection: {
          credentialRef: "cred_runtime_01",
          kind: "private_ravi_sdk",
          protocolVersion: "1",
          safeEndpointRef: "endpoint_runtime_01",
          status: "online",
        },
        observedState: "ready",
        operationId,
        phase: "ready",
        progressPercent: 100,
        runtimeVersion: "3.260715.1",
        safeResult: { installationId: "installation_01" },
        status: "succeeded",
      },
      repository,
    });

    const publicView = await getManagedInstance({
      instanceId: repository.only().instance.id,
      projectRef: "core",
      repository,
      workspace: workspace(),
    });
    expect(publicView.instance.observedState).toBe("ready");
    expect(publicView.connections).toEqual([
      expect.objectContaining({ kind: "private_ravi_sdk", status: "online" }),
    ]);
    expect(JSON.stringify(publicView)).not.toContain("cred_runtime_01");
    expect(JSON.stringify(publicView)).not.toContain("endpoint_runtime_01");
    expect(JSON.stringify(publicView)).not.toContain("deck-hostd-01");
  });

  test("claims host-owned delete across an image revision without rebinding it", async () => {
    const repository = inMemoryRepository();
    const created = await seedInstance(repository);
    const initialClaim = await claimManagedInstanceOperation({
      body: {
        actions: ["create"],
        claimOwner: "deck-hostd-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
        imageId: IMAGE_ID,
      },
      repository,
    });
    await reportManagedInstanceOperation({
      body: {
        claimOwner: "deck-hostd-01",
        failureCode: "managed_appliance_ready_timeout",
        observedState: "failed",
        operationId: initialClaim.operation?.id,
        progressPercent: 100,
        provisioningPhase: "failed",
        status: "failed",
      },
      repository,
    });
    await enqueueManagedInstanceOperation({
      body: {
        action: "delete",
        idempotencyKey: "delete:image-revision:1",
      },
      instanceId: created.instance.id,
      projectRef: "core",
      repository,
      requestId: "req_delete_image_revision",
      workspace: workspace(),
    });

    const nextImageId = "50000000-0000-4000-8000-000000000099";
    const foreignClaim = await claimManagedInstanceOperation({
      body: {
        actions: ["delete"],
        claimOwner: "deck-hostd-02",
        claimTtlSeconds: 60,
        hostId: "40000000-0000-4000-8000-000000000099",
        imageId: nextImageId,
      },
      repository,
    });
    expect(foreignClaim).toMatchObject({ claimed: false, operation: null });

    const deletion = await claimManagedInstanceOperation({
      body: {
        actions: ["delete"],
        claimOwner: "deck-hostd-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
        imageId: nextImageId,
      },
      repository,
    });

    expect(deletion.operation).toMatchObject({ action: "delete" });
    expect(deletion.operation?.instance).toMatchObject({
      hostId: HOST_ID,
      imageId: IMAGE_ID,
    });
  });
});

function workspace(
  options: { organizationId?: string; role?: string; userId?: string } = {},
): ConsoleWorkspace {
  return {
    mode: "workos",
    organization: { id: options.organizationId ?? ORG_ID },
    membership: { role: options.role ?? "owner" },
    user: { id: options.userId ?? USER_ID },
  } as ConsoleWorkspace;
}

async function seedInstance(repository: ReturnType<typeof inMemoryRepository>) {
  return createManagedInstance({
    body: {
      displayName: "Ravi financeiro",
      idempotencyKey: "create:ravi-financeiro:1",
      provider: "codex",
    },
    projectRef: "core",
    repository,
    requestId: "req_seed",
    workspace: workspace(),
  });
}

function inMemoryRepository(): ManagedInstancesRepository & {
  aggregates: Map<string, ManagedInstanceAggregate>;
  only(): ManagedInstanceAggregate;
} {
  const aggregates = new Map<string, ManagedInstanceAggregate>();
  const idempotency = new Map<string, string>();
  let sequence = 1;

  const repository: ManagedInstancesRepository & {
    aggregates: Map<string, ManagedInstanceAggregate>;
    only(): ManagedInstanceAggregate;
  } = {
    aggregates,
    async authorizeProject(workspace, projectId, action) {
      return authorizeFixtureProject(workspace, projectId, action, { projects: [{ id: PROJECT_ID, organizationId: ORG_ID }], projectRole: (await this.findProjectMembership(projectId, workspace.user.id))?.role });
    },
    only() {
      const aggregate = [...aggregates.values()][0];
      if (!aggregate) throw new Error("missing test aggregate");
      return aggregate;
    },

    async findProjectByRef(organizationId, projectRef) {
      if (organizationId !== ORG_ID || (projectRef !== "core" && projectRef !== PROJECT_ID)) return null;
      return { id: PROJECT_ID, organizationId: ORG_ID };
    },

    async findProjectMembership(projectId, userId) {
      if (projectId === PROJECT_ID && userId === USER_ID) return { role: "viewer", status: "active" };
      return null;
    },

    async findOperationByIdempotency(input) {
      const instanceId = idempotency.get(`${input.action}:${input.idempotencyKey}`);
      return instanceId ? requiredAggregate(aggregates, instanceId) : null;
    },

    async createInstance(input) {
      const replayId = idempotency.get(`create:${input.idempotencyKey}`);
      if (replayId) return requiredAggregate(aggregates, replayId);
      const instanceId = uuid(sequence++);
      const operationId = uuid(sequence++);
      const now = new Date("2026-07-15T12:00:00.000Z");
      const aggregate: ManagedInstanceAggregate = {
        instance: {
          id: instanceId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          hostId: null,
          imageId: null,
          installationId: null,
          displayName: input.displayName,
          desiredState: "running",
          observedState: "provisioning",
          provisioningPhase: "queued",
          failureCode: null,
          runtimeProvider: "codex",
          runtimeModel: input.runtimeModel,
          status: "provisioning",
          runtimeVersion: null,
          placementClass: input.placementClass,
          localStateRef: null,
          syncCursorJson: {},
          safeMetadataJson: input.safeInput,
          lastHeartbeatAt: null,
          createdAt: now,
          updatedAt: now,
        },
        operations: [operation(operationId, instanceId, input.organizationId, input.projectId, "create", input.idempotencyKey, now)],
        connections: [],
      };
      aggregates.set(instanceId, aggregate);
      idempotency.set(`create:${input.idempotencyKey}`, instanceId);
      return aggregate;
    },

    async enqueueOperation(input) {
      const key = `${input.action}:${input.idempotencyKey}`;
      const replayId = idempotency.get(key);
      if (replayId) return requiredAggregate(aggregates, replayId);
      const aggregate = requiredAggregate(aggregates, input.instanceId);
      aggregate.instance.desiredState = input.nextDesiredState;
      aggregate.instance.updatedAt = new Date(aggregate.instance.updatedAt.getTime() + 1000);
      const nextOperation = operation(
          uuid(sequence++),
          input.instanceId,
          input.organizationId,
          input.projectId,
          input.action,
          input.idempotencyKey,
          aggregate.instance.updatedAt,
        );
      nextOperation.safeInputJson = input.safeInput;
      aggregate.operations.unshift(nextOperation);
      idempotency.set(key, input.instanceId);
      return aggregate;
    },

    async getInstance(input) {
      const aggregate = aggregates.get(input.instanceId);
      if (
        !aggregate
        || aggregate.instance.organizationId !== input.organizationId
        || aggregate.instance.projectId !== input.projectId
      ) return null;
      return aggregate;
    },

    async listInstances(input) {
      return [...aggregates.values()].filter(
        ({ instance }) =>
          instance.organizationId === input.organizationId && instance.projectId === input.projectId,
      );
    },

    async claimOperation(input) {
      const aggregate = [...aggregates.values()].find(({ instance, operations }) =>
        operations.some(
          (item) =>
            (!input.actions || input.actions.includes(item.action))
            && operationMatchesPlacement(item.action, instance, input.placement)
            && (item.status === "pending"
              || (["claimed", "running"].includes(item.status)
                && Boolean(item.claimExpiresAt && item.claimExpiresAt <= input.now))),
        ),
      );
      if (!aggregate) return null;
      const current = aggregate.operations.find(
        (item) => (!input.actions || input.actions.includes(item.action)) && item.status === "pending",
      );
      if (!current) return null;
      current.status = "claimed";
      current.claimOwner = input.claimOwner;
      current.claimExpiresAt = new Date(input.now.getTime() + input.claimTtlSeconds * 1000);
      current.attemptCount += 1;
      current.updatedAt = input.now;
      if (input.placement && itemIsProvisioning(current.action)) {
        aggregate.instance.hostId = input.placement.hostId;
        aggregate.instance.imageId = input.placement.imageId;
      }
      return { ...aggregate, operations: [current] };
    },

    async reportOperation(input) {
      const aggregate = [...aggregates.values()].find(({ operations }) =>
        operations.some((item) => item.id === input.operationId),
      );
      if (!aggregate) throw new ManagedRuntimeError(404, "managed_runtime_operation_not_found");
      const current = aggregate.operations.find((item) => item.id === input.operationId);
      if (!current) throw new ManagedRuntimeError(404, "managed_runtime_operation_not_found");
      current.status = input.status;
      current.phase = input.phase;
      current.progressPercent = input.status === "succeeded" ? 100 : input.progressPercent;
      current.failureCode = input.failureCode;
      current.safeResultJson = input.safeResult;
      current.startedAt ??= new Date();
      current.completedAt = input.status === "running" ? null : new Date();
      if (input.observedState) {
        aggregate.instance.observedState = input.observedState;
        aggregate.instance.status = input.observedState === "ready" ? "active" : aggregate.instance.status;
      }
      if (input.runtimeVersion) aggregate.instance.runtimeVersion = input.runtimeVersion;
      if (input.connection) {
        aggregate.connections = [
          {
            id: uuid(sequence++),
            organizationId: aggregate.instance.organizationId,
            instanceId: aggregate.instance.id,
            kind: input.connection.kind,
            status: input.connection.status,
            protocolVersion: input.connection.protocolVersion,
            safeEndpointRef: input.connection.safeEndpointRef,
            credentialRef: input.connection.credentialRef,
            lastConnectedAt: new Date(),
            lastHeartbeatAt: new Date(),
            revokedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      return aggregate;
    },
  };

  return repository;
}

function itemIsProvisioning(action: ManagedInstanceAggregate["operations"][number]["action"]) {
  return action === "create" || action === "retry";
}

function operationMatchesPlacement(
  action: ManagedInstanceAggregate["operations"][number]["action"],
  instance: ManagedInstanceAggregate["instance"],
  placement: { hostId: string; imageId: string } | null,
) {
  if (!placement) return true;
  if (!instance.hostId && !instance.imageId) {
    return ["create", "retry", "delete"].includes(action);
  }
  if (instance.hostId !== placement.hostId) return false;
  return instance.imageId === placement.imageId || !itemIsProvisioning(action);
}

function operation(
  id: string,
  instanceId: string,
  organizationId: string,
  projectId: string,
  action: ManagedInstanceAggregate["operations"][number]["action"],
  idempotencyKey: string,
  now: Date,
): ManagedInstanceAggregate["operations"][number] {
  return {
    id,
    organizationId,
    projectId,
    instanceId,
    actorType: "user",
    actorId: USER_ID,
    action,
    idempotencyKey,
    status: "pending",
    phase: "queued",
    progressPercent: 0,
    claimOwner: null,
    claimExpiresAt: null,
    attemptCount: 0,
    safeInputJson: {},
    safeResultJson: null,
    failureCode: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function requiredAggregate(
  aggregates: Map<string, ManagedInstanceAggregate>,
  id: string,
) {
  const aggregate = aggregates.get(id);
  if (!aggregate) throw new Error(`missing aggregate ${id}`);
  return aggregate;
}

function uuid(sequence: number) {
  return `90000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}
