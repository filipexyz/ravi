import { getAccountForAgent, type AgentConfig } from "../router/index.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { buildRuntimeEnv, buildTaskRuntimeEnv } from "./host-env.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import {
  createRuntimeContext,
  getOrCreateAgentRuntimeContext,
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

  const runtimeContext = getOrCreateAgentRuntimeContext({
    agentId: agent.id,
    sessionKey: dbSessionKey,
    sessionName,
    source: resolvedSource
      ? {
          channel: resolvedSource.channel,
          accountId: resolvedSource.accountId,
          chatId: resolvedSource.chatId,
          ...(resolvedSource.threadId ? { threadId: resolvedSource.threadId } : {}),
        }
      : undefined,
    capabilities: snapshotAgentCapabilities(agent.id),
    metadata: {
      runtimeProvider: runtimeProviderId,
      runtimeModel: model,
      ...(runtimeResolution.options.effort ? { runtimeEffort: runtimeResolution.options.effort } : {}),
      ...(runtimeResolution.options.thinking ? { runtimeThinking: runtimeResolution.options.thinking } : {}),
      runtimeModelSource: runtimeResolution.sources.model,
      ...(approvalSource ? { approvalSource } : {}),
    },
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
  } else if (prompt.context?.accountId) {
    raviEnv.RAVI_ACCOUNT_ID = prompt.context.accountId;
    if (prompt.context.channelId) raviEnv.RAVI_CHANNEL = prompt.context.channelId;
  } else if (agent.mode === "sentinel") {
    const accountId = getAccountForAgent(agent.id);
    if (accountId) raviEnv.RAVI_ACCOUNT_ID = accountId;
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

  Object.assign(raviEnv, buildTaskRuntimeEnv(sessionName, sessionCwd, prompt.taskBarrierTaskId));
  return raviEnv;
}
