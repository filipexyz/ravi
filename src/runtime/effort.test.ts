import { describe, expect, it } from "bun:test";
import {
  DEFAULT_RUNTIME_EFFORT,
  RUNTIME_EFFORT_LEVELS,
  formatRuntimeEffortLevels,
  normalizeRuntimeEffort,
  parseRuntimeEffort,
  resolveRuntimeEffort,
  toCodexRuntimeEffort,
  toStrongestCompatibleRuntimeEffort,
} from "./effort.js";

describe("runtime effort", () => {
  it("exposes the canonical expanded effort list", () => {
    expect(RUNTIME_EFFORT_LEVELS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(formatRuntimeEffortLevels()).toBe("none|minimal|low|medium|high|xhigh|max|ultra");
    expect(DEFAULT_RUNTIME_EFFORT).toBe("xhigh");
  });

  it("normalizes max and ultra", () => {
    expect(normalizeRuntimeEffort("max")).toBe("max");
    expect(normalizeRuntimeEffort("ULTRA")).toBe("ultra");
    expect(normalizeRuntimeEffort("  Max  ")).toBe("max");
  });

  it("returns undefined for empty values", () => {
    expect(normalizeRuntimeEffort("")).toBeUndefined();
    expect(normalizeRuntimeEffort("   ")).toBeUndefined();
    expect(normalizeRuntimeEffort(null)).toBeUndefined();
    expect(normalizeRuntimeEffort(undefined)).toBeUndefined();
    expect(parseRuntimeEffort("")).toBeUndefined();
  });

  it("returns undefined for invalid values without falling back", () => {
    expect(normalizeRuntimeEffort("invalid")).toBeUndefined();
    expect(normalizeRuntimeEffort("extreme")).toBeUndefined();
  });

  it("parses strictly, throwing on unknown values", () => {
    expect(parseRuntimeEffort("ultra")).toBe("ultra");
    expect(() => parseRuntimeEffort("invalid")).toThrow(/Invalid runtime effort/);
    expect(() => parseRuntimeEffort("xhighest")).toThrow(/none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra/);
  });

  it("resolves to the default for empty or invalid input", () => {
    expect(resolveRuntimeEffort(undefined)).toBe("xhigh");
    expect(resolveRuntimeEffort("invalid")).toBe("xhigh");
    expect(resolveRuntimeEffort("max")).toBe("max");
    expect(toCodexRuntimeEffort("ultra")).toBe("ultra");
  });

  it("maps xhigh to max for strongest-compatible providers", () => {
    expect(toStrongestCompatibleRuntimeEffort("xhigh")).toBe("max");
    expect(toStrongestCompatibleRuntimeEffort("max")).toBe("max");
    expect(toStrongestCompatibleRuntimeEffort("ultra")).toBe("max");
    expect(toStrongestCompatibleRuntimeEffort("high")).toBe("high");
    expect(toStrongestCompatibleRuntimeEffort("none")).toBe("low");
    expect(toStrongestCompatibleRuntimeEffort("minimal")).toBe("low");
    expect(toStrongestCompatibleRuntimeEffort(undefined)).toBe("max");
  });
});
