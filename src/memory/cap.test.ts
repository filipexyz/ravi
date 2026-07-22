import { describe, expect, it } from "bun:test";
import { checkCap, countChars } from "./cap.js";
import { DEFAULT_MEMORY_CAP_CHARS, DEFAULT_MEMORY_FILE_CAP_CHARS } from "./types.js";

describe("checkCap (R3 hard cap)", () => {
  it("passes when proposed content fits within default cap", () => {
    const result = checkCap({
      currentContent: "abc",
      proposedContent: "abcdef",
    });
    expect(result.ok).toBe(true);
    expect(result.cap).toBe(DEFAULT_MEMORY_CAP_CHARS);
    expect(result.overflowChars).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it("fails when proposed content exceeds cap and reports the overflow", () => {
    const cap = 100;
    const proposedContent = "x".repeat(150);
    const result = checkCap({
      currentContent: "",
      proposedContent,
      capChars: cap,
    });
    expect(result.ok).toBe(false);
    expect(result.overflowChars).toBe(50);
    expect(result.reason).toContain("R3");
    expect(result.reason).toContain("consolidate");
  });

  it("passes exactly at the cap boundary", () => {
    const cap = 100;
    const result = checkCap({
      currentContent: "",
      proposedContent: "x".repeat(100),
      capChars: cap,
    });
    expect(result.ok).toBe(true);
    expect(result.overflowChars).toBe(0);
  });

  it("countChars matches string length in chars (not bytes)", () => {
    expect(countChars("abc")).toBe(3);
    expect(countChars("café")).toBe(4);
    expect(countChars("")).toBe(0);
  });

  it("uses supplied cap over the default when provided", () => {
    const smallCap = 5;
    const result = checkCap({
      currentContent: "abc",
      proposedContent: "abcdefgh",
      capChars: smallCap,
    });
    expect(result.cap).toBe(smallCap);
    expect(result.ok).toBe(false);
  });

  it("memory-lifecycle L1: write/file cap is decoupled from (and larger than) the read/injection cap", () => {
    expect(DEFAULT_MEMORY_FILE_CAP_CHARS).toBeGreaterThan(DEFAULT_MEMORY_CAP_CHARS);
    const overReadUnderFile = "x".repeat(DEFAULT_MEMORY_CAP_CHARS + 5000);
    // Would BLOCK under the old read cap…
    expect(
      checkCap({ currentContent: "", proposedContent: overReadUnderFile, capChars: DEFAULT_MEMORY_CAP_CHARS }).ok,
    ).toBe(false);
    // …but PASSES under the file cap — the index no longer blocks a write on size alone (L1).
    expect(
      checkCap({ currentContent: "", proposedContent: overReadUnderFile, capChars: DEFAULT_MEMORY_FILE_CAP_CHARS }).ok,
    ).toBe(true);
  });
});
