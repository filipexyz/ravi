import { describe, expect, test } from "bun:test";

import { CliApiError } from "./errors";
import { logWorkosUnmappedOrganizationRole, workosIdentityFromPayload } from "./workos";

describe("WorkOS CLI identity mapping", () => {
  test("requires an explicit valid role for organization-scoped tokens", () => {
    expect(() =>
      workosIdentityFromPayload({
        sub: "user_123",
        email: "dev@ravi.bot",
        org_id: "org_123",
      }),
    ).toThrow(CliApiError);

    try {
      workosIdentityFromPayload({
        sub: "user_123",
        email: "dev@ravi.bot",
        org_id: "org_123",
        role: "support",
      });
      throw new Error("expected ORG_ACCESS_DENIED");
    } catch (error) {
      expect(error).toBeInstanceOf(CliApiError);
      expect((error as CliApiError).code).toBe("ORG_ACCESS_DENIED");
      expect((error as CliApiError).message).toContain("slug=\"support\"");
      expect((error as CliApiError).message).toContain("owner, admin, developer, viewer, billing");
      expect((error as CliApiError).message).toContain("/cli/authorize?user_code=");
    }
  });

  test("maps WorkOS default member without elevating privilege", () => {
    const result = workosIdentityFromPayload({
      sub: "user_123",
      email: "dev@ravi.bot",
      org_id: "org_123",
      role: "member",
      roles: ["member"],
    });

    expect(result.identity.role).toBe("viewer");
    expect(result.organizationRoleMapped).toBe(true);
    expect(result.diagnostics.parserPath).toBe("workos_member_alias");
    expect(result.diagnostics.roleClaimShape).toBe("string");
    expect(result.diagnostics.roleSlugs).toEqual(["member"]);
    expect(result.identity.providerOrganizationId).toBe("org_123");
  });

  test("maps nested organization role slugs", () => {
    const result = workosIdentityFromPayload({
      sub: "user_123",
      email: "dev@ravi.bot",
      org_id: "org_123",
      role: { slug: "developer" },
    });

    expect(result.identity.role).toBe("developer");
    expect(result.organizationRoleMapped).toBe(true);
    expect(result.diagnostics.roleClaimShape).toBe("object");
    expect(result.identity.rawProfile.role).toBe("developer");
  });

  test("maps role-bearing WorkOS claims without elevating by default", () => {
    const result = workosIdentityFromPayload({
      sub: "user_123",
      email: "dev@ravi.bot",
      org_id: "org_123",
      organization_role: "developer",
    });

    expect(result.identity.role).toBe("developer");
    expect(result.identity.providerOrganizationId).toBe("org_123");
  });

  test("can defer unmapped org roles to Ravi membership resolution", () => {
    const result = workosIdentityFromPayload(
      {
        sub: "user_123",
        email: "dev@ravi.bot",
        org_id: "org_01ABCDEFGHIJKLMNOP",
        role: "support",
      },
      null,
      { allowUnmappedOrganizationRole: true },
    );

    expect(result.organizationRoleMapped).toBe(false);
    expect(result.identity.role).toBe("viewer");
    expect(result.diagnostics).toMatchObject({
      hasOrganization: true,
      hasRole: true,
      roleClaimShape: "string",
      roleSlugs: ["support"],
      mappedRole: null,
      parserPath: "unmapped_slug",
      organizationIdSuffix: "KLMNOP",
      userOnlyFallbackPossible: true,
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("dev@ravi.bot");

    const logged: Array<{ message: unknown; details: unknown }> = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push({ message: args[0], details: args[1] });
    };
    try {
      logWorkosUnmappedOrganizationRole(result.diagnostics);
    } finally {
      console.error = originalError;
    }
    expect(logged[0]?.message).toBe("WorkOS CLI organization role was missing or unmapped");
    expect(logged[0]?.details).toMatchObject({
      roleClaimShape: "string",
      roleSlugs: ["support"],
      parserPath: "unmapped_slug",
      organizationIdSuffix: "KLMNOP",
    });
  });

  test("maps user-only WorkOS tokens as unscoped identity only", () => {
    const result = workosIdentityFromPayload({
      sub: "user_123",
      email: "dev@ravi.bot",
      name: "Dev Ravi",
    });

    expect(result.providerOrganizationId).toBeNull();
    expect(result.identity.providerOrganizationId).toBeUndefined();
    expect(result.identity.organizationSlug).toBe("cli-organization-required");
    expect(result.organizationRoleMapped).toBe(false);
  });

  test("uses fetched WorkOS user profile when access token lacks email", () => {
    const result = workosIdentityFromPayload(
      {
        sub: "user_123",
        iss: "https://api.workos.com/user_management/client_123",
      },
      {
        id: "user_123",
        email: "dev@ravi.bot",
        name: "Dev Ravi",
        profilePictureUrl: "https://example.com/avatar.png",
        rawProfile: { id: "user_123", email: "dev@ravi.bot" },
      },
    );

    expect(result.identity.email).toBe("dev@ravi.bot");
    expect(result.identity.name).toBe("Dev Ravi");
    expect(result.identity.avatarUrl).toBe("https://example.com/avatar.png");
    expect(result.providerOrganizationId).toBeNull();
  });
});
