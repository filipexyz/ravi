import { configStore } from "../config-store.js";
import {
  clearProviderSession,
  expandHome,
  getOrCreateSession,
  getSessionByName,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { logger } from "../utils/logger.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { createRuntimeProvider } from "./provider-registry.js";
import { resolveAgentModelSelection } from "./model-preset-resolver.js";
import type { RuntimeProviderId } from "./types.js";
import { resolveStoredRuntimeProvider } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";
import { validateRuntimeSessionState, type RuntimeSessionStateInvalidReason } from "./session-state.js";
import { resolveRuntimeForPrompt } from "./task-runtime-context.js";

const log = logger.child("runtime:session-resolver");

export interface RuntimeSessionResolution {
  sessionEntry: SessionEntry | null;
  agentId: string;
  agent: AgentConfig;
  agentCwd: string;
  runtimeProviderId: RuntimeProviderId;
  runtimeProvider: SessionRuntimeProvider;
  runtimeCapabilities: RuntimeCapabilities;
  runtimeResolution: TaskRuntimeResolution;
  model: string;
  session: SessionEntry;
  sessionCwd: string;
  dbSessionKey: string;
  storedRuntimeSessionParams: Record<string, unknown> | undefined;
  storedProviderSessionId?: string;
  storedRuntimeProvider?: RuntimeProviderId;
  canResumeStoredSession: boolean;
  resumeDecision: RuntimeResumeDecision;
}

export interface RuntimeResumeDecision {
  hadStoredProviderSessionId: boolean;
  storedProviderSessionAgeMs?: number;
  storedRuntimeProvider?: RuntimeProviderId;
  requestedRuntimeProvider: RuntimeProviderId;
  supportsSessionResume: boolean;
  providerMatches: boolean;
  sessionStateValid: boolean;
  sessionStateInvalidReason?: RuntimeSessionStateInvalidReason;
  canResume: boolean;
  reason:
    | "resuming"
    | "missing_provider_session"
    | "provider_mismatch"
    | "provider_resume_unsupported"
    | "session_state_invalid"
    | "unknown";
  staleCleared: boolean;
}

export function resolveRuntimeSession(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  configModel: string;
  defaultRuntimeProviderId: RuntimeProviderId;
}): RuntimeSessionResolution | null {
  const routerConfig = configStore.getConfig();
  const sessionEntry = getSessionByName(options.sessionName);
  const agentId = options.prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
  const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

  if (!agent) {
    log.error("No agent found", { sessionName: options.sessionName, agentId });
    return null;
  }

  const agentCwd = expandHome(agent.cwd);
  const agentSelection = resolveAgentModelSelection(agent);
  const sessionRuntimeProviderOverride =
    options.prompt._observation && options.prompt._runtimeProviderId
      ? undefined
      : sessionEntry?.runtimeProviderOverride;
  const runtimeProviderId: RuntimeProviderId =
    options.prompt._observation && options.prompt._runtimeProviderId
      ? options.prompt._runtimeProviderId
      : sessionRuntimeProviderOverride
        ? sessionRuntimeProviderOverride
        : agentSelection.modelSource === "agent_preset"
          ? agentSelection.effectiveProvider
          : (agent.provider ?? options.defaultRuntimeProviderId);
  const runtimeProvider = createRuntimeProvider(runtimeProviderId);
  const runtimeCapabilities = runtimeProvider.getCapabilities();

  let session: SessionEntry;
  if (sessionEntry && sessionEntry.agentId !== agentId) {
    session = getOrCreateSession(sessionEntry.sessionKey, agentId, agentCwd);
  } else {
    session = sessionEntry ?? getOrCreateSession(options.sessionName, agentId, agentCwd, { name: options.sessionName });
  }

  let storedRuntimeSessionParams = session.runtimeSessionParams;
  let storedProviderSessionId =
    session.runtimeSessionDisplayId ?? session.providerSessionId ?? session.sdkSessionId ?? undefined;
  const storedRuntimeProvider = resolveStoredRuntimeProvider(session);
  const providerMatches = storedRuntimeProvider === runtimeProviderId;
  const runtimeResolution = resolveRuntimeForPrompt({
    sessionName: options.sessionName,
    prompt: options.prompt,
    session,
    agent,
    configModel: options.configModel,
  });
  const model = runtimeResolution.options.model ?? options.configModel;
  const sessionStateValidation = validateRuntimeSessionState({
    capabilities: runtimeCapabilities,
    storedProviderSessionId,
    storedRuntimeSessionParams,
    sessionCwd: expandHome(session.agentCwd),
    runtimeProviderId,
    model,
  });
  const canResumeStoredSession =
    !!storedProviderSessionId &&
    providerMatches &&
    runtimeCapabilities.supportsSessionResume &&
    sessionStateValidation.valid;
  const resumeDecision: RuntimeResumeDecision = {
    hadStoredProviderSessionId: !!storedProviderSessionId,
    ...(storedProviderSessionId ? { storedProviderSessionAgeMs: Math.max(0, Date.now() - session.updatedAt) } : {}),
    ...(storedRuntimeProvider ? { storedRuntimeProvider } : {}),
    requestedRuntimeProvider: runtimeProviderId,
    supportsSessionResume: runtimeCapabilities.supportsSessionResume,
    providerMatches,
    sessionStateValid: sessionStateValidation.valid,
    ...(sessionStateValidation.reason ? { sessionStateInvalidReason: sessionStateValidation.reason } : {}),
    canResume: canResumeStoredSession,
    reason: resolveResumeDecisionReason({
      hasStoredProviderSessionId: !!storedProviderSessionId,
      providerMatches,
      supportsSessionResume: runtimeCapabilities.supportsSessionResume,
      sessionStateValid: sessionStateValidation.valid,
      canResume: canResumeStoredSession,
    }),
    staleCleared: false,
  };

  if (storedProviderSessionId && !canResumeStoredSession) {
    log.info("Clearing stale provider session state", {
      sessionName: options.sessionName,
      dbSessionKey: session.sessionKey,
      storedProvider: storedRuntimeProvider,
      requestedProvider: runtimeProviderId,
      resumeDecision,
    });
    clearProviderSession(session.sessionKey);
    session.runtimeSessionParams = undefined;
    session.runtimeSessionDisplayId = undefined;
    session.providerSessionId = undefined;
    session.sdkSessionId = undefined;
    session.runtimeProvider = undefined;
    storedRuntimeSessionParams = undefined;
    storedProviderSessionId = undefined;
    resumeDecision.staleCleared = true;
  }

  return {
    sessionEntry,
    agentId,
    agent,
    agentCwd,
    runtimeProviderId,
    runtimeProvider,
    runtimeCapabilities,
    runtimeResolution,
    model,
    session,
    sessionCwd: expandHome(session.agentCwd),
    dbSessionKey: session.sessionKey,
    storedRuntimeSessionParams,
    storedProviderSessionId,
    storedRuntimeProvider,
    canResumeStoredSession,
    resumeDecision,
  };
}

function resolveResumeDecisionReason(input: {
  hasStoredProviderSessionId: boolean;
  providerMatches: boolean;
  supportsSessionResume: boolean;
  sessionStateValid: boolean;
  canResume: boolean;
}): RuntimeResumeDecision["reason"] {
  if (input.canResume) return "resuming";
  if (!input.hasStoredProviderSessionId) return "missing_provider_session";
  if (!input.providerMatches) return "provider_mismatch";
  if (!input.supportsSessionResume) return "provider_resume_unsupported";
  if (!input.sessionStateValid) return "session_state_invalid";
  return "unknown";
}
