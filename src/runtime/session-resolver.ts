import { configStore } from "../config-store.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import {
  clearProviderSession,
  expandHome,
  getOrCreateSession,
  getSessionByName,
  type AgentConfig,
  type SessionEntry,
} from "../router/index.js";
import { logger } from "../utils/logger.js";
import { dbResolveActiveTaskBindingForSession } from "../tasks/task-db.js";
import { resolveTaskProfileForTask } from "../tasks/profiles.js";
import { createRuntimeProvider, listRegisteredRuntimeProviderIds } from "./provider-registry.js";
import { resolveAgentModelSelection } from "./model-preset-resolver.js";
import type { RuntimeProviderId } from "./types.js";
import { resolveStoredRuntimeProvider } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import type { RuntimeCapabilities, SessionRuntimeProvider } from "./types.js";
import { validateRuntimeSessionState, type RuntimeSessionStateInvalidReason } from "./session-state.js";
import { resolveRuntimeTargetPolicy } from "./target-policy-config.js";
import {
  selectRuntimeTarget,
  collectRuntimeCapabilityNames,
  deriveRuntimeTargetHealth,
  type RuntimeTarget,
  type RuntimeTargetPolicy,
  type RuntimeTargetRejection,
  type RuntimeTargetTurnState,
} from "./target-policy.js";
import type { RuntimeTargetPolicySource } from "./target-policy-config.js";
import { reconstructRuntimeTargetHealth, reconstructRuntimeTargetTurnState } from "./target-policy-trace.js";
import { resolveRuntimeTargetCredentialEligibility } from "./target-credential-eligibility.js";

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
  runtimeTargetPolicy?: RuntimeTargetPolicy;
  runtimeTarget?: RuntimeTarget;
  runtimeTargetRejected?: RuntimeTargetRejection[];
  runtimeTargetState?: RuntimeTargetTurnState;
  runtimeTargetPolicySource?: RuntimeTargetPolicySource;
  runtimeTargetPolicyProvenance?: string | null;
  taskProfileId?: string;
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

export type RuntimeSessionResolutionResult =
  | { ok: true; resolution: RuntimeSessionResolution | null }
  | { ok: false; error: unknown };

export function tryResolveRuntimeSession(options: {
  sessionName: string;
  prompt: RuntimeLaunchPrompt;
  defaultRuntimeProviderId: RuntimeProviderId;
}): RuntimeSessionResolutionResult {
  try {
    return { ok: true, resolution: resolveRuntimeSession(options) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function applyRuntimeTargetResolutionToPrompt(
  prompt: RuntimeLaunchPrompt,
  resolution: RuntimeSessionResolution | null,
): void {
  const { runtimeTargetPolicy, runtimeTarget, runtimeTargetState } = resolution ?? {};
  if (!runtimeTargetPolicy || !runtimeTarget || !runtimeTargetState) {
    return;
  }
  prompt._runtimeTargetPolicy = runtimeTargetPolicy;
  prompt._runtimeTargetPolicyResolution = {
    source: resolution?.runtimeTargetPolicySource ?? "none",
    provenance: resolution?.runtimeTargetPolicyProvenance ?? null,
  };
  prompt._runtimeTargetState = runtimeTargetState;
  prompt._runtimeProviderId = runtimeTarget.runtimeProvider;
  prompt._runtimeModel = runtimeTarget.model;
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
  const agentSelection = resolveAgentModelSelection(agent);
  const sessionRuntimeProviderOverride =
    options.prompt._observation && options.prompt._runtimeProviderId
      ? undefined
      : sessionEntry?.runtimeProviderOverride;
  const taskBinding = options.prompt.taskBarrierTaskId
    ? dbResolveActiveTaskBindingForSession(options.sessionName, options.prompt.taskBarrierTaskId)
    : null;
  const taskProfile = taskBinding ? resolveTaskProfileForTask(taskBinding.task) : null;
  const resolvedTargetPolicy = resolveRuntimeTargetPolicy({
    sessionOverride: options.prompt._runtimeTargetPolicy,
    taskProfilePolicy: taskProfile?.runtimeTargetPolicy,
    taskProfileId: taskProfile?.id,
    agentDefaults: agent.defaults,
    agentId,
  });
  if (options.prompt._runtimeTargetPolicyResolution && resolvedTargetPolicy.policy) {
    resolvedTargetPolicy.source = options.prompt._runtimeTargetPolicyResolution.source;
    resolvedTargetPolicy.provenance = options.prompt._runtimeTargetPolicyResolution.provenance;
  }
  const reconstructedTargetState =
    resolvedTargetPolicy.policy && options.prompt._resumeStashedMessages && sessionEntry
      ? reconstructRuntimeTargetTurnState(sessionEntry.sessionKey, resolvedTargetPolicy.policy.id)
      : undefined;
  const promptTargetState = options.prompt._runtimeTargetState;
  let targetState: RuntimeTargetTurnState | undefined;
  if (resolvedTargetPolicy.policy) {
    if (
      options.prompt._resumeStashedMessages &&
      reconstructedTargetState &&
      (!promptTargetState || reconstructedTargetState.logicalTurnId === promptTargetState.logicalTurnId)
    ) {
      targetState = reconstructedTargetState;
    } else {
      targetState = promptTargetState ?? {
        logicalTurnId: crypto.randomUUID(),
        attempts: [],
        credentialRecoveries: {},
        sideEffectBoundaryCrossed: false,
        terminal: false,
      };
    }
  }
  if (resolvedTargetPolicy.policy && targetState) {
    // Persist the selected envelope before selection. If selection is exhausted
    // and throws, the launcher still needs the authoritative state to discard
    // only this logical turn instead of replaying it forever.
    options.prompt._runtimeTargetPolicy = resolvedTargetPolicy.policy;
    options.prompt._runtimeTargetPolicyResolution = {
      source: resolvedTargetPolicy.source,
      provenance: resolvedTargetPolicy.provenance,
    };
    options.prompt._runtimeTargetState = targetState;
  }
  const registeredRuntimeProviders = new Set(listRegisteredRuntimeProviderIds());
  const agentCapabilities = materializeSubjectCapabilities("agent", agentId, { includeRoles: true });
  const permittedTargetIds = new Set(
    (resolvedTargetPolicy.policy?.targets ?? [])
      .filter((target) => canWithCapabilities(agentCapabilities, "use", "runtime.target", target.id))
      .map((target) => target.id),
  );
  const targetSelection =
    resolvedTargetPolicy.policy && targetState
      ? selectRuntimeTarget(resolvedTargetPolicy.policy, targetState, {
          now: Date.now(),
          registeredProviders: registeredRuntimeProviders,
          availableCapabilities: new Map(
            resolvedTargetPolicy.policy.targets
              .filter((target) => registeredRuntimeProviders.has(target.runtimeProvider))
              .map((target) => [
                target.runtimeProvider,
                collectRuntimeCapabilityNames(createRuntimeProvider(target.runtimeProvider).getCapabilities()),
              ]),
          ),
          permittedTargetIds,
          credentialEligibility: resolveRuntimeTargetCredentialEligibility(resolvedTargetPolicy.policy, {
            agentId,
            ...(taskProfile ? { taskProfileId: taskProfile.id } : {}),
          }),
          health: sessionEntry
            ? reconstructRuntimeTargetHealth(sessionEntry.sessionKey, resolvedTargetPolicy.policy, Date.now())
            : deriveRuntimeTargetHealth(resolvedTargetPolicy.policy, targetState),
        })
      : undefined;
  if (targetSelection?.status === "exhausted") {
    throw new Error(`Runtime target policy '${resolvedTargetPolicy.policy?.id}' is exhausted.`);
  }
  const runtimeTarget = targetSelection?.status === "selected" ? targetSelection.target : undefined;
  if (runtimeTarget && targetState) {
    targetState.attempts.push({
      targetId: runtimeTarget.id,
      attempt: targetState.attempts.filter((attempt) => attempt.targetId === runtimeTarget.id).length + 1,
      startedAt: Date.now(),
    });
  }
  const runtimeProviderId: RuntimeProviderId =
    runtimeTarget?.runtimeProvider ??
    (options.prompt._runtimeProviderId
      ? options.prompt._runtimeProviderId
      : sessionRuntimeProviderOverride
        ? sessionRuntimeProviderOverride
        : agentSelection.modelSource === "agent_preset"
          ? agentSelection.effectiveProvider
          : (agent.provider ?? options.defaultRuntimeProviderId));
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
  const sessionStateValidation = validateRuntimeSessionState({
    capabilities: runtimeCapabilities,
    storedProviderSessionId,
    storedRuntimeSessionParams,
    sessionCwd: expandHome(session.agentCwd),
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
    session,
    sessionCwd: expandHome(session.agentCwd),
    dbSessionKey: session.sessionKey,
    storedRuntimeSessionParams,
    storedProviderSessionId,
    storedRuntimeProvider,
    canResumeStoredSession,
    resumeDecision,
    ...(taskProfile?.id ? { taskProfileId: taskProfile.id } : {}),
    ...(resolvedTargetPolicy.policy ? { runtimeTargetPolicy: resolvedTargetPolicy.policy } : {}),
    ...(resolvedTargetPolicy.policy ? { runtimeTargetPolicySource: resolvedTargetPolicy.source } : {}),
    ...(resolvedTargetPolicy.policy ? { runtimeTargetPolicyProvenance: resolvedTargetPolicy.provenance } : {}),
    ...(runtimeTarget ? { runtimeTarget } : {}),
    ...(targetSelection ? { runtimeTargetRejected: targetSelection.rejected } : {}),
    ...(targetState ? { runtimeTargetState: targetState } : {}),
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
