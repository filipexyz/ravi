import { and, eq, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { KNOWLEDGE_ROUTE_CONFIG_KEY } from "@/server/console/knowledge/marks";
import { deleteKnowledgeSourceContent } from "@/server/console/knowledge/producer";
import { isUuidRef } from "@/server/console/ref";
import { validateConsoleSlug } from "@/server/console/slugs";
import { db, schema } from "@/server/db";

const pageVisibilitySchema = z.enum(["public", "private", "protected_link"]);

const createPageSiteBodySchema = z.object({
  defaultVisibility: pageVisibilitySchema.default("private"),
  makeDefault: z.boolean().default(false),
  organizationRef: z.string().trim().min(1).max(240),
  projectRef: z.string().trim().min(1).max(240).optional(),
  reason: z.string().trim().min(3).max(500),
  slug: z.string().trim().min(1).max(320),
});

const movePageSiteBodySchema = z.object({
  makeDefault: z.boolean().optional(),
  reason: z.string().trim().min(3).max(500),
  siteRef: z.string().trim().min(1).max(320),
  targetOrganizationRef: z.string().trim().min(1).max(240),
  targetProjectRef: z.string().trim().min(1).max(240).optional(),
});

const abortUploadSessionsBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
  siteRef: z.string().trim().min(1).max(320),
});

type AdminPagesInput = {
  body: unknown;
  requestId: string;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PageSite = typeof schema.pageSites.$inferSelect;
type Project = typeof schema.projects.$inferSelect;
type Organization = typeof schema.organizations.$inferSelect;

export async function createAdminPageSite(input: AdminPagesInput) {
  const body = parseCreatePageSiteBody(input.body);
  const normalized = normalizePageSiteRef(body.slug);

  try {
    return await db.transaction(async (tx) => {
      const targetOrganization = await findOrganization(tx, body.organizationRef);
      if (!targetOrganization) {
        return {
          status: "not_found" as const,
          code: "target_organization_not_found",
        };
      }
      if (targetOrganization.status !== "active") {
        return {
          status: "blocked" as const,
          code: "target_organization_not_active",
          organization: sanitizeOrganization(targetOrganization),
        };
      }

      const rejectionReason = validateConsoleSlug(normalized.slug, {
        ownerOrganizationSlug: targetOrganization.slug,
      });
      if (rejectionReason) return fail("invalid_slug");

      const targetProject = await resolveTargetProject(tx, {
        organizationId: targetOrganization.id,
        projectRef: body.projectRef,
      });
      if (targetProject.status === "not_found" || targetProject.status === "ambiguous") return targetProject;
      if (targetProject.project.status !== "active") {
        return {
          status: "blocked" as const,
          code: "target_project_not_active",
          target: sanitizeMoveOwner(targetOrganization, targetProject.project),
        };
      }

      const existingSite = await findPageSite(tx, normalized.slug);
      if (existingSite && existingSite.status !== "deleted") {
        if (
          existingSite.organizationId === targetOrganization.id &&
          existingSite.projectId === targetProject.project.id
        ) {
          return {
            status: "exists" as const,
            site: sanitizePageSite(existingSite),
            target: sanitizeMoveOwner(targetOrganization, targetProject.project),
          };
        }
        return {
          status: "conflict" as const,
          code: "page_site_slug_taken",
          site: sanitizePageSite(existingSite),
        };
      }
      if (existingSite) {
        return {
          status: "conflict" as const,
          code: "page_site_slug_taken",
          site: sanitizePageSite(existingSite),
        };
      }

      if (body.makeDefault) {
        const [existingDefault] = await tx
          .select({ id: schema.pageSites.id })
          .from(schema.pageSites)
          .where(
            and(
              eq(schema.pageSites.projectId, targetProject.project.id),
              eq(schema.pageSites.isDefault, true),
            ),
          )
          .limit(1);

        if (existingDefault) return fail("target_default_site_exists");
      }

      const now = new Date();
      const [site] = await tx
        .insert(schema.pageSites)
        .values({
          organizationId: targetOrganization.id,
          projectId: targetProject.project.id,
          slug: normalized.slug,
          defaultHostname: normalized.hostname,
          defaultVisibility: body.defaultVisibility,
          isDefault: body.makeDefault,
          status: "active",
          createdByActorType: "system",
          createdByActorId: null,
          metadataJson: {
            createdFrom: "admin_control",
            reason: body.reason,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!site) throw new Error("page_site_create_failed");

      await tx.insert(schema.auditEvents).values({
        organizationId: targetOrganization.id,
        projectId: targetProject.project.id,
        actorType: "system",
        actorId: null,
        targetType: "page_site",
        targetId: site.id,
        action: "admin.page_site.created",
        requestId: input.requestId,
        beforeJson: null,
        afterJson: { site: sanitizePageSite(site) },
        metadataJson: {
          defaultHostname: site.defaultHostname,
          reason: body.reason,
          source: "admin_control",
        },
      });

      return {
        status: "created" as const,
        site: sanitizePageSite(site),
        target: sanitizeMoveOwner(targetOrganization, targetProject.project),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        status: "conflict" as const,
        code: "page_site_slug_taken",
      };
    }
    throw error;
  }
}

export async function moveAdminPageSite(input: AdminPagesInput) {
  const body = parseMovePageSiteBody(input.body);

  try {
    return await db.transaction(async (tx) => {
      const site = await findPageSite(tx, body.siteRef);
      if (!site || site.status === "deleted") {
        return {
          status: "not_found" as const,
          code: "page_site_not_found",
        };
      }

      const [sourceOrganization, sourceProject, targetOrganization] = await Promise.all([
        findOrganizationById(tx, site.organizationId),
        findProjectById(tx, site.projectId),
        findOrganization(tx, body.targetOrganizationRef),
      ]);
      if (!sourceOrganization || !sourceProject) {
        return {
          status: "not_found" as const,
          code: "source_owner_not_found",
        };
      }
      if (!targetOrganization) {
        return {
          status: "not_found" as const,
          code: "target_organization_not_found",
        };
      }

      const targetProject = await resolveTargetProject(tx, {
        organizationId: targetOrganization.id,
        projectRef: body.targetProjectRef,
      });
      if (targetProject.status === "not_found" || targetProject.status === "ambiguous") return targetProject;

      const desiredDefault = await resolveTargetDefaultState(tx, {
        makeDefault: body.makeDefault,
        site,
        targetProject: targetProject.project,
      });

      if (
        site.organizationId === targetOrganization.id &&
        site.projectId === targetProject.project.id &&
        site.isDefault === desiredDefault
      ) {
        return {
          status: "unchanged" as const,
          site: sanitizePageSite(site),
          source: sanitizeMoveOwner(sourceOrganization, sourceProject),
          target: sanitizeMoveOwner(targetOrganization, targetProject.project),
        };
      }

      await assertNoCustomDomainBindings(tx, site);
      await assertNoActiveUploadSessions(tx, site);
      const artifactIds = await artifactIdsForSite(tx, site.id);
      await assertArtifactsAreSiteLocal(tx, { artifactIds, siteId: site.id });

      const now = new Date();
      const [updatedSite] = await tx
        .update(schema.pageSites)
        .set({
          organizationId: targetOrganization.id,
          projectId: targetProject.project.id,
          isDefault: desiredDefault,
          metadataJson: transferMetadata(site.metadataJson, {
            requestId: input.requestId,
            sourceOrganizationId: sourceOrganization.id,
            sourceProjectId: sourceProject.id,
            targetOrganizationId: targetOrganization.id,
            targetProjectId: targetProject.project.id,
          }),
          updatedAt: now,
        })
        .where(eq(schema.pageSites.id, site.id))
        .returning();

      if (!updatedSite) throw new Error("page_site_move_failed");

      await updateSiteScopedRows(tx, {
        artifactIds,
        now,
        siteId: site.id,
        targetOrganizationId: targetOrganization.id,
        targetProjectId: targetProject.project.id,
      });
      // Only a change of owner moves the pages' text; making the site default in its own project does not.
      if (site.organizationId !== targetOrganization.id || site.projectId !== targetProject.project.id) {
        await removeSiteKnowledge(tx, {
          requestId: input.requestId,
          siteId: site.id,
          sourceOrganizationId: sourceOrganization.id,
        });
      }

      await insertTransferAudit(tx, {
        reason: body.reason,
        requestId: input.requestId,
        siteBefore: site,
        siteAfter: updatedSite,
        sourceOrganization,
        sourceProject,
        targetOrganization,
        targetProject: targetProject.project,
      });

      return {
        status: "moved" as const,
        artifactsMoved: artifactIds.length,
        site: sanitizePageSite(updatedSite),
        source: sanitizeMoveOwner(sourceOrganization, sourceProject),
        target: sanitizeMoveOwner(targetOrganization, targetProject.project),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("target_unique_conflict");
    throw error;
  }
}

function parseCreatePageSiteBody(body: unknown) {
  const result = createPageSiteBodySchema.safeParse(body);
  if (!result.success) return fail("invalid_body");
  return result.data;
}

function parseMovePageSiteBody(body: unknown) {
  const result = movePageSiteBodySchema.safeParse(body);
  if (!result.success) return fail("invalid_body");
  return result.data;
}

function parseAbortUploadSessionsBody(body: unknown) {
  const result = abortUploadSessionsBodySchema.safeParse(body);
  if (!result.success) return fail("invalid_body");
  return result.data;
}

export async function abortAdminPageUploadSessions(input: AdminPagesInput) {
  const body = parseAbortUploadSessionsBody(input.body);

  return db.transaction(async (tx) => {
    const site = await findPageSite(tx, body.siteRef);
    if (!site || site.status === "deleted") {
      return {
        status: "not_found" as const,
        code: "page_site_not_found",
      };
    }

    const active = await tx
      .select()
      .from(schema.pageUploadSessions)
      .where(
        and(
          eq(schema.pageUploadSessions.siteId, site.id),
          inArray(schema.pageUploadSessions.status, ["created", "uploading", "uploaded"]),
        ),
      );

    if (active.length === 0) {
      return {
        status: "unchanged" as const,
        aborted: 0,
        site: sanitizePageSite(site),
      };
    }

    const now = new Date();
    const updated = await tx
      .update(schema.pageUploadSessions)
      .set({
        status: "failed",
        errorCode: "admin_abort",
        finalizedAt: now,
        updatedAt: now,
      })
      .where(
        inArray(
          schema.pageUploadSessions.id,
          active.map((s) => s.id),
        ),
      )
      .returning({
        id: schema.pageUploadSessions.id,
        status: schema.pageUploadSessions.status,
        createdByActorType: schema.pageUploadSessions.createdByActorType,
        createdByActorId: schema.pageUploadSessions.createdByActorId,
      });

    for (const session of active) {
      await tx.insert(schema.auditEvents).values({
        organizationId: site.organizationId,
        projectId: site.projectId,
        actorType: "system",
        actorId: null,
        targetType: "page_upload_session",
        targetId: session.id,
        action: "admin.page_upload_session.aborted",
        requestId: input.requestId,
        beforeJson: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          createdByActorType: session.createdByActorType,
          createdByActorId: session.createdByActorId,
        },
        afterJson: {
          id: session.id,
          status: "failed",
          errorCode: "admin_abort",
          finalizedAt: now.toISOString(),
        },
        metadataJson: {
          reason: body.reason,
          source: "admin_control",
          siteId: site.id,
        },
      });
    }

    return {
      status: "aborted" as const,
      aborted: updated.length,
      sessions: updated,
      site: sanitizePageSite(site),
    };
  });
}

async function findPageSite(tx: Tx, siteRef: string) {
  const normalized = normalizePageSiteRef(siteRef);
  const predicates = [
    eq(schema.pageSites.slug, normalized.slug),
    eq(schema.pageSites.defaultHostname, normalized.hostname),
  ];
  if (isUuidRef(normalized.raw)) predicates.push(eq(schema.pageSites.id, normalized.raw));

  const [site] = await tx
    .select()
    .from(schema.pageSites)
    .where(or(...predicates))
    .limit(1);
  return site ?? null;
}

function normalizePageSiteRef(siteRef: string) {
  const raw = siteRef.trim();
  let value = raw.toLowerCase();
  try {
    value = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    value = raw.toLowerCase().replace(/\/+$/, "");
  }

  const hostname = value.endsWith(".ravi.page") ? value : `${value}.ravi.page`;
  const slug = value.endsWith(".ravi.page") ? value.slice(0, -".ravi.page".length) : value;
  return { hostname, raw, slug };
}

async function findOrganization(tx: Tx, organizationRef: string) {
  const ref = organizationRef.trim();
  const [organization] = await tx
    .select()
    .from(schema.organizations)
    .where(isUuidRef(ref) ? eq(schema.organizations.id, ref) : eq(schema.organizations.slug, ref))
    .limit(1);
  return organization ?? null;
}

async function findOrganizationById(tx: Tx, organizationId: string) {
  const [organization] = await tx
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  return organization ?? null;
}

async function findProjectById(tx: Tx, projectId: string) {
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return project ?? null;
}

async function resolveTargetProject(tx: Tx, input: { organizationId: string; projectRef?: string }) {
  if (input.projectRef) {
    const ref = input.projectRef.trim();
    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.organizationId, input.organizationId),
          isUuidRef(ref) ? or(eq(schema.projects.id, ref), eq(schema.projects.slug, ref)) : eq(schema.projects.slug, ref),
          ne(schema.projects.status, "deleted"),
        ),
      )
      .limit(1);

    return project
      ? ({ status: "ok" as const, project })
      : ({ status: "not_found" as const, code: "target_project_not_found" as const });
  }

  const projects = await tx
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.organizationId, input.organizationId), eq(schema.projects.status, "active")))
    .limit(2);

  if (projects.length === 1 && projects[0]) return { status: "ok" as const, project: projects[0] };
  return projects.length === 0
    ? ({ status: "not_found" as const, code: "target_project_not_found" as const })
    : ({ status: "ambiguous" as const, code: "target_project_required" as const });
}

async function resolveTargetDefaultState(
  tx: Tx,
  input: {
    makeDefault?: boolean;
    site: PageSite;
    targetProject: Project;
  },
) {
  const [existingDefault] = await tx
    .select({ id: schema.pageSites.id })
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.projectId, input.targetProject.id),
        eq(schema.pageSites.isDefault, true),
        ne(schema.pageSites.id, input.site.id),
      ),
    )
    .limit(1);

  if (input.makeDefault === true && existingDefault) return fail("target_default_site_exists");
  if (input.makeDefault !== undefined) return input.makeDefault;
  return input.site.isDefault && !existingDefault;
}

async function assertNoCustomDomainBindings(tx: Tx, site: PageSite) {
  const [binding] = await tx
    .select({ hostname: schema.pageDomainBindings.hostname })
    .from(schema.pageDomainBindings)
    .where(eq(schema.pageDomainBindings.pageSiteId, site.id))
    .limit(1);

  if (binding) return fail("custom_domain_binding_transfer_unsupported");
}

async function assertNoActiveUploadSessions(tx: Tx, site: PageSite) {
  const [uploadSession] = await tx
    .select({ id: schema.pageUploadSessions.id })
    .from(schema.pageUploadSessions)
    .where(
      and(
        eq(schema.pageUploadSessions.siteId, site.id),
        inArray(schema.pageUploadSessions.status, ["created", "uploading", "uploaded"]),
      ),
    )
    .limit(1);

  if (uploadSession) return fail("active_upload_session_exists");
}

async function artifactIdsForSite(tx: Tx, siteId: string) {
  const releaseArtifacts = await tx
    .select({ artifactId: schema.pageReleaseRoutes.artifactId })
    .from(schema.pageReleaseRoutes)
    .where(eq(schema.pageReleaseRoutes.siteId, siteId));
  const publishArtifacts = await tx
    .select({ artifactId: schema.pagePublishes.artifactId })
    .from(schema.pagePublishes)
    .where(and(eq(schema.pagePublishes.siteId, siteId), isNotNull(schema.pagePublishes.artifactId)));

  return Array.from(
    new Set(
      [...releaseArtifacts.map((row) => row.artifactId), ...publishArtifacts.map((row) => row.artifactId)].filter(
        (artifactId): artifactId is string => Boolean(artifactId),
      ),
    ),
  );
}

async function assertArtifactsAreSiteLocal(
  tx: Tx,
  input: {
    artifactIds: string[];
    siteId: string;
  },
) {
  if (input.artifactIds.length === 0) return;

  const [otherRelease] = await tx
    .select({ siteId: schema.pageReleaseRoutes.siteId })
    .from(schema.pageReleaseRoutes)
    .where(
      and(
        inArray(schema.pageReleaseRoutes.artifactId, input.artifactIds),
        ne(schema.pageReleaseRoutes.siteId, input.siteId),
      ),
    )
    .limit(1);

  if (otherRelease) return fail("artifact_shared_with_another_site");
}

async function updateSiteScopedRows(
  tx: Tx,
  input: {
    artifactIds: string[];
    now: Date;
    siteId: string;
    targetOrganizationId: string;
    targetProjectId: string;
  },
) {
  const owner = {
    organizationId: input.targetOrganizationId,
    projectId: input.targetProjectId,
  };

  await tx.update(schema.pageRoutes).set({ ...owner, updatedAt: input.now }).where(eq(schema.pageRoutes.siteId, input.siteId));
  await tx.update(schema.pageSiteReleases).set(owner).where(eq(schema.pageSiteReleases.siteId, input.siteId));
  await tx.update(schema.pageReleaseRoutes).set(owner).where(eq(schema.pageReleaseRoutes.siteId, input.siteId));
  await tx.update(schema.pagePublishes).set({ ...owner, updatedAt: input.now }).where(eq(schema.pagePublishes.siteId, input.siteId));
  await tx.update(schema.pageUploadSessions).set({ ...owner, updatedAt: input.now }).where(eq(schema.pageUploadSessions.siteId, input.siteId));
  await tx.update(schema.pagesClaimCodes).set({ ...owner, updatedAt: input.now }).where(eq(schema.pagesClaimCodes.siteId, input.siteId));
  await tx.update(schema.pagesSessions).set({ ...owner, updatedAt: input.now }).where(eq(schema.pagesSessions.siteId, input.siteId));
  await tx.update(schema.usageEvents).set(owner).where(eq(schema.usageEvents.siteId, input.siteId));
  await tx.update(schema.usageRollups).set(owner).where(eq(schema.usageRollups.siteId, input.siteId));

  if (input.artifactIds.length > 0) {
    await tx
      .update(schema.artifacts)
      .set({
        projectId: input.targetProjectId,
        updatedAt: input.now,
      })
      .where(inArray(schema.artifacts.id, input.artifactIds));
  }
}

/**
 * Knowledge rows stay with the owner that captured them, so a moved site's
 * page text would stay searchable there: its `page:<siteId>:*` sources lose
 * their content and are left `revoked` (not `deleted`, which only a person or
 * retention sets), so the next capture revives them under the new owner. Route
 * marks, which pin the removed documents, are removed.
 */
async function removeSiteKnowledge(tx: Tx, input: { requestId: string; siteId: string; sourceOrganizationId: string }) {
  const sources = await tx
    .select({ id: schema.knowledgeSources.id })
    .from(schema.knowledgeSources)
    .where(
      and(
        eq(schema.knowledgeSources.organizationId, input.sourceOrganizationId),
        like(schema.knowledgeSources.originKey, `page:${input.siteId}:%`),
        ne(schema.knowledgeSources.status, "deleted"),
      ),
    );
  for (const source of sources) {
    await deleteKnowledgeSourceContent(
      {
        organizationId: input.sourceOrganizationId,
        sourceId: source.id,
        actor: { type: "system", id: null },
        reason: "site_moved",
        requestId: input.requestId,
      },
      tx as unknown as typeof db,
    );
  }
  await tx
    .update(schema.pageRoutes)
    .set({ routeConfigJson: sql`${schema.pageRoutes.routeConfigJson} - ${KNOWLEDGE_ROUTE_CONFIG_KEY}::text` })
    .where(and(eq(schema.pageRoutes.siteId, input.siteId), sql`${schema.pageRoutes.routeConfigJson} -> ${KNOWLEDGE_ROUTE_CONFIG_KEY}::text IS NOT NULL`));
}

async function insertTransferAudit(
  tx: Tx,
  input: {
    reason: string;
    requestId: string;
    siteBefore: PageSite;
    siteAfter: PageSite;
    sourceOrganization: Organization;
    sourceProject: Project;
    targetOrganization: Organization;
    targetProject: Project;
  },
) {
  const beforeJson = {
    site: sanitizePageSite(input.siteBefore),
    owner: sanitizeMoveOwner(input.sourceOrganization, input.sourceProject),
  };
  const afterJson = {
    site: sanitizePageSite(input.siteAfter),
    owner: sanitizeMoveOwner(input.targetOrganization, input.targetProject),
  };
  const metadataJson = {
    defaultHostname: input.siteAfter.defaultHostname,
    reason: input.reason,
    source: "admin_control",
    sourceOrganizationId: input.sourceOrganization.id,
    sourceProjectId: input.sourceProject.id,
    targetOrganizationId: input.targetOrganization.id,
    targetProjectId: input.targetProject.id,
  };

  await tx.insert(schema.auditEvents).values({
    organizationId: input.sourceOrganization.id,
    projectId: input.sourceProject.id,
    actorType: "system",
    actorId: null,
    targetType: "page_site",
    targetId: input.siteBefore.id,
    action:
      input.sourceOrganization.id === input.targetOrganization.id
        ? "admin.page_site.moved"
        : "admin.page_site.transferred_out",
    requestId: input.requestId,
    beforeJson,
    afterJson,
    metadataJson,
  });

  if (input.sourceOrganization.id !== input.targetOrganization.id) {
    await tx.insert(schema.auditEvents).values({
      organizationId: input.targetOrganization.id,
      projectId: input.targetProject.id,
      actorType: "system",
      actorId: null,
      targetType: "page_site",
      targetId: input.siteAfter.id,
      action: "admin.page_site.transferred_in",
      requestId: input.requestId,
      beforeJson,
      afterJson,
      metadataJson,
    });
  }
}

function transferMetadata(
  metadataJson: Record<string, unknown>,
  transfer: {
    requestId: string;
    sourceOrganizationId: string;
    sourceProjectId: string;
    targetOrganizationId: string;
    targetProjectId: string;
  },
) {
  return {
    ...asRecord(metadataJson),
    lastAdminTransfer: {
      ...transfer,
      transferredAt: new Date().toISOString(),
    },
  };
}

function sanitizePageSite(site: PageSite) {
  return {
    id: site.id,
    slug: site.slug,
    defaultHostname: site.defaultHostname,
    organizationId: site.organizationId,
    projectId: site.projectId,
    defaultVisibility: site.defaultVisibility,
    isDefault: site.isDefault,
    status: site.status,
  };
}

function sanitizeOrganization(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

function sanitizeMoveOwner(organization: Organization, project: Project) {
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
    },
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      status: project.status,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === "23505";
}

function fail(code: string): never {
  const error = new Error(code);
  error.name = "AdminPagesError";
  throw error;
}
