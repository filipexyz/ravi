import { describe, expect, it } from "bun:test";
import { applyTerminalUsage, isTerminalRuntimeEvent } from "./runtime-feed.js";

describe("runtime-feed", () => {
  it("recognizes failed and interrupted turns as terminal events", () => {
    expect(isTerminalRuntimeEvent("turn.failed")).toBe(true);
    expect(isTerminalRuntimeEvent("turn.interrupted")).toBe(true);
    expect(isTerminalRuntimeEvent("assistant.message")).toBe(false);
  });

  it("accumulates terminal usage only once per turn", () => {
    const initial = {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheCreation: 1,
      contextTokens: 13,
    };

    const counted = applyTerminalUsage(
      initial,
      { input_tokens: 7, outputTokens: 3, cache_read_input_tokens: 4, cacheCreationTokens: 2 },
      false,
    );
    expect(counted.counted).toBe(true);
    expect(counted.total).toEqual({
      input: 17,
      output: 8,
      cacheRead: 6,
      cacheCreation: 3,
      contextTokens: 13,
    });

    const deduped = applyTerminalUsage(counted.total, { inputTokens: 99, outputTokens: 99 }, true);
    expect(deduped.total).toEqual(counted.total);
    expect(deduped.counted).toBe(true);
  });
});
