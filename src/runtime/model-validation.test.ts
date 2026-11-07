import { describe, expect, it } from "bun:test";
import { validateRuntimeModelSelector } from "./model-validation.js";

describe("validateRuntimeModelSelector", () => {
  it("rejects known runtime/model mismatches without closing custom catalogs", () => {
    for (const [provider, model] of [
      ["claude", "deepseek/deepseek-flash"],
      ["claude", "gpt-6-astra"],
      ["pi", "gpt-6-astra"],
      ["codex", "deepseek/deepseek-flash"],
    ])
      expect(validateRuntimeModelSelector(provider!, model!).ok).toBe(false);
    for (const [provider, model] of [
      ["pi", "deepseek/deepseek-flash"],
      ["pi", "anthropic/claude-sonnet-4-5"],
      ["anthropic", "sonnet"],
      ["codex", "private-model"],
      ["pi", "openai/gpt-5.4"],
    ])
      expect(validateRuntimeModelSelector(provider!, model!)).toEqual({ ok: true });
  });

  it("accepts GPT-5.6 Sol/Terra/Luna as codex model selectors", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(validateRuntimeModelSelector("codex", model)).toEqual({ ok: true });
    }
  });

  it("rejects a model selector with embedded effort as one selector", () => {
    const result = validateRuntimeModelSelector("codex", "gpt-5.6-sol ultra");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot contain whitespace");
  });

  it("rejects empty and whitespace-only model selectors", () => {
    expect(validateRuntimeModelSelector("codex", "").ok).toBe(false);
    expect(validateRuntimeModelSelector("codex", "   ").ok).toBe(false);
  });

  it("continues rejecting Pi provider-only selectors", () => {
    expect(validateRuntimeModelSelector("pi", "kimi-coding").ok).toBe(false);
    expect(validateRuntimeModelSelector("pi", "kimi-coding/kimi-for-coding")).toEqual({ ok: true });
  });
});
