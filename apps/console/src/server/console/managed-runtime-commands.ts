import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { canAccessProject, type ProjectAuthorizationCheck } from "@/server/console/project-access";
import { isUuidRef } from "@/server/console/ref";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  managedRuntimeContentCodec,
  type ManagedRuntimeContentCodec,
  type ManagedRuntimeContentScope,
} from "./managed-runtime-content";
import { ManagedRuntimeError } from "./managed-runtime";
import { reconcileRaviControlCommandReport } from "./ravi-control-chat";

const COMMAND_ACTIONS = [
  "session_sync",
  "prompt_send",
  "turn_interrupt",
  "chat_message_create",
  "chat_sync",
] as const;
const LEGACY_COMMAND_API_ACTIONS = [
  "session_sync",
  "prompt_send",
  "turn_interrupt",
] as const;
const COMMAND_STATUSES = [
  "pending",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const REPORT_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLAIM_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9._-]{1,119}$/;
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|credential|password|private.?key|prompt|response|secret|text|token)/i;
const MAX_PROMPT_LENGTH = 32_000;
const MAX_SAFE_JSON_BYTES = 16 * 1024;
const MAX_EVENTS_PER_REPORT = 64;
const PRIMARY_SESSION_KEY = "managed-ravi";

type CommandAction = (typeof COMMAND_ACTIONS)[number];
type CommandStatus = (typeof COMMAND_STATUSES)[number];
type SessionRecord = typeof schema.managedRuntimeSessions.$inferSelect;
type CommandRecord = typeof schema.managedRuntimeCommands.$inferSelect;
type EventRecord = typeof schema.managedRuntimeEvents.$inferSelect;

type ProjectRecord = Pick<
  typeof schema.projects.$inferSelect,
  "id" | "organizationId"
>;
type ProjectMembershipRecord = Pick<
  typeof schema.projectMemberships.$inferSelect,
  "role" | "status"
>;
type InstanceAuthority = Pick<
  typeof schema.managedRuntimeInstances.$inferSelect,
  | "hostId"
  | "id"
  | "observedState"
  | "organizationId"
  | "projectId"
  | "runtimeModel"
  | "runtimeProvider"
> & {
  connectionStatus: string | null;
};

type CreateCommandInput = {
  action: CommandAction;
  actorId: string;
  actorType: "anonymous" | "user";
  commandId: string;
  encryptedInput: JsonRecord;
  idempotencyKey: string;
  instance: InstanceAuthority;
  requestId: string;
  session: SessionRecord;
};

type EncryptedEventInput = {
  encryptedPayload: JsonRecord;
  eventType: string;
  occurredAt: Date;
  safePayload: JsonRecord;
  severity: "debug" | "info" | "warning" | "error";
  sourceEventId: string;
};

type ReportCommandInput = {
  claimOwner: string;
  commandId: string;
  encryptedEvents: EncryptedEventInput[];
  encryptedResult: JsonRecord | null;
  failureCode: string | null;
  interruptTargetCommandId: string | null;
  phase: string;
  safeResult: JsonRecord | null;
  status: (typeof REPORT_STATUSES)[number];
};

export function isIdempotentTerminalCommandReport(
  current: Pick<CommandRecord, "action" | "claimOwner" | "phase" | "status">,
  input: Pick<ReportCommandInput, "claimOwner" | "phase" | "status">,
): boolean {
  if (current.status !== input.status) return false;
  if (current.claimOwner === input.claimOwner) return true;
  return (
    current.action === "prompt_send" &&
    current.claimOwner === null &&
    current.phase === "interrupted" &&
    current.status === "cancelled" &&
    input.phase === "interrupted"
  );
}

export type ManagedRuntimeCommandsRepository = {
  authorizeProject?: ProjectAuthorizationCheck;
  claimCommand(input: {
    claimOwner: string;
    claimTtlSeconds: number;
    hostId: string;
    now: Date;
  }): Promise<{ command: CommandRecord; instance: InstanceAuthority; session: SessionRecord } | null>;
  createCommand(input: CreateCommandInput): Promise<CommandRecord>;
  ensurePrimarySession(instance: InstanceAuthority): Promise<SessionRecord>;
  findActiveCommand(input: {
    actions: CommandAction[];
    sessionId: string;
  }): Promise<CommandRecord | null>;
  findCommandById(commandId: string): Promise<CommandRecord | null>;
  findCommandByIdempotency(input: {
    action: CommandAction;
    idempotencyKey: string;
    organizationId: string;
  }): Promise<CommandRecord | null>;
  findInstance(input: {
    instanceId: string;
    organizationId: string;
    projectId: string;
  }): Promise<InstanceAuthority | null>;
  findProjectByRef(
    organizationId: string,
    projectRef: string,
  ): Promise<ProjectRecord | null>;
  findProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<ProjectMembershipRecord | null>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listCommands(sessionId: string): Promise<CommandRecord[]>;
  listEvents(input: {
    afterSequence: number;
    limit: number;
    sessionId: string;
  }): Promise<EventRecord[]>;
  reportCommand(input: ReportCommandInput): Promise<{
    command: CommandRecord;
    events: EventRecord[];
  }>;
};

const commandInputSchema = z
  .object({
    action: z.enum(LEGACY_COMMAND_API_ACTIONS),
    idempotencyKey: z.string().trim().regex(IDEMPOTENCY_PATTERN),
    prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "prompt_send" && !value.prompt) {
      context.addIssue({
        code: "custom",
        message: "prompt_required",
        path: ["prompt"],
      });
    }
    if (value.action !== "prompt_send" && value.prompt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "prompt_not_allowed",
        path: ["prompt"],
      });
    }
  });

const claimCommandSchema = z
  .object({
    claimOwner: z.string().trim().regex(CLAIM_OWNER_PATTERN),
    claimTtlSeconds: z.number().int().min(15).max(300),
    hostId: z.string().uuid(),
  })
  .strict();

const eventSchema = z
  .object({
    sourceEventId: z.string().trim().regex(EVENT_REF_PATTERN),
    eventType: z.string().trim().regex(SAFE_CODE_PATTERN),
    severity: z.enum(["debug", "info", "warning", "error"]).default("info"),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const reportCommandSchema = z
  .object({
    claimOwner: z.string().trim().regex(CLAIM_OWNER_PATTERN),
    commandId: z.string().uuid(),
    events: z.array(eventSchema).max(MAX_EVENTS_PER_REPORT).default([]),
    failureCode: z.string().trim().regex(SAFE_CODE_PATTERN).nullable().optional(),
    phase: z.string().trim().regex(SAFE_CODE_PATTERN),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    safeResult: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(REPORT_STATUSES),
  })
  .strict();

export async function getManagedRaviSession(input: {
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: ManagedRuntimeCommandsRepository;
  sessionId?: string;
  workspace: ConsoleWorkspace;
}) {
  assertOptionalSessionId(input.sessionId);
  const repository = input.repository ?? managedRuntimeCommandsRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: "read",
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  const session = input.sessionId
    ? await repository.getSession(input.sessionId)
    : await repository.ensurePrimarySession(instance);
  assertSessionScope(session, instance);
  const codec = input.codec ?? managedRuntimeContentCodec();
  const commands = await repository.listCommands(session.id);
  const events = await repository.listEvents({
    afterSequence: 0,
    limit: 1,
    sessionId: session.id,
  });
  return {
    version: 1 as const,
    session: publicSessionView(session),
    commands: commands.map((command) =>
      publicCommandView(command, session, codec),
    ),
    latestEventSequence: events.at(-1)?.sequence ?? 0,
  };
}

export async function enqueueManagedRaviCommand(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: ManagedRuntimeCommandsRepository;
  requestId: string;
  sessionId?: string;
  workspace: ConsoleWorkspace;
}) {
  assertOptionalSessionId(input.sessionId);
  const parsed = parseConsole(commandInputSchema, input.body);
  const action = parsed.action;
  const access = action === "session_sync" ? "read" : "write";
  const repository = input.repository ?? managedRuntimeCommandsRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: access,
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  assertInstanceCanAcceptCommand(instance);
  const session = input.sessionId
    ? await repository.getSession(input.sessionId)
    : await repository.ensurePrimarySession(instance);
  assertSessionScope(session, instance);

  const existing = await repository.findCommandByIdempotency({
    action,
    idempotencyKey: parsed.idempotencyKey,
    organizationId: instance.organizationId,
  });
  if (existing) {
    if (existing.instanceId !== instance.id || existing.sessionId !== session.id) {
      throw new ConsoleApiError(409, {
        error: "managed_runtime_command_idempotency_conflict",
      });
    }
    return {
      version: 1 as const,
      command: publicCommandView(
        existing,
        session,
        input.codec ?? managedRuntimeContentCodec(),
      ),
    };
  }

  const active = await repository.findActiveCommand({
    actions:
      action === "turn_interrupt"
        ? ["turn_interrupt"]
        : ["session_sync", "prompt_send", "chat_message_create", "chat_sync"],
    sessionId: session.id,
  });
  if (active) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_session_busy",
    });
  }
  const interruptTarget = action === "turn_interrupt"
    ? await repository.findActiveCommand({
        actions: ["chat_message_create", "prompt_send"],
        sessionId: session.id,
      })
    : null;
  if (action === "turn_interrupt" && !interruptTarget) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_no_active_turn",
    });
  }

  const commandId = randomUUID();
  const codec = input.codec ?? managedRuntimeContentCodec();
  const commandInput = action === "prompt_send"
    ? { sessionKey: session.sessionKey, prompt: parsed.prompt }
    : action === "turn_interrupt"
      ? {
          sessionKey: session.sessionKey,
          targetCommandId: interruptTarget!.id,
        }
      : { sessionKey: session.sessionKey };
  const encryptedInput = codec.encrypt(
    commandInput,
    contentScope(instance, session.id, commandId, "command_input"),
  );
  const command = await repository.createCommand({
    action,
    actorId: input.workspace.user.id,
    actorType: input.workspace.mode === "anonymous" ? "anonymous" : "user",
    commandId,
    encryptedInput,
    idempotencyKey: parsed.idempotencyKey,
    instance,
    requestId: input.requestId,
    session,
  });
  return {
    version: 1 as const,
    command: publicCommandView(command, session, codec),
  };
}

type SessionReadInput = {
  instanceId: string;
  projectRef: string;
  repository?: ManagedRuntimeCommandsRepository;
  sessionId: string;
  workspace: ConsoleWorkspace;
};

async function resolveManagedRaviSessionReadAccess(input: SessionReadInput) {
  if (!isUuidRef(input.sessionId)) {
    throw new ConsoleApiError(404, {
      error: "managed_runtime_session_not_found",
    });
  }
  const repository = input.repository ?? managedRuntimeCommandsRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: "read",
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  const session = await repository.getSession(input.sessionId);
  assertSessionScope(session, instance);
  return { instance, session, repository };
}

/** Read-only scope check: no session creation, event read or runtime dispatch. */
export async function assertManagedRaviSessionReadAccess(input: SessionReadInput) {
  const { session } = await resolveManagedRaviSessionReadAccess(input);
  if (!session.projectId) throw new ConsoleApiError(404, { error: "project_not_found" });
  return { projectId: session.projectId };
}

export async function listManagedRaviSessionEvents(input: SessionReadInput & {
  afterSequence?: number;
  codec?: ManagedRuntimeContentCodec;
  limit?: number;
}) {
  const { repository, session } = await resolveManagedRaviSessionReadAccess(input);
  const events = await repository.listEvents({
    afterSequence: Math.max(0, input.afterSequence ?? 0),
    limit: Math.min(100, Math.max(1, input.limit ?? 100)),
    sessionId: session.id,
  });
  const codec = input.codec ?? managedRuntimeContentCodec();
  return {
    version: 1 as const,
    items: events.map((event) => publicEventView(event, session, codec)),
    nextSequence: events.at(-1)?.sequence ?? input.afterSequence ?? 0,
  };
}

export async function claimManagedRaviCommand(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  repository?: ManagedRuntimeCommandsRepository;
}) {
  const parsed = parseInternal(claimCommandSchema, input.body);
  const repository = input.repository ?? managedRuntimeCommandsRepositoryForDb();
  const claimed = await repository.claimCommand({
    ...parsed,
    now: new Date(),
  });
  if (!claimed) {
    return { version: 1 as const, claimed: false, command: null };
  }
  const codec = input.codec ?? managedRuntimeContentCodec();
  const decryptedInput = codec.decrypt(
    claimed.command.encryptedInputJson,
    contentScope(
      claimed.instance,
      claimed.session.id,
      claimed.command.id,
      "command_input",
    ),
  );
  return {
    version: 1 as const,
    claimed: true,
    command: {
      id: claimed.command.id,
      organizationId: claimed.command.organizationId,
      projectId: claimed.command.projectId,
      instanceId: claimed.command.instanceId,
      sessionId: claimed.session.id,
      sessionKey: claimed.session.sessionKey,
      action: claimed.command.action,
      status: claimed.command.status,
      attemptCount: claimed.command.attemptCount,
      claimExpiresAt: claimed.command.claimExpiresAt?.toISOString() ?? null,
      input: decryptedInput,
    },
  };
}

export async function reportManagedRaviCommand(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  repository?: ManagedRuntimeCommandsRepository;
}) {
  const parsed = parseInternal(reportCommandSchema, input.body);
  if (parsed.status === "failed" && !parsed.failureCode) {
    throw new ManagedRuntimeError(400, "managed_runtime_command_failure_code_required");
  }
  if (parsed.status !== "failed" && parsed.failureCode) {
    throw new ManagedRuntimeError(400, "managed_runtime_command_failure_code_not_allowed");
  }
  const repository = input.repository ?? managedRuntimeCommandsRepositoryForDb();
  const command = await repository.findCommandById(parsed.commandId);
  if (!command) {
    throw new ManagedRuntimeError(404, "managed_runtime_command_not_found");
  }
  const session = command.sessionId
    ? await repository.getSession(command.sessionId)
    : null;
  if (!session) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_session_missing");
  }
  if (!command.projectId) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_project_missing");
  }
  const instance = await repository.findInstance({
    instanceId: command.instanceId,
    organizationId: command.organizationId,
    projectId: command.projectId,
  });
  if (!instance) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_instance_missing");
  }
  const codec = input.codec ?? managedRuntimeContentCodec();
  const encryptedResult = parsed.result
    ? codec.encrypt(
        parsed.result,
        contentScope(instance, session.id, command.id, "command_result"),
      )
    : null;
  const encryptedEvents = parsed.events.map((event) => ({
    encryptedPayload: codec.encrypt(
      event.payload,
      contentScope(instance, session.id, command.id, "session_event"),
    ),
    eventType: event.eventType,
    occurredAt: new Date(event.occurredAt),
    safePayload: {
      occurredAt: event.occurredAt,
      source: "private_ravi_sdk",
    },
    severity: event.severity,
    sourceEventId: event.sourceEventId,
  }));
  const safeResult = parsed.safeResult
    ? validateSafeRecord(parsed.safeResult)
    : null;
  const commandInput = codec.decrypt(
    command.encryptedInputJson,
    contentScope(instance, session.id, command.id, "command_input"),
  );
  const reported = await repository.reportCommand({
    claimOwner: parsed.claimOwner,
    commandId: command.id,
    encryptedEvents,
    encryptedResult,
    failureCode: parsed.failureCode ?? null,
    interruptTargetCommandId:
      command.action === "turn_interrupt"
        ? requireInterruptTargetCommandId(commandInput)
        : null,
    phase: parsed.phase,
    safeResult,
    status: parsed.status,
  });
  await reconcileRaviControlCommandReport({
    codec,
    command: reported.command,
    commandInput,
    failureCode: parsed.failureCode ?? null,
    result: parsed.result ?? null,
    status: parsed.status,
  });
  return {
    version: 1 as const,
    command: internalCommandStatusView(reported.command),
    acceptedEvents: reported.events.length,
  };
}

export function managedRuntimeCommandsRepositoryForDb(): ManagedRuntimeCommandsRepository {
  return {
    authorizeProject: canAccessProject,
    async findProjectByRef(organizationId, projectRef) {
      const whereRef = isUuidRef(projectRef)
        ? eq(schema.projects.id, projectRef)
        : eq(schema.projects.slug, projectRef);
      const [project] = await db
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, organizationId),
            whereRef,
            ne(schema.projects.status, "deleted"),
          ),
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
          ),
        )
        .limit(1);
      return membership ?? null;
    },

    async findInstance(input) {
      const [row] = await db
        .select({
          hostId: schema.managedRuntimeInstances.hostId,
          id: schema.managedRuntimeInstances.id,
          observedState: schema.managedRuntimeInstances.observedState,
          organizationId: schema.managedRuntimeInstances.organizationId,
          projectId: schema.managedRuntimeInstances.projectId,
          runtimeModel: schema.managedRuntimeInstances.runtimeModel,
          runtimeProvider: schema.managedRuntimeInstances.runtimeProvider,
          connectionStatus: schema.managedRuntimeConnections.status,
        })
        .from(schema.managedRuntimeInstances)
        .leftJoin(
          schema.managedRuntimeConnections,
          and(
            eq(
              schema.managedRuntimeConnections.instanceId,
              schema.managedRuntimeInstances.id,
            ),
            eq(schema.managedRuntimeConnections.kind, "private_ravi_sdk"),
          ),
        )
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
      return row ?? null;
    },

    async ensurePrimarySession(instance) {
      const now = new Date();
      await db
        .insert(schema.managedRuntimeSessions)
        .values({
          id: randomUUID(),
          organizationId: instance.organizationId,
          projectId: instance.projectId,
          instanceId: instance.id,
          hostId: instance.hostId,
          sessionKey: PRIMARY_SESSION_KEY,
          runtimeProvider: instance.runtimeProvider,
          runtimeModel: instance.runtimeModel,
          providerSessionStateJson: { agentId: PRIMARY_SESSION_KEY },
          status: instance.observedState === "ready" ? "idle" : "starting",
          startedAt: now,
        })
        .onConflictDoNothing();
      const [session] = await db
        .select()
        .from(schema.managedRuntimeSessions)
        .where(
          and(
            eq(schema.managedRuntimeSessions.instanceId, instance.id),
            eq(schema.managedRuntimeSessions.sessionKey, PRIMARY_SESSION_KEY),
          ),
        )
        .limit(1);
      if (!session) {
        throw new ManagedRuntimeError(503, "managed_runtime_session_create_failed");
      }
      return session;
    },

    async getSession(sessionId) {
      const [session] = await db
        .select()
        .from(schema.managedRuntimeSessions)
        .where(eq(schema.managedRuntimeSessions.id, sessionId))
        .limit(1);
      return session ?? null;
    },

    async findCommandById(commandId) {
      const [command] = await db
        .select()
        .from(schema.managedRuntimeCommands)
        .where(eq(schema.managedRuntimeCommands.id, commandId))
        .limit(1);
      return command ?? null;
    },

    async findCommandByIdempotency(input) {
      const [command] = await db
        .select()
        .from(schema.managedRuntimeCommands)
        .where(
          and(
            eq(schema.managedRuntimeCommands.organizationId, input.organizationId),
            eq(schema.managedRuntimeCommands.action, input.action),
            eq(schema.managedRuntimeCommands.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      return command ?? null;
    },

    async findActiveCommand(input) {
      const [command] = await db
        .select()
        .from(schema.managedRuntimeCommands)
        .where(
          and(
            eq(schema.managedRuntimeCommands.sessionId, input.sessionId),
            inArray(schema.managedRuntimeCommands.action, input.actions),
            inArray(schema.managedRuntimeCommands.status, [
              "pending",
              "claimed",
              "running",
            ]),
          ),
        )
        .orderBy(asc(schema.managedRuntimeCommands.createdAt))
        .limit(1);
      return command ?? null;
    },

    async createCommand(input) {
      return db.transaction(async (tx) => {
        const [command] = await tx
          .insert(schema.managedRuntimeCommands)
          .values({
            id: input.commandId,
            organizationId: input.instance.organizationId,
            projectId: input.instance.projectId,
            instanceId: input.instance.id,
            sessionId: input.session.id,
            actorType: input.actorType,
            actorId: input.actorId,
            action: input.action,
            idempotencyKey: input.idempotencyKey,
            encryptedInputJson: input.encryptedInput,
          })
          .onConflictDoNothing()
          .returning();
        if (!command) {
          const [replay] = await tx
            .select()
            .from(schema.managedRuntimeCommands)
            .where(
              and(
                eq(
                  schema.managedRuntimeCommands.organizationId,
                  input.instance.organizationId,
                ),
                eq(schema.managedRuntimeCommands.action, input.action),
                eq(
                  schema.managedRuntimeCommands.idempotencyKey,
                  input.idempotencyKey,
                ),
              ),
            )
            .limit(1);
          if (replay) return replay;
          throw new ConsoleApiError(409, {
            error: "managed_runtime_session_busy",
          });
        }
        await tx.insert(schema.auditEvents).values({
          organizationId: input.instance.organizationId,
          projectId: input.instance.projectId,
          actorType: input.actorType,
          actorId: input.actorId,
          targetType: "managed_runtime_command",
          targetId: command.id,
          action: "managed_runtime.command.requested",
          requestId: input.requestId,
          metadataJson: {
            action: input.action,
            instanceId: input.instance.id,
            sessionId: input.session.id,
          },
        });
        return command;
      });
    },

    async listCommands(sessionId) {
      return db
        .select()
        .from(schema.managedRuntimeCommands)
        .where(eq(schema.managedRuntimeCommands.sessionId, sessionId))
        .orderBy(desc(schema.managedRuntimeCommands.createdAt))
        .limit(100);
    },

    async listEvents(input) {
      const order = input.afterSequence === 0 && input.limit === 1 ? desc : asc;
      return db
        .select()
        .from(schema.managedRuntimeEvents)
        .where(
          and(
            eq(schema.managedRuntimeEvents.sessionId, input.sessionId),
            sql`${schema.managedRuntimeEvents.sequence} > ${input.afterSequence}`,
          ),
        )
        .orderBy(order(schema.managedRuntimeEvents.sequence))
        .limit(input.limit);
    },

    async claimCommand(input) {
      return db.transaction(async (tx) => {
        const hostInstanceIds = tx
          .select({ id: schema.managedRuntimeInstances.id })
          .from(schema.managedRuntimeInstances)
          .where(eq(schema.managedRuntimeInstances.hostId, input.hostId));
        const expiredPrompts = await tx
          .update(schema.managedRuntimeCommands)
          .set({
            claimExpiresAt: null,
            claimOwner: null,
            completedAt: input.now,
            failureCode: "managed_runtime_prompt_delivery_uncertain",
            phase: "delivery_uncertain",
            status: "failed",
            updatedAt: input.now,
          })
          .where(
            and(
              eq(schema.managedRuntimeCommands.action, "prompt_send"),
              inArray(schema.managedRuntimeCommands.status, ["claimed", "running"]),
              lte(schema.managedRuntimeCommands.claimExpiresAt, input.now),
              inArray(schema.managedRuntimeCommands.instanceId, hostInstanceIds),
            ),
          )
          .returning({
            id: schema.managedRuntimeCommands.id,
            instanceId: schema.managedRuntimeCommands.instanceId,
            organizationId: schema.managedRuntimeCommands.organizationId,
            projectId: schema.managedRuntimeCommands.projectId,
            sessionId: schema.managedRuntimeCommands.sessionId,
          });

        for (const command of expiredPrompts) {
          await tx.insert(schema.auditEvents).values({
            organizationId: command.organizationId,
            projectId: command.projectId,
            actorType: "system",
            actorId: input.claimOwner,
            targetType: "managed_runtime_command",
            targetId: command.id,
            action: "managed_runtime.command.failed",
            metadataJson: {
              action: "prompt_send",
              failureCode: "managed_runtime_prompt_delivery_uncertain",
              instanceId: command.instanceId,
              recovery: "expired_claim",
              sessionId: command.sessionId,
            },
          });
          if (!command.sessionId) continue;
          await recoverUncontendedUncertainSession(tx, {
            actorId: input.claimOwner,
            commandId: command.id,
            commandUpdatedAt: input.now,
            instanceId: command.instanceId,
            organizationId: command.organizationId,
            projectId: command.projectId,
            sessionId: command.sessionId,
          });
        }

        const legacyUncertainSessions = await tx
          .select({
            commandId: schema.managedRuntimeCommands.id,
            commandUpdatedAt: schema.managedRuntimeCommands.updatedAt,
            instanceId: schema.managedRuntimeCommands.instanceId,
            organizationId: schema.managedRuntimeCommands.organizationId,
            projectId: schema.managedRuntimeCommands.projectId,
            sessionId: schema.managedRuntimeCommands.sessionId,
          })
          .from(schema.managedRuntimeCommands)
          .innerJoin(
            schema.managedRuntimeSessions,
            eq(
              schema.managedRuntimeSessions.id,
              schema.managedRuntimeCommands.sessionId,
            ),
          )
          .where(
            and(
              eq(schema.managedRuntimeCommands.action, "prompt_send"),
              eq(schema.managedRuntimeCommands.status, "failed"),
              eq(
                schema.managedRuntimeCommands.failureCode,
                "managed_runtime_prompt_delivery_uncertain",
              ),
              eq(schema.managedRuntimeSessions.status, "active"),
              lte(
                schema.managedRuntimeSessions.updatedAt,
                schema.managedRuntimeCommands.updatedAt,
              ),
              inArray(schema.managedRuntimeCommands.instanceId, hostInstanceIds),
            ),
          )
          .orderBy(desc(schema.managedRuntimeCommands.updatedAt))
          .limit(100);
        const repairedSessionIds = new Set<string>();
        for (const command of legacyUncertainSessions) {
          if (!command.sessionId || repairedSessionIds.has(command.sessionId)) {
            continue;
          }
          repairedSessionIds.add(command.sessionId);
          await recoverUncontendedUncertainSession(tx, {
            actorId: input.claimOwner,
            commandId: command.commandId,
            commandUpdatedAt: command.commandUpdatedAt,
            instanceId: command.instanceId,
            organizationId: command.organizationId,
            projectId: command.projectId,
            sessionId: command.sessionId,
          });
        }

        const recoverableExpired = and(
          ne(schema.managedRuntimeCommands.action, "prompt_send"),
          inArray(schema.managedRuntimeCommands.status, ["claimed", "running"]),
          lte(schema.managedRuntimeCommands.claimExpiresAt, input.now),
        );
        const [row] = await tx
          .select({
            command: schema.managedRuntimeCommands,
            instance: {
              hostId: schema.managedRuntimeInstances.hostId,
              id: schema.managedRuntimeInstances.id,
              observedState: schema.managedRuntimeInstances.observedState,
              organizationId: schema.managedRuntimeInstances.organizationId,
              projectId: schema.managedRuntimeInstances.projectId,
              runtimeModel: schema.managedRuntimeInstances.runtimeModel,
              runtimeProvider: schema.managedRuntimeInstances.runtimeProvider,
              connectionStatus: schema.managedRuntimeConnections.status,
            },
            session: schema.managedRuntimeSessions,
          })
          .from(schema.managedRuntimeCommands)
          .innerJoin(
            schema.managedRuntimeInstances,
            eq(
              schema.managedRuntimeInstances.id,
              schema.managedRuntimeCommands.instanceId,
            ),
          )
          .innerJoin(
            schema.managedRuntimeSessions,
            eq(
              schema.managedRuntimeSessions.id,
              schema.managedRuntimeCommands.sessionId,
            ),
          )
          .leftJoin(
            schema.managedRuntimeConnections,
            and(
              eq(
                schema.managedRuntimeConnections.instanceId,
                schema.managedRuntimeInstances.id,
              ),
              eq(schema.managedRuntimeConnections.kind, "private_ravi_sdk"),
            ),
          )
          .where(
            and(
              eq(schema.managedRuntimeInstances.hostId, input.hostId),
              eq(schema.managedRuntimeInstances.observedState, "ready"),
              eq(schema.managedRuntimeConnections.status, "online"),
              or(
                eq(schema.managedRuntimeCommands.status, "pending"),
                recoverableExpired,
              ),
            ),
          )
          .orderBy(asc(schema.managedRuntimeCommands.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return null;

        const [command] = await tx
          .update(schema.managedRuntimeCommands)
          .set({
            attemptCount: row.command.attemptCount + 1,
            claimOwner: input.claimOwner,
            claimExpiresAt: new Date(
              input.now.getTime() + input.claimTtlSeconds * 1_000,
            ),
            status: "claimed",
            updatedAt: input.now,
          })
          .where(eq(schema.managedRuntimeCommands.id, row.command.id))
          .returning();
        if (!command) {
          throw new ManagedRuntimeError(409, "managed_runtime_command_claim_failed");
        }
        return { command, instance: row.instance, session: row.session };
      });
    },

    async reportCommand(input) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [current] = await tx
          .select()
          .from(schema.managedRuntimeCommands)
          .where(eq(schema.managedRuntimeCommands.id, input.commandId))
          .limit(1)
          .for("update");
        if (!current) {
          throw new ManagedRuntimeError(404, "managed_runtime_command_not_found");
        }
        if (
          new Set<CommandStatus>(["succeeded", "failed", "cancelled"]).has(
            current.status,
          )
        ) {
          if (isIdempotentTerminalCommandReport(current, input)) {
            return { command: current, events: [] };
          }
          throw new ManagedRuntimeError(409, "managed_runtime_command_terminal");
        }
        assertCommandClaim(current, input.claimOwner, now);
        if (!current.sessionId) {
          throw new ManagedRuntimeError(409, "managed_runtime_command_session_missing");
        }

        const [cursor] = await tx
          .select({
            next: sql<number>`coalesce(max(${schema.managedRuntimeEvents.sequence}), 0) + 1`,
          })
          .from(schema.managedRuntimeEvents)
          .where(eq(schema.managedRuntimeEvents.sessionId, current.sessionId));
        let sequence = Number(cursor?.next ?? 1);
        const accepted: EventRecord[] = [];
        for (const event of input.encryptedEvents) {
          const [stored] = await tx
            .insert(schema.managedRuntimeEvents)
            .values({
              organizationId: current.organizationId,
              sessionId: current.sessionId,
              hostId: null,
              commandId: current.id,
              sourceEventId: event.sourceEventId,
              eventType: event.eventType,
              sequence,
              severity: event.severity,
              safePayloadJson: event.safePayload,
              encryptedPayloadJson: event.encryptedPayload,
              createdAt: now,
            })
            .onConflictDoNothing()
            .returning();
          if (stored) {
            accepted.push(stored);
            sequence += 1;
          }
        }

        const terminal = input.status !== "running";
        const [command] = await tx
          .update(schema.managedRuntimeCommands)
          .set({
            claimExpiresAt: terminal ? null : new Date(now.getTime() + 60_000),
            completedAt: terminal ? now : null,
            encryptedResultJson: input.encryptedResult,
            failureCode: input.failureCode,
            phase: input.phase,
            safeResultJson: input.safeResult,
            startedAt: current.startedAt ?? now,
            status: input.status,
            updatedAt: now,
          })
          .where(eq(schema.managedRuntimeCommands.id, current.id))
          .returning();
        if (!command) {
          throw new ManagedRuntimeError(409, "managed_runtime_command_report_failed");
        }

        let interruptApplied = false;
        if (
          current.action === "turn_interrupt" &&
          input.status === "succeeded" &&
          input.interruptTargetCommandId
        ) {
          const [cancelledPrompt] = await tx
            .update(schema.managedRuntimeCommands)
            .set({
              claimExpiresAt: null,
              claimOwner: null,
              completedAt: now,
              failureCode: null,
              phase: "interrupted",
              status: "cancelled",
              updatedAt: now,
            })
            .where(
              and(
                eq(
                  schema.managedRuntimeCommands.id,
                  input.interruptTargetCommandId,
                ),
                eq(schema.managedRuntimeCommands.sessionId, current.sessionId),
                inArray(schema.managedRuntimeCommands.action, [
                  "prompt_send",
                  "chat_message_create",
                ]),
                inArray(schema.managedRuntimeCommands.status, [
                  "pending",
                  "claimed",
                  "running",
                ]),
              ),
            )
            .returning();
          if (cancelledPrompt) {
            interruptApplied = true;
            await tx.insert(schema.auditEvents).values({
              organizationId: current.organizationId,
              projectId: current.projectId,
              actorType: "system",
              actorId: input.claimOwner,
              targetType: "managed_runtime_command",
              targetId: cancelledPrompt.id,
              action: "managed_runtime.command.cancelled",
              metadataJson: {
                action: cancelledPrompt.action,
                interruptedByCommandId: current.id,
                instanceId: current.instanceId,
                sessionId: current.sessionId,
              },
            });
          } else {
            const [target] = await tx
              .select({ status: schema.managedRuntimeCommands.status })
              .from(schema.managedRuntimeCommands)
              .where(
                and(
                  eq(
                    schema.managedRuntimeCommands.id,
                    input.interruptTargetCommandId,
                  ),
                  eq(schema.managedRuntimeCommands.sessionId, current.sessionId),
                  inArray(schema.managedRuntimeCommands.action, [
                    "prompt_send",
                    "chat_message_create",
                  ]),
                ),
              )
              .limit(1);
            interruptApplied = target?.status === "cancelled";
          }
        }

        let sessionStatus: SessionRecord["status"] =
          input.status === "failed"
            ? "failed"
            : input.status === "cancelled"
              ? "interrupted"
              : input.status === "running"
                ? "active"
                : "idle";
        if (current.action === "turn_interrupt" && input.status === "succeeded") {
          if (interruptApplied) {
            sessionStatus = "interrupted";
          } else {
            const [activeExecution] = await tx
              .select({ id: schema.managedRuntimeCommands.id })
              .from(schema.managedRuntimeCommands)
              .where(
                and(
                  eq(schema.managedRuntimeCommands.sessionId, current.sessionId),
                  ne(schema.managedRuntimeCommands.action, "turn_interrupt"),
                  inArray(schema.managedRuntimeCommands.status, [
                    "pending",
                    "claimed",
                    "running",
                  ]),
                ),
              )
              .limit(1);
            sessionStatus = activeExecution ? "active" : "idle";
          }
        }

        await tx
          .update(schema.managedRuntimeSessions)
          .set({
            status: sessionStatus,
            startedAt: sql`coalesce(${schema.managedRuntimeSessions.startedAt}, ${sql.param(now, schema.managedRuntimeSessions.startedAt)})`,
            endedAt: null,
            updatedAt: now,
          })
          .where(eq(schema.managedRuntimeSessions.id, current.sessionId));

        if (terminal) {
          await tx.insert(schema.auditEvents).values({
            organizationId: current.organizationId,
            projectId: current.projectId,
            actorType: "system",
            actorId: input.claimOwner,
            targetType: "managed_runtime_command",
            targetId: current.id,
            action: `managed_runtime.command.${input.status}`,
            metadataJson: {
              action: current.action,
              acceptedEvents: accepted.length,
              failureCode: input.failureCode,
              instanceId: current.instanceId,
              sessionId: current.sessionId,
            },
          });
        }
        return { command, events: accepted };
      });
    },
  };
}

async function recoverUncontendedUncertainSession(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    actorId: string;
    commandId: string;
    commandUpdatedAt: Date;
    instanceId: string;
    organizationId: string;
    projectId: string | null;
    sessionId: string;
  },
): Promise<void> {
  const [active] = await tx
    .select({ id: schema.managedRuntimeCommands.id })
    .from(schema.managedRuntimeCommands)
    .where(
      and(
        eq(schema.managedRuntimeCommands.sessionId, input.sessionId),
        inArray(schema.managedRuntimeCommands.status, [
          "pending",
          "claimed",
          "running",
        ]),
      ),
    )
    .limit(1);
  if (active) return;

  const [session] = await tx
    .update(schema.managedRuntimeSessions)
    .set({
      status: "failed",
      updatedAt: input.commandUpdatedAt,
    })
    .where(
      and(
        eq(schema.managedRuntimeSessions.id, input.sessionId),
        eq(schema.managedRuntimeSessions.status, "active"),
        lte(schema.managedRuntimeSessions.updatedAt, input.commandUpdatedAt),
      ),
    )
    .returning({ id: schema.managedRuntimeSessions.id });
  if (!session) return;

  await tx.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorType: "system",
    actorId: input.actorId,
    targetType: "managed_runtime_session",
    targetId: input.sessionId,
    action: "managed_runtime.session.recovered_failed",
    metadataJson: {
      failureCode: "managed_runtime_prompt_delivery_uncertain",
      instanceId: input.instanceId,
      sourceCommandId: input.commandId,
    },
  });
}

async function requireInstanceAccess(input: {
  action: "read" | "write";
  instanceId: string;
  projectRef: string;
  repository: ManagedRuntimeCommandsRepository;
  workspace: ConsoleWorkspace;
}): Promise<InstanceAuthority> {
  const project = await input.repository.findProjectByRef(
    input.workspace.organization.id,
    input.projectRef,
  );
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  const allowed = await input.repository.authorizeProject?.(input.workspace, project.id, input.action);
  if (!allowed) throw new ConsoleApiError(403, { error: "project_forbidden" });
  const instance = await input.repository.findInstance({
    instanceId: input.instanceId,
    organizationId: input.workspace.organization.id,
    projectId: project.id,
  });
  if (!instance) {
    throw new ConsoleApiError(404, {
      error: "managed_runtime_instance_not_found",
    });
  }
  return instance;
}

function assertInstanceCanAcceptCommand(instance: InstanceAuthority): void {
  if (
    instance.runtimeProvider !== "codex" ||
    instance.observedState !== "ready" ||
    instance.connectionStatus !== "online"
  ) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_instance_not_ready",
    });
  }
}

function assertOptionalSessionId(sessionId: string | undefined): void {
  if (
    sessionId !== undefined &&
    sessionId !== "current" &&
    !isUuidRef(sessionId)
  ) {
    throw new ConsoleApiError(404, {
      error: "managed_runtime_session_not_found",
    });
  }
}

function assertSessionScope(
  session: SessionRecord | null,
  instance: InstanceAuthority,
): asserts session is SessionRecord {
  if (
    !session ||
    session.organizationId !== instance.organizationId ||
    session.projectId !== instance.projectId ||
    session.instanceId !== instance.id
  ) {
    throw new ConsoleApiError(404, {
      error: "managed_runtime_session_not_found",
    });
  }
}

function contentScope(
  instance: InstanceAuthority,
  sessionId: string,
  commandId: string,
  purpose: ManagedRuntimeContentScope["purpose"],
): ManagedRuntimeContentScope {
  return {
    organizationId: instance.organizationId,
    projectId: instance.projectId,
    instanceId: instance.id,
    sessionId,
    commandId,
    purpose,
  };
}

function publicSessionView(session: SessionRecord) {
  return {
    id: session.id,
    instanceId: session.instanceId,
    sessionKey: session.sessionKey,
    runtimeProvider: session.runtimeProvider,
    runtimeModel: session.runtimeModel,
    status: session.status,
    startedAt: session.startedAt?.toISOString() ?? null,
    updatedAt: session.updatedAt.toISOString(),
  };
}

function publicCommandView(
  command: CommandRecord,
  session: SessionRecord,
  codec: ManagedRuntimeContentCodec,
) {
  const authority = sessionAuthority(session);
  return {
    ...internalCommandStatusView(command),
    input: codec.decrypt(
      command.encryptedInputJson,
      contentScope(authority, session.id, command.id, "command_input"),
    ),
    result: command.encryptedResultJson
      ? codec.decrypt(
          command.encryptedResultJson,
          contentScope(authority, session.id, command.id, "command_result"),
        )
      : null,
  };
}

function publicEventView(
  event: EventRecord,
  session: SessionRecord,
  codec: ManagedRuntimeContentCodec,
) {
  if (!event.commandId || !event.encryptedPayloadJson) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_event_content_unavailable",
    });
  }
  const authority = sessionAuthority(session);
  return {
    id: event.id,
    commandId: event.commandId,
    eventType: event.eventType,
    sequence: event.sequence,
    severity: event.severity,
    payload: codec.decrypt(
      event.encryptedPayloadJson,
      contentScope(authority, session.id, event.commandId, "session_event"),
    ),
    createdAt: event.createdAt.toISOString(),
  };
}

function sessionAuthority(session: SessionRecord): InstanceAuthority {
  if (!session.instanceId) {
    throw new ConsoleApiError(409, {
      error: "managed_runtime_session_instance_missing",
    });
  }
  return {
    connectionStatus: null,
    hostId: session.hostId,
    id: session.instanceId,
    observedState: "ready",
    organizationId: session.organizationId,
    projectId: session.projectId,
    runtimeModel: session.runtimeModel,
    runtimeProvider: session.runtimeProvider,
  };
}

function internalCommandStatusView(command: CommandRecord) {
  return {
    id: command.id,
    instanceId: command.instanceId,
    sessionId: command.sessionId,
    action: command.action,
    status: command.status,
    phase: command.phase,
    attemptCount: command.attemptCount,
    failureCode: command.failureCode,
    startedAt: command.startedAt?.toISOString() ?? null,
    completedAt: command.completedAt?.toISOString() ?? null,
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString(),
  };
}

function requireInterruptTargetCommandId(input: unknown): string {
  const targetCommandId =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).targetCommandId
      : null;
  if (typeof targetCommandId !== "string" || !isUuidRef(targetCommandId)) {
    throw new ManagedRuntimeError(
      409,
      "managed_runtime_interrupt_target_invalid",
    );
  }
  return targetCommandId;
}

function assertCommandClaim(
  command: CommandRecord,
  claimOwner: string,
  now: Date,
): void {
  if (new Set<CommandStatus>(["succeeded", "failed", "cancelled"]).has(command.status)) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_terminal");
  }
  if (command.claimOwner !== claimOwner) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_claim_owner_mismatch");
  }
  if (!command.claimExpiresAt || command.claimExpiresAt <= now) {
    throw new ManagedRuntimeError(409, "managed_runtime_command_claim_expired");
  }
}

function validateSafeRecord(value: Record<string, unknown>): JsonRecord {
  const encoded = JSON.stringify(value);
  if (
    Buffer.byteLength(encoded, "utf8") > MAX_SAFE_JSON_BYTES ||
    hasSensitiveKey(value)
  ) {
    throw new ManagedRuntimeError(400, "managed_runtime_command_safe_result_invalid");
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

function parseConsole<T extends z.ZodTypeAny>(
  schemaDef: T,
  body: unknown,
): z.infer<T> {
  const result = schemaDef.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "managed_runtime_command_payload_invalid",
    });
  }
  return result.data;
}

function parseInternal<T extends z.ZodTypeAny>(
  schemaDef: T,
  body: unknown,
): z.infer<T> {
  const result = schemaDef.safeParse(body);
  if (!result.success) {
    throw new ManagedRuntimeError(400, "managed_runtime_command_payload_invalid");
  }
  return result.data;
}
