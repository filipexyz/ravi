/**
 * Shared constants
 */

/**
 * All built-in Claude SDK tools.
 * Used to compute disallowedTools via REBAC.
 */
export const ALL_BUILTIN_TOOLS = [
  // Core tools
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
  "Skill",
  // Additional tools
  "TaskOutput",
  "KillShell",
  "TaskStop",
  "LSP",
] as const;

export type BuiltinTool = (typeof ALL_BUILTIN_TOOLS)[number];

// ============================================================================
// Model Pricing (per 1M tokens, USD — March 2026)
// ============================================================================

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheCreation: 6.25 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheCreation: 1.25 },
};

/**
 * Resolve a model string to a pricing key.
 * Handles aliases like "opus", "sonnet", "haiku" and full model IDs.
 */
export function resolveModelPricing(model: string): ModelPricing | null {
  // Direct match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Alias matching
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  if (lower.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5"];

  return null;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
}

/**
 * Calculate cost for a single turn given model and token usage.
 */
export function calculateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number },
): CostBreakdown | null {
  const pricing = resolveModelPricing(model);
  if (!pricing) return null;

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheCost =
    (usage.cacheRead / 1_000_000) * pricing.cacheRead + (usage.cacheCreation / 1_000_000) * pricing.cacheCreation;

  return {
    inputCost,
    outputCost,
    cacheCost,
    totalCost: inputCost + outputCost + cacheCost,
  };
}
