import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "./authorization/fixture-policy";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createPageSite,
  listPageSitesForProject,
  updatePageSite,
  type PageSite,
  type PageSitesRepository,
} from "./pages";
import type { ConsoleWorkspace } from "./workspace";

describe("Ravi Pages site service", () => {
  test("allows one project to own multiple page sites", async () => {
    const repository = createInMemoryPageSitesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "demo-project" },
    ]);

    await createPageSite({
      input: { slug: "demo-site" },
      projectRef: "proj_1",
      repository,
      requestId: "req_1",
      workspace: workspace("org_1"),
    });
    await createPageSite({
      input: { slug: "docs-site" },
      projectRef: "proj_1",
      repository,
      requestId: "req_2",
      workspace: workspace("org_1"),
    });

    const sites = await listPageSitesForProject({
      projectRef: "proj_1",
      repository,
      workspace: workspace("org_1"),
    });

    expect(sites.map((site) => site.slug).sort()).toEqual(["demo-site", "docs-site"]);
    expect(repository.auditEvents.filter((event) => event.action === "page_site.created")).toHaveLength(2);
  });

  test("enforces hosted Pages slug uniqueness globally across projects", async () => {
    const repository = createInMemoryPageSitesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "first" },
      { id: "proj_2", organizationId: "org_1", slug: "second" },
    ]);

    await createPageSite({
      input: { slug: "shared-site" },
      projectRef: "proj_1",
      repository,
      requestId: "req_1",
      workspace: workspace("org_1"),
    });

    await expect(
      createPageSite({
        input: { slug: "shared-site" },
        projectRef: "proj_2",
        repository,
        requestId: "req_2",
        workspace: workspace("org_1"),
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    const rejection = repository.auditEvents.find((event) => event.action === "slug.rejected");
    expect(rejection?.metadataJson).toMatchObject({
      namespace: "page_site",
      reason: "namespace_conflict",
    });
  });

  test("updates a page site default visibility and records an audit event", async () => {
    const repository = createInMemoryPageSitesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "demo-project" },
    ]);

    await createPageSite({
      input: { slug: "demo-site", defaultVisibility: "private" },
      projectRef: "proj_1",
      repository,
      requestId: "req_create",
      workspace: workspace("org_1"),
    });

    const updated = await updatePageSite({
      input: { siteRef: "demo-site", defaultVisibility: "public" },
      projectRef: "proj_1",
      repository,
      requestId: "req_update",
      workspace: workspace("org_1"),
    });

    expect(updated.defaultVisibility).toBe("public");
    expect(repository.auditEvents.find((event) => event.action === "page_site.visibility_updated")?.metadataJson)
      .toMatchObject({
        previousDefaultVisibility: "private",
        defaultVisibility: "public",
      });
  });

  test("an explicitly configured developer rule permits Pages management without project membership", async () => {
    const repository = createInMemoryPageSitesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "demo-project" },
    ]);

    const site = await createPageSite({
      input: { slug: "dev-site" },
      projectRef: "proj_1",
      repository,
      requestId: "req_dev_site",
      workspace: workspace("org_1", { role: "developer", userId: "user_without_project" }),
    });

    expect(site.slug).toBe("dev-site");
  });
});

function workspace(
  organizationId: string,
  options: { role?: string; userId?: string } = {},
): ConsoleWorkspace {
  return {
    mode: "workos",
    organization: {
      id: organizationId,
    },
    membership: {
      role: options.role ?? "owner",
    },
    user: {
      id: options.userId ?? "user_1",
    },
  } as ConsoleWorkspace;
}

function createInMemoryPageSitesRepository(
  projects: Array<{ id: string; organizationId: string; slug: string }>,
): PageSitesRepository & { auditEvents: Array<{ action: string; metadataJson: Record<string, unknown> }> } {
  const sites: PageSite[] = [];
  const auditEvents: Array<{ action: string; metadataJson: Record<string, unknown> }> = [];

  return {
    auditEvents,
    async authorizeProject(workspace, projectId, action) {
      return authorizeFixtureProject(workspace, projectId, action, { projects, projectRole: (await this.findProjectMembership(projectId, workspace.user.id))?.role });
    },

    async findDefaultSite(projectId) {
      return sites.find((site) => site.projectId === projectId && site.isDefault) ?? null;
    },

    async findProjectMembership(projectId, userId) {
      if (projectId === "proj_1" && userId === "user_1") {
        return { role: "developer", status: "active" };
      }
      return null;
    },

    async findProjectByRef(organizationId, projectRef) {
      return (
        projects.find(
          (project) =>
            project.organizationId === organizationId && (project.id === projectRef || project.slug === projectRef),
        ) ?? null
      );
    },

    async findSiteBySlug(slug) {
      return sites.find((site) => site.slug === slug) ?? null;
    },

    async getSiteByRef(organizationId, siteRef) {
      return (
        sites.find((site) => site.organizationId === organizationId && (site.id === siteRef || site.slug === siteRef)) ??
        null
      );
    },

    async insertAudit(input) {
      auditEvents.push({
        action: input.action,
        metadataJson: input.metadataJson,
      });
    },

    async insertSite(input) {
      const now = new Date();
      const site = {
        id: `site_${sites.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        slug: input.slug,
        defaultHostname: input.defaultHostname,
        defaultVisibility: input.defaultVisibility,
        activeReleaseId: null,
        isDefault: input.isDefault,
        status: "active",
        createdByActorType: input.createdByActorType,
        createdByActorId: input.createdByActorId,
        metadataJson: input.metadataJson,
        createdAt: now,
        updatedAt: now,
      } as PageSite;
      sites.push(site);
      return site;
    },

    async listSites(projectId) {
      return sites.filter((site) => site.projectId === projectId);
    },

    async updateSiteVisibility(input) {
      const index = sites.findIndex((item) => item.id === input.siteId);
      const site = sites[index];
      if (!site) throw new Error("Site not found.");
      const updated = {
        ...site,
        defaultVisibility: input.defaultVisibility,
        updatedAt: input.now,
      };
      sites[index] = updated;
      return updated;
    },
  };
}
