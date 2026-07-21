import { describe, expect, it } from "bun:test";
import { observerRefreshReturnSchema } from "./operational-return-schemas.js";

describe("observer refresh return contract", () => {
  const basePayload = {
    source: {},
    total: 1,
    created: [{}],
    bindings: [{}],
    skipped: [],
  };

  it("requires and validates reconciliation result fields", () => {
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        mode: "refresh-profile",
        disabled: [],
        refreshedProfiles: [{}],
      }).success,
    ).toBe(true);
    expect(observerRefreshReturnSchema.safeParse(basePayload).success).toBe(false);
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        mode: "future-only",
        disabled: [],
        refreshedProfiles: [],
      }).success,
    ).toBe(false);
    expect(
      observerRefreshReturnSchema.safeParse({
        ...basePayload,
        source: null,
        mode: "attach-missing",
        disabled: [],
        refreshedProfiles: [],
      }).success,
    ).toBe(true);
  });
});
