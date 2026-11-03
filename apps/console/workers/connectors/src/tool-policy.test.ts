import { describe, expect, test } from "bun:test";

import {
  defaultToolPolicy,
  effectiveToolPolicy,
  isLooserThan,
  sharedDefaultToolPolicy,
  strictestToolPolicy,
  toolPolicyCeiling,
} from "./tool-policy";

describe("tool policy", () => {
  test("class defaults: reads run, writes need approval", () => {
    expect(defaultToolPolicy("read")).toBe("always_allow");
    expect(defaultToolPolicy("write")).toBe("needs_approval");
    expect(defaultToolPolicy("destructive")).toBe("needs_approval");
  });

  test("strictest: blocked > needs_approval > always_allow", () => {
    expect(strictestToolPolicy()).toBe("always_allow");
    expect(strictestToolPolicy(null, undefined)).toBe("always_allow");
    expect(strictestToolPolicy("always_allow", "needs_approval")).toBe("needs_approval");
    expect(strictestToolPolicy("blocked", "needs_approval", "always_allow")).toBe("blocked");
  });

  test("the owner's choice replaces the class default", () => {
    const base = { ceiling: undefined, writesAllowed: true };
    expect(effectiveToolPolicy({ ...base, capabilityClass: "read", userPolicy: null })).toBe("always_allow");
    expect(effectiveToolPolicy({ ...base, capabilityClass: "destructive", userPolicy: null })).toBe("needs_approval");
    expect(effectiveToolPolicy({ ...base, capabilityClass: "destructive", userPolicy: "always_allow" })).toBe(
      "always_allow",
    );
    expect(effectiveToolPolicy({ ...base, capabilityClass: "read", userPolicy: "needs_approval" })).toBe(
      "needs_approval",
    );
    expect(effectiveToolPolicy({ ...base, capabilityClass: "read", userPolicy: "blocked" })).toBe("blocked");
  });

  test("the organization ceiling caps the owner's choice", () => {
    expect(
      effectiveToolPolicy({
        capabilityClass: "destructive",
        ceiling: "needs_approval",
        writesAllowed: true,
        userPolicy: "always_allow",
      }),
    ).toBe("needs_approval");
    expect(
      effectiveToolPolicy({ capabilityClass: "read", ceiling: "blocked", writesAllowed: true, userPolicy: "always_allow" }),
    ).toBe("blocked");
    expect(
      effectiveToolPolicy({ capabilityClass: "read", ceiling: "always_allow", writesAllowed: true, userPolicy: "blocked" }),
    ).toBe("blocked");
  });

  test("writes not allowed blocks write and destructive tools only", () => {
    const off = { ceiling: undefined, writesAllowed: false, userPolicy: "always_allow" as const };
    expect(effectiveToolPolicy({ ...off, capabilityClass: "write" })).toBe("blocked");
    expect(effectiveToolPolicy({ ...off, capabilityClass: "destructive" })).toBe("blocked");
    expect(effectiveToolPolicy({ ...off, capabilityClass: "read" })).toBe("always_allow");
  });

  test("ceilings: none, stored, writes off, and garbage fails closed", () => {
    expect(toolPolicyCeiling({ capabilityClass: "read", ceiling: undefined, writesAllowed: true })).toBeNull();
    expect(toolPolicyCeiling({ capabilityClass: "read", ceiling: null, writesAllowed: false })).toBeNull();
    expect(toolPolicyCeiling({ capabilityClass: "write", ceiling: null, writesAllowed: false })).toBe("blocked");
    expect(toolPolicyCeiling({ capabilityClass: "read", ceiling: "needs_approval", writesAllowed: true })).toBe(
      "needs_approval",
    );
    expect(toolPolicyCeiling({ capabilityClass: "read", ceiling: "sometimes", writesAllowed: true })).toBe("blocked");
  });

  test("looser than a ceiling", () => {
    expect(isLooserThan("always_allow", null)).toBe(false);
    expect(isLooserThan("always_allow", "needs_approval")).toBe(true);
    expect(isLooserThan("needs_approval", "needs_approval")).toBe(false);
    expect(isLooserThan("blocked", "needs_approval")).toBe(false);
    expect(isLooserThan("needs_approval", "blocked")).toBe(true);
  });

  test("shared organization accounts: reads blocked except free/busy, writes need approval", () => {
    expect(sharedDefaultToolPolicy({ id: "gmail.message.list", class: "read" })).toBe("blocked");
    expect(sharedDefaultToolPolicy({ id: "gcal.event.list", class: "read" })).toBe("blocked");
    expect(sharedDefaultToolPolicy({ id: "gcal.freebusy.query", class: "read" })).toBe("always_allow");
    expect(sharedDefaultToolPolicy({ id: "gmail.message.send", class: "write" })).toBe("needs_approval");
    const base = { capabilityClass: "read" as const, ceiling: undefined, writesAllowed: true, defaultPolicy: "blocked" as const };
    expect(effectiveToolPolicy({ ...base, userPolicy: null })).toBe("blocked");
    // The manager may loosen within the organization's ceilings.
    expect(effectiveToolPolicy({ ...base, userPolicy: "always_allow" })).toBe("always_allow");
    expect(effectiveToolPolicy({ ...base, ceiling: "needs_approval", userPolicy: "always_allow" })).toBe("needs_approval");
  });
});
