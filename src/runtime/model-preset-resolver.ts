/**
 * Canonical runtime model resolver for agents.
 *
 * Single source of truth for turning an agent's stored model configuration
 * (a direct `model` OR an indirect `modelPresetId`) into an effective model
 * selection. Reused by the runtime dispatch path, session resolver, and CLI
 * observability so precedence and preset semantics never drift between callers.
 *
 * Precedence at the agent level is a single tier: a preset reference OR a
 * direct model. Missing/disabled/provider-incompatible presets are reported as
 * errors and never silently fall back to the global default.
 */

import type { AgentConfig } from "../router/types.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "./provider-registry.js";
import { getRuntimeModelPreset, type RuntimeModelPreset } from "./model-preset-store.js";
import { validateRuntimeModelSelector } from "./model-validation.js";

export type AgentModelSource = "agent_preset" | "agent_default" | null;

export interface AgentModelSelection {
  /** Effective runtime provider for the agent (preset provider wins when a preset applies). */
  effectiveProvider: string;
  /** Effective agent-level model, or null when the agent has no model and the global default applies. */
  effectiveModel: string | null;
  /** Where the effective agent-level model came from. */
  modelSource: AgentModelSource;
  /** Referenced preset id, when a preset reference is present (even if unusable). */
  modelPresetId: string | null;
  /** Referenced preset version, when a usable preset applies. */
  modelPresetVersion: number | null;
  /** Observable warning (e.g. legacy drift where both a model and a preset are set). */
  warning: string | null;
  /** Non-fatal error describing why a referenced preset could not be applied. */
  error: string | null;
}

export interface ResolveAgentModelSelectionOptions {
  lookupPreset?: (id: string) => RuntimeModelPreset | null;
}

export function resolveAgentModelSelection(
  agent: Pick<AgentConfig, "model" | "modelPresetId" | "provider">,
  options: ResolveAgentModelSelectionOptions = {},
): AgentModelSelection {
  const lookupPreset = options.lookupPreset ?? getRuntimeModelPreset;
  const directModel = agent.model?.trim() || undefined;
  const presetId = agent.modelPresetId?.trim() || undefined;
  const agentProvider = agent.provider?.trim() || undefined;
  const fallbackProvider = agentProvider ?? DEFAULT_RUNTIME_PROVIDER_ID;

  // Legacy drift: both a direct model and a preset reference. Prefer the direct
  // model and surface an observable warning.
  if (directModel && presetId) {
    return {
      effectiveProvider: fallbackProvider,
      effectiveModel: directModel,
      modelSource: "agent_default",
      modelPresetId: presetId,
      modelPresetVersion: null,
      warning: `Agent has both a direct model ('${directModel}') and modelPresetId ('${presetId}'). Preferring the direct model; clear one to remove drift.`,
      error: null,
    };
  }

  if (presetId) {
    const preset = lookupPreset(presetId);
    if (!preset) {
      return {
        effectiveProvider: fallbackProvider,
        effectiveModel: null,
        modelSource: null,
        modelPresetId: presetId,
        modelPresetVersion: null,
        warning: null,
        error: `Model preset not found: ${presetId}.`,
      };
    }
    if (!preset.enabled) {
      return {
        effectiveProvider: preset.provider,
        effectiveModel: null,
        modelSource: null,
        modelPresetId: preset.id,
        modelPresetVersion: preset.version,
        warning: null,
        error: `Model preset is disabled: ${preset.id}.`,
      };
    }
    if (agentProvider && agentProvider !== preset.provider) {
      return {
        effectiveProvider: preset.provider,
        effectiveModel: null,
        modelSource: null,
        modelPresetId: preset.id,
        modelPresetVersion: preset.version,
        warning: null,
        error: `Agent provider '${agentProvider}' is incompatible with preset provider '${preset.provider}'.`,
      };
    }
    const validation = validateRuntimeModelSelector(preset.provider, preset.model);
    if (!validation.ok) {
      return {
        effectiveProvider: preset.provider,
        effectiveModel: null,
        modelSource: null,
        modelPresetId: preset.id,
        modelPresetVersion: preset.version,
        warning: null,
        error: validation.error ?? `Invalid preset model: ${preset.model}.`,
      };
    }
    return {
      effectiveProvider: preset.provider,
      effectiveModel: preset.model,
      modelSource: "agent_preset",
      modelPresetId: preset.id,
      modelPresetVersion: preset.version,
      warning: null,
      error: null,
    };
  }

  if (directModel) {
    return {
      effectiveProvider: fallbackProvider,
      effectiveModel: directModel,
      modelSource: "agent_default",
      modelPresetId: null,
      modelPresetVersion: null,
      warning: null,
      error: null,
    };
  }

  return {
    effectiveProvider: fallbackProvider,
    effectiveModel: null,
    modelSource: null,
    modelPresetId: null,
    modelPresetVersion: null,
    warning: null,
    error: null,
  };
}

/**
 * Convenience view for observability surfaces: resolves the agent selection and
 * folds in the global default so callers can report the true effective model.
 */
export interface EffectiveAgentModel {
  effectiveProvider: string;
  effectiveModel: string | null;
  modelSource: "agent_preset" | "agent_default" | "global_default" | null;
  modelPresetId: string | null;
  modelPresetVersion: number | null;
  warning: string | null;
  error: string | null;
}

export function resolveEffectiveAgentModel(
  agent: Pick<AgentConfig, "model" | "modelPresetId" | "provider">,
  globalDefaultModel?: string | null,
  options: ResolveAgentModelSelectionOptions = {},
): EffectiveAgentModel {
  const selection = resolveAgentModelSelection(agent, options);
  if (selection.effectiveModel !== null) {
    return { ...selection, modelSource: selection.modelSource };
  }
  const globalModel = globalDefaultModel?.trim() || null;
  return {
    ...selection,
    effectiveModel: globalModel,
    modelSource: globalModel ? "global_default" : null,
  };
}
