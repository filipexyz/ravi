import { describe, expect, test } from "bun:test";

import {
  canManageBases,
  computeViewAdmission,
  effectiveProjectRole,
  principalAdmits,
  projectRoleAtLeast,
  type BasesCallerAccess,
  type StoredViewAccess,
} from "./access";

const USER = "8e0e034f-6cce-4f10-82da-3ebf2c8b49f4";
const OTHER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const SITE = "c9bf9e57-1685-4c89-bafb-ff5af830be8a";
const P_NAME = "6e0b0000-0000-4000-8000-000000000001";
const P_STATUS = "6e0b0000-0000-4000-8000-000000000002";
const P_OWNER = "6e0b0000-0000-4000-8000-000000000003";

function access(overrides: Partial<BasesCallerAccess> = {}): BasesCallerAccess {
  const base = {
    projectRole: "viewer" as const,
    projectRead: true,
    projectWrite: false,
    userId: USER,
    activeOrgMember: true,
    pageSiteId: null,
    pageSurface: false,
    ...overrides,
  };
  return { ...base, manage: overrides.manage ?? canManageBases(base) };
}

function stored(overrides: Partial<StoredViewAccess["write"]> = {}, read: StoredViewAccess["read"] = []) {
  return {
    columns: [P_NAME, P_STATUS, "created_time", "body"],
    access: {
      read,
      write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false, ...overrides },
    },
  };
}

describe("effective project role", () => {
  test("org owner/admin/developer cannot fabricate a project role", () => {
    expect(effectiveProjectRole("owner", null)).toBeNull();
    expect(effectiveProjectRole("admin", "viewer")).toBe("viewer");
    expect(effectiveProjectRole("developer", "viewer")).toBe("viewer");
  });

  test("viewer and billing fall back to the project membership", () => {
    expect(effectiveProjectRole("viewer", "developer")).toBe("developer");
    expect(effectiveProjectRole("viewer", null)).toBeNull();
    expect(effectiveProjectRole("billing", "viewer")).toBe("viewer");
  });

  test("ranks viewer < developer < project_admin", () => {
    expect(projectRoleAtLeast("viewer", "viewer")).toBe(true);
    expect(projectRoleAtLeast("viewer", "developer")).toBe(false);
    expect(projectRoleAtLeast("project_admin", "developer")).toBe(true);
    expect(projectRoleAtLeast(null, "viewer")).toBe(false);
  });

  test("managers need project read/write decisions and are never Pages viewers", () => {
    expect(canManageBases({ projectRead: true, projectWrite: true, pageSurface: false })).toBe(true);
    expect(canManageBases({ projectRead: false, projectWrite: true, pageSurface: false })).toBe(false);
    expect(canManageBases({ projectRead: true, projectWrite: false, pageSurface: false })).toBe(false);
    expect(canManageBases({ projectRead: true, projectWrite: true, pageSurface: true })).toBe(false);
  });
});

describe("principals", () => {
  test("project_role uses the effective role and never admits Pages sessions", () => {
    expect(principalAdmits({ kind: "project_role", minRole: "viewer" }, access())).toBe(true);
    expect(principalAdmits({ kind: "project_role", minRole: "developer" }, access())).toBe(false);
    expect(principalAdmits({ kind: "project_role", minRole: "viewer" }, access({ pageSurface: true, pageSiteId: SITE }))).toBe(false);
  });

  test("user principals need the same user and an active org membership", () => {
    expect(principalAdmits({ kind: "user", userId: USER.toUpperCase() }, access())).toBe(true);
    expect(principalAdmits({ kind: "user", userId: OTHER }, access())).toBe(false);
    expect(principalAdmits({ kind: "user", userId: USER }, access({ activeOrgMember: false }))).toBe(false);
  });

  test("page_viewer admits only a Pages session for that site", () => {
    expect(principalAdmits({ kind: "page_viewer", siteId: SITE }, access({ pageSurface: true, pageSiteId: SITE }))).toBe(true);
    expect(principalAdmits({ kind: "page_viewer", siteId: SITE }, access({ pageSurface: true, pageSiteId: OTHER }))).toBe(false);
    expect(principalAdmits({ kind: "page_viewer", siteId: SITE }, access({ pageSiteId: SITE }))).toBe(false);
  });
});

describe("view admission", () => {
  test("managers read and write every projected non-system column", () => {
    const admission = computeViewAdmission(stored(), access({ projectRole: "developer", projectWrite: true }));
    expect(admission).toMatchObject({ admitted: true, read: true, write: true, create: true, archive: true, allowEscape: true, manage: true });
    expect(admission.writeColumns).toEqual([P_NAME, P_STATUS, "body"]);
  });

  test("callers not admitted get nothing", () => {
    const admission = computeViewAdmission(stored(), access());
    expect(admission.admitted).toBe(false);
    expect(admission.read).toBe(false);
    expect(admission.writeColumns).toEqual([]);
  });

  test("aggregate mode admits chart data only", () => {
    const admission = computeViewAdmission(stored({}, [{ kind: "project_role", minRole: "viewer", mode: "aggregate" }]), access());
    expect(admission).toMatchObject({ admitted: true, read: false, aggregateOnly: true, write: false });
  });

  test("a rows-mode principal wins over an aggregate-mode one", () => {
    const admission = computeViewAdmission(
      stored({}, [
        { kind: "project_role", minRole: "viewer", mode: "aggregate" },
        { kind: "user", userId: USER },
      ]),
      access(),
    );
    expect(admission.read).toBe(true);
    expect(admission.aggregateOnly).toBe(false);
  });

  test("read admission does not imply write", () => {
    const admission = computeViewAdmission(stored({ columns: [P_STATUS] }, [{ kind: "project_role", minRole: "viewer" }]), access());
    expect(admission.read).toBe(true);
    expect(admission.write).toBe(false);
    expect(admission.writeColumns).toEqual([]);
  });

  test("writers get write.columns within the projection, minus system columns and preset keys", () => {
    const admission = computeViewAdmission(
      stored({
        principals: [{ kind: "project_role", minRole: "viewer" }],
        columns: [P_STATUS, P_NAME, P_OWNER, "created_time", "body"],
        set: { [P_NAME]: "x" },
        create: true,
      }),
      access({ projectWrite: true, manage: false }),
    );
    expect(admission.write).toBe(true);
    expect(admission.writeColumns).toEqual([P_STATUS, "body"]);
    expect(admission.create).toBe(true);
    expect(admission.archive).toBe(false);
    expect(admission.maySupplySetKeys).toBe(false);
  });
});
