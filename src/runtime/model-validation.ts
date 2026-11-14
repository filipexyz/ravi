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
  if (!/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return {
      ok: false,
      error: `Invalid model: '${value}' contains unsupported characters. Use the provider's model id (letters, digits, '.', '_', ':', '/', '-').`,
    };
  }

  const mismatch = ["claude", "codex", "pi", "grok"].includes(providerId)
    ? modelProviderMismatch(providerId as RuntimeProviderId, value)
    : null;
  if (mismatch) return { ok: false, error: mismatch };

  if (providerId !== "pi") {
    // Fail fast at write time — without a closed catalog. What gets refused
    // is what can never work: a family this provider does not route, or (for
    // Codex) a slug absent from this installation's account cache. A known
    // family with an unknown version passes through intact; the provider owns
    // model resolution, and a version it refuses surfaces in the liveness
    // probe with rollback.
    const catalog = checkRuntimeModelInCatalog(providerId as RuntimeProviderId, value, options);
    if (catalog.authoritative && !catalog.exists) {
      const error =
        catalog.knownFamilies.length > 0
          ? `Unknown ${providerId} model: '${value}' does not belong to any model family this provider runs. Known model families: ${catalog.knownFamilies.join(", ")}. Listed models: ${catalog.validIds.join(", ")}.`
          : `Unknown ${providerId} model: '${value}' is not in this installation's models cache. Listed models: ${catalog.validIds.join(", ")}.`;
      return { ok: false, error };
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
