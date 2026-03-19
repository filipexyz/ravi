import { describe, expect, it } from "bun:test";
import { parseIgnoredOmniInstanceIds, serializeIgnoredOmniInstanceIds } from "./omni-ignore.js";

describe("omni ignore helpers", () => {
  it("parses JSON arrays and removes empty or duplicate values", () => {
    expect(parseIgnoredOmniInstanceIds('["inst-b", "", "inst-a", "inst-b"]')).toEqual(["inst-b", "inst-a"]);
  });

  it("parses comma and newline separated lists", () => {
    expect(parseIgnoredOmniInstanceIds("inst-a, inst-b\ninst-c")).toEqual(["inst-a", "inst-b", "inst-c"]);
  });

  it("serializes a stable deduplicated JSON array", () => {
    expect(serializeIgnoredOmniInstanceIds(["inst-b", "inst-a", "inst-b"])).toBe('["inst-a","inst-b"]');
  });
});
