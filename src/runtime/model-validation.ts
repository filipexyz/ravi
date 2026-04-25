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
