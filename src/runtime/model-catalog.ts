import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeProviderId } from "./types.js";

export interface RuntimeProviderOption {
  id: RuntimeProviderId;
  name: string;
  description: string;
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
];

export interface RuntimeModelCatalogOptions {
  codexCachePath?: string;
}

export function listRuntimeProviders(): RuntimeProviderOption[] {
  return PROVIDER_OPTIONS;
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
  if (normalized && models.length === 0) {
    return normalized;
  }
  if (normalized && models.some((entry) => entry.id.toLowerCase() === normalized.toLowerCase())) {
    return normalized;
  }

  return getDefaultModelForProvider(provider, options);
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
