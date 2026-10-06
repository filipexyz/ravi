import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDefaultModelForProvider,
  listRuntimeModelCatalog,
  listRuntimeModels,
  listRuntimeProviders,
  resolvePreferredRuntimeModel,
} from "./model-catalog.js";
import { resolveModelContextWindow } from "./model-context-window.js";
import type { PricingCatalogSnapshot } from "../costs/pricing-catalog.js";
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

  test("does not pass Claude aliases to Grok from env fallback", () => {
    expect(listRuntimeModels("grok").map((model) => model.id)).toEqual(["grok-4"]);
    expect(getDefaultModelForProvider("grok")).toBe("grok-4");
    expect(resolvePreferredRuntimeModel("grok", "opus")).toBe("grok-4");
    expect(resolvePreferredRuntimeModel("grok", "sonnet")).toBe("grok-4");
    expect(resolvePreferredRuntimeModel("grok", "claude-opus-4-6")).toBe("grok-4");
    expect(resolvePreferredRuntimeModel("grok", "grok-4")).toBe("grok-4");
  });
});

function pricingCatalog(entries: PricingCatalogSnapshot["entries"]): PricingCatalogSnapshot {
  return {
    source: "test",
    sourceUrl: "https://example.invalid/prices.json",
    sourceVersion: null,
    fetchedAt: 1,
    stale: false,
    entries,
  };
}

describe("runtime model catalog listing", () => {
  test("lists every requested provider, including free-form Pi", () => {
    const catalog = listRuntimeModelCatalog(["claude", "codex", "grok", "pi"], {
      codexCachePath: join(tmpdir(), "ravi-missing-codex-cache", "models_cache.json"),
      pricingCatalog: pricingCatalog({ "gpt-5.4": { max_input_tokens: 272_000 } }),
    });

    expect(catalog.map((provider) => provider.id)).toEqual(["claude", "codex", "grok", "pi"]);
    const codex = catalog.find((provider) => provider.id === "codex")!;
    expect(codex.freeText).toBe(false);
    expect(codex.defaultModel).toBe("gpt-5.4");
    expect(codex.models[0]).toEqual({
      id: "gpt-5.4",
      name: "gpt-5.4",
      description: "Latest frontier agentic coding model.",
      contextWindow: 272_000,
    });
    // No sourced window for Claude aliases: null, never a guess.
    expect(catalog.find((provider) => provider.id === "claude")!.models.map((m) => m.contextWindow)).toEqual([
      null,
      null,
      null,
    ]);
    expect(catalog.find((provider) => provider.id === "pi")).toMatchObject({
      name: "Pi",
      freeText: true,
      defaultModel: null,
      models: [],
    });
  });

  test("reports unknown registered providers as free-form and keeps the TUI picker list fixed", () => {
    expect(listRuntimeModelCatalog(["custom-provider"], { pricingCatalog: null })).toEqual([
      {
        id: "custom-provider",
        name: "custom-provider",
        description: "Registered runtime provider without a model catalog.",
        freeText: true,
        defaultModel: null,
        models: [],
      },
    ]);
    expect(listRuntimeProviders().map((provider) => provider.id)).toEqual(["claude", "codex", "grok"]);
  });
});

describe("model context window resolver", () => {
  const catalog = pricingCatalog({
    "claude-opus-4-7": { max_input_tokens: 200_000 },
    "gpt-5.4": { max_input_tokens: "272000" },
    "no-window": { input_cost_per_token: 0.000001 },
  });

  test("prefers the provider-reported session window over the catalog", () => {
    expect(
      resolveModelContextWindow(
        { model: "gpt-5.4", runtimeSessionParams: { model: { contextWindow: 128_000 } } },
        { catalog },
      ),
    ).toEqual({ tokens: 128_000, source: "runtime-session" });
  });

  test("reads max_input_tokens from the catalog and leaves unknown models null", () => {
    expect(resolveModelContextWindow({ model: "gpt-5.4" }, { catalog })).toEqual({
      tokens: 272_000,
      source: "pricing-catalog",
    });
    expect(resolveModelContextWindow({ model: "openai/gpt-5.4" }, { catalog })?.tokens).toBe(272_000);
    expect(resolveModelContextWindow({ model: "no-window" }, { catalog })).toBeNull();
    expect(resolveModelContextWindow({ model: "sonnet" }, { catalog })).toBeNull();
    expect(resolveModelContextWindow({ model: null }, { catalog })).toBeNull();
    expect(resolveModelContextWindow({ model: "gpt-5.4" }, { catalog: null })).toBeNull();
  });

  test("does not apply the base catalog window to [1m] extended-context selectors", () => {
    expect(resolveModelContextWindow({ model: "claude-opus-4-7" }, { catalog })?.tokens).toBe(200_000);
    expect(resolveModelContextWindow({ model: "claude-opus-4-7[1m]" }, { catalog })).toBeNull();
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

  test("does not swallow an unusable preset into the global or env default", () => {
    const effective = resolveEffectiveAgentModel({ modelPresetId: "fast-sonnet" }, "haiku", {
      lookupPreset: lookupPreset(fakePreset({ enabled: false })),
      globalDefaultSource: "env_fallback",
    });
    expect(effective.effectiveModel).toBeNull();
    expect(effective.modelSource).toBeNull();
    expect(effective.error).toContain("disabled");
  });
});
