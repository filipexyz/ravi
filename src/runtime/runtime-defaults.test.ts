import { describe, expect, it } from "bun:test";
import { DEFAULT_RUNTIME_EFFORT } from "./effort.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "./provider-registry.js";
import {
  HARDCODED_RUNTIME_MODEL,
  RUNTIME_DEFAULT_EFFORT_SETTING,
  RUNTIME_DEFAULT_MODEL_ENV,
  RUNTIME_DEFAULT_MODEL_SETTING,
  RUNTIME_DEFAULT_PROVIDER_SETTING,
  resolveRuntimeDefaults,
} from "./runtime-defaults.js";

describe("resolveRuntimeDefaults", () => {
  it("uses stored settings ahead of env and hardcoded fallbacks", () => {
    const resolved = resolveRuntimeDefaults({
      getSetting: (key) => {
        if (key === RUNTIME_DEFAULT_PROVIDER_SETTING) return "claude";
        if (key === RUNTIME_DEFAULT_MODEL_SETTING) return "opus";
        if (key === RUNTIME_DEFAULT_EFFORT_SETTING) return "high";
        return null;
      },
      env: { [RUNTIME_DEFAULT_MODEL_ENV]: "sonnet-from-env" },
    });

    expect(resolved.provider).toEqual({ value: "claude", source: "global_default" });
    expect(resolved.model).toEqual({ value: "opus", source: "global_default" });
    expect(resolved.effort).toEqual({ value: "high", source: "global_default" });
  });

  it("uses RAVI_MODEL only when no stored model exists", () => {
    const resolved = resolveRuntimeDefaults({
      getSetting: () => null,
      env: { [RUNTIME_DEFAULT_MODEL_ENV]: "haiku-from-env" },
    });

    expect(resolved.model).toEqual({ value: "haiku-from-env", source: "env_fallback" });
    expect(resolved.provider).toEqual({ value: DEFAULT_RUNTIME_PROVIDER_ID, source: "runtime_default" });
    expect(resolved.effort).toEqual({ value: DEFAULT_RUNTIME_EFFORT, source: "runtime_default" });
  });

  it("uses hardcoded defaults when neither setting nor env is present", () => {
    const resolved = resolveRuntimeDefaults({
      getSetting: () => null,
      env: {},
    });

    expect(resolved.provider).toEqual({ value: DEFAULT_RUNTIME_PROVIDER_ID, source: "runtime_default" });
    expect(resolved.model).toEqual({ value: HARDCODED_RUNTIME_MODEL, source: "runtime_default" });
    expect(resolved.effort).toEqual({ value: DEFAULT_RUNTIME_EFFORT, source: "runtime_default" });
  });

  it("ignores an unknown stored provider instead of inventing a live engine", () => {
    const resolved = resolveRuntimeDefaults({
      getSetting: (key) => (key === RUNTIME_DEFAULT_PROVIDER_SETTING ? "not-a-provider" : null),
      env: {},
    });

    expect(resolved.provider).toEqual({ value: DEFAULT_RUNTIME_PROVIDER_ID, source: "runtime_default" });
  });
});
