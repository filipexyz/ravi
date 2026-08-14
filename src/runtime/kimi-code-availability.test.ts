import { describe, expect, test } from "bun:test";
import { isKimiCodeSessionStartEnabled } from "./kimi-code-availability.js";
import { listRuntimeProviders } from "./model-catalog.js";
import { listRegisteredRuntimeProviderIds } from "./provider-registry.js";

describe("Kimi Code availability", () => {
  test("enables session starts only for the exact rollout value", () => {
    expect(isKimiCodeSessionStartEnabled({})).toBe(false);
    expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "0" })).toBe(false);
    expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "true" })).toBe(false);
    expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "1" })).toBe(true);
  });

  test("keeps the disabled provider discoverable in the registry and model catalog", () => {
    expect(listRegisteredRuntimeProviderIds()).toContain("kimi-code");
    expect(listRuntimeProviders().map((provider) => provider.id)).toContain("kimi-code");
  });
});
