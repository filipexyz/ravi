/**
 * Canonical next-turn runtime selection.
 *
 * Provider, model, and effort are independent axes. Display and launch MUST
 * share this module so `sessions info` cannot invent a model or disagree with
 * the start path. A missing/invalid agent preset never swallows into env.
 */

import type { AgentConfig, SessionEntry } from "../router/types.js";
import { DEFAULT_RUNTIME_EFFORT, type RuntimeEffort } from "./effort.js";
import { resolveAgentModelSelection, type ResolveAgentModelSelectionOptions } from "./model-preset-resolver.js";
import { resolveRuntimeDefaults, type ResolvedRuntimeDefaults, type RuntimeDefaultsDeps } from "./runtime-defaults.js";
import type { RuntimeProviderId } from "./types.js";

export type RuntimeProviderSource =
  | "launch_override"
  | "observation_override"
  | "session_override"
  | "last_used"
  | "restart_snapshot"
  | "agent_preset"
  | "agent_default"
  | "global_default"
  | "runtime_default";

const EXPLICIT_RUNTIME_PROVIDER_SOURCES = new Set<RuntimeProviderSource>([
  "launch_override",
  "observation_override",
  "session_override",
]);

export function isExplicitRuntimeProviderSource(source: RuntimeProviderSource): boolean {
  return EXPLICIT_RUNTIME_PROVIDER_SOURCES.has(source);
}

export type RuntimeModelSource =
  | "session_override"
  | "agent_preset"
  | "agent_default"
  | "global_default"
  | "env_fallback"
  | "runtime_default";

export type RuntimeEffortSource = "session_override" | "agent_default" | "global_default" | "runtime_default";

export type RuntimeThinkingSource = "session_override" | null;

export interface RequestedRuntimeProviderResolution {
  value: RuntimeProviderId;
  source: RuntimeProviderSource;
  warning: string | null;
  error: string | null;
}

export interface EffectiveSessionRuntimeSelection {
  provider: { value: RuntimeProviderId; source: RuntimeProviderSource };
  model: {
    value: string | null;
    source: RuntimeModelSource | null;
    presetId: string | null;
    presetVersion: number | null;
    warning: string | null;
    error: string | null;
  };
  effort: { value: RuntimeEffort; source: RuntimeEffortSource };
  thinking: { value: SessionEntry["thinkingLevel"] | null; source: RuntimeThinkingSource };
}

export class UnusableAgentModelPresetError extends Error {
  readonly modelPresetId: string | null;

  constructor(message: string, modelPresetId: string | null = null) {
    super(message);
    this.name = "UnusableAgentModelPresetError";
    this.modelPresetId = modelPresetId;
  }
}

export function resolveRequestedRuntimeProvider(input: {
  runtimeProviderIdOverride?: RuntimeProviderId;
  observationProviderId?: RuntimeProviderId;
  sessionProviderOverride?: RuntimeProviderId | null;
  lastUsedProvider?: RuntimeProviderId | null;
  restartSnapshotProvider?: RuntimeProviderId | null;
  agent: Pick<AgentConfig, "model" | "modelPresetId" | "provider">;
  defaults?: ResolvedRuntimeDefaults;
  defaultsDeps?: RuntimeDefaultsDeps;
  lookupPreset?: ResolveAgentModelSelectionOptions["lookupPreset"];
}): RequestedRuntimeProviderResolution {
  const defaults = input.defaults ?? resolveRuntimeDefaults(input.defaultsDeps);
  const agentSelection = resolveAgentModelSelection(input.agent, {
    ...(input.lookupPreset ? { lookupPreset: input.lookupPreset } : {}),
  });

  if (input.runtimeProviderIdOverride) {
    return {
      value: input.runtimeProviderIdOverride,
      source: "launch_override",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  if (input.observationProviderId) {
    return {
      value: input.observationProviderId,
      source: "observation_override",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  const sessionOverride = input.sessionProviderOverride?.trim() || undefined;
  if (sessionOverride) {
    return {
      value: sessionOverride as RuntimeProviderId,
      source: "session_override",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  const lastUsed = input.lastUsedProvider?.trim() || undefined;
  if (lastUsed) {
    return {
      value: lastUsed as RuntimeProviderId,
      source: "last_used",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  const restartSnapshot = input.restartSnapshotProvider?.trim() || undefined;
  if (restartSnapshot) {
    return {
      value: restartSnapshot as RuntimeProviderId,
      source: "restart_snapshot",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  if (agentSelection.modelSource === "agent_preset") {
    return {
      value: agentSelection.effectiveProvider as RuntimeProviderId,
      source: "agent_preset",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  const agentProvider = input.agent.provider?.trim();
  if (agentProvider) {
    return {
      value: agentProvider as RuntimeProviderId,
      source: "agent_default",
      warning: agentSelection.warning,
      error: agentSelection.error,
    };
  }

  return {
    value: defaults.provider.value,
    source: defaults.provider.source === "global_default" ? "global_default" : "runtime_default",
    warning: agentSelection.warning,
    error: agentSelection.error,
  };
}

export function resolveEffectiveSessionRuntime(input: {
  session: Pick<
    SessionEntry,
    "agentId" | "runtimeProvider" | "runtimeProviderOverride" | "modelOverride" | "effortOverride" | "thinkingLevel"
  >;
  agent?: Pick<AgentConfig, "model" | "modelPresetId" | "provider" | "effort"> | null;
  defaults?: ResolvedRuntimeDefaults;
  defaultsDeps?: RuntimeDefaultsDeps;
  lookupPreset?: ResolveAgentModelSelectionOptions["lookupPreset"];
}): EffectiveSessionRuntimeSelection {
  const defaults = input.defaults ?? resolveRuntimeDefaults(input.defaultsDeps);
  const agent = input.agent ?? {};
  const provider = resolveRequestedRuntimeProvider({
    sessionProviderOverride: input.session.runtimeProviderOverride,
    lastUsedProvider: input.session.runtimeProvider,
    agent,
    defaults,
    lookupPreset: input.lookupPreset,
  });
  const agentSelection = resolveAgentModelSelection(agent, {
    ...(input.lookupPreset ? { lookupPreset: input.lookupPreset } : {}),
  });

  const sessionModel = input.session.modelOverride?.trim() || undefined;
  let modelValue: string | null = null;
  let modelSource: RuntimeModelSource | null = null;

  if (sessionModel) {
    modelValue = sessionModel;
    modelSource = "session_override";
  } else if (agentSelection.error) {
    modelValue = null;
    modelSource = null;
  } else if (agentSelection.modelSource === "agent_preset" && agentSelection.effectiveModel) {
    modelValue = agentSelection.effectiveModel;
    modelSource = "agent_preset";
  } else if (agentSelection.modelSource === "agent_default" && agentSelection.effectiveModel) {
    modelValue = agentSelection.effectiveModel;
    modelSource = "agent_default";
  } else {
    modelValue = defaults.model.value;
    modelSource = defaults.model.source;
  }

  const effort = input.session.effortOverride
    ? { value: input.session.effortOverride, source: "session_override" as const }
    : agent.effort
      ? { value: agent.effort, source: "agent_default" as const }
      : defaults.effort.source === "global_default"
        ? { value: defaults.effort.value, source: "global_default" as const }
        : { value: DEFAULT_RUNTIME_EFFORT, source: "runtime_default" as const };

  const thinking = input.session.thinkingLevel
    ? { value: input.session.thinkingLevel, source: "session_override" as const }
    : { value: null, source: null };

  return {
    provider: { value: provider.value, source: provider.source },
    model: {
      value: modelValue,
      source: modelSource,
      presetId: agentSelection.modelPresetId,
      presetVersion: agentSelection.modelPresetVersion,
      warning: agentSelection.warning,
      error: agentSelection.error,
    },
    effort,
    thinking,
  };
}

export function assertUsableAgentModelPreset(input: {
  error: string | null;
  modelPresetId: string | null;
  shadowedByHigherModel: boolean;
}): void {
  if (!input.error || input.shadowedByHigherModel) {
    return;
  }
  throw new UnusableAgentModelPresetError(input.error, input.modelPresetId);
}
