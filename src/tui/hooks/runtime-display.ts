import type { RuntimeProviderId } from "../../runtime/types.js";

export interface RuntimeDisplayInput {
  configuredProvider?: RuntimeProviderId | null;
  runtimeProvider?: RuntimeProviderId | null;
  configuredModel?: string | null;
  executionModel?: string | null;
}

export interface RuntimeDisplayLabel {
  provider: RuntimeProviderId;
  model: string;
}

const CLAUDE_ALIAS_MODELS = new Set(["sonnet", "haiku", "opus"]);

export function resolveRuntimeDisplayLabel(input: RuntimeDisplayInput): RuntimeDisplayLabel {
  const provider = input.runtimeProvider ?? input.configuredProvider ?? "claude";

  const executionModel = input.executionModel?.trim();
  if (executionModel) {
    return { provider, model: executionModel };
  }

  return {
    provider,
    model: resolveConfiguredModelLabel(provider, input.configuredModel),
  };
}

function resolveConfiguredModelLabel(provider: RuntimeProviderId, configuredModel?: string | null): string {
  const value = configuredModel?.trim();
  if (!value) {
    return "default";
  }

  if (provider !== "codex") {
    return value;
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("claude") || CLAUDE_ALIAS_MODELS.has(lower) || lower === "gpt-5") {
    return "default";
  }

  return value;
}
