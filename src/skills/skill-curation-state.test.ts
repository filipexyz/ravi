import { describe, expect, it } from "bun:test";
import {
  markSkillMessageProcessed,
  preserveSkillCurationState,
  readSkillCurationState,
} from "./skill-curation-state.js";

describe("skill-curation-state (I16 durable watermark, separate from memory)", () => {
  it("cold-start: absent state reads as zero", () => {
    expect(readSkillCurationState({ runtimeSessionParams: undefined }).lastCuratedMessageId).toBe(0);
    expect(readSkillCurationState({ runtimeSessionParams: {} }).lastCuratedMessageId).toBe(0);
  });

  it("mark advances the skill watermark under its own key", () => {
    const next = markSkillMessageProcessed({ runtimeSessionParams: {} }, 42);
    expect((next.skillCuration as { lastCuratedMessageId: number }).lastCuratedMessageId).toBe(42);
    expect(readSkillCurationState({ runtimeSessionParams: next }).lastCuratedMessageId).toBe(42);
  });

  it("is monotonic — never regresses", () => {
    const at42 = markSkillMessageProcessed({ runtimeSessionParams: {} }, 42);
    const at10 = markSkillMessageProcessed({ runtimeSessionParams: at42 }, 10);
    expect((at10.skillCuration as { lastCuratedMessageId: number }).lastCuratedMessageId).toBe(42);
  });

  it("does NOT clobber the memory watermark (separate concern, same JSON column)", () => {
    const params = {
      memoryCuration: { lastCuratedMessageId: 99, turnCount: 5 },
      skillVisibility: { loadedSkills: ["x"] },
    };
    const next = markSkillMessageProcessed({ runtimeSessionParams: params }, 7);
    expect((next.memoryCuration as { lastCuratedMessageId: number }).lastCuratedMessageId).toBe(99);
    expect((next.skillVisibility as { loadedSkills: string[] }).loadedSkills).toEqual(["x"]);
    expect((next.skillCuration as { lastCuratedMessageId: number }).lastCuratedMessageId).toBe(7);
  });

  it("clamps corrupt/absurd stored values", () => {
    expect(
      readSkillCurationState({ runtimeSessionParams: { skillCuration: { lastCuratedMessageId: 1e18 } } })
        .lastCuratedMessageId,
    ).toBe(0);
  });

  describe("preserveSkillCurationState (M2 — survive the main session's per-turn param write)", () => {
    it("carries the durable watermark forward into an incoming provider-params replace", () => {
      const existing = { skillCuration: { lastCuratedMessageId: 500 }, sessionId: "old" };
      const incoming = { sessionId: "new", skillVisibility: { loadedSkills: ["a"] } }; // provider params, no skillCuration
      const merged = preserveSkillCurationState(existing, incoming);
      expect((merged?.skillCuration as { lastCuratedMessageId: number }).lastCuratedMessageId).toBe(500);
      expect(merged?.sessionId).toBe("new"); // provider-authoritative data untouched
    });

    it("is a no-op when there is no watermark to preserve", () => {
      const incoming = { sessionId: "new" };
      expect(preserveSkillCurationState({ sessionId: "old" }, incoming)).toBe(incoming);
      expect(preserveSkillCurationState(undefined, incoming)).toBe(incoming);
    });
  });
});
