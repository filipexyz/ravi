import { describe, expect, test } from "bun:test";
import type { RuntimeEffort } from "./effort.js";
import { KIMI_CODE_MODELS, KIMI_CODE_PROVIDER_ID, isKimiCodeModel, resolveKimiCodeEffort } from "./kimi-code-models.js";

describe("Kimi Code model catalog", () => {
  test("exposes exactly the documented membership model ids", () => {
    expect(KIMI_CODE_PROVIDER_ID).toBe("kimi-code");
    expect(KIMI_CODE_MODELS.map((model) => model.id)).toEqual([
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ]);
  });

  test("recognizes only canonical Kimi Code model ids", () => {
    expect(isKimiCodeModel("k3")).toBe(true);
    expect(isKimiCodeModel("k3-256k")).toBe(true);
    expect(isKimiCodeModel("kimi-for-coding")).toBe(true);
    expect(isKimiCodeModel("kimi-for-coding-highspeed")).toBe(true);
    expect(isKimiCodeModel("kimi-coding/kimi-for-coding")).toBe(false);
    expect(isKimiCodeModel("k3 ")).toBe(false);
    expect(isKimiCodeModel("unknown")).toBe(false);
  });

  test("maps every canonical effort explicitly for both K3 models", () => {
    const efforts: Array<[RuntimeEffort | undefined, "low" | "high" | "max"]> = [
      [undefined, "high"],
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "high"],
      ["high", "high"],
      ["xhigh", "max"],
      ["max", "max"],
      ["ultra", "max"],
    ];

    for (const model of ["k3", "k3-256k"] as const) {
      for (const [effort, expected] of efforts) {
        expect(resolveKimiCodeEffort(model, effort)).toBe(expected);
      }
      expect(() => resolveKimiCodeEffort(model, "none")).toThrow("does not support effort 'none'");
    }
  });

  test("omits K3 reasoning fields for fixed-thinking models at every canonical effort", () => {
    const efforts: RuntimeEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

    for (const model of ["kimi-for-coding", "kimi-for-coding-highspeed"] as const) {
      expect(resolveKimiCodeEffort(model)).toBeUndefined();
      for (const effort of efforts) {
        expect(resolveKimiCodeEffort(model, effort)).toBeUndefined();
      }
    }
  });
});
