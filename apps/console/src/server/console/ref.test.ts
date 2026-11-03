import { describe, expect, test } from "bun:test";

import { isUuidRef } from "./ref";

describe("Console ref helpers", () => {
  test("distinguishes UUID refs from slug and email refs", () => {
    expect(isUuidRef("8e0e034f-6cce-4f10-82da-3ebf2c8b49f4")).toBe(true);

    expect(isUuidRef("luis")).toBe(false);
    expect(isUuidRef("operator@ravi.bot")).toBe(false);
    expect(isUuidRef("org_123")).toBe(false);
  });
});
