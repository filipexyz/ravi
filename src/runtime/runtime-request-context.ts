import { getAccountForAgent, type AgentConfig } from "../router/index.js";
import { type ContextCapability, type ContextRecord } from "../router/router-db.js";
import {
  buildEffectiveCapabilities,
  hasAnyCapability,
  TURN_SCOPED_AUTHORITY_KIND,
  type AuthorityPrincipal,
} from "../permissions/delegation.js";
import {
  AGENT_IDENTITY_AUTHORITY_MODE,
  AGENT_IDENTITY_AUTHORITY_RESOLVER,
  AGENT_IDENTITY_SUBJECT_TYPE,
  buildAgentIdentitySubjectId,
  type AgentIdentityCompartment,
} from "../permissions/agent-identity-permissions-provider.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { buildRuntimeEnv, buildTaskRuntimeEnv } from "./host-env.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { MessageActorMetadata, RuntimeLaunchPrompt } from "./message-types.js";
import {
  createRuntimeContext,
  DEFAULT_DERIVED_CONTEXT_TTL_MS,
  revokeRuntimeContext,
  snapshotAgentCapabilities,
} from "./runtime-context-store.js";
import type { RuntimeCapabilities, RuntimeProviderId } from "./types.js";

export interface RuntimeRequestContextOptions {
  dbSessionKey: string;
  sessionName: string;
  sessionCwd: string;
  agent: AgentConfig;
  prompt: RuntimeLaunchPrompt;
  runtimeProviderId: RuntimeProviderId;
  model: string;
  runtimeResolution: TaskRuntimeResolution;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
}

export function buildRuntimeRequestContext(options: RuntimeRequestContextOptions) {
  const {
    dbSessionKey,
    sessionName,
    sessionCwd,
    agent,
    prompt,
    runtimeProviderId,
    model,
    runtimeResolution,
    resolvedSource,
    approvalSource,
  } = options;

  const capabilities = buildRuntimeContextCapabilities(agent.id, sessionName, prompt);
  const runtimeContext = createRuntimeContextForPrompt({
    agentId: agent.id,
    sessionKey: dbSessionKey,
    sessionName,
    prompt,
    resolvedSource,
    capabilities,
    metadata: buildRuntimeContextMetadata({
      prompt,
      resolvedSource,
      runtimeProviderId,
      model,
      runtimeResolution,
      approvalSource,
    }),
  });

  const toolContext = {
    contextId: runtimeContext.contextId,
    context: runtimeContext,
    sessionKey: dbSessionKey,
    sessionName,
    agentId: agent.id,
    source: resolvedSource,
  };

  return {
    runtimeContext,
    toolContext,
    raviEnv: buildRaviRuntimeEnv({
      runtimeContext,
      dbSessionKey,
      sessionName,
      sessionCwd,
      agent,
      prompt,
      resolvedSource,
    }),
  };
}

export function refreshRuntimeRequestContextForTurn(options: {
  runtimeContext: ContextRecord;
  toolContext: Record<string, unknown>;
  runtimeEnv?: Record<string, string>;
  dbSessionKey: string;
  sessionName: string;
  sessionCwd: string;
  agent: AgentConfig;
  prompt: RuntimeLaunchPrompt;
  runtimeProviderId: RuntimeProviderId;
  model: string;
  runtimeResolution: TaskRuntimeResolution;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
}): ContextRecord {
  const capabilities = buildRuntimeContextCapabilities(options.agent.id, options.sessionName, options.prompt);
  const nextContext = createRuntimeContextForPrompt({
    agentId: options.agent.id,
    sessionKey: options.dbSessionKey,
    sessionName: options.sessionName,
    prompt: options.prompt,
    resolvedSource: options.resolvedSource,
    capabilities,
    metadata: buildRuntimeContextMetadata({
      prompt: options.prompt,
      resolvedSource: options.resolvedSource,
      runtimeProviderId: options.runtimeProviderId,
      model: options.model,
      runtimeResolution: options.runtimeResolution,
      approvalSource: options.approvalSource,
    }),
  });

  const previousContextId = options.runtimeContext.contextId;
  if (previousContextId !== nextContext.contextId) {
    revokeRuntimeContext(previousContextId, {
      cascade: false,
      reason: "turn_context_rotated",
    });
  }

  Object.assign(options.runtimeContext, nextContext);
  options.toolContext.contextId = options.runtimeContext.contextId;
  options.toolContext.context = options.runtimeContext;
  options.toolContext.sessionKey = options.dbSessionKey;
  options.toolContext.sessionName = options.sessionName;
  options.toolContext.agentId = options.agent.id;
  options.toolContext.source = options.resolvedSource;
  if (options.runtimeEnv) {
    refreshManagedRaviRuntimeEnv(
      options.runtimeEnv,
      buildRaviRuntimeEnv({
        runtimeContext: options.runtimeContext,
        dbSessionKey: options.dbSessionKey,
        sessionName: options.sessionName,
        sessionCwd: options.sessionCwd,
        agent: options.agent,
        prompt: options.prompt,
        resolvedSource: options.resolvedSource,
      }),
    );
  }
  return options.runtimeContext;
}

function buildRuntimeContextCapabilities(
  agentId: string,
  sessionName?: string,
  prompt?: RuntimeLaunchPrompt,
): ContextCapability[] {
  return dedupeContextCapabilities([
    ...snapshotAgentCapabilities(agentId),
    ...buildTaskSelfCapabilities(sessionName, prompt),
  ]);
}

function buildTaskSelfCapabilities(sessionName?: string, prompt?: RuntimeLaunchPrompt): ContextCapability[] {
  const taskId = cleanStringValue(prompt?.taskBarrierTaskId);
  if (!sessionName || !taskId) return [];
  const binding = dbResolveActiveTaskBindingForSession(sessionName, taskId);
  if (!binding) return [];
  const source = `task-runtime:self:${binding.task.id}`;
  return [
    {
      permission: "read",
      objectType: "task",
      objectId: binding.task.id,
      source,
    },
    {
      permission: "mutate",
      objectType: "task",
      objectId: binding.task.id,
      source,
    },
  ];
}

function createRuntimeContextForPrompt(options: {
  agentId: string;
  sessionKey: string;
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  resolvedSource?: RuntimeMessageTarget;
  capabilities: ContextCapability[];
  metadata: Record<string, unknown>;
}): ContextRecord {
  const identity = buildAgentIdentityRuntimeContextInputForPrompt(options);
  return createRuntimeContext({
    kind: TURN_SCOPED_AUTHORITY_KIND,
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    sessionName: options.sessionName,
    source: buildContextSource(options.resolvedSource),
    capabilities: identity.capabilities,
    metadata: {
      ...options.metadata,
      ...identity.metadata,
    },
    ttlMs: DEFAULT_DERIVED_CONTEXT_TTL_MS,
  });
}

function buildAgentIdentityRuntimeContextInputForPrompt(options: {
  agentId: string;
  prompt: RuntimeLaunchPrompt;
  resolvedSource?: RuntimeMessageTarget;
  capabilities: ContextCapability[];
}): {
  capabilities: ContextCapability[];
  metadata: Record<string, unknown>;
} {
  const actorMetadata = resolveAuthorityActorMetadata(options.prompt, options.resolvedSource);
  const actorPrincipal = resolveActorPrincipal(actorMetadata);
  const surfacePrincipal = resolveSurfacePrincipal(actorMetadata);
  const actorDisplayName = cleanStringValue(actorMetadata?.senderName);
  const surfaceDisplayName = cleanStringValue(actorMetadata?.groupName);
  const actorResolution = resolveActorResolution(actorMetadata, actorPrincipal);

  return buildAgentIdentityRuntimeContextInput({
    agentId: options.agentId,
    prompt: options.prompt,
    capabilities: options.capabilities,
    actorPrincipal,
    actorResolution,
    surfacePrincipal,
    actorDisplayName,
    surfaceDisplayName,
  });
}

function buildAgentIdentityRuntimeContextInput(options: {
  agentId: string;
  prompt: RuntimeLaunchPrompt;
  capabilities: ContextCapability[];
  actorPrincipal: AuthorityPrincipal | null;
  actorResolution: "resolved" | "missing_contact" | "not_applicable";
  surfacePrincipal: AuthorityPrincipal | null;
  actorDisplayName?: string;
  surfaceDisplayName?: string;
}): {
  capabilities: ContextCapability[];
  metadata: Record<string, unknown>;
} {
  const observationCapabilities = parseObservationPermissionGrants(options.prompt._observation?.permissionGrants);
  const compartment = resolveAgentIdentityCompartment(options.prompt, options.actorPrincipal, options.surfacePrincipal);
  const agentIdentitySubjectId = buildAgentIdentitySubjectId(options.agentId, compartment);
  const agentIdentityPrincipal = {
    subjectType: AGENT_IDENTITY_SUBJECT_TYPE,
    subjectId: agentIdentitySubjectId,
  };
  const shouldMaterializeIdentity = options.actorResolution !== "missing_contact";
  const agentIdentityCapabilities = shouldMaterializeIdentity
    ? materializeSubjectCapabilities(AGENT_IDENTITY_SUBJECT_TYPE, agentIdentitySubjectId, {
        executorAgentId: options.agentId,
        executorCapabilities: options.capabilities,
        compartmentType: compartment.type,
        compartmentId: compartment.id,
        authorityModel: AGENT_IDENTITY_AUTHORITY_MODE,
      })
    : [];
  const taskSelfCapabilityCount = countTaskSelfCapabilities(options.capabilities);
  const taskSelfTaskId = resolveTaskSelfTaskId(options.capabilities);
  const effectiveCapabilities = buildEffectiveCapabilities({
    agentCapabilities: agentIdentityCapabilities,
    actorCapabilities: agentIdentityCapabilities,
    turnCapabilities: hasAnyCapability(observationCapabilities) ? observationCapabilities : undefined,
  });

  return {
    capabilities: effectiveCapabilities,
    metadata: {
      authorityMode: AGENT_IDENTITY_AUTHORITY_MODE,
      authorityResolver: AGENT_IDENTITY_AUTHORITY_RESOLVER,
      executorAgentId: options.agentId,
      actorPrincipal: options.actorPrincipal ? formatPrincipal(options.actorPrincipal) : "unknown",
      actorResolution: options.actorResolution,
      actorAuthorizationMode: options.actorResolution === "not_applicable" ? "not-applicable" : "invoke-only",
      ...(options.actorDisplayName ? { actorDisplayName: options.actorDisplayName } : {}),
      ...(options.surfacePrincipal ? { surfacePrincipal: formatPrincipal(options.surfacePrincipal) } : {}),
      ...(options.surfaceDisplayName ? { surfaceDisplayName: options.surfaceDisplayName } : {}),
      surfaceAuthorizationMode: "compartment",
      agentIdentityPrincipal: formatPrincipal(agentIdentityPrincipal),
      agentIdentityCompartment: `${compartment.type}:${compartment.id}`,
      agentIdentityCapabilityCount: agentIdentityCapabilities.length,
      ...(taskSelfCapabilityCount > 0 ? { taskSelfCapabilityCount } : {}),
      ...(taskSelfTaskId ? { taskSelfTaskId } : {}),
      actorCapabilityCount: 0,
      surfaceCapabilityCount: 0,
      turnCapabilityCount: observationCapabilities.length,
      ...(observationCapabilities.length > 0 ? { turnCapabilities: observationCapabilities } : {}),
      effectiveCapabilityCount: effectiveCapabilities.length,
    },
  };
}

function countTaskSelfCapabilities(capabilities: ContextCapability[]): number {
  return capabilities.filter(isTaskSelfCapability).length;
}

function resolveTaskSelfTaskId(capabilities: ContextCapability[]): string | undefined {
  return capabilities.find(isTaskSelfCapability)?.objectId;
}

function isTaskSelfCapability(capability: ContextCapability): boolean {
  return capability.source?.startsWith("task-runtime:self:") === true;
}

function resolveAgentIdentityCompartment(
  prompt: RuntimeLaunchPrompt,
  actorPrincipal: AuthorityPrincipal | null,
  surfacePrincipal: AuthorityPrincipal | null,
): AgentIdentityCompartment {
  if (surfacePrincipal) {
    return {
      type: prompt.context?.isGroup === false ? "dm" : "chat",
      id: surfacePrincipal.subjectId,
    };
  }
  if (actorPrincipal?.subjectType === "automation") {
    return {
      type: "automation",
      id: actorPrincipal.subjectId,
    };
  }
  return {
    type: "workspace",
    id: "default",
  };
}

export function shouldUseTurnScopedAuthorityForPrompt(
  prompt: RuntimeLaunchPrompt,
  resolvedSource?: RuntimeMessageTarget,
): boolean {
  void prompt;
  void resolvedSource;
  return true;
}

function resolveAuthorityActorMetadata(
  prompt: RuntimeLaunchPrompt,
  resolvedSource?: RuntimeMessageTarget,
):
  | (MessageActorMetadata & {
      channel?: string;
      channelId?: string;
      accountId?: string;
      chatId?: string;
      threadId?: string;
      sourceMessageId?: string;
      automationId?: string;
      senderName?: string;
      groupName?: string;
    })
  | undefined {
  const source = resolvedSource ?? prompt.source;
  const context = prompt.context;
  const automationPrincipal = resolveAutomationPromptPrincipal(prompt, source, context);
  if (!source && !context && !automationPrincipal) return undefined;
  return {
    ...(source ?? {}),
    ...(context ?? {}),
    canonicalChatId: context?.canonicalChatId ?? source?.canonicalChatId,
    actorType: automationPrincipal ? "automation" : (context?.actorType ?? source?.actorType),
    contactId: automationPrincipal ? undefined : (context?.contactId ?? source?.contactId),
    actorAgentId: automationPrincipal ? undefined : (context?.actorAgentId ?? source?.actorAgentId),
    automationId: automationPrincipal?.subjectId,
    identityProvenance:
      context?.identityProvenance ?? source?.identityProvenance ?? buildAutomationIdentityProvenance(prompt),
    platformIdentityId: context?.platformIdentityId ?? source?.platformIdentityId,
    rawSenderId: context?.rawSenderId ?? source?.rawSenderId,
    normalizedSenderId: context?.normalizedSenderId ?? source?.normalizedSenderId,
    accountId: context?.accountId ?? source?.accountId,
    chatId: context?.chatId ?? source?.chatId,
    threadId: source?.threadId,
    sourceMessageId: source?.sourceMessageId,
    senderName: context?.senderName,
    groupName: context?.groupName,
  };
}

function isExternalAuthoritySurface(
  actorMetadata:
    | (MessageActorMetadata & {
        channel?: string;
        channelId?: string;
        accountId?: string;
        chatId?: string;
        threadId?: string;
        sourceMessageId?: string;
      })
    | undefined,
): boolean {
  return Boolean(
    actorMetadata?.channel ||
      actorMetadata?.channelId ||
      actorMetadata?.accountId ||
      actorMetadata?.chatId ||
      actorMetadata?.canonicalChatId,
  );
}

function resolveActorResolution(
  actorMetadata: MessageActorMetadata | undefined,
  actorPrincipal: AuthorityPrincipal | null,
): "resolved" | "missing_contact" | "not_applicable" {
  if (actorPrincipal) return "resolved";
  if (isExternalAuthoritySurface(actorMetadata)) return "missing_contact";
  return "not_applicable";
}

function resolveActorPrincipal(actorMetadata: MessageActorMetadata | undefined): AuthorityPrincipal | null {
  if (actorMetadata?.actorType === "contact" && actorMetadata.contactId) {
    return { subjectType: "contact", subjectId: actorMetadata.contactId };
  }
  if (actorMetadata?.actorType === "automation" && actorMetadata.automationId) {
    return { subjectType: "automation", subjectId: actorMetadata.automationId };
  }
  return null;
}

function resolveSurfacePrincipal(actorMetadata: MessageActorMetadata | undefined): AuthorityPrincipal | null {
  const rawChatId = (actorMetadata as (MessageActorMetadata & { chatId?: unknown }) | undefined)?.chatId;
  const chatId = actorMetadata?.canonicalChatId ?? (typeof rawChatId === "string" ? rawChatId : undefined);
  if (!chatId) return null;
  return { subjectType: "chat", subjectId: chatId };
}

function formatPrincipal(principal: AuthorityPrincipal): string {
  return `${principal.subjectType}:${principal.subjectId}`;
}

function buildRuntimeContextMetadata(options: {
  prompt: RuntimeLaunchPrompt;
  resolvedSource?: RuntimeMessageTarget;
  runtimeProviderId: RuntimeProviderId;
  model: string;
  runtimeResolution: TaskRuntimeResolution;
  approvalSource?: RuntimeMessageTarget;
}): Record<string, unknown> {
  const actorMetadata = buildRuntimeContextActorMetadata(options.prompt, options.resolvedSource);
  return {
    runtimeProvider: options.runtimeProviderId,
    runtimeModel: options.model,
    ...(options.runtimeResolution.options.effort ? { runtimeEffort: options.runtimeResolution.options.effort } : {}),
    ...(options.runtimeResolution.options.thinking
      ? { runtimeThinking: options.runtimeResolution.options.thinking }
      : {}),
    runtimeModelSource: options.runtimeResolution.sources.model,
    ...(options.approvalSource ? { approvalSource: options.approvalSource } : {}),
    ...(actorMetadata ? { actor: actorMetadata, actorMetadata } : {}),
    ...(options.prompt._thread ? { raviThread: options.prompt._thread } : {}),
  };
}

function buildRuntimeContextActorMetadata(
  prompt: RuntimeLaunchPrompt,
  resolvedSource?: RuntimeMessageTarget,
): Record<string, unknown> | null {
  const actor = resolveAuthorityActorMetadata(prompt, resolvedSource);
  const context = prompt.context;
  const metadata: Record<string, unknown> = {};
  copyStringField(metadata, "canonicalChatId", actor?.canonicalChatId);
  copyStringField(metadata, "channel", actor?.channel);
  copyStringField(metadata, "channelId", actor?.channelId);
  copyStringField(metadata, "accountId", actor?.accountId);
  copyStringField(metadata, "chatId", actor?.chatId);
  copyStringField(metadata, "threadId", actor?.threadId);
  copyStringField(metadata, "sourceMessageId", actor?.sourceMessageId);
  copyStringField(metadata, "actorType", actor?.actorType);
  copyStringField(metadata, "contactId", actor?.contactId);
  copyStringField(metadata, "actorAgentId", actor?.actorAgentId);
  copyStringField(metadata, "automationId", actor?.automationId);
  copyStringField(metadata, "platformIdentityId", actor?.platformIdentityId);
  copyStringField(metadata, "rawSenderId", actor?.rawSenderId);
  copyStringField(metadata, "normalizedSenderId", actor?.normalizedSenderId);
  copyStringField(metadata, "senderId", context?.senderId);
  copyStringField(metadata, "senderName", context?.senderName);
  copyStringField(metadata, "senderPhone", context?.senderPhone);
  copyStringField(metadata, "groupName", context?.groupName);
  if (typeof actor?.identityConfidence === "number") metadata.identityConfidence = actor.identityConfidence;
  if (actor?.identityProvenance) metadata.identityProvenance = actor.identityProvenance;
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function resolveAutomationPromptPrincipal(
  prompt: RuntimeLaunchPrompt,
  source?: RuntimeMessageTarget,
  context?: RuntimeLaunchPrompt["context"],
): AuthorityPrincipal | null {
  if (prompt._cron && prompt._jobId) {
    return { subjectType: "automation", subjectId: `cron:${prompt._jobId}` };
  }
  if (prompt._trigger && prompt._triggerId) {
    return {
      subjectType: "automation",
      subjectId: `trigger:${prompt._triggerId}`,
    };
  }
  if (prompt._sessionFollowup) {
    return {
      subjectType: "automation",
      subjectId: "session-followup",
    };
  }
  if (prompt._daemonRestartResume) {
    if (hasResolvedContactActor(source) || hasResolvedContactActor(context)) {
      return null;
    }
    return { subjectType: "automation", subjectId: "daemon-restart" };
  }
  return null;
}

function hasResolvedContactActor(metadata: { actorType?: string; contactId?: string } | undefined): boolean {
  return metadata?.actorType === "contact" && Boolean(cleanStringValue(metadata.contactId));
}

function buildAutomationIdentityProvenance(prompt: RuntimeLaunchPrompt): Record<string, unknown> | undefined {
  if (prompt._cron && prompt._jobId) {
    return { source: "cron", jobId: prompt._jobId };
  }
  return undefined;
}

function copyStringField(target: Record<string, unknown>, key: string, value: unknown): void {
  const trimmed = cleanStringValue(value);
  if (trimmed) target[key] = trimmed;
}

function cleanStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildContextSource(resolvedSource?: RuntimeMessageTarget) {
  return resolvedSource
    ? {
        channel: resolvedSource.channel,
        accountId: resolvedSource.accountId,
        chatId: resolvedSource.chatId,
        ...(resolvedSource.threadId ? { threadId: resolvedSource.threadId } : {}),
      }
    : undefined;
}

const MANAGED_RAVI_RUNTIME_ENV_KEYS = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
  "RAVI_INSTANCE_ID",
  "RAVI_CANONICAL_CHAT_ID",
  "RAVI_ACTOR_TYPE",
  "RAVI_CONTACT_ID",
  "RAVI_ACTOR_AGENT_ID",
  "RAVI_PLATFORM_IDENTITY_ID",
  "RAVI_RAW_SENDER_ID",
  "RAVI_NORMALIZED_SENDER_ID",
  "RAVI_SENDER_ID",
  "RAVI_SENDER_NAME",
  "RAVI_SENDER_PHONE",
  "RAVI_GROUP_ID",
  "RAVI_GROUP_NAME",
  "RAVI_THREAD_ID",
  "RAVI_THREAD_HANDOFF_ID",
  "RAVI_THREAD_SLUG",
  "RAVI_TASK_ID",
  "RAVI_TASK_PROFILE_ID",
  "RAVI_PARENT_TASK_ID",
  "RAVI_TASK_SESSION",
  "RAVI_TASK_WORKSPACE",
] as const;

function refreshManagedRaviRuntimeEnv(runtimeEnv: Record<string, string>, raviEnv: Record<string, string>): void {
  for (const key of MANAGED_RAVI_RUNTIME_ENV_KEYS) {
    delete runtimeEnv[key];
  }
  Object.assign(runtimeEnv, raviEnv);
}

function parseObservationPermissionGrants(values?: string[]): ContextCapability[] {
  return (values ?? []).flatMap((value) => parseObservationPermissionGrant(value));
}

function parseObservationPermissionGrant(value: string): ContextCapability[] {
  const grant = value.trim();
  if (!grant) return [];

  const direct = /^([^:\s]+):([^:\s]+):(.+)$/.exec(grant);
  if (direct) {
    return [
      {
        permission: direct[1]!,
        objectType: direct[2]!,
        objectId: direct[3]!.trim(),
        source: "observer-rule",
      },
    ];
  }

  const shortcut = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_.*-]+)$/.exec(grant);
  if (!shortcut) return [];

  const group = normalizeCliToolNamePart(shortcut[1]!);
  const command = shortcut[2]!;
  if (command === "*") {
    return [
      {
        permission: "use",
        objectType: "tool",
        objectId: `${group}_*`,
        source: "observer-rule",
      },
      {
        permission: "execute",
        objectType: "group",
        objectId: group,
        source: "observer-rule",
      },
    ];
  }

  const normalizedCommand = normalizeCliToolNamePart(command);
  return [
    {
      permission: "use",
      objectType: "tool",
      objectId: `${group}_${normalizedCommand}`,
      source: "observer-rule",
    },
    {
      permission: "execute",
      objectType: "group",
      objectId: `${group}_${normalizedCommand}`,
      source: "observer-rule",
    },
  ];
}

function normalizeCliToolNamePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function dedupeContextCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

export function buildRuntimeRequestEnv(options: {
  raviEnv: Record<string, string>;
  providerEnv?: Record<string, string>;
  runtimeCapabilities: RuntimeCapabilities;
}): Record<string, string> {
  const baseRuntimeEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return buildRuntimeEnv(baseRuntimeEnv, options.raviEnv, options.providerEnv, options.runtimeCapabilities);
}

function buildRaviRuntimeEnv(options: {
  runtimeContext: ReturnType<typeof createRuntimeContext>;
  dbSessionKey: string;
  sessionName: string;
  sessionCwd: string;
  agent: AgentConfig;
  prompt: RuntimeLaunchPrompt;
  resolvedSource?: RuntimeMessageTarget;
}): Record<string, string> {
  const { runtimeContext, dbSessionKey, sessionName, sessionCwd, agent, prompt, resolvedSource } = options;
  const raviEnv: Record<string, string> = {
    RAVI_CONTEXT_KEY: runtimeContext.contextKey,
    RAVI_SESSION_KEY: dbSessionKey,
    RAVI_SESSION_NAME: sessionName,
    RAVI_AGENT_ID: agent.id,
  };

  if (resolvedSource) {
    raviEnv.RAVI_CHANNEL = resolvedSource.channel;
    raviEnv.RAVI_ACCOUNT_ID = resolvedSource.accountId;
    raviEnv.RAVI_CHAT_ID = resolvedSource.chatId;
    if (resolvedSource.instanceId) raviEnv.RAVI_INSTANCE_ID = resolvedSource.instanceId;
  } else if (prompt.context?.accountId) {
    raviEnv.RAVI_ACCOUNT_ID = prompt.context.accountId;
    if (prompt.context.channelId) raviEnv.RAVI_CHANNEL = prompt.context.channelId;
    if (prompt.context.instanceId) raviEnv.RAVI_INSTANCE_ID = prompt.context.instanceId;
    if (prompt.context.chatId) raviEnv.RAVI_CHAT_ID = prompt.context.chatId;
  } else if (agent.mode === "sentinel") {
    const accountId = getAccountForAgent(agent.id);
    if (accountId) raviEnv.RAVI_ACCOUNT_ID = accountId;
  }

  const actorMetadata = resolvedSource ?? prompt.context;
  if (actorMetadata) {
    if (actorMetadata.canonicalChatId) raviEnv.RAVI_CANONICAL_CHAT_ID = actorMetadata.canonicalChatId;
    if (actorMetadata.actorType) raviEnv.RAVI_ACTOR_TYPE = actorMetadata.actorType;
    if (actorMetadata.contactId) raviEnv.RAVI_CONTACT_ID = actorMetadata.contactId;
    if (actorMetadata.actorAgentId) raviEnv.RAVI_ACTOR_AGENT_ID = actorMetadata.actorAgentId;
    if (actorMetadata.platformIdentityId) raviEnv.RAVI_PLATFORM_IDENTITY_ID = actorMetadata.platformIdentityId;
    if (actorMetadata.rawSenderId) raviEnv.RAVI_RAW_SENDER_ID = actorMetadata.rawSenderId;
    if (actorMetadata.normalizedSenderId) raviEnv.RAVI_NORMALIZED_SENDER_ID = actorMetadata.normalizedSenderId;
  }

  if (prompt.context) {
    raviEnv.RAVI_SENDER_ID = prompt.context.senderId;
    if (prompt.context.senderName) raviEnv.RAVI_SENDER_NAME = prompt.context.senderName;
    if (prompt.context.senderPhone) raviEnv.RAVI_SENDER_PHONE = prompt.context.senderPhone;
    if (prompt.context.isGroup) {
      if (prompt.context.groupId) raviEnv.RAVI_GROUP_ID = prompt.context.groupId;
      if (prompt.context.groupName) raviEnv.RAVI_GROUP_NAME = prompt.context.groupName;
    }
  }

  if (prompt._thread) {
    raviEnv.RAVI_THREAD_ID = prompt._thread.id;
    raviEnv.RAVI_THREAD_HANDOFF_ID = prompt._thread.handoffId;
    if (prompt._thread.slug) raviEnv.RAVI_THREAD_SLUG = prompt._thread.slug;
  }

  Object.assign(raviEnv, buildTaskRuntimeEnv(sessionName, sessionCwd, prompt.taskBarrierTaskId));
  return raviEnv;
}
