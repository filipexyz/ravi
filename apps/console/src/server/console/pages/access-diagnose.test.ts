import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "../authorization/fixture-policy";

import { diagnosePagesAccess, type PagesAccessDiagnoseRepository } from "./access-diagnose";

describe("Ravi Pages access diagnosis", () => {
  test("explains a protected route on a public site as project-read gated", async () => {
    const repository = inMemoryPagesAccessDiagnoseRepository({
      targetOrgMembership: { role: "developer", status: "active" },
    });

    const diagnosis = await diagnosePagesAccess({
      input: {
        projectRef: "rbbt-lab",
        targetUrl: "https://rbbt-orcamento.ravi.page/",
        userRef: "gustavo@rbbtlab.ai",
        workspace: ownerWorkspace(),
      },
      repository,
    });

    expect(diagnosis.site).toMatchObject({
      defaultVisibility: "public",
      slug: "rbbt-orcamento",
    });
    expect(diagnosis.route).toMatchObject({
      effectiveVisibility: "protected_link",
      path: "/",
      visibility: "protected_link",
    });
    expect(diagnosis.access).toEqual({
      allowed: true,
      canAccessProject: true,
      reason: "project_read_allowed",
      requiredAccess: "project_read",
    });
  });

  test("shows when an organization viewer lacks explicit project access", async () => {
    const repository = inMemoryPagesAccessDiagnoseRepository({
      targetOrgMembership: { role: "viewer", status: "active" },
      targetProjectMembership: null,
    });

    const diagnosis = await diagnosePagesAccess({
      input: {
        projectRef: "rbbt-lab",
        targetUrl: "https://rbbt-orcamento.ravi.page/",
        userRef: "gustavo@rbbtlab.ai",
        workspace: ownerWorkspace(),
      },
      repository,
    });

    expect(diagnosis.organizationMembership).toEqual({ role: "viewer", status: "active" });
    expect(diagnosis.projectMembership).toBeNull();
    expect(diagnosis.access).toEqual({
      allowed: false,
      canAccessProject: false,
      reason: "project_forbidden",
      requiredAccess: "project_read",
    });
  });

  test("does not require user membership for public routes", async () => {
    const repository = inMemoryPagesAccessDiagnoseRepository({
      routeVisibility: "public",
      targetUser: null,
    });

    const diagnosis = await diagnosePagesAccess({
      input: {
        projectRef: "rbbt-lab",
        targetUrl: "https://rbbt-orcamento.ravi.page/",
        userRef: "missing@rbbtlab.ai",
        workspace: ownerWorkspace(),
      },
      repository,
    });

    expect(diagnosis.targetUser).toBeNull();
    expect(diagnosis.route?.effectiveVisibility).toBe("public");
    expect(diagnosis.access).toEqual({
      allowed: true,
      canAccessProject: null,
      reason: "public_route",
      requiredAccess: "none",
    });
  });
});

function ownerWorkspace() {
  return {
    organization: { id: "org_rbbt" },
    user: { id: "user_luis" },
    membership: { role: "owner" },
  };
}

function inMemoryPagesAccessDiagnoseRepository({
  routeVisibility = "protected_link",
  targetOrgMembership = { role: "developer", status: "active" },
  targetProjectMembership = null,
  targetUser = {
    displayName: "Gustavo",
    id: "user_gustavo",
    primaryEmail: "gustavo@rbbtlab.ai",
    status: "active",
  },
}: {
  routeVisibility?: "public" | "private" | "protected_link";
  targetOrgMembership?: { role: string; status: string } | null;
  targetProjectMembership?: { role: string; status: string } | null;
  targetUser?: { displayName: string | null; id: string; primaryEmail: string; status: string } | null;
} = {}): PagesAccessDiagnoseRepository {
  const project = {
    id: "proj_rbbt_lab",
    name: "RBBT Lab",
    organizationId: "org_rbbt",
    slug: "rbbt-lab",
    status: "active",
  };
  const site = {
    activeReleaseId: "rel_4",
    defaultHostname: "rbbt-orcamento.ravi.page",
    defaultVisibility: "public" as const,
    id: "site_orcamento",
    organizationId: "org_rbbt",
    projectId: "proj_rbbt_lab",
    slug: "rbbt-orcamento",
    status: "active",
  };

  return {
    async authorizeProject(workspace, projectId, action) {
      const member = await this.findProjectMembership({ projectId, userId: workspace.user.id });
      return authorizeFixtureProject(workspace, projectId, action, { projects: [project], projectRole: member?.status === "active" ? member.role : null });
    },
    async findOrganizationMembership(input) {
      if (input.userId === "user_luis") return { role: "owner", status: "active" };
      return targetOrgMembership;
    },
    async findProjectByRef(input) {
      return input.organizationId === "org_rbbt" && input.projectRef === "rbbt-lab" ? project : null;
    },
    async findProjectMembership(input) {
      if (input.userId === "user_luis") return null;
      return targetProjectMembership;
    },
    async findSiteByHost(host) {
      return host === "rbbt-orcamento.ravi.page" ? site : null;
    },
    async findUserByRef(userRef) {
      return userRef === targetUser?.primaryEmail || userRef === targetUser?.id ? targetUser : null;
    },
    async getActiveRelease(inputSite) {
      return inputSite.id === site.id ? { id: "rel_4", releaseNumber: 4, status: "active" } : null;
    },
    async listReleaseRoutes(releaseId) {
      return releaseId === "rel_4"
        ? [
            {
              id: "release_route_home",
              matchType: "spa",
              path: "/",
              priority: 0,
              routeId: "route_home",
              visibility: routeVisibility,
            },
          ]
        : [];
    },
  };
}
