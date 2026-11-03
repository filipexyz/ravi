import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
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

const DEFAULT_AGENT_ID = "managed-ravi";
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLIENT_MESSAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const LOCAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const MAX_MESSAGE_LENGTH = 32_000;
const ACTIVE_COMMAND_STATUSES = new Set(["pending", "claimed", "running"]);

type InstanceRecord = Pick<
  typeof schema.managedRuntimeInstances.$inferSelect,
  | "displayName"
  | "hostId"
  | "id"
  | "observedState"
  | "organizationId"
  | "projectId"
  | "runtimeModel"
  | "runtimeProvider"
> & { connectionStatus: string | null };
type SessionRecord = typeof schema.managedRuntimeSessions.$inferSelect;
type BindingRecord = typeof schema.raviControlChatBindings.$inferSelect;
type MirrorRecord = typeof schema.raviControlMessageMirrors.$inferSelect;
type CommandRecord = typeof schema.managedRuntimeCommands.$inferSelect;

type ProjectRecord = Pick<
  typeof schema.projects.$inferSelect,
  "id" | "organizationId"
>;
type ProjectMembershipRecord = Pick<
  typeof schema.projectMemberships.$inferSelect,
  "role" | "status"
>;

const messageInputSchema = z
  .object({
    clientMessageId: z.string().trim().regex(CLIENT_MESSAGE_PATTERN),
    idempotencyKey: z.string().trim().regex(IDEMPOTENCY_PATTERN),
    replyToMessageId: z.string().trim().regex(LOCAL_REF_PATTERN).optional(),
    targetAgentId: z.string().trim().regex(LOCAL_REF_PATTERN).default(DEFAULT_AGENT_ID),
    text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  })
  .strict();

const syncInputSchema = z
  .object({
    idempotencyKey: z.string().trim().regex(IDEMPOTENCY_PATTERN),
    targetAgentId: z.string().trim().regex(LOCAL_REF_PATTERN).default(DEFAULT_AGENT_ID),
  })
  .strict();

const interruptInputSchema = syncInputSchema.extend({
  targetCommandId: z.string().uuid().optional(),
});

const canonicalReportSchema = z
  .object({
    binding: z.object({
      actorId: z.string().trim().regex(LOCAL_REF_PATTERN),
      chatId: z.string().trim().regex(LOCAL_REF_PATTERN),
      platformIdentityId: z.string().trim().regex(LOCAL_REF_PATTERN),
      sessionKey: z.string().trim().regex(LOCAL_REF_PATTERN),
    }),
    accepted: z
      .object({
        dispatchStatus: z.string().trim().max(40),
        duplicate: z.boolean(),
        messageId: z.string().trim().regex(LOCAL_REF_PATTERN),
      })
      .optional(),
    history: z.object({
      messages: z
        .array(
          z.object({
            actorType: z.string().trim().min(1).max(40),
            agentId: z.string().trim().max(200).optional(),
            content: z.record(z.string(), z.unknown()).optional(),
            createdAt: z.number().int().nonnegative(),
            id: z.string().trim().regex(LOCAL_REF_PATTERN),
            messageType: z.string().trim().max(80).optional(),
            platformIdentityId: z.string().trim().max(200).optional(),
            sortKey: z.string().trim().max(240),
          }),
        )
        .max(500),
    }),
  })
  .strict();

const boundCommandIdentitySchema = z
  .object({
    actorId: z.string().trim().regex(LOCAL_REF_PATTERN),
    agentId: z.string().trim().regex(LOCAL_REF_PATTERN),
    bindingId: z.string().uuid(),
    targetCommandId: z.string().uuid().nullable(),
  })
  .passthrough();

type CreateCommandInput = {
  action: "chat_message_create" | "chat_sync" | "turn_interrupt";
  actorId: string;
  actorType: "anonymous" | "user";
  binding: BindingRecord;
  commandId: string;
  encryptedInput: JsonRecord;
  idempotencyKey: string;
  instance: InstanceRecord;
  mirror?: {
    actorId: string;
    encryptedContent: JsonRecord;
    id: string;
    clientMessageId: string;
    replyToLocalMessageId: string | null;
  };
  requestId: string;
  session: SessionRecord;
};

export type RaviControlChatRepository = {
  authorizeProject?: ProjectAuthorizationCheck;
  createCommand(input: CreateCommandInput): Promise<{
    command: CommandRecord;
    created: boolean;
    mirror: MirrorRecord | null;
  }>;
  ensureBinding(input: {
    actorId: string;
    actorType: "anonymous" | "user";
    instance: InstanceRecord;
    targetAgentId: string;
  }): Promise<BindingRecord>;
  ensureSession(instance: InstanceRecord): Promise<SessionRecord>;
  findActiveCommand(input: {
    actions: Array<"chat_message_create" | "chat_sync" | "turn_interrupt">;
    sessionId: string;
  }): Promise<CommandRecord | null>;
  findBinding(input: {
    actorId: string;
    instanceId: string;
    organizationId: string;
    targetAgentId: string;
  }): Promise<BindingRecord | null>;
  findCommand(commandId: string): Promise<CommandRecord | null>;
  findInstance(input: {
    instanceId: string;
    organizationId: string;
    projectId: string;
  }): Promise<InstanceRecord | null>;
  findMirror(input: {
    bindingId: string;
    clientMessageId: string;
  }): Promise<MirrorRecord | null>;
  findProjectByRef(
    organizationId: string,
    projectRef: string,
  ): Promise<ProjectRecord | null>;
  findProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<ProjectMembershipRecord | null>;
  listMirrors(bindingId: string): Promise<MirrorRecord[]>;
};

export async function getRaviControlChat(input: {
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: RaviControlChatRepository;
  targetAgentId?: string;
  workspace: ConsoleWorkspace;
}) {
  const targetAgentId = requireLocalRef(
    input.targetAgentId ?? DEFAULT_AGENT_ID,
    "target_agent",
  );
  const repository = input.repository ?? raviControlChatRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: "read",
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  const binding = await repository.findBinding({
    actorId: input.workspace.user.id,
    instanceId: instance.id,
    organizationId: instance.organizationId,
    targetAgentId,
  });
  const codec = input.codec ?? managedRuntimeContentCodec();
  const mirrors = binding ? await repository.listMirrors(binding.id) : [];
  return {
    version: 1 as const,
    installation: publicInstallation(instance),
    binding: binding ? publicBinding(binding) : null,
    messages: binding
      ? mirrors.map((mirror) => publicMirror(mirror, binding, codec))
      : [],
  };
}

export async function sendRaviControlMessage(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: RaviControlChatRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const parsed = parseBody(messageInputSchema, input.body);
  const repository = input.repository ?? raviControlChatRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: "write",
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  assertInstanceReady(instance);
  const binding = await repository.ensureBinding({
    actorId: input.workspace.user.id,
    actorType: input.workspace.mode === "anonymous" ? "anonymous" : "user",
    instance,
    targetAgentId: parsed.targetAgentId,
  });
  const existing = await repository.findMirror({
    bindingId: binding.id,
    clientMessageId: parsed.clientMessageId,
  });
  if (existing) {
    if (!existing.commandId) {
      throw new ConsoleApiError(409, { error: "ravi_control_message_recovery_required" });
    }
    const command = await repository.findCommand(existing.commandId);
    if (!command) {
      throw new ConsoleApiError(409, { error: "ravi_control_message_recovery_required" });
    }
    return {
      version: 1 as const,
      duplicate: true,
      binding: publicBinding(binding),
      message: publicMirror(
        existing,
        binding,
        input.codec ?? managedRuntimeContentCodec(),
      ),
      operation: publicCommand(command),
    };
  }
  const session = await repository.ensureSession(instance);
  const active = await repository.findActiveCommand({
    actions: ["chat_message_create", "chat_sync"],
    sessionId: session.id,
  });
  if (active) {
    throw new ConsoleApiError(409, { error: "ravi_control_chat_busy" });
  }

  const commandId = randomUUID();
  const mirrorId = randomUUID();
  const codec = input.codec ?? managedRuntimeContentCodec();
  const commandPayload = {
    schemaVersion: "ravi.control.command/v1",
    bindingId: binding.id,
    organizationId: instance.organizationId,
    installationId: instance.id,
    actorId: input.workspace.user.id,
    actorName:
      input.workspace.user.displayName ?? input.workspace.user.primaryEmail,
    agentId: parsed.targetAgentId,
    chatId: binding.localChatId,
    sessionKey: binding.localSessionKey,
    clientMessageId: parsed.clientMessageId,
    replyToMessageId: parsed.replyToMessageId ?? null,
    text: parsed.text,
  };
  const encryptedInput = codec.encrypt(
    commandPayload,
    commandScope(instance, session.id, commandId, "command_input"),
  );
  const encryptedContent = codec.encrypt(
    { text: parsed.text },
    mirrorScope(instance, binding.id, mirrorId, input.workspace.user.id),
  );
  const created = await repository.createCommand({
    action: "chat_message_create",
    actorId: input.workspace.user.id,
    actorType: input.workspace.mode === "anonymous" ? "anonymous" : "user",
    binding,
    commandId,
    encryptedInput,
    idempotencyKey: parsed.idempotencyKey,
    instance,
    mirror: {
      actorId: input.workspace.user.id,
      clientMessageId: parsed.clientMessageId,
      encryptedContent,
      id: mirrorId,
      replyToLocalMessageId: parsed.replyToMessageId ?? null,
    },
    requestId: input.requestId,
    session,
  });
  if (!created.mirror) {
    throw new ManagedRuntimeError(409, "ravi_control_message_create_failed");
  }
  if (
    created.command.actorId !== input.workspace.user.id ||
    created.mirror.bindingId !== binding.id ||
    created.mirror.clientMessageId !== parsed.clientMessageId ||
    created.mirror.commandId !== created.command.id
  ) {
    throw new ConsoleApiError(409, {
      error: "ravi_control_operation_idempotency_conflict",
    });
  }
  return {
    version: 1 as const,
    duplicate: !created.created,
    binding: publicBinding(binding),
    message: publicMirror(created.mirror, binding, codec),
    operation: publicCommand(created.command),
  };
}

export async function syncRaviControlChat(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: RaviControlChatRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const parsed = parseBody(syncInputSchema, input.body);
  return enqueueBoundCommand({
    action: "chat_sync",
    access: "read",
    codec: input.codec,
    instanceId: input.instanceId,
    parsed,
    projectRef: input.projectRef,
    repository: input.repository,
    requestId: input.requestId,
    workspace: input.workspace,
  });
}

export async function interruptRaviControlTurn(input: {
  body: unknown;
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  projectRef: string;
  repository?: RaviControlChatRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const parsed = parseBody(interruptInputSchema, input.body);
  return enqueueBoundCommand({
    action: "turn_interrupt",
    access: "write",
    codec: input.codec,
    instanceId: input.instanceId,
    parsed,
    projectRef: input.projectRef,
    repository: input.repository,
    requestId: input.requestId,
    workspace: input.workspace,
  });
}

async function enqueueBoundCommand(input: {
  action: "chat_sync" | "turn_interrupt";
  access: "read" | "write";
  codec?: ManagedRuntimeContentCodec;
  instanceId: string;
  parsed: z.infer<typeof syncInputSchema> & { targetCommandId?: string };
  projectRef: string;
  repository?: RaviControlChatRepository;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const repository = input.repository ?? raviControlChatRepositoryForDb();
  const instance = await requireInstanceAccess({
    action: input.access,
    instanceId: input.instanceId,
    projectRef: input.projectRef,
    repository,
    workspace: input.workspace,
  });
  assertInstanceReady(instance);
  const binding = await repository.findBinding({
    actorId: input.workspace.user.id,
    instanceId: instance.id,
    organizationId: instance.organizationId,
    targetAgentId: input.parsed.targetAgentId,
  });
  if (!binding || binding.status !== "active" || !binding.localChatId || !binding.localSessionKey) {
    throw new ConsoleApiError(409, { error: "ravi_control_chat_not_ready" });
  }
  const session = await repository.ensureSession(instance);
  const target = input.action === "turn_interrupt"
    ? input.parsed.targetCommandId
      ? await repository.findCommand(input.parsed.targetCommandId)
      : await repository.findActiveCommand({
          actions: ["chat_message_create"],
          sessionId: session.id,
        })
    : null;
  if (
    input.action === "turn_interrupt" &&
    (!target ||
      target.action !== "chat_message_create" ||
      target.organizationId !== instance.organizationId ||
      target.instanceId !== instance.id ||
      target.sessionId !== session.id ||
      !ACTIVE_COMMAND_STATUSES.has(target.status))
  ) {
    throw new ConsoleApiError(409, { error: "ravi_control_no_active_turn" });
  }
  const active = await repository.findActiveCommand({
    actions: input.action === "turn_interrupt" ? ["turn_interrupt"] : ["chat_message_create", "chat_sync"],
    sessionId: session.id,
  });
  if (active) {
    throw new ConsoleApiError(409, { error: "ravi_control_chat_busy" });
  }
  const commandId = randomUUID();
  const codec = input.codec ?? managedRuntimeContentCodec();
  const payload = {
    schemaVersion: "ravi.control.command/v1",
    bindingId: binding.id,
    organizationId: instance.organizationId,
    installationId: instance.id,
    actorId: input.workspace.user.id,
    agentId: input.parsed.targetAgentId,
    chatId: binding.localChatId,
    sessionKey: binding.localSessionKey,
    localActorId: binding.localActorId,
    localPlatformIdentityId: binding.localPlatformIdentityId,
    targetCommandId: target?.id ?? null,
  };
  const created = await repository.createCommand({
    action: input.action,
    actorId: input.workspace.user.id,
    actorType: input.workspace.mode === "anonymous" ? "anonymous" : "user",
    binding,
    commandId,
    encryptedInput: codec.encrypt(
      payload,
      commandScope(instance, session.id, commandId, "command_input"),
    ),
    idempotencyKey: input.parsed.idempotencyKey,
    instance,
    requestId: input.requestId,
    session,
  });
  const identity = boundCommandIdentitySchema.safeParse(
    codec.decrypt(
      created.command.encryptedInputJson,
      commandScope(
        instance,
        session.id,
        created.command.id,
        "command_input",
      ),
    ),
  );
  if (
    !identity.success ||
    identity.data.actorId !== input.workspace.user.id ||
    identity.data.agentId !== input.parsed.targetAgentId ||
    identity.data.bindingId !== binding.id ||
    identity.data.targetCommandId !== (target?.id ?? null)
  ) {
    throw new ConsoleApiError(409, {
      error: "ravi_control_operation_idempotency_conflict",
    });
  }
  return {
    version: 1 as const,
    binding: publicBinding(binding),
    operation: publicCommand(created.command),
  };
}

export async function reconcileRaviControlCommandReport(input: {
  codec?: ManagedRuntimeContentCodec;
  command: CommandRecord;
  commandInput: unknown;
  failureCode: string | null;
  result: unknown;
  status: string;
}) {
  if (!new Set(["chat_message_create", "chat_sync"]).has(input.command.action)) {
    return;
  }
  const commandInput = z
    .object({
      actorId: z.string().trim().regex(LOCAL_REF_PATTERN),
      bindingId: z.string().uuid(),
      clientMessageId: z.string().trim().regex(CLIENT_MESSAGE_PATTERN).optional(),
    })
    .passthrough()
    .safeParse(input.commandInput);
  if (!commandInput.success) {
    throw new ManagedRuntimeError(409, "ravi_control_command_binding_invalid");
  }
  const [binding] = await db
    .select()
    .from(schema.raviControlChatBindings)
    .where(
      and(
        eq(schema.raviControlChatBindings.id, commandInput.data.bindingId),
        eq(schema.raviControlChatBindings.organizationId, input.command.organizationId),
        eq(schema.raviControlChatBindings.instanceId, input.command.instanceId),
        eq(schema.raviControlChatBindings.actorId, commandInput.data.actorId),
      ),
    )
    .limit(1);
  if (!binding) {
    throw new ManagedRuntimeError(409, "ravi_control_chat_binding_missing");
  }
  if (input.status === "failed" || input.status === "cancelled") {
    await db
      .update(schema.raviControlMessageMirrors)
      .set({
        failureCode: input.failureCode,
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.raviControlMessageMirrors.commandId, input.command.id));
    return;
  }
  if (input.status !== "succeeded") return;
  const parsed = canonicalReportSchema.safeParse(input.result);
  if (!parsed.success) {
    throw new ManagedRuntimeError(409, "ravi_control_canonical_report_invalid");
  }
  const now = new Date();
  const codec = input.codec ?? managedRuntimeContentCodec();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.raviControlChatBindings)
      .set({
        localActorId: parsed.data.binding.actorId,
        localChatId: parsed.data.binding.chatId,
        localPlatformIdentityId: parsed.data.binding.platformIdentityId,
        localSessionKey: parsed.data.binding.sessionKey,
        status: "active",
        lastSyncedAt: now,
        chatCursor: parsed.data.history.messages.at(-1)?.sortKey ?? binding.chatCursor,
        updatedAt: now,
      })
      .where(eq(schema.raviControlChatBindings.id, binding.id));

    if (parsed.data.accepted && commandInput.data.clientMessageId) {
      await tx
        .update(schema.raviControlMessageMirrors)
        .set({
          localMessageId: parsed.data.accepted.messageId,
          safeMetadataJson: {
            dispatchStatus: parsed.data.accepted.dispatchStatus,
            duplicate: parsed.data.accepted.duplicate,
          },
          status: "canonical",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.raviControlMessageMirrors.bindingId, binding.id),
            eq(
              schema.raviControlMessageMirrors.clientMessageId,
              commandInput.data.clientMessageId,
            ),
          ),
        );
    }

    for (const message of parsed.data.history.messages) {
      const [existing] = await tx
        .select()
        .from(schema.raviControlMessageMirrors)
        .where(
          and(
            eq(schema.raviControlMessageMirrors.bindingId, binding.id),
            eq(schema.raviControlMessageMirrors.localMessageId, message.id),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(schema.raviControlMessageMirrors)
          .set({
            cursor: message.sortKey,
            localCreatedAt: new Date(message.createdAt),
            status: "canonical",
            updatedAt: now,
          })
          .where(eq(schema.raviControlMessageMirrors.id, existing.id));
        continue;
      }
      const mirrorId = randomUUID();
      await tx
        .insert(schema.raviControlMessageMirrors)
        .values({
          id: mirrorId,
          organizationId: binding.organizationId,
          projectId: binding.projectId,
          instanceId: binding.instanceId,
          bindingId: binding.id,
          commandId: input.command.id,
          localMessageId: message.id,
          clientMessageId: `local:${message.id}`,
          actorType: message.actorType,
          actorId: message.platformIdentityId ?? message.agentId ?? null,
          status: "canonical",
          cursor: message.sortKey,
          encryptedContentJson: codec.encrypt(
            message.content ?? {},
            mirrorScope(
              {
                id: binding.instanceId,
                organizationId: binding.organizationId,
                projectId: binding.projectId,
              },
              binding.id,
              mirrorId,
              message.platformIdentityId ?? message.agentId ?? null,
            ),
          ),
          safeMetadataJson: {
            messageType: message.messageType ?? null,
          },
          localCreatedAt: new Date(message.createdAt),
        })
        .onConflictDoNothing();
    }
  });
}

export function raviControlChatRepositoryForDb(): RaviControlChatRepository {
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
      const [instance] = await db
        .select({
          displayName: schema.managedRuntimeInstances.displayName,
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
            eq(schema.managedRuntimeInstances.organizationId, input.organizationId),
            eq(schema.managedRuntimeInstances.projectId, input.projectId),
          ),
        )
        .limit(1);
      return instance ?? null;
    },

    async ensureSession(instance) {
      await db
        .insert(schema.managedRuntimeSessions)
        .values({
          organizationId: instance.organizationId,
          projectId: instance.projectId,
          instanceId: instance.id,
          hostId: instance.hostId,
          sessionKey: DEFAULT_AGENT_ID,
          runtimeProvider: instance.runtimeProvider,
          runtimeModel: instance.runtimeModel,
          providerSessionStateJson: { agentId: DEFAULT_AGENT_ID },
          status: instance.observedState === "ready" ? "idle" : "starting",
          startedAt: new Date(),
        })
        .onConflictDoNothing();
      const [session] = await db
        .select()
        .from(schema.managedRuntimeSessions)
        .where(
          and(
            eq(schema.managedRuntimeSessions.instanceId, instance.id),
            eq(schema.managedRuntimeSessions.sessionKey, DEFAULT_AGENT_ID),
          ),
        )
        .limit(1);
      if (!session) {
        throw new ManagedRuntimeError(503, "managed_runtime_session_create_failed");
      }
      return session;
    },

    async findBinding(input) {
      const [binding] = await db
        .select()
        .from(schema.raviControlChatBindings)
        .where(
          and(
            eq(schema.raviControlChatBindings.organizationId, input.organizationId),
            eq(schema.raviControlChatBindings.instanceId, input.instanceId),
            eq(schema.raviControlChatBindings.actorId, input.actorId),
            eq(schema.raviControlChatBindings.targetAgentId, input.targetAgentId),
          ),
        )
        .limit(1);
      return binding ?? null;
    },

    async ensureBinding(input) {
      await db
        .insert(schema.raviControlChatBindings)
        .values({
          organizationId: input.instance.organizationId,
          projectId: input.instance.projectId,
          instanceId: input.instance.id,
          actorType: input.actorType,
          actorId: input.actorId,
          targetAgentId: input.targetAgentId,
        })
        .onConflictDoNothing();
      const [binding] = await db
        .select()
        .from(schema.raviControlChatBindings)
        .where(
          and(
            eq(
              schema.raviControlChatBindings.organizationId,
              input.instance.organizationId,
            ),
            eq(schema.raviControlChatBindings.instanceId, input.instance.id),
            eq(schema.raviControlChatBindings.actorId, input.actorId),
            eq(
              schema.raviControlChatBindings.targetAgentId,
              input.targetAgentId,
            ),
          ),
        )
        .limit(1);
      if (!binding || binding.status === "revoked") {
        throw new ConsoleApiError(403, { error: "ravi_control_chat_revoked" });
      }
      return binding;
    },

    async findMirror(input) {
      const [mirror] = await db
        .select()
        .from(schema.raviControlMessageMirrors)
        .where(
          and(
            eq(schema.raviControlMessageMirrors.bindingId, input.bindingId),
            eq(schema.raviControlMessageMirrors.clientMessageId, input.clientMessageId),
          ),
        )
        .limit(1);
      return mirror ?? null;
    },

    async listMirrors(bindingId) {
      return db
        .select()
        .from(schema.raviControlMessageMirrors)
        .where(eq(schema.raviControlMessageMirrors.bindingId, bindingId))
        .orderBy(
          asc(schema.raviControlMessageMirrors.cursor),
          asc(schema.raviControlMessageMirrors.createdAt),
        )
        .limit(500);
    },

    async findCommand(commandId) {
      const [command] = await db
        .select()
        .from(schema.managedRuntimeCommands)
        .where(eq(schema.managedRuntimeCommands.id, commandId))
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
        const resolvedCommand = command ?? (
          await tx
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
            .limit(1)
        )[0];
        if (!resolvedCommand) {
          throw new ConsoleApiError(409, { error: "ravi_control_chat_busy" });
        }
        if (
          resolvedCommand.instanceId !== input.instance.id ||
          resolvedCommand.sessionId !== input.session.id ||
          resolvedCommand.actorId !== input.actorId
        ) {
          throw new ConsoleApiError(409, {
            error: "ravi_control_operation_idempotency_conflict",
          });
        }
        let mirror: MirrorRecord | null = null;
        if (input.mirror) {
          if (command) {
            const [createdMirror] = await tx
              .insert(schema.raviControlMessageMirrors)
              .values({
                id: input.mirror.id,
                organizationId: input.instance.organizationId,
                projectId: input.instance.projectId,
                instanceId: input.instance.id,
                bindingId: input.binding.id,
                commandId: resolvedCommand.id,
                clientMessageId: input.mirror.clientMessageId,
                replyToLocalMessageId: input.mirror.replyToLocalMessageId,
                actorType: "human",
                actorId: input.mirror.actorId,
                encryptedContentJson: input.mirror.encryptedContent,
              })
              .onConflictDoNothing()
              .returning();
            mirror = createdMirror ?? null;
          } else {
            const [existingMirror] = await tx
              .select()
              .from(schema.raviControlMessageMirrors)
              .where(eq(schema.raviControlMessageMirrors.commandId, resolvedCommand.id))
              .limit(1);
            mirror = existingMirror ?? null;
          }
        }
        if (command) {
          await tx.insert(schema.auditEvents).values({
            organizationId: input.instance.organizationId,
            projectId: input.instance.projectId,
            actorType: input.actorType,
            actorId: input.actorId,
            targetType: "ravi_control_operation",
            targetId: resolvedCommand.id,
            action: `ravi_control.${input.action}.requested`,
            requestId: input.requestId,
            metadataJson: {
              bindingId: input.binding.id,
              instanceId: input.instance.id,
              targetAgentId: input.binding.targetAgentId,
            },
          });
        }
        return { command: resolvedCommand, created: Boolean(command), mirror };
      });
    },
  };
}

async function requireInstanceAccess(input: {
  action: "read" | "write";
  instanceId: string;
  projectRef: string;
  repository: RaviControlChatRepository;
  workspace: ConsoleWorkspace;
}): Promise<InstanceRecord> {
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
    throw new ConsoleApiError(404, { error: "managed_runtime_instance_not_found" });
  }
  return instance;
}

function assertInstanceReady(instance: InstanceRecord): void {
  if (
    instance.runtimeProvider !== "codex" ||
    instance.observedState !== "ready" ||
    instance.connectionStatus !== "online"
  ) {
    throw new ConsoleApiError(409, { error: "ravi_control_installation_not_ready" });
  }
}

function commandScope(
  instance: Pick<InstanceRecord, "id" | "organizationId" | "projectId">,
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

function mirrorScope(
  instance: Pick<InstanceRecord, "id" | "organizationId" | "projectId">,
  bindingId: string,
  mirrorId: string,
  actorId: string | null,
): ManagedRuntimeContentScope {
  return {
    organizationId: instance.organizationId,
    projectId: instance.projectId,
    instanceId: instance.id,
    sessionId: null,
    commandId: null,
    chatId: bindingId,
    messageId: mirrorId,
    actorId,
    purpose: "chat_message",
  };
}

function publicInstallation(instance: InstanceRecord) {
  return {
    id: instance.id,
    displayName: instance.displayName,
    observedState: instance.observedState,
    connectionStatus: instance.connectionStatus,
    runtimeProvider: instance.runtimeProvider,
    runtimeModel: instance.runtimeModel,
  };
}

function publicBinding(binding: BindingRecord) {
  return {
    id: binding.id,
    installationId: binding.instanceId,
    targetAgentId: binding.targetAgentId,
    status: binding.status,
    bindingVersion: binding.bindingVersion,
    lastSyncedAt: binding.lastSyncedAt?.toISOString() ?? null,
    updatedAt: binding.updatedAt.toISOString(),
  };
}

function publicMirror(
  mirror: MirrorRecord,
  binding: BindingRecord,
  codec: ManagedRuntimeContentCodec,
) {
  return {
    id: mirror.localMessageId ?? mirror.id,
    mirrorId: mirror.id,
    operationId: mirror.commandId,
    clientMessageId: mirror.clientMessageId,
    replyToMessageId: mirror.replyToLocalMessageId,
    actorType: mirror.actorType,
    actorId: mirror.actorId,
    status: mirror.status,
    content: codec.decrypt(
      mirror.encryptedContentJson,
      mirrorScope(
        {
          id: mirror.instanceId,
          organizationId: mirror.organizationId,
          projectId: mirror.projectId,
        },
        binding.id,
        mirror.id,
        mirror.actorId,
      ),
    ),
    failureCode: mirror.failureCode,
    createdAt: (mirror.localCreatedAt ?? mirror.createdAt).toISOString(),
    updatedAt: mirror.updatedAt.toISOString(),
  };
}

function publicCommand(command: CommandRecord) {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    phase: command.phase,
    failureCode: command.failureCode,
    attemptCount: command.attemptCount,
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString(),
  };
}

function parseBody<T extends z.ZodTypeAny>(schemaValue: T, body: unknown): z.infer<T> {
  const parsed = schemaValue.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "ravi_control_payload_invalid" });
  }
  return parsed.data;
}

function requireLocalRef(value: string, code: string): string {
  const normalized = value.trim();
  if (!LOCAL_REF_PATTERN.test(normalized)) {
    throw new ConsoleApiError(400, { error: `ravi_control_${code}_invalid` });
  }
  return normalized;
}
