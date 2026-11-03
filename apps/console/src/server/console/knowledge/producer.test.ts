import { describe, expect, test } from "bun:test";

import { KNOWLEDGE_PRODUCER_MAX_BYTES, knowledgeChunkKey, knowledgePolicySnapshotV2 } from "./producer";

describe("knowledge producer (pure parts)", () => {
  test("the chunk key carries the stable key, the ordinal and 16 hash chars", () => {
    const hash = "0123456789abcdef".repeat(4);
    expect(knowledgeChunkKey("t872:sp1:p0", 4, hash)).toBe("t872:sp1:p0:4:0123456789abcdef");
  });

  test("the producer cap is 2 MB of chunk text", () => {
    expect(KNOWLEDGE_PRODUCER_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test("the v2 snapshot records retention", () => {
    expect(
      knowledgePolicySnapshotV2({
        trustTier: "published",
        sensitivity: "standard",
        retainUntil: new Date("2027-10-17T00:00:00.000Z"),
        capturedAt: new Date("2026-10-17T00:00:00.000Z"),
      }).retention,
    ).toEqual({ retainUntil: "2027-10-17T00:00:00.000Z" });
  });
});
