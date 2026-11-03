import { describe, expect, test } from "bun:test";

import { normalizeUserCode } from "./device-auth";

describe("CLI Console device authorization", () => {
  test("normalizes human user codes without accepting malformed values", () => {
    expect(normalizeUserCode("ABCD-EFGH")).toBe("ABCDEFGH");
    expect(normalizeUserCode("abcd efgh")).toBe("ABCDEFGH");
    expect(normalizeUserCode("ABC")).toBeNull();
    expect(normalizeUserCode(null)).toBeNull();
  });
});
