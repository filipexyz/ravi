import type { AgentConfig, SessionEntry } from "../router/index.js";
import { dbGetChat, dbGetSessionChatBinding } from "../router/router-db.js";
import { configStore } from "../config-store.js";
import {
  buildRuntimeTracePromptSectionMetadata,
  createSessionTraceTurnId,
  recordAdapterRequestTrace,
  summarizeRuntimeCapabilities,
} from "../session-trace/runtime-trace.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { createRuntimeMessageGenerator } from "./delivery-queue.js";
import { getRuntimeToolAccessMode } from "./host-services.js";
import {
  type RuntimeHostStreamingSession,
  type RuntimeMessageTarget,
  type RuntimeUserMessage,
} from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeHostAttachments } from "./runtime-host-attachments.js";
import { prepareRuntimeProviderBootstrap } from "./runtime-provider-bootstrap.js";
import { buildRuntimeRequestContext, buildRuntimeRequestEnv } from "./runtime-request-context.js";
import { resolveRuntimeSessionContinuity } from "./runtime-session-continuity.js";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt.js";
import type { RuntimeCapabilities, RuntimeProviderId, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

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
}

export interface RuntimeStartRequestBuildResult {
  runtimeRequest: RuntimeStartRequest;
  toolContext: Record<string, unknown>;
}

export function resolveRuntimePromptSource(
  prompt: RuntimeLaunchPrompt,
  session: SessionEntry,
): RuntimeMessageTarget | undefined {
  let resolvedSource = prompt.source;
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
  } = options;

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
  const runtimeEnv = buildRuntimeRequestEnv({
    raviEnv,
    providerEnv: providerBootstrap?.env,
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

  const { forkFromProviderSessionId, resumeProviderSessionId } = resolveRuntimeSessionContinuity({
    dbSessionKey,
    runtimeProviderId,
    supportsSessionFork: runtimeCapabilities.supportsSessionFork,
    supportsSessionResume: runtimeCapabilities.supportsSessionResume,
    storedProviderSessionId,
    canResumeStoredSession,
    defaultRuntimeProviderId,
  });
  const { specServer, hooks, remoteSpawn } = buildRuntimeHostAttachments({
    runtimeCapabilities,
    agent,
    sessionName,
    sessionCwd,
    resolvedSource,
    approvalSource,
  });
  const { text: systemPromptAppend, sections: systemPromptSections } = await buildRuntimeSystemPrompt({
    agent,
    ctx: prompt.context,
    sessionName,
    cwd: sessionCwd,
    sessionRuntimeParams: session.runtimeSessionParams,
  });
  const systemPromptSectionMetadata = buildRuntimeTracePromptSectionMetadata(systemPromptSections);
  const pluginNames = runtimePlugins.map((plugin) => plugin.path);
  const mcpServerNames = specServer ? ["spec"] : [];
  const toolAccessMode = getRuntimeToolAccessMode(runtimeCapabilities, agent.id);
  const traceTurnStart = (input: { combinedPrompt: string; deliverableMessages: RuntimeUserMessage[] }) => {
    const firstMessage = input.deliverableMessages[0];
    return recordAdapterRequestTrace({
      sessionKey: dbSessionKey,
      sessionName,
      agentId: agent.id,
      runId,
      turnId: createSessionTraceTurnId(),
      provider: runtimeProviderId,
      model,
      effort: runtimeResolution.options.effort ?? null,
      thinking: runtimeResolution.options.thinking ?? null,
      prompt: input.combinedPrompt,
      systemPrompt: systemPromptAppend,
      systemPromptSectionMetadata,
      cwd: sessionCwd,
      resume: Boolean(resumeProviderSessionId || canResumeStoredSession),
      fork: Boolean(forkFromProviderSessionId),
      providerSessionIdBefore: forkFromProviderSessionId ?? resumeProviderSessionId ?? storedProviderSessionId ?? null,
      contextId: runtimeContext.contextId,
      source: streamingSession.currentSource ?? resolvedSource ?? null,
      deliveryBarrier: firstMessage?.deliveryBarrier ?? null,
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
    });
  };
  const messageGenerator = createRuntimeMessageGenerator({
    sessionName,
    session: streamingSession,
    stashedMessages,
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
      ...(canResumeStoredSession
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
      ...(remoteSpawn ? { remoteSpawn } : {}),
    },
    toolContext,
  };
}
