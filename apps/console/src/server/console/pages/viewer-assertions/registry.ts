import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { pageSitesRepositoryForDb } from "@/server/console/pages";
import {
  assertViewerAssertionOriginsForSite,
  normalizeViewerAssertionAudience,
} from "@/server/console/pages/viewer-assertions/audience";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";

const writeBodySchema = z
  .object({
    audience: z.string(),
    origins: z.array(z.string()).min(1).max(8),
  })
  .strict();

export type ViewerAssertionAudienceRecord = {
  audience: string;
  id: string;
  organizationId: string;
  origins: string[];
  projectId: string;
  siteId: string;
  status: string;
  updatedAt: Date;
};

export type ViewerAssertionRegistryRepository = {
  deleteAudience(input: { id: string; siteId: string }): Promise<ViewerAssertionAudienceRecord | null>;
  findActiveAudience(input: { audience: string; siteId: string }): Promise<ViewerAssertionAudienceRecord | null>;
  insertAudit(input: {
    action: string;
    actorId: string;
    metadataJson: Record<string, unknown>;
    organizationId: string;
    projectId: string;
    requestId: string;
    targetId: string;
  }): Promise<void>;
  listAudiences(siteId: string): Promise<ViewerAssertionAudienceRecord[]>;
  listSiteHostnames(site: { defaultHostname: string; id: string }): Promise<string[]>;
  upsertAudience(input: {
    audience: string;
    createdByUserId: string;
    organizationId: string;
    origins: string[];
    projectId: string;
    siteId: string;
  }): Promise<ViewerAssertionAudienceRecord>;
};

type RegistrySite = {
  defaultHostname: string;
  id: string;
  organizationId: string;
  projectId: string;
  status: string;
};

export async function listViewerAssertionAudiences(input: {
  projectRef: string;
  repository?: ViewerAssertionRegistryRepository;
  siteRef: string;
  workspace: ProjectAccessWorkspace;
}) {
  const site = await requireRegistrySite(input, "read");
  const repository = input.repository ?? viewerAssertionRegistryRepositoryForDb();
  const items = await repository.listAudiences(site.id);
  return { items: items.map(serializeViewerAssertionAudience) };
}

export async function createViewerAssertionAudience(input: {
  body: unknown;
  projectRef: string;
  repository?: ViewerAssertionRegistryRepository;
  requestId: string;
  siteRef: string;
  workspace: ProjectAccessWorkspace;
}) {
  const site = await requireRegistrySite(input, "write");
  const repository = input.repository ?? viewerAssertionRegistryRepositoryForDb();
  const record = await createViewerAssertionAudienceForSite({
    body: input.body,
    repository,
    requestId: input.requestId,
    site,
    userId: input.workspace.user.id,
  });
  return serializeViewerAssertionAudience(record);
}

export async function deleteViewerAssertionAudience(input: {
  audienceId: string;
  projectRef: string;
  repository?: ViewerAssertionRegistryRepository;
  requestId: string;
  siteRef: string;
  workspace: ProjectAccessWorkspace;
}) {
  const site = await requireRegistrySite(input, "write");
  const repository = input.repository ?? viewerAssertionRegistryRepositoryForDb();
  const deleted = await repository.deleteAudience({ id: input.audienceId, siteId: site.id });
  if (!deleted) throw new ConsoleApiError(404, { error: "not_found" });
  await repository.insertAudit({
    action: "pages.viewer_assertion_audience.deleted",
    actorId: input.workspace.user.id,
    metadataJson: {
      audience: deleted.audience,
      requestId: input.requestId,
      siteId: site.id,
    },
    organizationId: site.organizationId,
    projectId: site.projectId,
    requestId: input.requestId,
    targetId: deleted.id,
  });
  return { id: deleted.id };
}

export async function createViewerAssertionAudienceForSite(input: {
  body: unknown;
  repository: ViewerAssertionRegistryRepository;
  requestId: string;
  site: RegistrySite;
  userId: string;
}) {
  const parsed = writeBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "payload_invalid" });
  }

  const audience = normalizeViewerAssertionAudience(parsed.data.audience);
  const hostnames = await input.repository.listSiteHostnames(input.site);
  const origins = assertViewerAssertionOriginsForSite(parsed.data.origins, hostnames);
  const record = await input.repository.upsertAudience({
    audience,
    createdByUserId: input.userId,
    organizationId: input.site.organizationId,
    origins,
    projectId: input.site.projectId,
    siteId: input.site.id,
  });
  await input.repository.insertAudit({
    action: "pages.viewer_assertion_audience.upserted",
    actorId: input.userId,
    metadataJson: {
      audience,
      origins,
      requestId: input.requestId,
      siteId: input.site.id,
    },
    organizationId: input.site.organizationId,
    projectId: input.site.projectId,
    requestId: input.requestId,
    targetId: record.id,
  });
  return record;
}

export async function findActiveViewerAssertionAudience(input: { audience: string; siteId: string }) {
  return viewerAssertionRegistryRepositoryForDb().findActiveAudience(input);
}

export function viewerAssertionRegistryRepositoryForDb(
  database: Pick<typeof db, "delete" | "insert" | "select"> = db,
): ViewerAssertionRegistryRepository {
  return {
    async deleteAudience(input) {
      const [row] = await database
        .delete(schema.pageViewerAssertionAudiences)
        .where(
          and(
            eq(schema.pageViewerAssertionAudiences.id, input.id),
            eq(schema.pageViewerAssertionAudiences.siteId, input.siteId),
          ),
        )
        .returning();
      return row ? projectRecord(row) : null;
    },

    async findActiveAudience(input) {
      const [row] = await database
        .select()
        .from(schema.pageViewerAssertionAudiences)
        .where(
          and(
            eq(schema.pageViewerAssertionAudiences.siteId, input.siteId),
            eq(schema.pageViewerAssertionAudiences.audience, input.audience),
            eq(schema.pageViewerAssertionAudiences.status, "active"),
          ),
        )
        .limit(1);
      return row ? projectRecord(row) : null;
    },

    async insertAudit(input) {
      await database.insert(schema.auditEvents).values({
        action: input.action,
        actorId: input.actorId,
        actorType: "user",
        metadataJson: input.metadataJson,
        organizationId: input.organizationId,
        projectId: input.projectId,
        requestId: input.requestId,
        targetId: input.targetId,
        targetType: "page_viewer_assertion_audience",
      });
    },

    async listAudiences(siteId) {
      const rows = await database
        .select()
        .from(schema.pageViewerAssertionAudiences)
        .where(eq(schema.pageViewerAssertionAudiences.siteId, siteId))
        .orderBy(asc(schema.pageViewerAssertionAudiences.audience));
      return rows.map(projectRecord);
    },

    async listSiteHostnames(site) {
      const rows = await database
        .select({ hostname: schema.pageDomainBindings.hostname })
        .from(schema.pageDomainBindings)
        .innerJoin(
          schema.domainBindings,
          eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id),
        )
        .where(
          and(
            eq(schema.pageDomainBindings.pageSiteId, site.id),
            eq(schema.domainBindings.product, "pages"),
            eq(schema.domainBindings.status, "active"),
          ),
        );
      return [site.defaultHostname, ...rows.map((row) => row.hostname)];
    },

    async upsertAudience(input) {
      const [row] = await database
        .insert(schema.pageViewerAssertionAudiences)
        .values({
          audience: input.audience,
          createdByUserId: input.createdByUserId,
          organizationId: input.organizationId,
          origins: input.origins,
          projectId: input.projectId,
          siteId: input.siteId,
          status: "active",
        })
        .onConflictDoUpdate({
          target: [schema.pageViewerAssertionAudiences.siteId, schema.pageViewerAssertionAudiences.audience],
          set: {
            origins: input.origins,
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to save viewer assertion audience.");
      return projectRecord(row);
    },
  };
}

async function requireRegistrySite(
  input: {
    projectRef: string;
    siteRef: string;
    workspace: ProjectAccessWorkspace;
  },
  action: "read" | "write",
): Promise<RegistrySite> {
  const project = await findAccessibleProjectRecord(input.workspace, input.projectRef, action);
  if (!project || project.organizationId !== input.workspace.organization.id) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const site = await pageSitesRepositoryForDb().getSiteByRef(input.workspace.organization.id, input.siteRef);
  if (!site || site.projectId !== project.id || site.status !== "active") {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  return {
    defaultHostname: site.defaultHostname,
    id: site.id,
    organizationId: site.organizationId,
    projectId: site.projectId,
    status: site.status,
  };
}

export function serializeViewerAssertionAudience(record: ViewerAssertionAudienceRecord) {
  return {
    audience: record.audience,
    id: record.id,
    organizationId: record.organizationId,
    origins: record.origins,
    projectId: record.projectId,
    siteId: record.siteId,
    status: record.status === "active" ? ("active" as const) : ("disabled" as const),
    updatedAt: record.updatedAt,
  };
}

function projectRecord(row: typeof schema.pageViewerAssertionAudiences.$inferSelect): ViewerAssertionAudienceRecord {
  return {
    audience: row.audience,
    id: row.id,
    organizationId: row.organizationId,
    origins: Array.isArray(row.origins) ? row.origins.filter((origin): origin is string => typeof origin === "string") : [],
    projectId: row.projectId,
    siteId: row.siteId,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}
