import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRuntimeModelSelector } from "./model-validation.js";

/** Codex checks pin the cache path so results do not depend on this machine's ~/.codex. */
const NO_CODEX_CACHE = { codexCachePath: "/nonexistent/ravi-test-models-cache.json" };

describe("validateRuntimeModelSelector", () => {
  it("rejects known runtime/model mismatches without closing custom catalogs", () => {
    for (const [provider, model] of [
      ["claude", "deepseek/deepseek-flash"],
      ["claude", "gpt-6-astra"],
      ["pi", "gpt-6-astra"],
      ["codex", "deepseek/deepseek-flash"],
    ])
      expect(validateRuntimeModelSelector(provider!, model!, NO_CODEX_CACHE).ok).toBe(false);
    for (const [provider, model] of [
      ["pi", "deepseek/deepseek-flash"],
      ["pi", "anthropic/claude-sonnet-4-5"],
      ["anthropic", "sonnet"],
      ["codex", "private-model"],
      ["pi", "openai/gpt-5.4"],
    ])
      expect(validateRuntimeModelSelector(provider!, model!, NO_CODEX_CACHE)).toEqual({ ok: true });
  });

  it("accepts GPT-5.6 Sol/Terra/Luna as codex model selectors", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(validateRuntimeModelSelector("codex", model, NO_CODEX_CACHE)).toEqual({ ok: true });
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

  describe("catalog existence (fail fast at write time)", () => {
    it("refuses a claude model this installation's catalog does not know, naming the valid ids", () => {
      // 2026-11-13 incident: `--provider claude --model fable-5-2` was written
      // and only died, masked, on the thread's first turn.
      const result = validateRuntimeModelSelector("claude", "fable-9-9");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("fable-9-9");
      expect(result.error).toContain("Valid models:");
      expect(result.error).toContain("sonnet");
    });

    it("accepts claude aliases and full ids that normalize into the catalog", () => {
      for (const model of ["sonnet", "opus", "haiku", "claude-sonnet-4-5-20250929", "claude-3-5-haiku-latest"]) {
        expect(validateRuntimeModelSelector("claude", model)).toEqual({ ok: true });
      }
    });

    it("refuses a grok model outside the catalog, naming the valid ids", () => {
      const result = validateRuntimeModelSelector("grok", "grok-99");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("grok-99");
      expect(result.error).toContain("grok-4");
      expect(validateRuntimeModelSelector("grok", "grok-4")).toEqual({ ok: true });
    });

    it("enforces the codex models cache when present, staying open without one", () => {
      const dir = mkdtempSync(join(tmpdir(), "ravi-model-validation-"));
      const cachePath = join(dir, "models_cache.json");
      try {
        writeFileSync(
          cachePath,
          JSON.stringify({
            models: [
              { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list", priority: 0 },
              { slug: "gpt-hidden-legacy", display_name: "Hidden", visibility: "hidden", priority: 9 },
            ],
          }),
        );
        expect(validateRuntimeModelSelector("codex", "gpt-6-astra", { codexCachePath: cachePath })).toEqual({
          ok: true,
        });
        // Hidden models still exist and run; only menus omit them.
        expect(validateRuntimeModelSelector("codex", "gpt-hidden-legacy", { codexCachePath: cachePath })).toEqual({
          ok: true,
        });
        const rejected = validateRuntimeModelSelector("codex", "gpt-nonexistent", { codexCachePath: cachePath });
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toContain("gpt-nonexistent");
        expect(rejected.error).toContain("gpt-6-astra");
        // No cache: there is no trustworthy local list, so stay permissive.
        expect(validateRuntimeModelSelector("codex", "gpt-nonexistent", NO_CODEX_CACHE)).toEqual({ ok: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps pi and unknown providers open", () => {
      expect(validateRuntimeModelSelector("pi", "openrouter/some-brand-new-model")).toEqual({ ok: true });
      expect(validateRuntimeModelSelector("custom-provider", "anything-goes")).toEqual({ ok: true });
    });
  });
});
