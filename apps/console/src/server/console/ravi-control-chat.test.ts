import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "./authorization/fixture-policy";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import { schema } from "@/server/db";
import {
  getRaviControlChat,
  interruptRaviControlTurn,
  sendRaviControlMessage,
  syncRaviControlChat,
  type RaviControlChatRepository,
} from "./ravi-control-chat";
import { managedRuntimeContentCodecFromKey } from "./managed-runtime-content";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const HOST_ID = "40000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_ID = "60000000-0000-4000-8000-000000000001";
const BINDING_ID = "70000000-0000-4000-8000-000000000001";
const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 19));

type Binding = typeof schema.raviControlChatBindings.$inferSelect;
type Command = typeof schema.managedRuntimeCommands.$inferSelect;
type Mirror = typeof schema.raviControlMessageMirrors.$inferSelect;
type Session = typeof schema.managedRuntimeSessions.$inferSelect;

describe("Ravi Control canonical chat authority", () => {
  test("queues one encrypted canonical message and replays by client id", async () => {
    const repository = inMemoryRepository();
    const request = {
      body: {
        clientMessageId: "client-message-0001",
        idempotencyKey: "message:canonical:0001",
        text: "segredo que nao pode ficar em claro",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_control_chat_1",
      workspace: workspace(),
    } as const;

    const first = await sendRaviControlMessage(request);
    const replay = await sendRaviControlMessage({
      ...request,
      requestId: "req_control_chat_2",
    });

    expect(first.duplicate).toBeFalse();
    expect(replay.duplicate).toBeTrue();
    expect(replay.operation.id).toBe(first.operation.id);
    expect(repository.commands).toHaveLength(1);
    expect(repository.mirrors).toHaveLength(1);
    expect(JSON.stringify(repository.commands[0]?.encryptedInputJson)).not.toContain(
      "segredo que nao pode ficar em claro",
    );
    expect(
      JSON.stringify(repository.mirrors[0]?.encryptedContentJson),
    ).not.toContain("segredo que nao pode ficar em claro");
    expect(first.message.content).toEqual({
      text: "segredo que nao pode ficar em claro",
    });
    expect(first.message.operationId).toBe(first.operation.id);

    const aggregate = await getRaviControlChat({
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      workspace: workspace(),
    });
    expect(aggregate.messages).toHaveLength(1);
    expect(aggregate.binding).toMatchObject({
      id: BINDING_ID,
      installationId: INSTANCE_ID,
      status: "pending",
    });
    expect(JSON.stringify(aggregate.binding)).not.toContain("local-chat-secret");
  });

  test("denies message writes to project viewers", async () => {
    const repository = inMemoryRepository();

    await expect(
      sendRaviControlMessage({
        body: {
          clientMessageId: "client-message-viewer-0001",
          idempotencyKey: "message:viewer:0001",
          text: "nao deve entrar",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_control_viewer",
        workspace: workspace("viewer"),
      }),
    ).rejects.toMatchObject({
      payload: { error: "project_forbidden" },
      status: 403,
    });
    expect(repository.commands).toHaveLength(0);
  });

  test("fails closed when history sync has no canonical binding", async () => {
    const repository = inMemoryRepository();

    await expect(
      syncRaviControlChat({
        body: {
          idempotencyKey: "sync:canonical:0001",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_control_sync",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "ravi_control_chat_not_ready" },
      status: 409,
    });
  });

  test("rejects an interrupt target outside the active installation session", async () => {
    const repository = inMemoryRepository();
    repository.binding.status = "active";
    repository.binding.localActorId = "local-actor";
    repository.binding.localPlatformIdentityId = "local-platform";
    repository.binding.localChatId = "local-chat";
    repository.binding.localSessionKey = "local-session";
    repository.commands.push(
      commandRecord({
        id: "80000000-0000-4000-8000-000000000001",
        instanceId: "50000000-0000-4000-8000-000000000099",
        status: "running",
      }),
    );

    await expect(
      interruptRaviControlTurn({
        body: {
          idempotencyKey: "interrupt:canonical:0001",
          targetCommandId: "80000000-0000-4000-8000-000000000001",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_control_interrupt",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "ravi_control_no_active_turn" },
      status: 409,
    });
  });

  test("rejects a reused operation key for a different client message", async () => {
    const repository = inMemoryRepository();
    await sendRaviControlMessage({
      body: {
        clientMessageId: "client-message-0001",
        idempotencyKey: "message:canonical:shared",
        text: "primeira mensagem",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_control_chat_first",
      workspace: workspace(),
    });
    repository.commands[0]!.status = "succeeded";

    await expect(
      sendRaviControlMessage({
        body: {
          clientMessageId: "client-message-0002",
          idempotencyKey: "message:canonical:shared",
          text: "mensagem diferente",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_control_chat_conflict",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "ravi_control_operation_idempotency_conflict" },
      status: 409,
    });
    expect(repository.commands).toHaveLength(1);
    expect(repository.mirrors).toHaveLength(1);
  });

  test("rejects a reused interrupt key for a different active turn", async () => {
    const repository = inMemoryRepository();
    repository.binding.status = "active";
    repository.binding.localActorId = "local-actor";
    repository.binding.localPlatformIdentityId = "local-platform";
    repository.binding.localChatId = "local-chat";
    repository.binding.localSessionKey = "local-session";
    const firstTarget = commandRecord({
      id: "80000000-0000-4000-8000-000000000010",
      status: "running",
    });
    repository.commands.push(firstTarget);

    await interruptRaviControlTurn({
      body: {
        idempotencyKey: "interrupt:canonical:shared",
        targetCommandId: firstTarget.id,
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_control_interrupt_first",
      workspace: workspace(),
    });
    repository.commands.find(
      (command) => command.action === "turn_interrupt",
    )!.status = "succeeded";
    firstTarget.status = "succeeded";
    const secondTarget = commandRecord({
      id: "80000000-0000-4000-8000-000000000011",
      status: "running",
    });
    repository.commands.push(secondTarget);

    await expect(
      interruptRaviControlTurn({
        body: {
          idempotencyKey: "interrupt:canonical:shared",
          targetCommandId: secondTarget.id,
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_control_interrupt_conflict",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "ravi_control_operation_idempotency_conflict" },
      status: 409,
    });
  });
});

function workspace(role = "owner"): ConsoleWorkspace {
  return {
    mode: "workos",
    organization: { id: ORG_ID },
    membership: { role },
    user: {
      id: USER_ID,
      displayName: "Luis",
      primaryEmail: "luis@example.com",
    },
  } as ConsoleWorkspace;
}

function inMemoryRepository(): RaviControlChatRepository & {
  binding: Binding;
  commands: Command[];
  mirrors: Mirror[];
} {
  const now = new Date("2026-07-17T15:00:00.000Z");
  const commands: Command[] = [];
  const mirrors: Mirror[] = [];
  const binding: Binding = {
    id: BINDING_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    actorType: "user",
    actorId: USER_ID,
    targetAgentId: "managed-ravi",
    localActorId: null,
    localPlatformIdentityId: null,
    localChatId: null,
    localSessionKey: null,
    bindingVersion: 1,
    status: "pending",
    chatCursor: null,
    sessionCursor: null,
    lastSyncedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const session: Session = {
    id: SESSION_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    leaseId: null,
    hostId: HOST_ID,
    sandboxId: null,
    sessionKey: "managed-ravi",
    runtimeProvider: "codex",
    runtimeModel: "gpt-5",
    providerSessionStateJson: { agentId: "managed-ravi" },
    status: "idle",
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const instance = {
    connectionStatus: "online",
    displayName: "Managed Ravi",
    hostId: HOST_ID,
    id: INSTANCE_ID,
    observedState: "ready",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    runtimeModel: "gpt-5",
    runtimeProvider: "codex",
  } as const;

  return {
    binding,
    commands,
    mirrors,
    async authorizeProject(workspace, projectId, action) {
      return authorizeFixtureProject(workspace, projectId, action, { projects: [{ id: PROJECT_ID, organizationId: ORG_ID }], projectRole: (await this.findProjectMembership(projectId, workspace.user.id))?.role });
    },

    async findProjectByRef(organizationId, projectRef) {
      return organizationId === ORG_ID && projectRef === "core"
        ? { id: PROJECT_ID, organizationId: ORG_ID }
        : null;
    },

    async findProjectMembership() {
      return null;
    },

    async findInstance(input) {
      return input.organizationId === ORG_ID &&
        input.projectId === PROJECT_ID &&
        input.instanceId === INSTANCE_ID
        ? instance
        : null;
    },

    async ensureBinding() {
      return binding;
    },

    async findBinding(input) {
      return input.organizationId === ORG_ID &&
        input.instanceId === INSTANCE_ID &&
        input.actorId === USER_ID &&
        input.targetAgentId === "managed-ravi"
        ? binding
        : null;
    },

    async ensureSession() {
      return session;
    },

    async findActiveCommand(input) {
      return commands.find(
        (command) =>
          command.sessionId === input.sessionId &&
          input.actions.includes(command.action as never) &&
          ["pending", "claimed", "running"].includes(command.status),
      ) ?? null;
    },

    async findMirror(input) {
      return mirrors.find(
        (mirror) =>
          mirror.bindingId === input.bindingId &&
          mirror.clientMessageId === input.clientMessageId,
      ) ?? null;
    },

    async findCommand(commandId) {
      return commands.find((command) => command.id === commandId) ?? null;
    },

    async listMirrors(bindingId) {
      return mirrors.filter((mirror) => mirror.bindingId === bindingId);
    },

    async createCommand(input) {
      const existing = commands.find(
        (command) =>
          command.organizationId === ORG_ID &&
          command.action === input.action &&
          command.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        return {
          command: existing,
          created: false,
          mirror: mirrors.find((mirror) => mirror.commandId === existing.id) ?? null,
        };
      }
      const command: Command = {
        id: input.commandId,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        phase: null,
        claimOwner: null,
        claimExpiresAt: null,
        attemptCount: 0,
        encryptedInputJson: input.encryptedInput,
        encryptedResultJson: null,
        safeResultJson: null,
        failureCode: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      commands.push(command);
      let mirror: Mirror | null = null;
      if (input.mirror) {
        mirror = {
          id: input.mirror.id,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          instanceId: INSTANCE_ID,
          bindingId: BINDING_ID,
          commandId: command.id,
          localMessageId: null,
          clientMessageId: input.mirror.clientMessageId,
          replyToLocalMessageId: input.mirror.replyToLocalMessageId,
          actorType: "human",
          actorId: input.mirror.actorId,
          status: "queued",
          cursor: null,
          encryptedContentJson: input.mirror.encryptedContent,
          safeMetadataJson: {},
          failureCode: null,
          localCreatedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        mirrors.push(mirror);
      }
      return { command, created: true, mirror };
    },
  };
}

function commandRecord(
  overrides: Partial<Command> & Pick<Command, "id">,
): Command {
  const now = new Date("2026-07-17T15:00:00.000Z");
  const { id, ...rest } = overrides;
  return {
    id,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    instanceId: INSTANCE_ID,
    sessionId: SESSION_ID,
    actorType: "user",
    actorId: USER_ID,
    action: "chat_message_create",
    idempotencyKey: `message:${id}`,
    status: "pending",
    phase: null,
    claimOwner: null,
    claimExpiresAt: null,
    attemptCount: 0,
    encryptedInputJson: {},
    encryptedResultJson: null,
    safeResultJson: null,
    failureCode: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}
