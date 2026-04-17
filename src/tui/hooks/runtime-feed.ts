import type { TokenUsage } from "./useNats.js";

export interface RuntimeFeedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function isTerminalRuntimeEvent(type?: string): boolean {
  return type === "result" || type === "turn.complete" || type === "turn.failed" || type === "turn.interrupted";
}

export function applyTerminalUsage(
  current: TokenUsage,
  usage: RuntimeFeedUsage | undefined,
  alreadyCounted: boolean,
): { total: TokenUsage; counted: boolean } {
  if (!usage || alreadyCounted) {
    return { total: current, counted: alreadyCounted };
  }

  const input = usage.input_tokens ?? usage.inputTokens ?? 0;
  const output = usage.output_tokens ?? usage.outputTokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? usage.cacheCreationTokens ?? 0;

  return {
    counted: true,
    total: {
      input: current.input + input,
      output: current.output + output,
      cacheRead: current.cacheRead + cacheRead,
      cacheCreation: current.cacheCreation + cacheCreation,
      contextTokens: input + cacheRead + cacheCreation,
    },
  };
}
