import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "./authorization/fixture-policy";

import { ConsoleApiError } from "@/server/console/api-error";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  claimManagedRaviCommand,
  enqueueManagedRaviCommand,
  getManagedRaviSession,
  isIdempotentTerminalCommandReport,
  listManagedRaviSessionEvents,
  reportManagedRaviCommand,
  type ManagedRuntimeCommandsRepository,
} from "./managed-runtime-commands";
import { managedRuntimeContentCodecFromKey } from "./managed-runtime-content";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const HOST_ID = "40000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_ID = "60000000-0000-4000-8000-000000000001";
const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 17));

type Session = typeof schema.managedRuntimeSessions.$inferSelect;
type Command = typeof schema.managedRuntimeCommands.$inferSelect;
type Event = typeof schema.managedRuntimeEvents.$inferSelect;

describe("Managed Ravi command authority", () => {
  test("encrypts prompt content, replays idempotency, and serializes a session", async () => {
    const repository = inMemoryRepository();
    const input = {
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:managed-ravi:0001",
        prompt: "Explique o fluxo financeiro.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_prompt_1",
      workspace: workspace(),
    } as const;

    const first = await enqueueManagedRaviCommand(input);
    const replay = await enqueueManagedRaviCommand({
      ...input,
      requestId: "req_prompt_2",
    });

    expect(replay.command.id).toBe(first.command.id);
    expect(first.command.input).toEqual({
      prompt: "Explique o fluxo financeiro.",
      sessionKey: "managed-ravi",
    });
    expect(repository.commands).toHaveLength(1);
    expect(JSON.stringify(repository.commands[0]?.encryptedInputJson)).not.toContain(
      "fluxo financeiro",
    );

    const aggregate = await getManagedRaviSession({
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      workspace: workspace(),
    });
    expect(aggregate.session).toMatchObject({
      id: SESSION_ID,
      sessionKey: "managed-ravi",
      status: "idle",
    });
    expect(aggregate.commands).toHaveLength(1);

    await expect(
      enqueueManagedRaviCommand({
        ...input,
        body: {
          action: "prompt_send",
          idempotencyKey: "prompt:managed-ravi:0002",
          prompt: "Outro turno",
        },
      }),
    ).rejects.toMatchObject({
      payload: { error: "managed_runtime_session_busy" },
      status: 409,
    });

    const interrupt = await enqueueManagedRaviCommand({
      ...input,
      body: {
        action: "turn_interrupt",
        idempotencyKey: "interrupt:managed-ravi:0001",
      },
    });
    expect(interrupt.command).toMatchObject({
      action: "turn_interrupt",
      input: {
        sessionKey: "managed-ravi",
        targetCommandId: first.command.id,
      },
    });
  });

  test("rejects an interrupt when the session has no active prompt", async () => {
    const repository = inMemoryRepository();

    await expect(
      enqueueManagedRaviCommand({
        body: {
          action: "turn_interrupt",
          idempotencyKey: "interrupt:idle-session:0001",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_interrupt_idle",
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "managed_runtime_no_active_turn" },
      status: 409,
    });
  });

  test("enforces project write access while allowing read-only sync", async () => {
    const repository = inMemoryRepository();

    await expect(
      enqueueManagedRaviCommand({
        body: {
          action: "prompt_send",
          idempotencyKey: "prompt:viewer-denied:0001",
          prompt: "Nao deve entrar",
        },
        codec,
        instanceId: INSTANCE_ID,
        projectRef: "core",
        repository,
        requestId: "req_denied",
        workspace: workspace({ role: "viewer" }),
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    const sync = await enqueueManagedRaviCommand({
      body: {
        action: "session_sync",
        idempotencyKey: "sync:viewer-allowed:0001",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_sync",
      workspace: workspace({ role: "viewer" }),
    });
    expect(sync.command.action).toBe("session_sync");
  });

  test("binds claims to a host and persists decryptable ordered events", async () => {
    const repository = inMemoryRepository();
    const created = await enqueueManagedRaviCommand({
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:claim-report:0001",
        prompt: "Responda apenas OK.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_claim",
      workspace: workspace(),
    });

    const wrongHost = await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: "40000000-0000-4000-8000-000000000099",
      },
      codec,
      repository,
    });
    expect(wrongHost.claimed).toBeFalse();

    const claim = await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    expect(claim.command).toMatchObject({
      id: created.command.id,
      action: "prompt_send",
      input: { prompt: "Responda apenas OK.", sessionKey: "managed-ravi" },
    });

    const event = {
      eventType: "assistant.message",
      occurredAt: new Date().toISOString(),
      payload: { role: "assistant", text: "OK" },
      severity: "info",
      sourceEventId: "session:managed-ravi:event:0001",
    } as const;
    await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: created.command.id,
        events: [event],
        phase: "streaming",
        safeResult: { eventCount: 1 },
        status: "running",
      },
      codec,
      repository,
    });
    const terminal = await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: created.command.id,
        events: [event],
        phase: "completed",
        result: { response: { length: 2, text: "OK" } },
        safeResult: { eventCount: 1, outputLength: 2 },
        status: "succeeded",
      },
      codec,
      repository,
    });
    expect(terminal.command.status).toBe("succeeded");

    const replay = await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: created.command.id,
        events: [event],
        phase: "completed",
        result: { response: { length: 2, text: "OK" } },
        safeResult: { eventCount: 1, outputLength: 2 },
        status: "succeeded",
      },
      codec,
      repository,
    });
    expect(replay.acceptedEvents).toBe(0);

    const events = await listManagedRaviSessionEvents({
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      sessionId: SESSION_ID,
      workspace: workspace(),
    });
    expect(events.items).toEqual([
      expect.objectContaining({
        commandId: created.command.id,
        eventType: "assistant.message",
        payload: { role: "assistant", text: "OK" },
        sequence: 1,
      }),
    ]);

    const aggregate = await getManagedRaviSession({
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      workspace: workspace(),
    });
    expect(aggregate.commands[0]).toMatchObject({
      result: { response: { length: 2, text: "OK" } },
      status: "succeeded",
    });
  });

  test("never reclaims an expired in-flight prompt delivery", async () => {
    const repository = inMemoryRepository();
    const created = await enqueueManagedRaviCommand({
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:uncertain:0001",
        prompt: "Execute uma vez.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_uncertain",
      workspace: workspace(),
    });
    await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    const command = repository.commands.find((item) => item.id === created.command.id);
    if (!command) throw new Error("missing command");
    command.status = "running";
    command.claimExpiresAt = new Date(Date.now() - 1_000);
    repository.session.status = "active";

    const nextClaim = await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-02",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    expect(nextClaim.claimed).toBeFalse();
    expect(command).toMatchObject({
      failureCode: "managed_runtime_prompt_delivery_uncertain",
      phase: "delivery_uncertain",
      status: "failed",
    });
    expect(command.attemptCount).toBe(1);
    expect(repository.session).toMatchObject({ status: "failed" });
  });

  test("repairs legacy uncertain prompt drift without overriding active work", async () => {
    const repository = inMemoryRepository();
    const created = await enqueueManagedRaviCommand({
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:legacy-drift:0001",
        prompt: "Execute uma vez.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_legacy_drift",
      workspace: workspace(),
    });
    const command = repository.commands.find((item) => item.id === created.command.id);
    if (!command) throw new Error("missing command");
    command.status = "failed";
    command.failureCode = "managed_runtime_prompt_delivery_uncertain";
    command.phase = "delivery_uncertain";
    command.completedAt = new Date();
    command.updatedAt = new Date(repository.session.updatedAt.getTime() + 1_000);
    repository.session.status = "active";

    const repaired = await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-02",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    expect(repaired.claimed).toBeFalse();
    expect(repository.session).toMatchObject({ status: "failed" });

    repository.session.status = "active";
    const sync = await enqueueManagedRaviCommand({
      body: {
        action: "session_sync",
        idempotencyKey: "sync:legacy-drift:0001",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_legacy_sync",
      workspace: workspace(),
    });
    expect(sync.command.status).toBe("pending");
    await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-02",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    expect(repository.session.status).toBe("active");
  });

  test("accepts a cancelled prompt report and projects the session as interrupted", async () => {
    const repository = inMemoryRepository();
    const created = await enqueueManagedRaviCommand({
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:cancelled:0001",
        prompt: "Conte indefinidamente.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_cancelled",
      workspace: workspace(),
    });
    await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });

    const cancelled = await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: created.command.id,
        events: [],
        phase: "interrupted",
        result: { history: { messages: [] } },
        safeResult: { eventCount: 1 },
        status: "cancelled",
      },
      codec,
      repository,
    });

    expect(cancelled.command.status).toBe("cancelled");
    expect(repository.session.status).toBe("interrupted");
  });

  test("atomically cancels the bound prompt when an interrupt succeeds", async () => {
    const repository = inMemoryRepository();
    const prompt = await enqueueManagedRaviCommand({
      body: {
        action: "prompt_send",
        idempotencyKey: "prompt:interrupt-target:0001",
        prompt: "Conte indefinidamente.",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_interrupt_target",
      workspace: workspace(),
    });
    await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: prompt.command.id,
        events: [],
        phase: "streaming",
        safeResult: { eventCount: 1 },
        status: "running",
      },
      codec,
      repository,
    });

    const interrupt = await enqueueManagedRaviCommand({
      body: {
        action: "turn_interrupt",
        idempotencyKey: "interrupt:bound-target:0001",
      },
      codec,
      instanceId: INSTANCE_ID,
      projectRef: "core",
      repository,
      requestId: "req_bound_interrupt",
      workspace: workspace(),
    });
    expect(interrupt.command.input).toEqual({
      sessionKey: "managed-ravi",
      targetCommandId: prompt.command.id,
    });
    await claimManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        claimTtlSeconds: 60,
        hostId: HOST_ID,
      },
      codec,
      repository,
    });
    await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: interrupt.command.id,
        events: [],
        phase: "completed",
        result: { history: { messages: [] } },
        safeResult: { eventCount: 0, historyCount: 0 },
        status: "succeeded",
      },
      codec,
      repository,
    });

    expect(
      repository.commands.find((command) => command.id === prompt.command.id),
    ).toMatchObject({
      claimExpiresAt: null,
      claimOwner: null,
      phase: "interrupted",
      status: "cancelled",
    });
    expect(
      repository.commands.find((command) => command.id === interrupt.command.id),
    ).toMatchObject({ status: "succeeded" });
    expect(repository.session.status).toBe("interrupted");

    const localCancellationReplay = await reportManagedRaviCommand({
      body: {
        claimOwner: "runtime-control-01",
        commandId: prompt.command.id,
        events: [],
        phase: "interrupted",
        safeResult: { interrupted: true, retryable: false },
        status: "cancelled",
      },
      codec,
      repository,
    });
    expect(localCancellationReplay).toMatchObject({
      acceptedEvents: 0,
      command: { phase: "interrupted", status: "cancelled" },
    });
  });

  test("accepts only the exact terminal replay after an atomic interrupt", () => {
    const current = {
      action: "prompt_send",
      claimOwner: null,
      phase: "interrupted",
      status: "cancelled",
    } as const;

    expect(
      isIdempotentTerminalCommandReport(current, {
        claimOwner: "runtime-control-01",
        phase: "interrupted",
        status: "cancelled",
      }),
    ).toBeTrue();
    expect(
      isIdempotentTerminalCommandReport(current, {
        claimOwner: "runtime-control-01",
        phase: "failed",
        status: "cancelled",
      }),
    ).toBeFalse();
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

function inMemoryRepository(): ManagedRuntimeCommandsRepository & {
  commands: Command[];
  events: Event[];
  session: Session;
} {
  const now = new Date("2026-07-15T12:00:00.000Z");
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
  const commands: Command[] = [];
  const events: Event[] = [];
  const instance = {
    connectionStatus: "online",
    hostId: HOST_ID,
    id: INSTANCE_ID,
    observedState: "ready",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    runtimeModel: "gpt-5",
    runtimeProvider: "codex",
  } as const;

  return {
    commands,
    events,
    session,
    async authorizeProject(workspace, projectId, action) {
      return authorizeFixtureProject(workspace, projectId, action, { projects: [{ id: PROJECT_ID, organizationId: ORG_ID }], projectRole: (await this.findProjectMembership(projectId, workspace.user.id))?.role });
    },

    async findProjectByRef(organizationId, projectRef) {
      if (
        organizationId !== ORG_ID ||
        (projectRef !== "core" && projectRef !== PROJECT_ID)
      ) {
        return null;
      }
      return { id: PROJECT_ID, organizationId: ORG_ID };
    },

    async findProjectMembership(projectId, userId) {
      return projectId === PROJECT_ID && userId === USER_ID
        ? { role: "viewer", status: "active" }
        : null;
    },

    async findInstance(input) {
      return input.organizationId === ORG_ID &&
        input.projectId === PROJECT_ID &&
        input.instanceId === INSTANCE_ID
        ? instance
        : null;
    },

    async ensurePrimarySession() {
      return session;
    },

    async getSession(sessionId) {
      return sessionId === SESSION_ID ? session : null;
    },

    async findCommandById(commandId) {
      return commands.find((command) => command.id === commandId) ?? null;
    },

    async findCommandByIdempotency(input) {
      return commands.find(
        (command) =>
          command.organizationId === input.organizationId &&
          command.action === input.action &&
          command.idempotencyKey === input.idempotencyKey,
      ) ?? null;
    },

    async findActiveCommand(input) {
      return commands.find(
        (command) =>
          command.sessionId === input.sessionId &&
          input.actions.includes(command.action) &&
          ["pending", "claimed", "running"].includes(command.status),
      ) ?? null;
    },

    async createCommand(input) {
      const command: Command = {
        id: input.commandId,
        organizationId: input.instance.organizationId,
        projectId: input.instance.projectId,
        instanceId: input.instance.id,
        sessionId: input.session.id,
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
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      commands.push(command);
      return command;
    },

    async listCommands(sessionId) {
      return commands.filter((command) => command.sessionId === sessionId).reverse();
    },

    async listEvents(input) {
      const selected = events
        .filter(
          (event) =>
            event.sessionId === input.sessionId &&
            event.sequence > input.afterSequence,
        )
        .sort((left, right) => left.sequence - right.sequence);
      if (input.afterSequence === 0 && input.limit === 1) {
        return selected.slice(-1);
      }
      return selected.slice(0, input.limit);
    },

    async claimCommand(input) {
      for (const command of commands) {
        if (
          command.action === "prompt_send" &&
          ["claimed", "running"].includes(command.status) &&
          command.claimExpiresAt &&
          command.claimExpiresAt <= input.now
        ) {
          command.status = "failed";
          command.phase = "delivery_uncertain";
          command.failureCode = "managed_runtime_prompt_delivery_uncertain";
          command.completedAt = input.now;
          command.claimOwner = null;
          command.claimExpiresAt = null;
          command.updatedAt = input.now;
        }
      }
      const uncertain = commands
        .filter(
          (command) =>
            command.action === "prompt_send" &&
            command.status === "failed" &&
            command.failureCode === "managed_runtime_prompt_delivery_uncertain" &&
            command.sessionId === session.id &&
            command.updatedAt >= session.updatedAt,
        )
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
        .at(0);
      const activeForSession = commands.some(
        (command) =>
          command.sessionId === session.id &&
          ["pending", "claimed", "running"].includes(command.status),
      );
      if (uncertain && session.status === "active" && !activeForSession) {
        session.status = "failed";
        session.updatedAt = uncertain.updatedAt;
      }
      if (input.hostId !== HOST_ID) return null;
      const command = commands.find((candidate) => {
        if (candidate.status === "pending") return true;
        return (
          candidate.action !== "prompt_send" &&
          ["claimed", "running"].includes(candidate.status) &&
          candidate.claimExpiresAt !== null &&
          candidate.claimExpiresAt <= input.now
        );
      });
      if (!command) return null;
      command.status = "claimed";
      command.claimOwner = input.claimOwner;
      command.claimExpiresAt = new Date(
        input.now.getTime() + input.claimTtlSeconds * 1_000,
      );
      command.attemptCount += 1;
      command.updatedAt = input.now;
      return { command, instance, session };
    },

    async reportCommand(input) {
      const command = commands.find((item) => item.id === input.commandId);
      if (!command) throw new Error("missing command");
      if (["succeeded", "failed", "cancelled"].includes(command.status)) {
        return { command, events: [] };
      }
      const accepted: Event[] = [];
      for (const item of input.encryptedEvents) {
        if (events.some((event) => event.sourceEventId === item.sourceEventId)) {
          continue;
        }
        const event: Event = {
          id: crypto.randomUUID(),
          organizationId: ORG_ID,
          sessionId: SESSION_ID,
          leaseId: null,
          hostId: null,
          sandboxId: null,
          commandId: command.id,
          sourceEventId: item.sourceEventId,
          eventType: item.eventType,
          sequence: events.length + 1,
          severity: item.severity,
          safePayloadJson: item.safePayload,
          encryptedPayloadJson: item.encryptedPayload,
          createdAt: new Date(),
        };
        events.push(event);
        accepted.push(event);
      }
      command.status = input.status;
      command.phase = input.phase;
      command.encryptedResultJson = input.encryptedResult;
      command.safeResultJson = input.safeResult;
      command.failureCode = input.failureCode;
      command.startedAt ??= new Date();
      command.completedAt = input.status === "running" ? null : new Date();
      command.updatedAt = new Date();
      let interruptApplied = false;
      if (
        command.action === "turn_interrupt" &&
        input.status === "succeeded" &&
        input.interruptTargetCommandId
      ) {
        const target = commands.find(
          (candidate) =>
            candidate.id === input.interruptTargetCommandId &&
            candidate.sessionId === command.sessionId &&
            candidate.action === "prompt_send",
        );
        if (target && ["pending", "claimed", "running"].includes(target.status)) {
          target.status = "cancelled";
          target.phase = "interrupted";
          target.claimOwner = null;
          target.claimExpiresAt = null;
          target.failureCode = null;
          target.completedAt = new Date();
          target.updatedAt = new Date();
          interruptApplied = true;
        } else {
          interruptApplied = target?.status === "cancelled";
        }
      }
      session.status = command.action === "turn_interrupt" && input.status === "succeeded"
        ? interruptApplied
          ? "interrupted"
          : commands.some(
              (candidate) =>
                candidate.sessionId === command.sessionId &&
                candidate.action !== "turn_interrupt" &&
                ["pending", "claimed", "running"].includes(candidate.status),
            )
            ? "active"
            : "idle"
        : input.status === "running"
          ? "active"
          : input.status === "cancelled"
            ? "interrupted"
            : input.status === "failed"
              ? "failed"
              : "idle";
      session.updatedAt = new Date();
      return { command, events: accepted };
    },
  };
}
