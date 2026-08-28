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
import { resolveRuntimeDefaults } from "./runtime-defaults.js";
import { isExplicitRuntimeProviderSource, resolveRequestedRuntimeProvider } from "./runtime-selection.js";
import { resolveStoredRuntimeProvider } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";
import { validateRuntimeSessionState, type RuntimeSessionStateInvalidReason } from "./session-state.js";

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

export interface RuntimeSessionIdentity {
  sessionEntry: SessionEntry | null;
  agentId: string;
  agent: AgentConfig;
  agentCwd: string;
  session: SessionEntry;
  sessionCwd: string;
  dbSessionKey: string;
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
  defaultRuntimeProviderId: RuntimeProviderId;
  runtimeProviderIdOverride?: RuntimeProviderId;
  identity?: RuntimeSessionIdentity;
}): RuntimeSessionResolution | null {
  const identity = options.identity ?? resolveRuntimeSessionIdentity(options);
  if (!identity) return null;
  const { sessionEntry, agent, session, sessionCwd, dbSessionKey } = identity;
  const sessionRuntimeProviderOverride =
    options.prompt._observation && options.prompt._runtimeProviderId
      ? undefined
      : sessionEntry?.runtimeProviderOverride;
  const defaults = resolveRuntimeDefaults();
  let storedRuntimeSessionParams = session.runtimeSessionParams;
  let storedProviderSessionId =
    session.runtimeSessionDisplayId ?? session.providerSessionId ?? session.sdkSessionId ?? undefined;
  const storedRuntimeProvider = resolveStoredRuntimeProvider(session);
  const requestedProvider = resolveRequestedRuntimeProvider({
    runtimeProviderIdOverride: options.runtimeProviderIdOverride,
    observationProviderId:
      options.prompt._observation && options.prompt._runtimeProviderId ? options.prompt._runtimeProviderId : undefined,
    sessionProviderOverride: sessionRuntimeProviderOverride,
    // Only the recorded last-used column. A leftover Claude sdkSessionId must
    // not be treated as last-used or every pre-column session stays on Claude.
    lastUsedProvider: session.runtimeProvider,
    restartSnapshotProvider: options.prompt._daemonRestartResume?.runtimeProvider,
    agent,
    defaults: {
      ...defaults,
      provider:
        defaults.provider.source === "global_default"
          ? defaults.provider
          : { value: options.defaultRuntimeProviderId, source: "runtime_default" },
    },
  });
  const runtimeProviderId = requestedProvider.value;
  const runtimeProvider = createRuntimeProvider(runtimeProviderId);
  const runtimeCapabilities = runtimeProvider.getCapabilities();
  const providerMatches = storedRuntimeProvider === runtimeProviderId;
  const sessionStateValidation = validateRuntimeSessionState({
    capabilities: runtimeCapabilities,
    storedProviderSessionId,
    storedRuntimeSessionParams,
    sessionCwd,
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
    const explicitProviderChange =
      resumeDecision.reason === "provider_mismatch" && isExplicitRuntimeProviderSource(requestedProvider.source);
    const shouldClearStoredProvider = resumeDecision.reason !== "provider_mismatch" || explicitProviderChange;
    if (shouldClearStoredProvider) {
      log.info("Clearing stale provider session state", {
        sessionName: options.sessionName,
        dbSessionKey,
        storedProvider: storedRuntimeProvider,
        requestedProvider: runtimeProviderId,
        requestedProviderSource: requestedProvider.source,
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
    } else {
      log.info("Keeping stored provider session; requested provider is not an explicit change", {
        sessionName: options.sessionName,
        dbSessionKey,
        storedProvider: storedRuntimeProvider,
        requestedProvider: runtimeProviderId,
        requestedProviderSource: requestedProvider.source,
        resumeDecision,
      });
    }
  }

  return {
    ...identity,
    runtimeProviderId,
    runtimeProvider,
    runtimeCapabilities,
    storedRuntimeSessionParams,
    storedProviderSessionId,
    storedRuntimeProvider,
    canResumeStoredSession,
    resumeDecision,
  };
}

export function resolveRuntimeSessionIdentity(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
}): RuntimeSessionIdentity | null {
  const routerConfig = configStore.getConfig();
  const sessionEntry = getSessionByName(options.sessionName);
  const agentId = options.prompt._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
  const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

  if (!agent) {
    log.error("No agent found", { sessionName: options.sessionName, agentId });
    return null;
  }

  const agentCwd = expandHome(agent.cwd);
  let session: SessionEntry;
  if (sessionEntry && sessionEntry.agentId !== agentId) {
    session = getOrCreateSession(sessionEntry.sessionKey, agentId, agentCwd);
  } else {
    session = sessionEntry ?? getOrCreateSession(options.sessionName, agentId, agentCwd, { name: options.sessionName });
  }

  return {
    sessionEntry,
    agentId,
    agent,
    agentCwd,
    session,
    sessionCwd: expandHome(session.agentCwd),
    dbSessionKey: session.sessionKey,
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
