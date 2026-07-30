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

export function validateRuntimeModelSelector(providerId: string, model: string): RuntimeModelValidationResult {
  const value = model.trim();
  if (!value) {
    return { ok: false, error: "Invalid model: value cannot be empty" };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: `Invalid model: '${model}' cannot contain whitespace` };
  }

  if (providerId !== "pi") {
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

/**
 * Conservative provider×model compatibility check.
 *
 * Only blocks pairs that are *clearly* fatal — a model whose id unambiguously
 * belongs to the OpenAI/Codex family running on the Claude runtime (the
 * production bug this guards: provider=claude + model=codex builds a session
 * that dies within seconds and leaves the task stuck at 0%).
 *
 * The reverse direction is intentionally NOT blocked: the Codex runtime
 * tolerates Claude-family model ids by falling back to its default model
 * (see resolveCodexModelArg in codex-provider.ts), and "sonnet" is the
 * built-in global default model (src/utils/config.ts) even when the default
 * provider is codex.
 *
 * Fail-open by design: unknown providers, empty models, and unrecognized model
 * ids are accepted so existing/custom setups are never blocked.
 */
const PROVIDER_MODEL_MISMATCH_PATTERNS: Record<string, RegExp> = {
  // OpenAI/Codex family running on the Claude runtime.
  claude: /(^gpt[-\d]|^o[134](-|$)|codex)/i,
};

export function validateProviderModelCompatibility(providerId: string, model: string): RuntimeModelValidationResult {
  const value = model.trim();
  if (!value) {
    return { ok: true };
  }

  const mismatch = PROVIDER_MODEL_MISMATCH_PATTERNS[providerId.trim()];
  if (!mismatch || !mismatch.test(value)) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      `Model '${value}' is not compatible with runtime provider '${providerId.trim()}'. ` +
      `Fix the agent runtime configuration (set a matching provider/model, e.g. via 'ravi agent update'), ` +
      `or clear the model override so the provider default applies.`,
  };
}
