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
import { createRuntimeProvider } from "./provider-registry.js";
import type { RuntimeProviderId } from "./types.js";
import { resolveStoredRuntimeProvider } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";

const log = logger.child("runtime:session-resolver");

export interface RuntimeSessionResolution {
  sessionEntry: SessionEntry | null;
  agentId: string;
  agent: AgentConfig;
  agentCwd: string;
  runtimeProviderId: RuntimeProviderId;
  runtimeProvider: SessionRuntimeProvider;
  runtimeCapabilities: RuntimeCapabilities;
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
  canResume: boolean;
  reason: "resuming" | "missing_provider_session" | "provider_mismatch" | "provider_resume_unsupported" | "unknown";
  staleCleared: boolean;
}

export function resolveRuntimeSession(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
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
  const runtimeProviderId: RuntimeProviderId = agent.provider ?? options.defaultRuntimeProviderId;
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
  const storedRuntimeProvider = resolveStoredRuntimeProvider(session, options.defaultRuntimeProviderId);
  const providerMatches = storedRuntimeProvider === runtimeProviderId;
  const canResumeStoredSession =
    !!storedProviderSessionId && providerMatches && runtimeCapabilities.supportsSessionResume;
  const resumeDecision: RuntimeResumeDecision = {
    hadStoredProviderSessionId: !!storedProviderSessionId,
    ...(storedProviderSessionId ? { storedProviderSessionAgeMs: Math.max(0, Date.now() - session.updatedAt) } : {}),
    ...(storedRuntimeProvider ? { storedRuntimeProvider } : {}),
    requestedRuntimeProvider: runtimeProviderId,
    supportsSessionResume: runtimeCapabilities.supportsSessionResume,
    providerMatches,
    canResume: canResumeStoredSession,
    reason: resolveResumeDecisionReason({
      hasStoredProviderSessionId: !!storedProviderSessionId,
      providerMatches,
      supportsSessionResume: runtimeCapabilities.supportsSessionResume,
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
  canResume: boolean;
}): RuntimeResumeDecision["reason"] {
  if (input.canResume) return "resuming";
  if (!input.hasStoredProviderSessionId) return "missing_provider_session";
  if (!input.providerMatches) return "provider_mismatch";
  if (!input.supportsSessionResume) return "provider_resume_unsupported";
  return "unknown";
}
