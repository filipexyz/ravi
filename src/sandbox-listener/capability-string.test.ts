import { describe, expect, test } from "bun:test";
import { parseCapabilityString, parseCapabilityStrings } from "./capability-string.js";

describe("parseCapabilityString", () => {
  test("splits permission:objectType:objectId and keeps colons in the object id", () => {
    expect(parseCapabilityString("read:task:task-1")).toEqual({
      permission: "read",
      objectType: "task",
      objectId: "task-1",
    });
    expect(parseCapabilityString("read:task:a:b")).toEqual({ permission: "read", objectType: "task", objectId: "a:b" });
  });

  test("returns null instead of failing on malformed input", () => {
    for (const value of [
      "",
      "read",
      "read:task",
      "read:task:",
      ":task:x",
      "read::x",
      42,
      null,
      undefined,
      ["read:task:x"],
    ]) {
      expect(parseCapabilityString(value)).toBeNull();
    }
  });

  test("parseCapabilityStrings is all-or-nothing", () => {
    expect(parseCapabilityStrings(["read:task:t", "mutate:task:t"])).toHaveLength(2);
    expect(parseCapabilityStrings(["read:task:t", "bogus"])).toBeNull();
    expect(parseCapabilityStrings([])).toEqual([]);
  });
});
