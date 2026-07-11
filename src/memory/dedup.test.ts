import { describe, expect, it } from "bun:test";
import { dedupeEntries } from "./dedup.js";

describe("dedupeEntries (R14 supersession helper)", () => {
  it("returns the same content when there are no duplicates", () => {
    const result = dedupeEntries("alpha\n\nbeta\n\ngamma");
    expect(result.content).toBe("alpha\n\nbeta\n\ngamma");
    expect(result.originalCount).toBe(3);
    expect(result.finalCount).toBe(3);
    expect(result.removedCount).toBe(0);
  });

  it("removes trailing duplicates and preserves order (keepFirst = true default)", () => {
    const result = dedupeEntries("alpha\n\nbeta\n\nalpha\n\ngamma\n\nbeta");
    expect(result.content).toBe("alpha\n\nbeta\n\ngamma");
    expect(result.removedCount).toBe(2);
  });

  it("keeps the LAST occurrence when keepFirst = false", () => {
    const result = dedupeEntries("v1\n\nv2\n\nv1", { keepFirst: false });
    // v1 stays because the last occurrence wins; v2 stays untouched (unique).
    expect(result.content.split("\n\n")).toEqual(["v2", "v1"]);
    expect(result.removedCount).toBe(1);
  });

  it("drops empty entries so a stray newline run does not survive", () => {
    const result = dedupeEntries("alpha\n\n\n\nbeta");
    expect(result.finalCount).toBe(2);
    expect(result.content).toBe("alpha\n\nbeta");
  });

  it("trims whitespace so duplicate detection ignores incidental padding", () => {
    const result = dedupeEntries("alpha  \n\n  alpha\n\nbeta");
    expect(result.finalCount).toBe(2);
    expect(result.removedCount).toBe(1);
  });

  it("honors a custom separator", () => {
    const result = dedupeEntries("alpha§beta§alpha", { separator: "§" });
    expect(result.content).toBe("alpha§beta");
    expect(result.removedCount).toBe(1);
  });

  it("handles empty input cleanly", () => {
    const result = dedupeEntries("");
    expect(result).toEqual({ content: "", originalCount: 0, finalCount: 0, removedCount: 0 });
  });
});
