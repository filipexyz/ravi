import { describe, expect, it } from "bun:test";
import { isAdminAll } from "./skill-capability-implication.js";

describe("isAdminAll", () => {
  const admin = { permission: "admin", objectType: "system", objectId: "*" };

  it("is true for the admin shortcut", () => {
    expect(isAdminAll([admin])).toBe(true);
  });

  it("is false when the turn withholds admin from a person (deny_admin:system:*)", () => {
    expect(isAdminAll([admin, { permission: "deny_admin", objectType: "system", objectId: "*" }])).toBe(false);
  });
});
