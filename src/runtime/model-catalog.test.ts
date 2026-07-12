import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultModelForProvider, listRuntimeModels, resolvePreferredRuntimeModel } from "./model-catalog.js";
import { resolveAgentModelSelection, resolveEffectiveAgentModel } from "./model-preset-resolver.js";
import type { RuntimeModelPreset } from "./model-preset-store.js";

function fakePreset(overrides: Partial<RuntimeModelPreset> = {}): RuntimeModelPreset {
  return {
    id: "fast-sonnet",
    provider: "anthropic",
    model: "sonnet",
    description: null,
    enabled: true,
    version: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("model catalog", () => {
  test("parses visible codex models sorted by priority", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-models-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "models_cache.json");

    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.3-codex",
            display_name: "gpt-5.3-codex",
            description: "Coding",
            visibility: "list",
            priority: 2,
          },
          { slug: "gpt-5.4", display_name: "gpt-5.4", description: "Latest", visibility: "list", priority: 0 },
          { slug: "hidden", display_name: "hidden", description: "Hidden", visibility: "hidden", priority: 1 },
        ],
      }),
    );

    const models = listRuntimeModels("codex", { codexCachePath: cachePath });
    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
    expect(getDefaultModelForProvider("codex", { codexCachePath: cachePath })).toBe("gpt-5.4");
  });

  test("surfaces GPT-5.6 Sol/Terra/Luna models when present in the codex catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-models-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "models_cache.json");

    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", priority: 0 },
          { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", visibility: "list", priority: 1 },
          { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", visibility: "list", priority: 2 },
        ],
      }),
    );

    const models = listRuntimeModels("codex", { codexCachePath: cachePath });
    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(resolvePreferredRuntimeModel("codex", "gpt-5.6-sol", { codexCachePath: cachePath })).toBe("gpt-5.6-sol");
  });

  test("normalizes full claude ids to aliases", () => {
    expect(resolvePreferredRuntimeModel("claude", "claude-opus-4-6")).toBe("opus");
    expect(resolvePreferredRuntimeModel("claude", "claude-sonnet-4-6")).toBe("sonnet");
  });

  test("falls back to provider default when model is incompatible", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-models-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "models_cache.json");

    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [{ slug: "gpt-5.2-codex", display_name: "gpt-5.2-codex", visibility: "list", priority: 0 }],
      }),
    );

    expect(resolvePreferredRuntimeModel("codex", "sonnet", { codexCachePath: cachePath })).toBe("gpt-5.2-codex");
  });

  test("passes through models for providers without a registered catalog", () => {
    expect(listRuntimeModels("custom-provider")).toEqual([]);
    expect(getDefaultModelForProvider("custom-provider")).toBe("default");
    expect(resolvePreferredRuntimeModel("custom-provider", "custom-model")).toBe("custom-model");
  });
});

describe("agent model preset resolution", () => {
  const lookupPreset = (preset: RuntimeModelPreset | null) => () => preset;

  test("resolves an enabled preset as agent_preset with provider/model/version", () => {
    const selection = resolveAgentModelSelection(
      { modelPresetId: "fast-sonnet" },
      { lookupPreset: lookupPreset(fakePreset()) },
    );
    expect(selection.modelSource).toBe("agent_preset");
    expect(selection.effectiveProvider).toBe("anthropic");
    expect(selection.effectiveModel).toBe("sonnet");
    expect(selection.modelPresetVersion).toBe(3);
    expect(selection.error).toBeNull();
  });

  test("rejects a disabled preset without falling back to the global default", () => {
    const selection = resolveAgentModelSelection(
      { modelPresetId: "fast-sonnet" },
      { lookupPreset: lookupPreset(fakePreset({ enabled: false })) },
    );
    expect(selection.modelSource).toBeNull();
    expect(selection.effectiveModel).toBeNull();
    expect(selection.error).toContain("disabled");
  });

  test("prefers the direct model and warns on legacy drift when both are set", () => {
    const selection = resolveAgentModelSelection(
      { model: "opus", modelPresetId: "fast-sonnet" },
      { lookupPreset: lookupPreset(fakePreset()) },
    );
    expect(selection.modelSource).toBe("agent_default");
    expect(selection.effectiveModel).toBe("opus");
    expect(selection.warning).toContain("drift");
  });

  test("folds in the global default only when the agent has no model or preset", () => {
    const effective = resolveEffectiveAgentModel({}, "haiku", { lookupPreset: lookupPreset(null) });
    expect(effective.modelSource).toBe("global_default");
    expect(effective.effectiveModel).toBe("haiku");

    const direct = resolveEffectiveAgentModel({ model: "opus" }, "haiku", { lookupPreset: lookupPreset(null) });
    expect(direct.modelSource).toBe("agent_default");
    expect(direct.effectiveModel).toBe("opus");
  });
});
