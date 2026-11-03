import { describe, expect, test } from "bun:test";

import { WORKOS_PLATFORM_OPERATOR_METADATA_KEY } from "./platform-operator";
import { isSwitchableWorkOSOrganizationId, normalizeConsoleRole } from "./workspace";

describe("console workspace role normalization", () => {
  test("does not promote missing organization roles to owner", () => {
    expect(normalizeConsoleRole(undefined)).toBe("viewer");
    expect(normalizeConsoleRole("not-a-role")).toBe("viewer");
    expect(normalizeConsoleRole("admin")).toBe("admin");
    expect(normalizeConsoleRole("member")).toBe("viewer");
    expect(normalizeConsoleRole({ slug: "admin" })).toBe("admin");
  });

  test("AuthKit session user clones do not invent User Management metadata", () => {
    const sessionUser = {
      id: "user_01HPLATFORMOPS",
      email: "ops@ravi.bot",
      firstName: "Ops",
      lastName: "User",
      profilePictureUrl: null,
    };
    const rawProfile = JSON.parse(JSON.stringify(sessionUser)) as Record<string, unknown>;
    expect(rawProfile.metadata).toBeUndefined();
    expect(rawProfile).not.toHaveProperty(WORKOS_PLATFORM_OPERATOR_METADATA_KEY);
  });

  test("only treats real WorkOS organization ids as switchable", () => {
    expect(isSwitchableWorkOSOrganizationId("org_01HWXYZ123")).toBe(true);
    expect(isSwitchableWorkOSOrganizationId("personal:user_123")).toBe(false);
    expect(isSwitchableWorkOSOrganizationId("workos-org_123")).toBe(false);
    expect(isSwitchableWorkOSOrganizationId(null)).toBe(false);
  });
});
