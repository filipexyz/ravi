import { describe, expect, it } from "bun:test";
import type { RuntimeModelPreset } from "./model-preset-store.js";
import {
  HARDCODED_RUNTIME_MODEL,
  RUNTIME_DEFAULT_MODEL_ENV,
  RUNTIME_DEFAULT_MODEL_SETTING,
  RUNTIME_DEFAULT_PROVIDER_SETTING,
  resolveRuntimeDefaults,
} from "./runtime-defaults.js";
import {
  UnusableAgentModelPresetError,
  assertUsableAgentModelPreset,
  resolveEffectiveSessionRuntime,
  resolveRequestedRuntimeProvider,
} from "./runtime-selection.js";

function fakePreset(overrides: Partial<RuntimeModelPreset> = {}): RuntimeModelPreset {
  return {
    id: "fast-sonnet",
    provider: "claude",
    model: "sonnet",
    description: null,
    enabled: true,
    version: 2,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("resolveRequestedRuntimeProvider", () => {
  it("follows session override, then agent, then stored default, then hardcoded", () => {
    const defaults = resolveRuntimeDefaults({
      getSetting: (key) => (key === RUNTIME_DEFAULT_PROVIDER_SETTING ? "pi" : null),
      env: {},
    });

    expect(
      resolveRequestedRuntimeProvider({
        sessionProviderOverride: "claude",
        agent: { provider: "codex" },
        defaults,
      }),
    ).toMatchObject({ value: "claude", source: "session_override" });

    expect(
      resolveRequestedRuntimeProvider({
        agent: { provider: "codex" },
        defaults,
      }),
    ).toMatchObject({ value: "codex", source: "agent_default" });

    expect(
      resolveRequestedRuntimeProvider({
        agent: {},
        defaults,
      }),
    ).toMatchObject({ value: "pi", source: "global_default" });

    expect(
      resolveRequestedRuntimeProvider({
        agent: {},
        defaults: resolveRuntimeDefaults({ getSetting: () => null, env: {} }),
      }),
    ).toMatchObject({ value: "codex", source: "runtime_default" });
  });

  it("uses a usable agent preset provider before stored/env defaults", () => {
    const defaults = resolveRuntimeDefaults({
      getSetting: (key) => (key === RUNTIME_DEFAULT_PROVIDER_SETTING ? "pi" : null),
      env: {},
    });

    expect(
      resolveRequestedRuntimeProvider({
        agent: { modelPresetId: "fast-sonnet" },
        defaults,
        lookupPreset: () => fakePreset(),
      }),
    ).toMatchObject({ value: "claude", source: "agent_preset" });
  });
});

describe("resolveEffectiveSessionRuntime", () => {
  it("keeps provider and model independent and does not invent a model", () => {
    const defaults = resolveRuntimeDefaults({
      getSetting: (key) => (key === RUNTIME_DEFAULT_MODEL_SETTING ? "stored-opus" : null),
      env: { [RUNTIME_DEFAULT_MODEL_ENV]: "env-sonnet" },
    });

    const resolved = resolveEffectiveSessionRuntime({
      session: { agentId: "main", runtimeProviderOverride: "claude" },
      agent: { model: "agent-gpt" },
      defaults,
    });

    expect(resolved.provider).toEqual({ value: "claude", source: "session_override" });
    expect(resolved.model.value).toBe("agent-gpt");
    expect(resolved.model.source).toBe("agent_default");
  });

  it("lets stored runtime config beat env, and env beat the hardcoded model", () => {
    const stored = resolveEffectiveSessionRuntime({
      session: { agentId: "main" },
      agent: {},
      defaults: resolveRuntimeDefaults({
        getSetting: (key) => (key === RUNTIME_DEFAULT_MODEL_SETTING ? "stored-opus" : null),
        env: { [RUNTIME_DEFAULT_MODEL_ENV]: "env-sonnet" },
      }),
    });
    expect(stored.model).toMatchObject({ value: "stored-opus", source: "global_default" });

    const env = resolveEffectiveSessionRuntime({
      session: { agentId: "main" },
      agent: {},
      defaults: resolveRuntimeDefaults({
        getSetting: () => null,
        env: { [RUNTIME_DEFAULT_MODEL_ENV]: "env-sonnet" },
      }),
    });
    expect(env.model).toMatchObject({ value: "env-sonnet", source: "env_fallback" });

    const hardcoded = resolveEffectiveSessionRuntime({
      session: { agentId: "main" },
      agent: {},
      defaults: resolveRuntimeDefaults({ getSetting: () => null, env: {} }),
    });
    expect(hardcoded.model).toMatchObject({ value: HARDCODED_RUNTIME_MODEL, source: "runtime_default" });
  });

  it("does not apply env when an agent preset is missing or disabled", () => {
    const defaults = resolveRuntimeDefaults({
      getSetting: () => null,
      env: { [RUNTIME_DEFAULT_MODEL_ENV]: "env-sonnet" },
    });

    const missing = resolveEffectiveSessionRuntime({
      session: { agentId: "main" },
      agent: { modelPresetId: "missing-preset" },
      defaults,
      lookupPreset: () => null,
    });
    expect(missing.model.value).toBeNull();
    expect(missing.model.source).toBeNull();
    expect(missing.model.error).toContain("not found");

    const disabled = resolveEffectiveSessionRuntime({
      session: { agentId: "main" },
      agent: { modelPresetId: "fast-sonnet" },
      defaults,
      lookupPreset: () => fakePreset({ enabled: false }),
    });
    expect(disabled.model.value).toBeNull();
    expect(disabled.model.error).toContain("disabled");
  });

  it("still applies a session model override when the agent preset is unusable", () => {
    const resolved = resolveEffectiveSessionRuntime({
      session: { agentId: "main", modelOverride: "session-opus" },
      agent: { modelPresetId: "fast-sonnet" },
      defaults: resolveRuntimeDefaults({
        getSetting: () => null,
        env: { [RUNTIME_DEFAULT_MODEL_ENV]: "env-sonnet" },
      }),
      lookupPreset: () => null,
    });

    expect(resolved.model).toMatchObject({ value: "session-opus", source: "session_override" });
    expect(resolved.model.error).toContain("not found");
  });
});

describe("assertUsableAgentModelPreset", () => {
  it("rejects an unusable preset unless a higher model already won", () => {
    expect(() =>
      assertUsableAgentModelPreset({
        error: "Model preset not found: missing.",
        modelPresetId: "missing",
        shadowedByHigherModel: false,
      }),
    ).toThrow(UnusableAgentModelPresetError);

    expect(() =>
      assertUsableAgentModelPreset({
        error: "Model preset not found: missing.",
        modelPresetId: "missing",
        shadowedByHigherModel: true,
      }),
    ).not.toThrow();
  });
});
