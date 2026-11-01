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

/**
 * The model a runtime will actually run for a requested model.
 *
 * Non-Claude runtimes cannot run a Claude alias, so the launcher replaces it
 * with the provider default. Display paths share this rule so `sessions threads`
 * cannot claim a model the runtime will not use.
 */
export function applyProviderModelRule(provider: RuntimeProviderId, model: string | null | undefined): string | null {
  const value = model?.trim();
  if (!value) return null;
  return provider !== "claude" && isClaudeModelAlias(value) ? resolvePreferredRuntimeModel(provider, value) : value;
}

/** Model families that are unambiguously owned by a non-Claude runtime. */
const FOREIGN_MODEL_PATTERN = /^(gpt[-_.]?\d|gpt-|o[1-9]([-_.]|$)|codex|grok|gemini|llama|mistral|deepseek)/i;

/**
 * Cross-vendor model check for an explicit `--provider` + `--model` pair.
 *
 * The launcher only remaps Claude aliases when the runtime is not Claude, so a
 * mismatched pair silently degrades (non-Claude runtime) or fails on the first
 * turn (Claude runtime). Creation paths call this to fail before the user pays
 * for a thread that cannot run.
 */
export function modelProviderMismatch(
  provider: RuntimeProviderId | undefined,
  model: string | null | undefined,
): string | null {
  const value = model?.trim();
  if (!value || !provider) return null;
  // Pi accepts provider/model selectors, but the Codex-only agent models are
  // not OpenAI API model ids. Do not silently launch them through Pi.
  if (
    provider === "pi" &&
    /^(?:(?:codex|openai|openai-codex)\/)?gpt-\d(?:\.\d+)?-(?:astra|sol|terra|luna)(?:$|-)/i.test(value)
  ) {
    return `Model "${value}" requires the codex runtime. Pass --provider codex.`;
  }
  if (provider === "codex" && /^(?:codex|openai-codex)\//i.test(value)) {
    return `Model "${value}" must be a bare model id for the codex runtime; remove its provider prefix.`;
  }
  if (provider === "pi" && !CLAUDE_MODEL_ALIASES.has(value.toLowerCase())) return null;
  if (provider === "claude") {
    if (isClaudeModelAlias(value) || !FOREIGN_MODEL_PATTERN.test(value)) return null;
    return `Model "${value}" does not belong to the claude runtime. Pass --provider for that model, or choose a Claude model.`;
  }
  if (isClaudeModelAlias(value)) {
    return `Model "${value}" is a Claude alias and ${provider} cannot run it. Pass --provider claude, or choose a ${provider} model.`;
  }
  if (provider === "codex" && /^(deepseek|gemini|grok|llama|mistral)(?:[-/_.]|$)/i.test(value)) {
    return `Model "${value}" does not belong to the codex runtime. Pass --provider for that model.`;
  }
  return null;
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
