import { checkRuntimeModelInCatalog, modelProviderMismatch, type RuntimeModelCatalogOptions } from "./model-catalog.js";
import type { RuntimeProviderId } from "./types.js";

export interface RuntimeModelValidationResult {
  ok: boolean;
  error?: string;
}

const PI_PROVIDER_ONLY_MODEL_SELECTORS = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function validateRuntimeModelSelector(
  providerId: string,
  model: string,
  options: RuntimeModelCatalogOptions = {},
): RuntimeModelValidationResult {
  const value = model.trim();
  if (!value) {
    return { ok: false, error: "Invalid model: value cannot be empty" };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: `Invalid model: '${model}' cannot contain whitespace` };
  }

  const mismatch = ["claude", "codex", "pi", "grok"].includes(providerId)
    ? modelProviderMismatch(providerId as RuntimeProviderId, value)
    : null;
  if (mismatch) return { ok: false, error: mismatch };

  if (providerId !== "pi") {
    // Fail fast at write time: a model this installation's catalog does not
    // know would otherwise be stored and only fail, masked, on the first turn.
    const catalog = checkRuntimeModelInCatalog(providerId as RuntimeProviderId, value, options);
    if (catalog.authoritative && !catalog.exists) {
      return {
        ok: false,
        error: `Unknown ${providerId} model: '${value}' is not in this installation's model catalog. Valid models: ${catalog.validIds.join(", ")}.`,
      };
    }
    return { ok: true };
  }

  const slashIndex = value.indexOf("/");
  if (value.includes("/") && (slashIndex <= 0 || slashIndex === value.length - 1)) {
    return {
      ok: false,
      error: `Invalid Pi model selector: '${value}'. Use provider/model, for example kimi-coding/kimi-for-coding`,
    };
  }
  if (slashIndex === -1 && PI_PROVIDER_ONLY_MODEL_SELECTORS.has(value)) {
    return {
      ok: false,
      error: `Invalid Pi model selector: '${value}' is a provider id. Use ${value}/<model-id>`,
    };
  }

  return { ok: true };
}
