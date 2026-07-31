import { homedir } from "node:os";
import { DEFAULT_DELIVERY_BARRIER } from "../delivery-barriers.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import { dbGetChat, dbGetSessionChatBinding } from "../router/router-db.js";
import { configStore } from "../config-store.js";
import {
  buildRuntimeTracePromptSectionMetadata,
  createSessionTraceTurnId,
  recordAdapterRequestTrace,
  recordTerminalTurnTrace,
  summarizeRuntimeCapabilities,
} from "../session-trace/runtime-trace.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { classifyTurnProvenance } from "./turn-provenance.js";
import { resolveAgentSkills } from "./allowed-skills.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createRuntimeMessageGenerator } from "./delivery-queue.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  resolveRuntimeToolEffectFence,
  type RuntimeHostStreamingSession,
  type RuntimeMessageTarget,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  isRuntimeCredentialSessionCompatible,
  resolveRuntimeCredentialAttemptBinding,
  serializeRuntimeCredentialAttemptBinding,
} from "./credential-resolver.js";
import {
  bindRuntimeCredentialAttemptTurn,
  markRuntimeCredentialAttemptStarted,
  reserveRuntimeCredentialAttempt,
} from "./credential-store.js";
import { buildRuntimeHostAttachments } from "./runtime-host-attachments.js";
import { prepareRuntimeProviderBootstrap } from "./runtime-provider-bootstrap.js";
import {
  buildRuntimeRequestContext,
  buildRuntimeRequestEnv,
  refreshRuntimeRequestContextForTurn,
} from "./runtime-request-context.js";
import { resolveRuntimeSessionContinuity } from "./runtime-session-continuity.js";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type {
  RuntimeApprovalResult,
  RuntimeCapabilities,
  RuntimeHostServices,
  RuntimeProviderId,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

const CRASH_RECOVERY_APPROVAL_OWNERSHIP_CHANGED_REASON =
  "Runtime action approval denied because durable turn ownership changed before authorization completed.";

class RuntimeCrashRecoveryApprovalOwnershipChangedError extends Error {
  constructor() {
    super(CRASH_RECOVERY_APPROVAL_OWNERSHIP_CHANGED_REASON);
    this.name = "RuntimeCrashRecoveryApprovalOwnershipChangedError";
  }
}

export interface RuntimeStartRequestBuildOptions {
  runId: string;
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  session: SessionEntry;
  agent: AgentConfig;
  runtimeProviderId: RuntimeProviderId;
  runtimeProvider: SessionRuntimeProvider;
  runtimeCapabilities: RuntimeCapabilities;
  sessionCwd: string;
  dbSessionKey: string;
  model: string;
  runtimeResolution: TaskRuntimeResolution;
  storedRuntimeSessionParams: Record<string, unknown> | undefined;
  storedProviderSessionId?: string;
  canResumeStoredSession: boolean;
  resolvedSource?: RuntimeMessageTarget;
  approvalSource?: RuntimeMessageTarget;
  streamingSession: RuntimeHostStreamingSession;
  stashedMessages: Map<string, RuntimeUserMessage[]>;
  defaultRuntimeProviderId: RuntimeProviderId;
  crashRecovery: RuntimeCrashRecoveryCoordinator;
}

export interface RuntimeStartRequestBuildResult {
  runtimeRequest: RuntimeStartRequest;
  toolContext: Record<string, unknown>;
  runtimeCredentialAttempt?: RuntimeCredentialAttemptBinding;
}

export function installCrashRecoveryApprovalFences(options: {
  hostServices: RuntimeHostServices;
  streamingSession: Pick<RuntimeHostStreamingSession, "currentCrashRecoveryAttemptId" | "currentTurnToolStarted">;
  crashRecovery: Pick<RuntimeCrashRecoveryCoordinator, "markTurnAttemptSafety">;
}): void {
  const { hostServices, streamingSession, crashRecovery } = options;
  const authorizeCapability = hostServices.authorizeCapability.bind(hostServices);
  const authorizeCommandExecution = hostServices.authorizeCommandExecution.bind(hostServices);
  const authorizeToolUse = hostServices.authorizeToolUse.bind(hostServices);
  const requestUserInput = hostServices.requestUserInput.bind(hostServices);

  const denyOwnershipChanged = (): RuntimeApprovalResult => ({
    approved: false,
    reason: CRASH_RECOVERY_APPROVAL_OWNERSHIP_CHANGED_REASON,
  });

  const denyCapabilityOwnershipChanged = () => ({
    allowed: false,
    inherited: false,
    reason: CRASH_RECOVERY_APPROVAL_OWNERSHIP_CHANGED_REASON,
  });

  const createBeforeExternalApprovalFence = (attemptId: string) => () => {
    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      throw new RuntimeCrashRecoveryApprovalOwnershipChangedError();
    }
    crashRecovery.markTurnAttemptSafety({ attemptId, materializedOutput: true });
    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      throw new RuntimeCrashRecoveryApprovalOwnershipChangedError();
    }
  };

  const authorizeWithFence = async (
    authorize: (beforeExternalApproval: () => void) => Promise<RuntimeApprovalResult>,
  ): Promise<RuntimeApprovalResult> => {
    const attemptId = streamingSession.currentCrashRecoveryAttemptId;
    if (!attemptId) {
      return denyOwnershipChanged();
    }
    let result: RuntimeApprovalResult;
    try {
      result = await authorize(createBeforeExternalApprovalFence(attemptId));
    } catch (error) {
      if (error instanceof RuntimeCrashRecoveryApprovalOwnershipChangedError) {
        return denyOwnershipChanged();
      }
      throw error;
    }

    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      return denyOwnershipChanged();
    }
    if (!result.approved) return result;

    // This is the last host-owned boundary before an approved command or tool
    // can produce an external effect. The marker must be durable before allow.
    crashRecovery.markTurnAttemptSafety({ attemptId, startedTool: true });
    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      return denyOwnershipChanged();
    }
    // Approval is itself the final host boundary before a side effect. Keep the
    // volatile retry guard aligned with the durable safety marker even when an
    // adapter never emits a later tool.started event.
    streamingSession.currentTurnToolStarted = true;
    return result;
  };

  const authorizeCapabilityWithFence: RuntimeHostServices["authorizeCapability"] = async (request) => {
    const attemptId = streamingSession.currentCrashRecoveryAttemptId;
    if (!attemptId) {
      return denyCapabilityOwnershipChanged();
    }

    let result: Awaited<ReturnType<RuntimeHostServices["authorizeCapability"]>>;
    try {
      result = await authorizeCapability({
        ...request,
        beforeExternalApproval: createBeforeExternalApprovalFence(attemptId),
      });
    } catch (error) {
      if (error instanceof RuntimeCrashRecoveryApprovalOwnershipChangedError) {
        return denyCapabilityOwnershipChanged();
      }
      throw error;
    }
    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      return denyCapabilityOwnershipChanged();
    }
    return result;
  };

  const requestUserInputWithFence: RuntimeHostServices["requestUserInput"] = async (request) => {
    const attemptId = streamingSession.currentCrashRecoveryAttemptId;
    if (!attemptId) {
      return denyOwnershipChanged();
    }

    let result: RuntimeApprovalResult;
    try {
      result = await requestUserInput({
        ...request,
        beforeExternalApproval: createBeforeExternalApprovalFence(attemptId),
      });
    } catch (error) {
      if (error instanceof RuntimeCrashRecoveryApprovalOwnershipChangedError) {
        return denyOwnershipChanged();
      }
      throw error;
    }
    if (streamingSession.currentCrashRecoveryAttemptId !== attemptId) {
      return denyOwnershipChanged();
    }
    return result;
  };

  // Provider bootstrap closures (notably Codex approveRuntimeRequest) capture
  // this object by reference. Mutating the same object keeps adapters unaware
  // of the ledger while fencing capability, tool, command, and user-input boundaries.
  hostServices.authorizeCapability = authorizeCapabilityWithFence;
  hostServices.authorizeCommandExecution = (request) =>
    authorizeWithFence((beforeExternalApproval) => authorizeCommandExecution({ ...request, beforeExternalApproval }));
  hostServices.authorizeToolUse = (request) =>
    authorizeWithFence((beforeExternalApproval) => authorizeToolUse({ ...request, beforeExternalApproval }));
  hostServices.requestUserInput = requestUserInputWithFence;
}

export function resolveRuntimePromptSource(
  prompt: RuntimeLaunchPrompt,
  session: SessionEntry,
): RuntimeMessageTarget | undefined {
  let resolvedSource = prompt.source;
  if (resolvedSource) {
    resolvedSource = enrichSourceFromSessionChatBinding(resolvedSource, session);
  }
  if (!resolvedSource) {
    resolvedSource = resolveSourceFromSessionChatBinding(session);
  }
  if (!resolvedSource && session.lastChannel && session.lastTo) {
    resolvedSource = {
      channel: session.lastChannel,
      accountId: session.lastAccountId ?? "",
      chatId: session.lastTo,
    };
  }

  return resolvedSource?.channel === "tui" ? undefined : resolvedSource;
}

function splitCanonicalPlatformChat(platformChatId: string): { chatId: string; threadId?: string } {
  const separator = platformChatId.indexOf("#");
  if (separator === -1) return { chatId: platformChatId };
  const chatId = platformChatId.slice(0, separator);
  const threadId = platformChatId.slice(separator + 1);
  return threadId ? { chatId, threadId } : { chatId };
}

function resolveSourceFromSessionChatBinding(session: SessionEntry): RuntimeMessageTarget | undefined {
  const binding = dbGetSessionChatBinding(session.sessionKey);
  if (!binding) return undefined;
  const chat = dbGetChat(binding.chatId);
  if (!chat) return undefined;
  const accountId = configStore.resolveAccountName(chat.instanceId) ?? session.lastAccountId ?? chat.instanceId;
  if (!accountId) return undefined;
  const target = splitCanonicalPlatformChat(chat.platformChatId);
  return {
    channel: chat.channel,
    accountId,
    instanceId: chat.instanceId,
    canonicalChatId: chat.id,
    ...target,
  };
}

function enrichSourceFromSessionChatBinding(source: RuntimeMessageTarget, session: SessionEntry): RuntimeMessageTarget {
  if (source.canonicalChatId) return source;
  const binding = dbGetSessionChatBinding(session.sessionKey);
  if (!binding) return source;
  const chat = dbGetChat(binding.chatId);
  if (!chat || !isSourceForChat(source, chat)) return source;
  return {
    ...source,
    instanceId: source.instanceId ?? chat.instanceId,
    canonicalChatId: chat.id,
  };
}

function isSourceForChat(source: RuntimeMessageTarget, chat: NonNullable<ReturnType<typeof dbGetChat>>): boolean {
  if (source.channel && source.channel !== chat.channel) return false;
  const sourceChatId = source.chatId?.trim();
  if (!sourceChatId) return false;
  const platformTarget = splitCanonicalPlatformChat(chat.platformChatId);
  const candidates = new Set(
    [chat.id, chat.platformChatId, chat.normalizedChatId, platformTarget.chatId].filter((value): value is string =>
      Boolean(value?.trim()),
    ),
  );
  if (!candidates.has(sourceChatId)) return false;
  if (source.threadId && platformTarget.threadId && source.threadId !== platformTarget.threadId) return false;
  return true;
}

export async function buildRuntimeStartRequest(
  options: RuntimeStartRequestBuildOptions,
): Promise<RuntimeStartRequestBuildResult> {
  const {
    runId,
    sessionName,
    prompt,
    session,
    agent,
    runtimeProviderId,
    runtimeProvider,
    runtimeCapabilities,
    sessionCwd,
    dbSessionKey,
    model,
    runtimeResolution,
    storedRuntimeSessionParams,
    storedProviderSessionId,
    canResumeStoredSession,
    resolvedSource,
    approvalSource,
    streamingSession,
    stashedMessages,
    defaultRuntimeProviderId,
    crashRecovery,
  } = options;
  const toolEffectFence = resolveRuntimeToolEffectFence(runtimeProviderId, runtimeCapabilities.tools.permissionMode);
  streamingSession.toolEffectFence = toolEffectFence;

  const { runtimeContext, toolContext, raviEnv } = buildRuntimeRequestContext({
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
  });

  const { hostServices, providerBootstrap, runtimePlugins } = await prepareRuntimeProviderBootstrap({
    runtimeProvider,
    runtimeCapabilities,
    agent,
    sessionName,
    sessionCwd,
    resolvedSource,
    approvalSource,
    toolContext,
    context: runtimeContext,
    session,
  });
  installCrashRecoveryApprovalFences({ hostServices, streamingSession, crashRecovery });
  const credentialResolution = await resolveRuntimeCredentialAttemptBinding({
    runtimeProvider: runtimeProviderId,
    upstreamProvider: resolveRuntimeCredentialUpstreamProvider(runtimeProviderId, model),
    model,
    agentId: agent.id,
    sessionKey: dbSessionKey,
    sessionName,
    runId,
  });
  if (!credentialResolution.attemptBinding && credentialResolution.managedPoolConfigured) {
    throw new Error(formatRuntimeCredentialResolutionFailure(runtimeProviderId, model, credentialResolution.rejected));
  }
  if (credentialResolution.attemptBinding) {
    (toolContext as Record<string, unknown>).runtimeCredential = serializeRuntimeCredentialAttemptBinding(
      credentialResolution.attemptBinding,
    );
  }
  const providerEnv = mergeProviderCredentialEnv(
    providerBootstrap?.env,
    buildRuntimeCredentialProfileEnv(runtimeProviderId, credentialResolution.attemptBinding ?? undefined),
    credentialResolution.attemptBinding?.resolvedEnv,
  );
  const runtimeEnv = buildRuntimeRequestEnv({
    raviEnv,
    ...(providerEnv ? { providerEnv } : {}),
    runtimeCapabilities,
  });
  const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
    const result = await hostServices.authorizeToolUse({ toolName, input });
    if (!result.approved) {
      return {
        behavior: "deny" as const,
        reason: result.reason ?? `${toolName} permission denied.`,
      };
    }
    return {
      behavior: "allow" as const,
      updatedInput: result.updatedInput ?? input,
    };
  };

  const canResumeCredentialSession =
    canResumeStoredSession &&
    isRuntimeCredentialSessionCompatible(storedRuntimeSessionParams, credentialResolution.attemptBinding);
  const { forkFromProviderSessionId, resumeProviderSessionId } = resolveRuntimeSessionContinuity({
    dbSessionKey,
    runtimeProviderId,
    supportsSessionFork: runtimeCapabilities.supportsSessionFork,
    supportsSessionResume: runtimeCapabilities.supportsSessionResume,
    storedProviderSessionId,
    canResumeStoredSession: canResumeCredentialSession,
    defaultRuntimeProviderId,
  });
  const { specServer, hooks, remoteSpawn } = buildRuntimeHostAttachments({
    runtimeCapabilities,
    agent,
    sessionName,
    sessionCwd,
    resolvedSource,
    approvalSource,
    streamingSession,
    crashRecovery,
  });
  const { text: systemPromptAppend, sections: systemPromptSections } = await buildRuntimeSystemPrompt({
    agent,
    ctx: prompt.context,
    sessionName,
    cwd: sessionCwd,
    sessionRuntimeParams: session.runtimeSessionParams,
    runtimeContext,
  });
  const systemPromptSectionMetadata = buildRuntimeTracePromptSectionMetadata(systemPromptSections);
  const pluginNames = runtimePlugins.map((plugin) => plugin.path);
  const mcpServerNames = specServer ? ["spec"] : [];
  const resolvedAllowedSkills = resolveAgentSkills(agent.id);
  const allowedSkills =
    resolvedAllowedSkills.hasConfiguration && resolvedAllowedSkills.allowlist.length > 0
      ? resolvedAllowedSkills.allowlist
      : undefined;
  const toolAccessMode = getRuntimeToolAccessMode(runtimeCapabilities, agent.id, runtimeContext);
  const traceTurnStart = (input: { combinedPrompt: string; deliverableMessages: RuntimeUserMessage[] }) => {
    const firstMessage = input.deliverableMessages[0];
    const turnId = createSessionTraceTurnId();
    const currentModel = streamingSession.currentModel;
    const runtimeCredential = credentialResolution.attemptBinding;
    if (runtimeCredential && !runtimeCredential.attemptId) {
      runtimeCredential.attemptId = reserveRuntimeCredentialAttempt({
        credentialId: runtimeCredential.credentialId,
        sessionKey: dbSessionKey,
        sessionName,
        runId,
        turnId,
        runtimeProvider: runtimeCredential.runtimeProvider,
        upstreamProvider: runtimeCredential.upstreamProvider,
        model: currentModel,
        metadata: { reason: "turn" },
      });
    }
    bindRuntimeCredentialAttemptTurn(runtimeCredential?.attemptId, turnId);
    markRuntimeCredentialAttemptStarted(runtimeCredential?.attemptId);
    const traceTurn = recordAdapterRequestTrace({
      sessionKey: dbSessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      turnId,
      provider: runtimeProviderId,
      model: currentModel,
      effort: runtimeResolution.options.effort ?? null,
      thinking: runtimeResolution.options.thinking ?? null,
      modelSource: runtimeResolution.sources.model,
      effortSource: runtimeResolution.sources.effort,
      thinkingSource: runtimeResolution.sources.thinking,
      prompt: input.combinedPrompt,
      systemPrompt: systemPromptAppend,
      systemPromptSectionMetadata,
      cwd: sessionCwd,
      resume: Boolean(resumeProviderSessionId || canResumeCredentialSession),
      fork: Boolean(forkFromProviderSessionId),
      providerSessionIdBefore:
        forkFromProviderSessionId ??
        resumeProviderSessionId ??
        (canResumeCredentialSession ? storedProviderSessionId : null) ??
        null,
      contextId: runtimeContext.contextId,
      source: streamingSession.currentSource ?? resolvedSource ?? null,
      deliveryBarrier: firstMessage?.deliveryBarrier ?? null,
      deliveryBarrierSource: firstMessage?.deliveryBarrierSource ?? null,
      taskBarrierTaskId: firstMessage?.taskBarrierTaskId ?? null,
      settingSources: agent.settingSources ?? ["project"],
      hasHooks: Boolean(hooks && Object.keys(hooks).length > 0),
      pluginNames,
      mcpServerNames,
      hasRemoteSpawn: Boolean(remoteSpawn),
      toolAccessMode,
      capabilitySummary: summarizeRuntimeCapabilities(runtimeCapabilities),
      queuedMessageCount: input.deliverableMessages.length,
      pendingIds: input.deliverableMessages.map((message) => message.pendingId).filter((id): id is string => !!id),
      commands: input.deliverableMessages.flatMap((message) => message.commands ?? []),
      runtimeCredential: runtimeCredential ? serializeRuntimeCredentialAttemptBinding(runtimeCredential) : null,
      turnProvenance: streamingSession.currentTurnProvenance ?? null,
    });
    if (!traceTurn) {
      throw new Error(`Failed to persist the adapter request for runtime turn ${turnId}`);
    }

    const turnProvenance =
      streamingSession.currentTurnProvenance ??
      classifyTurnProvenance({ source: streamingSession.currentSource ?? resolvedSource });
    const pendingIds = input.deliverableMessages
      .map((message) => message.pendingId)
      .filter((id): id is string => Boolean(id));
    let attempt: ReturnType<RuntimeCrashRecoveryCoordinator["startTurnAttempt"]>;
    try {
      attempt = crashRecovery.startTurnAttempt(
        {
          turnId: traceTurn.turnId,
          runId,
          sessionKey: dbSessionKey,
          sessionName,
          agentId: agent.id,
          provider: runtimeProviderId,
          model: currentModel,
          startedAt: traceTurn.startedAt,
          requestBlobSha256: traceTurn.requestBlobSha256,
          userPromptSha256: traceTurn.userPromptSha256,
          systemPromptSha256: traceTurn.systemPromptSha256,
          originKind: turnProvenance.origin,
          source: streamingSession.currentSource ?? resolvedSource ?? null,
          turnProvenance,
          taskBarrierTaskId: firstMessage?.taskBarrierTaskId ?? null,
          deliveryBarrier: firstMessage?.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER,
          pendingIds,
          metadata: {
            deliveryBarrierSource: firstMessage?.deliveryBarrierSource ?? null,
            queuedMessageCount: input.deliverableMessages.length,
            toolEffectFence,
          },
        },
        {
          onOwnershipLost: () => {
            // The coordinator already cleared ownership. Detach the stale
            // session binding before abort handlers inspect or terminalize it.
            streamingSession.currentCrashRecoveryAttemptId = undefined;
            streamingSession.internalAbortReason = "crash_recovery_ownership_lost";
            if (!streamingSession.abortController.signal.aborted) {
              streamingSession.abortController.abort();
            }
          },
        },
      );
    } catch (error) {
      const completedAt = Math.max(Date.now(), traceTurn.startedAt);
      recordTerminalTurnTrace({
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        runId,
        turnId: traceTurn.turnId,
        provider: runtimeProviderId,
        model: currentModel,
        status: "failed",
        eventType: "turn.failed",
        abortReason: "durable_attempt_persistence_failed",
        error: error instanceof Error ? error.message : String(error),
        startedAt: traceTurn.startedAt,
        completedAt,
        payloadJson: {
          phase: "runtime.durable_attempt_preparation",
          providerDelivered: false,
        },
      });
      throw error;
    }
    return { ...traceTurn, crashRecoveryAttemptId: attempt.attemptId };
  };
  const messageGenerator = createRuntimeMessageGenerator({
    sessionName,
    session: streamingSession,
    stashedMessages,
    beforeTurnStart: (input) => {
      const turnPrompt = resolveRuntimeTurnPrompt(input.deliverableMessages, prompt);
      const turnSource = turnPrompt.source ?? resolvedSource;
      if (turnSource) {
        streamingSession.currentSource = turnSource;
      }
      streamingSession.currentChannelBackend = turnPrompt._channelBackend;
      streamingSession.currentTurnProvenance = classifyTurnProvenance({
        prompt: turnPrompt,
        source: turnSource,
      });
      refreshRuntimeRequestContextForTurn({
        runtimeContext,
        toolContext,
        runtimeEnv,
        dbSessionKey,
        sessionName,
        sessionCwd,
        agent,
        prompt: turnPrompt,
        runtimeProviderId,
        model,
        runtimeResolution,
        resolvedSource: turnSource,
        approvalSource,
      });
    },
    traceTurnStart,
  });

  return {
    runtimeRequest: {
      prompt: messageGenerator,
      model,
      ...(runtimeResolution.options.effort ? { effort: runtimeResolution.options.effort } : {}),
      ...(runtimeResolution.options.thinking ? { thinking: runtimeResolution.options.thinking } : {}),
      cwd: sessionCwd,
      ...(resumeProviderSessionId ? { resume: resumeProviderSessionId } : {}),
      ...(canResumeCredentialSession
        ? {
            resumeSession: {
              params: storedRuntimeSessionParams,
              displayId: session.runtimeSessionDisplayId ?? storedProviderSessionId,
            },
          }
        : {}),
      ...(forkFromProviderSessionId ? { forkSession: true } : {}),
      abortController: streamingSession.abortController,
      permissionOptions: {
        permissionMode: "bypassPermissions",
      },
      canUseTool,
      ...(providerBootstrap?.startRequest ?? {}),
      env: runtimeEnv,
      ...(specServer ? { mcpServers: { spec: specServer } } : {}),
      systemPromptAppend,
      settingSources: agent.settingSources ?? ["project"],
      ...(hooks ? { hooks } : {}),
      ...(runtimePlugins.length > 0 ? { plugins: runtimePlugins } : {}),
      ...(allowedSkills ? { allowedSkills } : {}),
      ...(remoteSpawn ? { remoteSpawn } : {}),
    },
    toolContext,
    ...(credentialResolution.attemptBinding ? { runtimeCredentialAttempt: credentialResolution.attemptBinding } : {}),
  };
}

function resolveRuntimeTurnPrompt(
  deliverableMessages: RuntimeUserMessage[],
  fallback: RuntimeLaunchPrompt,
): RuntimeLaunchPrompt {
  for (let index = deliverableMessages.length - 1; index >= 0; index--) {
    const launchPrompt = deliverableMessages[index]?.launchPrompt;
    if (launchPrompt) return launchPrompt;
  }
  return fallback;
}

function mergeProviderCredentialEnv(
  ...envs: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const present = envs.filter((env): env is Record<string, string> => Boolean(env));
  if (present.length === 0) return undefined;
  return {
    ...Object.assign({}, ...present),
  };
}

export function resolveRuntimeCredentialUpstreamProvider(
  runtimeProviderId: RuntimeProviderId,
  model: string | undefined,
): string | undefined {
  const selector = model?.trim();
  const slashIndex = selector?.indexOf("/") ?? -1;
  if (selector && slashIndex > 0 && slashIndex < selector.length - 1) {
    return selector.slice(0, slashIndex);
  }
  if (runtimeProviderId === "pi") {
    return process.env.RAVI_PI_PROVIDER?.trim() || process.env.PI_PROVIDER?.trim() || "openai";
  }
  if (runtimeProviderId === "codex") {
    return process.env.RAVI_CODEX_PROVIDER?.trim() || process.env.CODEX_PROVIDER?.trim() || "openai";
  }
  if (runtimeProviderId === "claude") {
    return (
      process.env.RAVI_CLAUDE_UPSTREAM_PROVIDER?.trim() ||
      process.env.CLAUDE_CODE_PROVIDER?.trim() ||
      process.env.ANTHROPIC_PROVIDER?.trim() ||
      "anthropic"
    );
  }
  return undefined;
}

function buildRuntimeCredentialProfileEnv(
  runtimeProviderId: RuntimeProviderId,
  binding: RuntimeCredentialAttemptBinding | undefined,
): Record<string, string> | undefined {
  const authProfileRef = binding?.authProfileRef?.trim();
  if (!authProfileRef) return undefined;
  const profilePath = expandHomePath(authProfileRef);
  if (runtimeProviderId === "codex") {
    return { CODEX_HOME: profilePath };
  }
  if (runtimeProviderId === "claude") {
    return { CLAUDE_CONFIG_DIR: profilePath };
  }
  return undefined;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return `${homedir()}${value.slice(1)}`;
  return value;
}

function formatRuntimeCredentialResolutionFailure(
  runtimeProviderId: RuntimeProviderId,
  model: string | undefined,
  rejected: Array<{ label: string; reason: string }>,
): string {
  const reasonSummary = rejected
    .slice(0, 5)
    .map((item) => `${item.label}: ${item.reason}`)
    .join("; ");
  const suffix = reasonSummary ? ` Rejected credentials: ${reasonSummary}.` : "";
  return `No managed runtime credential could be resolved for provider ${runtimeProviderId}${model ? ` model ${model}` : ""}.${suffix}`;
}
