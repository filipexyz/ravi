import { and, eq, or, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";
import type { PageVisibility } from "../pages";
import { canAccessProject, type ProjectAuthorizationCheck, type ProjectAccessWorkspace } from "../project-access";
import { normalizeHostname } from "./auth";
import { matchPageRoute, validateRoutePath, type PageRouteMatchType } from "./policy";

type Workspace = {
  authorization?: ProjectAccessWorkspace["authorization"];
  organization: { id: string };
  user: { id: string };
  membership: { role: string };
};

type ProjectRecord = {
  id: string;
  name: string;
  organizationId: string;
  slug: string;
  status: string;
};

type PageSiteRecord = {
  activeReleaseId: string | null;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  id: string;
  organizationId: string;
  projectId: string;
  slug: string;
  status: string;
};

type PageReleaseRecord = {
  id: string;
  releaseNumber: number;
  status: string;
};

type PageReleaseRouteRecord = {
  id: string;
  matchType: PageRouteMatchType;
  path: string;
  priority: number;
  routeId: string;
  visibility: PageVisibility;
};

type UserRecord = {
  displayName: string | null;
  id: string;
  primaryEmail: string;
  status: string;
};

type MembershipRecord = {
  role: string;
  status: string;
};

export type PagesAccessDiagnosis = {
  access: {
    allowed: boolean;
    canAccessProject: boolean | null;
    reason:
      | "public_route"
      | "project_read_allowed"
      | "caller_project_forbidden"
      | "invalid_target"
      | "site_not_found"
      | "site_not_in_project"
      | "site_inactive"
      | "release_not_found"
      | "route_not_found"
      | "user_not_found"
      | "organization_membership_missing"
      | "organization_membership_inactive"
      | "project_forbidden";
    requiredAccess: "none" | "project_read" | "unknown";
  };
  organizationMembership: MembershipRecord | null;
  project: Pick<ProjectRecord, "id" | "name" | "slug" | "status">;
  projectMembership: MembershipRecord | null;
  release: Pick<PageReleaseRecord, "id" | "releaseNumber" | "status"> | null;
  request: {
    host: string;
    path: string;
    url: string | null;
    userRef: string;
  };
  route: (Pick<PageReleaseRouteRecord, "id" | "matchType" | "path" | "priority" | "routeId" | "visibility"> & {
    effectiveVisibility: PageVisibility;
  }) | null;
  site: Pick<PageSiteRecord, "activeReleaseId" | "defaultHostname" | "defaultVisibility" | "id" | "slug" | "status"> | null;
  targetUser: Pick<UserRecord, "displayName" | "id" | "primaryEmail" | "status"> | null;
};

export type PagesAccessDiagnoseRepository = {
  authorizeProject?: ProjectAuthorizationCheck;
  findOrganizationMembership(input: { organizationId: string; userId: string }): Promise<MembershipRecord | null>;
  findProjectByRef(input: { organizationId: string; projectRef: string }): Promise<ProjectRecord | null>;
  findProjectMembership(input: { projectId: string; userId: string }): Promise<MembershipRecord | null>;
  findSiteByHost(host: string): Promise<PageSiteRecord | null>;
  findUserByRef(userRef: string): Promise<UserRecord | null>;
  getActiveRelease(site: PageSiteRecord): Promise<PageReleaseRecord | null>;
  listReleaseRoutes(releaseId: string): Promise<PageReleaseRouteRecord[]>;
};

type DiagnoseInput = {
  path?: string | null;
  projectRef: string;
  targetUrl?: string | null;
  userRef: string;
  workspace: Workspace;
};

export function pagesAccessDiagnoseRepositoryForDb(database = db): PagesAccessDiagnoseRepository {
  return {
    authorizeProject: canAccessProject,
    async findOrganizationMembership(input) {
      const [membership] = await database
        .select({
          role: schema.organizationMemberships.role,
          status: schema.organizationMemberships.status,
        })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, input.organizationId),
            eq(schema.organizationMemberships.userId, input.userId),
          ),
        )
        .limit(1);
      return membership ?? null;
    },

    async findProjectByRef(input) {
      const refPredicate = isUuidRef(input.projectRef)
        ? or(eq(schema.projects.id, input.projectRef), eq(schema.projects.slug, input.projectRef))
        : eq(schema.projects.slug, input.projectRef);
      const [project] = await database
        .select({
          id: schema.projects.id,
          name: schema.projects.name,
          organizationId: schema.projects.organizationId,
          slug: schema.projects.slug,
          status: schema.projects.status,
        })
        .from(schema.projects)
        .where(and(eq(schema.projects.organizationId, input.organizationId), refPredicate))
        .limit(1);
      return project ?? null;
    },

    async findProjectMembership(input) {
      const [membership] = await database
        .select({
          role: schema.projectMemberships.role,
          status: schema.projectMemberships.status,
        })
        .from(schema.projectMemberships)
        .where(
          and(
            eq(schema.projectMemberships.projectId, input.projectId),
            eq(schema.projectMemberships.userId, input.userId),
          ),
        )
        .limit(1);
      return membership ?? null;
    },

    async findSiteByHost(host) {
      const hostedSlug = hostedSlugFromHost(host);
      const hostedPredicate = hostedSlug
        ? or(eq(schema.pageSites.slug, hostedSlug), eq(schema.pageSites.defaultHostname, host))
        : eq(schema.pageSites.defaultHostname, host);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(and(hostedPredicate, sql`${schema.pageSites.status} <> 'deleted'`))
        .limit(1);
      if (site) return site;

      const [customHostSite] = await database
        .select({
          activeReleaseId: schema.pageSites.activeReleaseId,
          defaultHostname: schema.pageSites.defaultHostname,
          defaultVisibility: schema.pageSites.defaultVisibility,
          id: schema.pageSites.id,
          organizationId: schema.pageSites.organizationId,
          projectId: schema.pageSites.projectId,
          slug: schema.pageSites.slug,
          status: schema.pageSites.status,
        })
        .from(schema.pageDomainBindings)
        .innerJoin(schema.domainBindings, eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id))
        .innerJoin(schema.pageSites, eq(schema.pageDomainBindings.pageSiteId, schema.pageSites.id))
        .where(
          and(
            eq(schema.pageDomainBindings.hostname, host),
            eq(schema.domainBindings.product, "pages"),
            eq(schema.domainBindings.status, "active"),
            sql`${schema.pageSites.status} <> 'deleted'`,
          ),
        )
        .limit(1);
      return customHostSite ?? null;
    },

    async findUserByRef(userRef) {
      const cleanRef = userRef.trim().toLowerCase();
      const [user] = await database
        .select({
          displayName: schema.users.displayName,
          id: schema.users.id,
          primaryEmail: schema.users.primaryEmail,
          status: schema.users.status,
        })
        .from(schema.users)
        .where(isUuidRef(userRef) ? eq(schema.users.id, userRef) : sql`lower(${schema.users.primaryEmail}) = ${cleanRef}`)
        .limit(1);
      return user ?? null;
    },

    async getActiveRelease(site) {
      if (!site.activeReleaseId) return null;
      const [release] = await database
        .select({
          id: schema.pageSiteReleases.id,
          releaseNumber: schema.pageSiteReleases.releaseNumber,
          status: schema.pageSiteReleases.status,
        })
        .from(schema.pageSiteReleases)
        .where(eq(schema.pageSiteReleases.id, site.activeReleaseId))
        .limit(1);
      return release ?? null;
    },

    async listReleaseRoutes(releaseId) {
      return database
        .select({
          id: schema.pageReleaseRoutes.id,
          matchType: schema.pageReleaseRoutes.matchType,
          path: schema.pageReleaseRoutes.path,
          priority: schema.pageReleaseRoutes.priority,
          routeId: schema.pageReleaseRoutes.routeId,
          visibility: schema.pageReleaseRoutes.visibility,
        })
        .from(schema.pageReleaseRoutes)
        .where(eq(schema.pageReleaseRoutes.releaseId, releaseId));
    },
  };
}

export async function diagnosePagesAccess({
  input,
  repository = pagesAccessDiagnoseRepositoryForDb(),
}: {
  input: DiagnoseInput;
  repository?: PagesAccessDiagnoseRepository;
}): Promise<PagesAccessDiagnosis> {
  const target = parseTarget(input.targetUrl, input.path);
  if (!target) {
    const project = await accessibleProjectOrThrow(repository, input.workspace, input.projectRef);
    return emptyDiagnosis(input, project, "invalid_target");
  }

  const project = await accessibleProjectOrThrow(repository, input.workspace, input.projectRef);
  const request = {
    host: target.host,
    path: target.path,
    url: target.url,
    userRef: input.userRef,
  };

  const site = await repository.findSiteByHost(target.host);
  if (!site) return diagnosis({ project, request, reason: "site_not_found" });
  if (site.projectId !== project.id || site.organizationId !== project.organizationId) {
    return diagnosis({
      project,
      request,
      reason: "site_not_in_project",
      site: sanitizeSite(site),
    });
  }
  if (site.status !== "active") {
    return diagnosis({
      project,
      request,
      reason: "site_inactive",
      site: sanitizeSite(site),
    });
  }

  const release = await repository.getActiveRelease(site);
  if (!release || release.status !== "active") {
    return diagnosis({
      project,
      release: release ? sanitizeRelease(release) : null,
      request,
      reason: "release_not_found",
      site: sanitizeSite(site),
    });
  }

  const routes = await repository.listReleaseRoutes(release.id);
  const matchedDefinition = matchPageRoute(
    routes.map((route) => ({
      id: route.id,
      matchType: route.matchType,
      path: route.path,
      priority: route.priority,
    })),
    target.path,
  );
  const route = matchedDefinition ? routes.find((candidate) => candidate.id === matchedDefinition.id) ?? null : null;
  if (!route) {
    return diagnosis({
      project,
      release: sanitizeRelease(release),
      request,
      reason: "route_not_found",
      site: sanitizeSite(site),
    });
  }

  const effectiveVisibility = effectiveVisibilityFor(site.defaultVisibility, route.visibility);
  const safeRoute = {
    id: route.id,
    matchType: route.matchType,
    path: route.path,
    priority: route.priority,
    routeId: route.routeId,
    visibility: route.visibility,
    effectiveVisibility,
  };

  const user = await repository.findUserByRef(input.userRef);
  if (effectiveVisibility === "public") {
    return diagnosis({
      access: {
        allowed: true,
        canAccessProject: null,
        reason: "public_route",
        requiredAccess: "none",
      },
      project,
      release: sanitizeRelease(release),
      request,
      route: safeRoute,
      site: sanitizeSite(site),
      targetUser: user ? sanitizeUser(user) : null,
    });
  }

  if (!user) {
    return diagnosis({
      project,
      release: sanitizeRelease(release),
      request,
      reason: "user_not_found",
      route: safeRoute,
      site: sanitizeSite(site),
    });
  }

  const organizationMembership = await repository.findOrganizationMembership({
    organizationId: site.organizationId,
    userId: user.id,
  });
  const projectMembership = await repository.findProjectMembership({
    projectId: site.projectId,
    userId: user.id,
  });

  if (!organizationMembership) {
    return diagnosis({
      organizationMembership: null,
      project,
      projectMembership,
      release: sanitizeRelease(release),
      request,
      reason: "organization_membership_missing",
      route: safeRoute,
      site: sanitizeSite(site),
      targetUser: sanitizeUser(user),
    });
  }

  if (organizationMembership.status !== "active") {
    return diagnosis({
      organizationMembership,
      project,
      projectMembership,
      release: sanitizeRelease(release),
      request,
      reason: "organization_membership_inactive",
      route: safeRoute,
      site: sanitizeSite(site),
      targetUser: sanitizeUser(user),
    });
  }

  const canReadProject = (await repository.authorizeProject?.({ organization: input.workspace.organization,
    user: { id: user.id }, membership: organizationMembership }, project.id, "read")) ?? false;
  return diagnosis({
    access: {
      allowed: canReadProject,
      canAccessProject: canReadProject,
      reason: canReadProject ? "project_read_allowed" : "project_forbidden",
      requiredAccess: "project_read",
    },
    organizationMembership,
    project,
    projectMembership,
    release: sanitizeRelease(release),
    request,
    route: safeRoute,
    site: sanitizeSite(site),
    targetUser: sanitizeUser(user),
  });
}

async function accessibleProjectOrThrow(
  repository: PagesAccessDiagnoseRepository,
  workspace: Workspace,
  projectRef: string,
) {
  const project = await repository.findProjectByRef({
    organizationId: workspace.organization.id,
    projectRef,
  });
  if (!project || project.status !== "active") {
    throw new ConsoleApiError(403, { error: "project_forbidden" });
  }

  // Inspecting another person's admission is a project-administration action.
  if (!(await repository.authorizeProject?.(workspace, project.id, "admin"))) {
    throw new ConsoleApiError(403, { error: "project_forbidden" });
  }

  return project;
}

function parseTarget(targetUrl: string | null | undefined, path: string | null | undefined) {
  if (!targetUrl?.trim()) return null;
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  const host = normalizeHostname(url.hostname);
  if (!host) return null;
  const targetPath = path?.trim() || `${url.pathname || "/"}${url.search}`;
  const pathUrl = new URL(`https://diagnose.local${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}`);
  const normalizedPath = validateRoutePath(pathUrl.pathname);
  if (!normalizedPath.ok) return null;
  return {
    host,
    path: normalizedPath.path,
    url: url.toString(),
  };
}

function emptyDiagnosis(
  input: DiagnoseInput,
  project: ProjectRecord,
  reason: PagesAccessDiagnosis["access"]["reason"],
): PagesAccessDiagnosis {
  return diagnosis({
    project,
    request: {
      host: "",
      path: "",
      url: input.targetUrl ?? null,
      userRef: input.userRef,
    },
    reason,
  });
}

function diagnosis(input: {
  access?: PagesAccessDiagnosis["access"];
  organizationMembership?: MembershipRecord | null;
  project: ProjectRecord;
  projectMembership?: MembershipRecord | null;
  release?: PagesAccessDiagnosis["release"];
  request: PagesAccessDiagnosis["request"];
  reason?: PagesAccessDiagnosis["access"]["reason"];
  route?: PagesAccessDiagnosis["route"];
  site?: PagesAccessDiagnosis["site"];
  targetUser?: PagesAccessDiagnosis["targetUser"];
}): PagesAccessDiagnosis {
  return {
    access:
      input.access ??
      {
        allowed: false,
        canAccessProject: null,
        reason: input.reason ?? "project_forbidden",
        requiredAccess: input.route?.effectiveVisibility === "public" ? "none" : input.route ? "project_read" : "unknown",
      },
    organizationMembership: input.organizationMembership ?? null,
    project: {
      id: input.project.id,
      name: input.project.name,
      slug: input.project.slug,
      status: input.project.status,
    },
    projectMembership: input.projectMembership ?? null,
    release: input.release ?? null,
    request: input.request,
    route: input.route ?? null,
    site: input.site ?? null,
    targetUser: input.targetUser ?? null,
  };
}

function effectiveVisibilityFor(siteVisibility: PageVisibility, routeVisibility: PageVisibility): PageVisibility {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}

import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";

function hostedSlugFromHost(host: string) {
  const suffix = `.${hostedPagesDomain()}`;
  if (!host.endsWith(suffix)) return null;
  return host.slice(0, -suffix.length);
}

function sanitizeSite(site: PageSiteRecord): PagesAccessDiagnosis["site"] {
  return {
    activeReleaseId: site.activeReleaseId,
    defaultHostname: site.defaultHostname,
    defaultVisibility: site.defaultVisibility,
    id: site.id,
    slug: site.slug,
    status: site.status,
  };
}

function sanitizeRelease(release: PageReleaseRecord): PagesAccessDiagnosis["release"] {
  return {
    id: release.id,
    releaseNumber: release.releaseNumber,
    status: release.status,
  };
}

function sanitizeUser(user: UserRecord): PagesAccessDiagnosis["targetUser"] {
  return {
    displayName: user.displayName,
    id: user.id,
    primaryEmail: user.primaryEmail,
    status: user.status,
  };
}
