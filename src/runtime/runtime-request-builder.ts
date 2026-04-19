import { buildSystemPrompt } from "../prompt-builder.js";
import type { AgentConfig, SessionEntry } from "../router/index.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { createRuntimeMessageGenerator } from "./delivery-queue.js";
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
import type { RuntimeCapabilities, RuntimeProviderId, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

export interface RuntimeStartRequestBuildOptions {
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
  if (!resolvedSource && session.lastChannel && session.lastTo) {
    resolvedSource = {
      channel: session.lastChannel,
      accountId: session.lastAccountId ?? "",
      chatId: session.lastTo,
    };
  }

  return resolvedSource?.channel === "tui" ? undefined : resolvedSource;
}

export async function buildRuntimeStartRequest(
  options: RuntimeStartRequestBuildOptions,
): Promise<RuntimeStartRequestBuildResult> {
  const {
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

  const messageGenerator = createRuntimeMessageGenerator({
    sessionName,
    session: streamingSession,
    stashedMessages,
  });

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
      systemPromptAppend: buildSystemPrompt(agent.id, prompt.context, undefined, sessionName, {
        agentMode: agent.mode,
      }),
      settingSources: agent.settingSources ?? ["project"],
      ...(hooks ? { hooks } : {}),
      ...(runtimePlugins.length > 0 ? { plugins: runtimePlugins } : {}),
      ...(remoteSpawn ? { remoteSpawn } : {}),
    },
    toolContext,
  };
}
