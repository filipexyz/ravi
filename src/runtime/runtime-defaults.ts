/**
 * Live global runtime defaults.
 *
 * Stored settings are the operator-configured source of truth. Environment
 * variables (`RAVI_MODEL` and any sibling) are last-resort fallbacks used only
 * when no stored value exists. Hardcoded constants are the final last resort
 * when neither a setting nor an env value is present.
 *
 * Callers MUST go through this module (or `runtime-selection.ts`) instead of
 * treating `loadConfig().model` as the live default.
 */

import { dbGetSetting } from "../router/router-db.js";
import { DEFAULT_RUNTIME_EFFORT, parseRuntimeEffort, type RuntimeEffort } from "./effort.js";
import { DEFAULT_RUNTIME_PROVIDER_ID, listRegisteredRuntimeProviderIds } from "./provider-registry.js";
import type { RuntimeProviderId } from "./types.js";

export const RUNTIME_DEFAULT_PROVIDER_SETTING = "runtime.defaultProvider";
export const RUNTIME_DEFAULT_MODEL_SETTING = "runtime.defaultModel";
export const RUNTIME_DEFAULT_EFFORT_SETTING = "runtime.defaultEffort";
export const RUNTIME_DEFAULT_MODEL_ENV = "RAVI_MODEL";
export const HARDCODED_RUNTIME_MODEL = "sonnet";

export type RuntimeDefaultSource = "global_default" | "env_fallback" | "runtime_default";

export interface RuntimeDefaultValue<T> {
  value: T;
  source: RuntimeDefaultSource;
}

export interface ResolvedRuntimeDefaults {
  provider: RuntimeDefaultValue<RuntimeProviderId>;
  model: RuntimeDefaultValue<string>;
  effort: RuntimeDefaultValue<RuntimeEffort>;
}

export interface RuntimeDefaultsDeps {
  getSetting?: (key: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

function readStoredSetting(key: string, deps?: RuntimeDefaultsDeps): string | null {
  try {
    const raw = (deps?.getSetting ?? dbGetSetting)(key);
    const normalized = raw?.trim();
    return normalized ? normalized : null;
  } catch {
    return null;
  }
}

function readEnv(name: string, deps?: RuntimeDefaultsDeps): string | null {
  const raw = (deps?.env ?? process.env)[name]?.trim();
  return raw ? raw : null;
}

function isRegisteredProvider(value: string): value is RuntimeProviderId {
  return listRegisteredRuntimeProviderIds().includes(value);
}

export function resolveRuntimeDefaults(deps?: RuntimeDefaultsDeps): ResolvedRuntimeDefaults {
  const storedProvider = readStoredSetting(RUNTIME_DEFAULT_PROVIDER_SETTING, deps);
  const storedModel = readStoredSetting(RUNTIME_DEFAULT_MODEL_SETTING, deps);
  const storedEffort = readStoredSetting(RUNTIME_DEFAULT_EFFORT_SETTING, deps);
  const envModel = readEnv(RUNTIME_DEFAULT_MODEL_ENV, deps);

  const provider: RuntimeDefaultValue<RuntimeProviderId> =
    storedProvider && isRegisteredProvider(storedProvider)
      ? { value: storedProvider, source: "global_default" }
      : { value: DEFAULT_RUNTIME_PROVIDER_ID, source: "runtime_default" };

  const model: RuntimeDefaultValue<string> = storedModel
    ? { value: storedModel, source: "global_default" }
    : envModel
      ? { value: envModel, source: "env_fallback" }
      : { value: HARDCODED_RUNTIME_MODEL, source: "runtime_default" };

  let effort: RuntimeDefaultValue<RuntimeEffort> = {
    value: DEFAULT_RUNTIME_EFFORT,
    source: "runtime_default",
  };
  if (storedEffort) {
    try {
      const parsed = parseRuntimeEffort(storedEffort);
      if (parsed) {
        effort = { value: parsed, source: "global_default" };
      }
    } catch {
      // Invalid stored effort is ignored; hardcoded default remains last resort.
    }
  }

  return { provider, model, effort };
}

/** Live model used when no session/agent/preset/task value exists. */
export function resolveGlobalRuntimeModel(deps?: RuntimeDefaultsDeps): string {
  return resolveRuntimeDefaults(deps).model.value;
}
