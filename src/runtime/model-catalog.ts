import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PricingCatalogSnapshot } from "../costs/pricing-catalog.js";
import { resolveModelContextWindow } from "./model-context-window.js";
import type { RuntimeProviderId } from "./types.js";

export interface RuntimeProviderOption {
  id: RuntimeProviderId;
  name: string;
  description: string;
  /** True when the provider takes a free-form model selector instead of a fixed list. */
  freeText?: boolean;
}

export interface RuntimeModelOption {
  id: string;
  name: string;
  description: string;
  priority: number;
}

interface CodexModelCacheEntry {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
}

interface CodexModelCache {
  models?: CodexModelCacheEntry[];
}

const CLAUDE_MODEL_OPTIONS: RuntimeModelOption[] = [
  {
    id: "sonnet",
    name: "sonnet",
    description: "Balanced default for most Claude sessions.",
    priority: 0,
  },
  {
    id: "haiku",
    name: "haiku",
    description: "Cheaper and faster for lightweight turns.",
    priority: 1,
  },
  {
    id: "opus",
    name: "opus",
    description: "Highest-capability Claude model for harder tasks.",
    priority: 2,
  },
];

const FALLBACK_CODEX_MODEL_OPTIONS: RuntimeModelOption[] = [
  {
    id: "gpt-5.4",
    name: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    priority: 0,
  },
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    description: "Strong coding-focused Codex model.",
    priority: 1,
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "gpt-5.3-codex-spark",
    description: "Faster Codex variant for shorter coding loops.",
    priority: 2,
  },
];

const GROK_MODEL_OPTIONS: RuntimeModelOption[] = [
  {
    id: "grok-4",
    name: "grok-4",
    description: "Default Grok ACP model.",
    priority: 0,
  },
];

const CLAUDE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku"]);

const PROVIDER_OPTIONS: RuntimeProviderOption[] = [
  {
    id: "claude",
    name: "Claude",
    description: "Anthropic runtime with Ravi hook support.",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Local Codex CLI runtime with native Codex skills.",
  },
  {
    id: "grok",
    name: "Grok",
    description: "xAI Grok ACP runtime.",
  },
  {
    id: "pi",
    name: "Pi",
    description: "Pi RPC runtime; models are free-form `provider/model` selectors.",
    freeText: true,
  },
];

export interface RuntimeModelCatalogOptions {
  codexCachePath?: string;
}

/** Providers with a fixed model list (what the TUI model picker can offer). */
export function listRuntimeProviders(): RuntimeProviderOption[] {
  return PROVIDER_OPTIONS.filter((option) => !option.freeText);
}

export interface RuntimeModelCatalogModel {
  id: string;
  name: string;
  description: string;
  contextWindow: number | null;
}

export interface RuntimeModelCatalogProvider {
  id: RuntimeProviderId;
  name: string;
  description: string;
  freeText: boolean;
  defaultModel: string | null;
  models: RuntimeModelCatalogModel[];
}

export interface RuntimeModelCatalogListOptions extends RuntimeModelCatalogOptions {
  /** Pricing catalog used for context windows; `null` skips it. Defaults to the locally cached catalog. */
  pricingCatalog?: PricingCatalogSnapshot | null;
}

/**
 * Valid models per provider for the given provider ids (normally every id in the
 * provider registry). Unknown providers are reported as free-form with no models.
 */
export function listRuntimeModelCatalog(
  providerIds: RuntimeProviderId[],
  options: RuntimeModelCatalogListOptions = {},
): RuntimeModelCatalogProvider[] {
  return providerIds.map((id) => {
    const option = PROVIDER_OPTIONS.find((entry) => entry.id === id);
    const models = listRuntimeModels(id, options).map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      contextWindow:
        resolveModelContextWindow({ model: model.id }, { catalog: options.pricingCatalog })?.tokens ?? null,
    }));
    return {
      id,
      name: option?.name ?? id,
      description: option?.description ?? "Registered runtime provider without a model catalog.",
      freeText: option ? Boolean(option.freeText) : true,
      defaultModel: models[0]?.id ?? null,
      models,
    };
  });
}

export function listRuntimeModels(
  provider: RuntimeProviderId,
  options: RuntimeModelCatalogOptions = {},
): RuntimeModelOption[] {
  if (provider === "claude") {
    return CLAUDE_MODEL_OPTIONS;
  }

  if (provider === "codex") {
    const models = readCodexModelOptions(options.codexCachePath);
    return models.length > 0 ? models : FALLBACK_CODEX_MODEL_OPTIONS;
  }

  if (provider === "grok") {
    return GROK_MODEL_OPTIONS;
  }

  return [];
}

export function getDefaultModelForProvider(
  provider: RuntimeProviderId,
  options: RuntimeModelCatalogOptions = {},
): string {
  return listRuntimeModels(provider, options)[0]?.id ?? (provider === "claude" ? "sonnet" : "default");
}

export function resolvePreferredRuntimeModel(
  provider: RuntimeProviderId,
  model: string | null | undefined,
  options: RuntimeModelCatalogOptions = {},
): string {
  const normalized = normalizeRuntimeModel(provider, model);
  const models = listRuntimeModels(provider, options);
  if (provider !== "claude" && isClaudeModelAlias(normalized)) {
    return getDefaultModelForProvider(provider, options);
  }
  if (normalized && models.length === 0) {
    return normalized;
  }
  if (normalized && models.some((entry) => entry.id.toLowerCase() === normalized.toLowerCase())) {
    return normalized;
  }

  return getDefaultModelForProvider(provider, options);
}

export function isClaudeModelAlias(model: string | null | undefined): boolean {
  const value = model?.trim().toLowerCase();
  if (!value) return false;
  return CLAUDE_MODEL_ALIASES.has(value) || value.includes("claude");
}

function normalizeRuntimeModel(provider: RuntimeProviderId, model: string | null | undefined): string | null {
  const value = model?.trim();
  if (!value) {
    return null;
  }

  if (provider === "claude") {
    const lower = value.toLowerCase();
    if (lower.includes("sonnet")) return "sonnet";
    if (lower.includes("haiku")) return "haiku";
    if (lower.includes("opus")) return "opus";
  }

  return value;
}

function readCodexModelOptions(cachePath = join(homedir(), ".codex", "models_cache.json")): RuntimeModelOption[] {
  if (!existsSync(cachePath)) {
    return [];
  }

  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as CodexModelCache;
    const models = parsed.models ?? [];
    return models
      .filter((entry) => entry.visibility === "list" && typeof entry.slug === "string" && entry.slug.trim().length > 0)
      .map((entry) => ({
        id: entry.slug!.trim(),
        name: entry.display_name?.trim() || entry.slug!.trim(),
        description: entry.description?.trim() || "Codex model.",
        priority: typeof entry.priority === "number" ? entry.priority : Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
