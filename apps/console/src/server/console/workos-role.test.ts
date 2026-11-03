import { describe, expect, test } from "bun:test";

import {
  inspectWorkosRoleClaims,
  mapWorkosOrganizationRole,
  normalizeConsoleRole,
  parseConsoleRole,
  workosOrganizationAccessDiagnostics,
  workosOrganizationRoleDeniedMessage,
} from "./workos-role";

describe("WorkOS organization role mapping", () => {
  test("keeps Console roles exact and does not invent owner", () => {
    expect(parseConsoleRole("admin")).toBe("admin");
    expect(parseConsoleRole("developer")).toBe("developer");
    expect(parseConsoleRole("member")).toBeNull();
    expect(parseConsoleRole(undefined)).toBeNull();
    expect(normalizeConsoleRole(undefined)).toBe("viewer");
    expect(normalizeConsoleRole("not-a-role")).toBe("viewer");
  });

  test("maps WorkOS default member to viewer without elevation", () => {
    expect(mapWorkosOrganizationRole("member")).toBe("viewer");
    expect(mapWorkosOrganizationRole("Member")).toBe("viewer");
    expect(normalizeConsoleRole("member")).toBe("viewer");
  });

  test("reads nested slug objects and roles arrays", () => {
    expect(mapWorkosOrganizationRole({ slug: "member" })).toBe("viewer");
    expect(mapWorkosOrganizationRole({ slug: "admin" })).toBe("admin");
    expect(inspectWorkosRoleClaims({ organization_role: { slug: "developer" } }).mappedRole).toBe("developer");
    expect(inspectWorkosRoleClaims({ roles: ["member", "admin"] }).mappedRole).toBe("admin");
    expect(inspectWorkosRoleClaims({ role: "member", roles: ["member"] }).mappedRole).toBe("viewer");
  });

  test("stays fail-closed for unknown WorkOS roles", () => {
    expect(mapWorkosOrganizationRole("support")).toBeNull();
    expect(mapWorkosOrganizationRole({ slug: "superuser" })).toBeNull();
    expect(inspectWorkosRoleClaims({ role: 12 }).parserPath).toBe("unsupported_shape");
  });

  test("diagnostics describe claim shape and org suffix without emails", () => {
    const diagnostics = workosOrganizationAccessDiagnostics({
      payload: {
        sub: "user_123",
        email: "secret@example.com",
        org_id: "org_01ABCDEFGHIJKLMNOP",
        role: { slug: "member" },
      },
    });

    expect(diagnostics).toMatchObject({
      hasSubject: true,
      hasEmail: true,
      hasOrganization: true,
      hasRole: true,
      roleClaimShape: "object",
      roleClaimSource: "role",
      roleSlugs: ["member"],
      mappedRole: "viewer",
      parserPath: "workos_member_alias",
      organizationIdSuffix: "KLMNOP",
      userOnlyFallbackPossible: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret@example.com");
  });

  test("builds an actionable ORG_ACCESS_DENIED message for invalid roles", () => {
    const inspection = inspectWorkosRoleClaims({ role: "support" });
    const message = workosOrganizationRoleDeniedMessage(inspection);

    expect(inspection.parserPath).toBe("unmapped_slug");
    expect(message).toContain("Console-compatible organization role");
    expect(message).toContain("shape=string");
    expect(message).toContain('slug="support"');
    expect(message).toContain("owner, admin, developer, viewer, billing");
    expect(message).toContain("/cli/authorize?user_code=");
    expect(message).toContain("private window");
  });
});
