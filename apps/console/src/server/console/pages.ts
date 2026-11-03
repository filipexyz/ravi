import { and, desc, eq, or } from "drizzle-orm";

import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { authorizationActorFromWorkspace, type ProjectAccessWorkspace } from "./project-access";
import { decideInTransaction } from "./authorization/store";
import { isUuidRef } from "./ref";
import { validateConsoleSlug, type SlugRejectionReason } from "./slugs";
import type { ConsoleWorkspace } from "./workspace";

export type PageVisibility = "public" | "private" | "protected_link" | "password";
export type PageSite = typeof schema.pageSites.$inferSelect;
type PageSiteWorkspace = {
  authorization?: ProjectAccessWorkspace["authorization"];
  mode: ConsoleWorkspace["mode"];
  user: Pick<ConsoleWorkspace["user"], "id">;
  organization: Pick<ConsoleWorkspace["organization"], "id">;
  membership: Pick<ConsoleWorkspace["membership"], "role">;
};

export type CreatePageSiteInput = {
  slug: string;
  defaultVisibility?: PageVisibility;
  isDefault?: boolean;
  metadataJson?: Record<string, unknown>;
};

export type UpdatePageSiteInput = {
  defaultVisibility: PageVisibility;
  siteRef: string;
};

type ProjectForPageSite = {
  id: string;
  organizationId: string;
};

type ProjectMembershipForPageSite = {
  role: string;
  status: string;
};

type InsertPageSiteInput = {
  createdByActorId: string;
  createdByActorType: "anonymous" | "user";
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  isDefault: boolean;
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  slug: string;
};

type AuditInput = {
  action: string;
  actorId: string;
  actorType: "anonymous" | "user" | "system";
  metadataJson: Record<string, unknown>;
  organizationId: string;
  projectId?: string | null;
  requestId: string;
  targetId?: string | null;
  targetType: string;
};

export type PageSitesRepository = {
  organizationSlug?(organizationId: string): Promise<string | undefined>;
  authorizeProject?(workspace: PageSiteWorkspace, projectId: string, action: "read" | "write" | "admin"): Promise<boolean>;
  findDefaultSite(projectId: string): Promise<PageSite | null>;
  findProjectMembership(projectId: string, userId: string): Promise<ProjectMembershipForPageSite | null>;
  findProjectByRef(organizationId: string, projectRef: string): Promise<ProjectForPageSite | null>;
  findSiteBySlug(slug: string): Promise<PageSite | null>;
  getSiteByRef(organizationId: string, siteRef: string): Promise<PageSite | null>;
  insertAudit(input: AuditInput): Promise<void>;
  insertSite(input: InsertPageSiteInput): Promise<PageSite>;
  listSites(projectId: string): Promise<PageSite[]>;
  updateSiteVisibility(input: { defaultVisibility: PageVisibility; now: Date; siteId: string }): Promise<PageSite>;
};

const PAGE_VISIBILITIES = new Set<PageVisibility>(["public", "private", "protected_link"]);
import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";
const SOURCE = "console.pages.sites";
const SLUG_UNAVAILABLE_PAYLOAD = {
  error: "slug_unavailable",
  fieldErrors: {
    slug: "This slug is unavailable.",
  },
} satisfies ConsoleApiErrorPayload;

type DbExecutor = Pick<typeof db, "insert" | "select" | "update" | "execute">;

export function pageSitesRepositoryForDb(database: DbExecutor = db): PageSitesRepository {
  return {
    async organizationSlug(organizationId) {
      const [organization] = await database.select({ slug: schema.organizations.slug }).from(schema.organizations)
        .where(eq(schema.organizations.id, organizationId)).limit(1);
      return organization?.slug;
    },
    async authorizeProject(workspace, projectId, action) {
      return (await decideInTransaction(database, authorizationActorFromWorkspace(workspace), projectId, `project.${action}`, crypto.randomUUID())).allowed;
    },
    async findDefaultSite(projectId) {
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(and(eq(schema.pageSites.projectId, projectId), eq(schema.pageSites.isDefault, true)))
        .limit(1);

      return site ?? null;
    },

    async findProjectMembership(projectId, userId) {
      const [membership] = await database
        .select({
          role: schema.projectMemberships.role,
          status: schema.projectMemberships.status,
        })
        .from(schema.projectMemberships)
        .where(
          and(
            eq(schema.projectMemberships.projectId, projectId),
            eq(schema.projectMemberships.userId, userId),
            eq(schema.projectMemberships.status, "active"),
          ),
        )
        .limit(1);

      return membership ?? null;
    },

    async findProjectByRef(organizationId, projectRef) {
      const refPredicate = isUuidRef(projectRef)
        ? or(eq(schema.projects.id, projectRef), eq(schema.projects.slug, projectRef))
        : eq(schema.projects.slug, projectRef);
      const [project] = await database
        .select({
          id: schema.projects.id,
          organizationId: schema.projects.organizationId,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.organizationId, organizationId),
            refPredicate,
          ),
        )
        .limit(1);

      return project ?? null;
    },

    async findSiteBySlug(slug) {
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(eq(schema.pageSites.slug, slug))
        .limit(1);

      return site ?? null;
    },

    async getSiteByRef(organizationId, siteRef) {
      const refPredicate = isUuidRef(siteRef)
        ? or(eq(schema.pageSites.id, siteRef), eq(schema.pageSites.slug, siteRef))
        : eq(schema.pageSites.slug, siteRef);
      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(
          and(
            eq(schema.pageSites.organizationId, organizationId),
            refPredicate,
          ),
        )
        .limit(1);

      return site ?? null;
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        actorType: input.actorType,
        actorId: input.actorId,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        action: input.action,
        requestId: input.requestId,
        metadataJson: input.metadataJson,
      });
    },

    async insertSite(input) {
      const [site] = await database
        .insert(schema.pageSites)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          slug: input.slug,
          defaultHostname: input.defaultHostname,
          defaultVisibility: input.defaultVisibility,
          isDefault: input.isDefault,
          status: "active",
          createdByActorType: input.createdByActorType,
          createdByActorId: input.createdByActorId,
          metadataJson: input.metadataJson,
        })
        .returning();

      if (!site) throw new Error("Failed to create page site.");
      return site;
    },

    async listSites(projectId) {
      return database
        .select()
        .from(schema.pageSites)
        .where(eq(schema.pageSites.projectId, projectId))
        .orderBy(desc(schema.pageSites.updatedAt));
    },

    async updateSiteVisibility(input) {
      const [site] = await database
        .update(schema.pageSites)
        .set({
          defaultVisibility: input.defaultVisibility,
          updatedAt: input.now,
        })
        .where(eq(schema.pageSites.id, input.siteId))
        .returning();

      if (!site) throw new Error("Failed to update page site.");
      return site;
    },
  };
}

export async function listPageSitesForProject({
  projectRef,
  repository = pageSitesRepositoryForDb(),
  workspace,
}: {
  projectRef: string;
  repository?: PageSitesRepository;
  workspace: PageSiteWorkspace;
}) {
  const project = await repository.findProjectByRef(workspace.organization.id, projectRef);
  if (!project) return [];
  if (!(await canAccessProject(workspace, repository, project.id, "read"))) return [];
  return repository.listSites(project.id);
}

export async function getPageSite({
  repository = pageSitesRepositoryForDb(),
  siteRef,
  workspace,
}: {
  repository?: PageSitesRepository;
  siteRef: string;
  workspace: PageSiteWorkspace;
}) {
  const site = await repository.getSiteByRef(workspace.organization.id, siteRef);
  if (!site) return null;
  if (!(await canAccessProject(workspace, repository, site.projectId, "read"))) return null;
  return site;
}

export async function getPageSiteForProject({
  action = "read",
  projectRef,
  repository = pageSitesRepositoryForDb(),
  siteRef,
  workspace,
}: {
  action?: "read" | "write" | "admin";
  projectRef: string;
  repository?: PageSitesRepository;
  siteRef: string;
  workspace: PageSiteWorkspace;
}) {
  const project = await repository.findProjectByRef(workspace.organization.id, projectRef);
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  await assertProjectAccess(workspace, repository, project.id, action);

  const site = await repository.getSiteByRef(workspace.organization.id, siteRef);
  if (!site || site.projectId !== project.id) throw new ConsoleApiError(404, { error: "site_not_found" });
  return site;
}

export async function createPageSite({
  input,
  projectRef,
  repository = pageSitesRepositoryForDb(),
  requestId,
  workspace,
}: {
  input: CreatePageSiteInput;
  projectRef: string;
  repository?: PageSitesRepository;
  requestId: string;
  workspace: PageSiteWorkspace;
}) {
  if (workspace.mode === "anonymous") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }

  const project = await repository.findProjectByRef(workspace.organization.id, projectRef);
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  await assertProjectAccess(workspace, repository, project.id, "write");

  try {
    return await createPageSiteForProject({
      defaultVisibility: input.defaultVisibility ?? "private",
      isDefault: Boolean(input.isDefault),
      metadataJson: input.metadataJson ?? {},
      project,
      repository,
      requestId,
      slug: input.slug,
      source: `${SOURCE}.create`,
      workspace,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await rejectPageSiteSlug({
        attemptedSlug: input.slug,
        projectId: project.id,
        reason: "namespace_conflict",
        repository,
        requestId,
        source: `${SOURCE}.create`,
        workspace,
      });
    }
    throw error;
  }
}

export async function updatePageSite({
  input,
  projectRef,
  repository = pageSitesRepositoryForDb(),
  requestId,
  workspace,
}: {
  input: unknown;
  projectRef: string;
  repository?: PageSitesRepository;
  requestId: string;
  workspace: PageSiteWorkspace;
}) {
  if (workspace.mode === "anonymous") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }

  const parsed = parseUpdatePageSiteInput(input);
  const project = await repository.findProjectByRef(workspace.organization.id, projectRef);
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  await assertProjectAccess(workspace, repository, project.id, "write");

  const site = await repository.getSiteByRef(workspace.organization.id, parsed.siteRef);
  if (!site || site.projectId !== project.id) throw new ConsoleApiError(404, { error: "site_not_found" });
  if (site.defaultVisibility === parsed.defaultVisibility) return site;

  const updated = await repository.updateSiteVisibility({
    defaultVisibility: parsed.defaultVisibility,
    now: new Date(),
    siteId: site.id,
  });

  await repository.insertAudit({
    organizationId: project.organizationId,
    projectId: project.id,
    actorType: actorTypeForWorkspace(workspace),
    actorId: workspace.user.id,
    targetType: "page_site",
    targetId: site.id,
    action: "page_site.visibility_updated",
    requestId,
    metadataJson: {
      previousDefaultVisibility: site.defaultVisibility,
      defaultVisibility: updated.defaultVisibility,
      source: `${SOURCE}.update`,
    },
  });

  return updated;
}

export async function createDefaultPageSiteForProject({
  defaultVisibility,
  project,
  repository,
  requestId,
  slug,
  source,
  workspace,
}: {
  defaultVisibility: PageVisibility;
  project: ProjectForPageSite;
  repository: PageSitesRepository;
  requestId: string;
  slug: string;
  source: string;
  workspace: PageSiteWorkspace;
}) {
  return createPageSiteForProject({
    defaultVisibility,
    isDefault: true,
    metadataJson: { source },
    project,
    repository,
    requestId,
    slug,
    source,
    workspace,
  });
}

export async function auditPageReleaseActivationScaffold({
  projectId,
  releaseId,
  repository = pageSitesRepositoryForDb(),
  requestId,
  siteId,
  source = "console.pages.releases.activate.scaffold",
  workspace,
}: {
  projectId: string;
  releaseId?: string | null;
  repository?: PageSitesRepository;
  requestId: string;
  siteId: string;
  source?: string;
  workspace: PageSiteWorkspace;
}) {
  await repository.insertAudit({
    organizationId: workspace.organization.id,
    projectId,
    actorType: actorTypeForWorkspace(workspace),
    actorId: workspace.user.id,
    targetType: "page_site_release",
    targetId: releaseId ?? null,
    action: "page_site_release.activation_scaffolded",
    requestId,
    metadataJson: {
      siteId,
      source,
    },
  });
}

async function createPageSiteForProject({
  defaultVisibility,
  isDefault,
  metadataJson,
  project,
  repository,
  requestId,
  slug,
  source,
  workspace,
}: {
  defaultVisibility: PageVisibility;
  isDefault: boolean;
  metadataJson: Record<string, unknown>;
  project: ProjectForPageSite;
  repository: PageSitesRepository;
  requestId: string;
  slug: string;
  source: string;
  workspace: PageSiteWorkspace;
}) {
  if (isDefault) {
    const existingDefault = await repository.findDefaultSite(project.id);
    if (existingDefault) return existingDefault;
  }

  const ownerOrganizationSlug = await repository.organizationSlug?.(project.organizationId);
  const rejectionReason = validateConsoleSlug(slug, { ownerOrganizationSlug });
  if (rejectionReason) {
    await rejectPageSiteSlug({
      attemptedSlug: slug,
      projectId: project.id,
      reason: rejectionReason,
      repository,
      requestId,
      source,
      workspace,
    });
  }

  const existingSite = await repository.findSiteBySlug(slug);
  if (existingSite) {
    await rejectPageSiteSlug({
      attemptedSlug: slug,
      projectId: project.id,
      reason: "namespace_conflict",
      repository,
      requestId,
      source,
      workspace,
    });
  }

  const site = await repository.insertSite({
    organizationId: project.organizationId,
    projectId: project.id,
    slug,
    defaultHostname: defaultHostnameForSlug(slug),
    defaultVisibility,
    isDefault,
    createdByActorType: actorTypeForWorkspace(workspace),
    createdByActorId: workspace.user.id,
    metadataJson,
  });

  await repository.insertAudit({
    organizationId: project.organizationId,
    projectId: project.id,
    actorType: actorTypeForWorkspace(workspace),
    actorId: workspace.user.id,
    targetType: "page_site",
    targetId: site.id,
    action: "page_site.created",
    requestId,
    metadataJson: {
      defaultHostname: site.defaultHostname,
      isDefault: site.isDefault,
      slug: site.slug,
      source,
    },
  });

  return site;
}

async function rejectPageSiteSlug({
  attemptedSlug,
  projectId,
  reason,
  repository,
  requestId,
  source,
  workspace,
}: {
  attemptedSlug: string | undefined;
  projectId?: string;
  reason: SlugRejectionReason;
  repository: PageSitesRepository;
  requestId: string;
  source: string;
  workspace: PageSiteWorkspace;
}): Promise<never> {
  await repository.insertAudit({
    organizationId: workspace.organization.id,
    projectId: projectId ?? null,
    actorType: actorTypeForWorkspace(workspace),
    actorId: workspace.user.id,
    targetType: "slug",
    targetId: attemptedSlug ?? null,
    action: "slug.rejected",
    requestId,
    metadataJson: {
      attemptedNormalizedSlug: attemptedSlug ?? null,
      namespace: "page_site",
      reason,
      requestId,
      source,
    },
  });

  throw new ConsoleApiError(409, SLUG_UNAVAILABLE_PAYLOAD);
}

function defaultHostnameForSlug(slug: string) {
  return `${slug}.${hostedPagesDomain()}`;
}

function actorTypeForWorkspace(workspace: PageSiteWorkspace) {
  return workspace.mode === "anonymous" ? "anonymous" : "user";
}

function parseUpdatePageSiteInput(input: unknown): UpdatePageSiteInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConsoleApiError(400, { error: "invalid_request" });
  }

  const record = input as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const siteRef = typeof record.siteRef === "string" ? record.siteRef.trim() : "";
  const defaultVisibility = parsePageVisibility(record.defaultVisibility, fieldErrors);

  if (!siteRef) fieldErrors.siteRef = "Site is required.";

  if (Object.keys(fieldErrors).length > 0) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors });
  }

  return {
    siteRef,
    defaultVisibility,
  };
}

function parsePageVisibility(value: unknown, fieldErrors: Record<string, string>): PageVisibility {
  if (typeof value === "string" && PAGE_VISIBILITIES.has(value as PageVisibility)) {
    return value as PageVisibility;
  }
  fieldErrors.defaultVisibility = "Choose a valid visibility.";
  return "private";
}

async function assertProjectAccess(
  workspace: PageSiteWorkspace,
  repository: PageSitesRepository,
  projectId: string,
  action: "read" | "write" | "admin",
) {
  if (await canAccessProject(workspace, repository, projectId, action)) return;
  throw new ConsoleApiError(403, { error: "project_forbidden" });
}

async function canAccessProject(
  workspace: PageSiteWorkspace,
  repository: PageSitesRepository,
  projectId: string,
  action: "read" | "write" | "admin",
) {
  return Boolean(await repository.authorizeProject?.(workspace, projectId, action));
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "23505";
}
