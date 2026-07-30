import { describe, expect, it } from "bun:test";
import { validateProviderModelCompatibility, validateRuntimeModelSelector } from "./model-validation.js";

describe("validateRuntimeModelSelector", () => {
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

describe("validateProviderModelCompatibility", () => {
  it("rejects Codex/OpenAI models on the claude provider", () => {
    for (const model of ["codex", "gpt-5.4", "gpt-5.3-codex", "o3", "o4-mini"]) {
      const result = validateProviderModelCompatibility("claude", model);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("claude");
      expect(result.error).toContain(model);
    }
  });

  it("accepts Claude-family models on the codex provider (runtime falls back to its default model)", () => {
    for (const model of ["sonnet", "haiku", "opus", "claude-opus-4-1"]) {
      expect(validateProviderModelCompatibility("codex", model)).toEqual({ ok: true });
    }
  });

  it("accepts matching provider/model pairs", () => {
    expect(validateProviderModelCompatibility("claude", "sonnet")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("claude", "claude-opus-4-1")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("codex", "gpt-5.4")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("codex", "gpt-5.3-codex")).toEqual({ ok: true });
  });

  it("fails open for unknown providers, empty models, and unrecognized models", () => {
    expect(validateProviderModelCompatibility("custom-runtime", "codex")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("acme", "anything")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("claude", "")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("claude", "   ")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("claude", "some-experimental-model")).toEqual({ ok: true });
    expect(validateProviderModelCompatibility("pi", "kimi-coding/kimi-for-coding")).toEqual({ ok: true });
  });
});
