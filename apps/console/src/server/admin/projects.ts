import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { isUuidRef } from "@/server/console/ref";
import { db, schema } from "@/server/db";

const moveProjectBodySchema = z.object({
  projectRef: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(3).max(500),
  sourceOrganizationRef: z.string().trim().min(1).max(240),
  targetOrganizationRef: z.string().trim().min(1).max(240),
});

export const projectMoveProjectScopedTables = [
  "page_sites",
  "page_routes",
  "page_site_releases",
  "page_release_routes",
  "page_comments",
  "page_publishes",
  "page_upload_sessions",
  "pages_claim_codes",
  "pages_sessions",
  "mailboxes",
  "mail_threads",
  "mail_messages",
  "mail_attachments",
  "mail_key_refs",
  "knowledge_sources",
  "knowledge_documents",
  "knowledge_permission_snapshots",
  "knowledge_chunks",
  "knowledge_ingestion_jobs",
  "knowledge_indexes",
  "knowledge_retrieval_strategies",
  "knowledge_retrieval_runs",
  "knowledge_citations",
  "knowledge_proposals",
  "bases",
  "base_properties",
  "base_rows",
  "base_row_ledger",
  "base_views",
  "base_charts",
  "base_operations",
  "base_subscriptions",
  "domains",
  "api_keys",
  "agent_inbox_items",
  "cloud_sync_events",
  "cloud_sync_cursors",
  "managed_runtime_instances",
  "runtime_leases",
  "managed_runtime_sessions",
  "managed_execution_harnesses",
  "managed_execution_harness_apps",
  "managed_execution_tool_projections",
  "runtime_trace_sessions",
  "runtime_trace_turns",
  "quota_usage",
  "usage_events",
  "usage_rollups",
  "provider_connections",
  "console_watches",
  "connector_grants_pending",
  "mcp_bridges",
  "mcp_oauth_clients",
  "mcp_oauth_authorizations",
  "mcp_oauth_tokens",
  "mcp_bridge_events",
  "mcp_bridge_usage",
] as const;

type AdminProjectsInput = {
  body: unknown;
  requestId: string;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Organization = typeof schema.organizations.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

export async function moveAdminProject(input: AdminProjectsInput) {
  const body = parseMoveProjectBody(input.body);

  try {
    return await db.transaction(async (tx) => {
      const sourceOrganization = await findOrganization(tx, body.sourceOrganizationRef);
      if (!sourceOrganization) return notFound("source_organization_not_found");

      const targetOrganization = await findOrganization(tx, body.targetOrganizationRef);
      if (!targetOrganization) return notFound("target_organization_not_found");
      if (targetOrganization.status !== "active") return blocked("target_organization_not_active");

      // Same order as issuance: serialize the inventory check and transfer with
      // any new key in either organization. Stable order avoids opposing moves.
      for (const org of [...new Set([sourceOrganization.id, targetOrganization.id])].sort()) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fleet:${org}`},0))`);
      }

      const project = await findProject(tx, {
        organizationId: sourceOrganization.id,
        projectRef: body.projectRef,
      });
      if (!project) return notFound("project_not_found");
      if (project.status === "deleted") return blocked("project_deleted");

      if (sourceOrganization.id === targetOrganization.id) {
        return {
          status: "unchanged" as const,
          project: sanitizeProject(project),
          source: sanitizeOrganization(sourceOrganization),
          target: sanitizeOrganization(targetOrganization),
        };
      }

      const slugConflict = await findProjectSlugConflict(tx, {
        project,
        targetOrganizationId: targetOrganization.id,
      });
      if (slugConflict) {
        return {
          status: "conflict" as const,
          code: "target_project_slug_taken" as const,
          conflict: sanitizeProject(slugConflict),
          source: sanitizeOrganization(sourceOrganization),
          target: sanitizeOrganization(targetOrganization),
        };
      }

      const blocker = await findMoveBlocker(tx, project.id);
      if (blocker) return blocker;

      const now = new Date();
      const [updatedProject] = await tx
        .update(schema.projects)
        .set({
          organizationId: targetOrganization.id,
          metadataJson: transferMetadata(project.metadataJson, {
            requestId: input.requestId,
            sourceOrganizationId: sourceOrganization.id,
            targetOrganizationId: targetOrganization.id,
          }),
          updatedAt: now,
        })
        .where(eq(schema.projects.id, project.id))
        .returning();

      if (!updatedProject) throw new Error("project_move_failed");

      const rowCounts = await updateProjectScopedRows(tx, {
        projectId: project.id,
        sourceOrganizationId: sourceOrganization.id,
        targetOrganizationId: targetOrganization.id,
      });

      await insertProjectTransferAudit(tx, {
        reason: body.reason,
        requestId: input.requestId,
        projectBefore: project,
        projectAfter: updatedProject,
        sourceOrganization,
        targetOrganization,
        rowCounts,
      });

      return {
        status: "moved" as const,
        project: sanitizeProject(updatedProject),
        source: sanitizeOrganization(sourceOrganization),
        target: sanitizeOrganization(targetOrganization),
        rowCounts,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("target_unique_conflict");
    throw error;
  }
}

function parseMoveProjectBody(body: unknown) {
  const result = moveProjectBodySchema.safeParse(body);
  if (!result.success) return fail("invalid_body");
  return result.data;
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

async function findProject(tx: Tx, input: { organizationId: string; projectRef: string }) {
  const ref = input.projectRef.trim();
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.organizationId, input.organizationId),
        isUuidRef(ref) ? or(eq(schema.projects.id, ref), eq(schema.projects.slug, ref)) : eq(schema.projects.slug, ref),
      ),
    )
    .limit(1);
  return project ?? null;
}

async function findProjectSlugConflict(
  tx: Tx,
  input: {
    project: Project;
    targetOrganizationId: string;
  },
) {
  const [conflict] = await tx
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.organizationId, input.targetOrganizationId),
        eq(schema.projects.slug, input.project.slug),
        ne(schema.projects.id, input.project.id),
        ne(schema.projects.status, "deleted"),
      ),
    )
    .limit(1);
  return conflict ?? null;
}

async function findMoveBlocker(tx: Tx, projectId: string) {
  const [keyHistory] = await tx.select({ id: schema.apiKeys.id }).from(schema.apiKeys)
    .where(eq(schema.apiKeys.projectId, projectId)).limit(1);
  if (keyHistory) return blocked("project_api_key_transfer_unsupported");
  const [activeUploadSession] = await tx
    .select({ id: schema.pageUploadSessions.id })
    .from(schema.pageUploadSessions)
    .where(
      and(
        eq(schema.pageUploadSessions.projectId, projectId),
        inArray(schema.pageUploadSessions.status, ["created", "uploading", "uploaded"]),
      ),
    )
    .limit(1);
  if (activeUploadSession) return blocked("active_upload_session_exists");

  const [customDomainBinding] = await tx
    .select({ id: schema.pageDomainBindings.domainBindingId })
    .from(schema.pageDomainBindings)
    .innerJoin(schema.pageSites, eq(schema.pageDomainBindings.pageSiteId, schema.pageSites.id))
    .where(eq(schema.pageSites.projectId, projectId))
    .limit(1);
  if (customDomainBinding) return blocked("custom_domain_binding_transfer_unsupported");

  const [mailbox] = await tx
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.projectId, projectId), ne(schema.mailboxes.status, "deleted")))
    .limit(1);
  if (mailbox) return blocked("project_mail_transfer_unsupported");

  const [providerConnection] = await tx
    .select({ id: schema.providerConnections.id })
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.projectId, projectId))
    .limit(1);
  if (providerConnection) return blocked("project_connector_transfer_unsupported");

  return null;
}

async function updateProjectScopedRows(
  tx: Tx,
  input: {
    projectId: string;
    sourceOrganizationId: string;
    targetOrganizationId: string;
  },
) {
  const rowCounts: Record<string, number> = {};
  for (const tableName of projectMoveProjectScopedTables) {
    const rows = await tx.execute<{ moved: number }>(sql`
      UPDATE ${safeTableIdentifier(tableName)}
      SET organization_id = ${input.targetOrganizationId}
      WHERE project_id = ${input.projectId}
        AND organization_id = ${input.sourceOrganizationId}
      RETURNING 1 AS moved
    `);
    rowCounts[tableName] = rows.length;
  }
  return rowCounts;
}

function safeTableIdentifier(tableName: string) {
  if (!/^[a-z_]+$/.test(tableName)) throw new Error("invalid_table_identifier");
  return sql.raw(`"${tableName}"`);
}

async function insertProjectTransferAudit(
  tx: Tx,
  input: {
    reason: string;
    requestId: string;
    projectBefore: Project;
    projectAfter: Project;
    sourceOrganization: Organization;
    targetOrganization: Organization;
    rowCounts: Record<string, number>;
  },
) {
  const beforeJson = {
    project: sanitizeProject(input.projectBefore),
    owner: sanitizeOrganization(input.sourceOrganization),
  };
  const afterJson = {
    project: sanitizeProject(input.projectAfter),
    owner: sanitizeOrganization(input.targetOrganization),
  };
  const metadataJson = {
    reason: input.reason,
    rowCounts: input.rowCounts,
    source: "admin_control",
    sourceOrganizationId: input.sourceOrganization.id,
    targetOrganizationId: input.targetOrganization.id,
  };

  await tx.insert(schema.auditEvents).values({
    organizationId: input.sourceOrganization.id,
    projectId: input.projectBefore.id,
    actorType: "system",
    actorId: null,
    targetType: "project",
    targetId: input.projectBefore.id,
    action: "admin.project.transferred_out",
    requestId: input.requestId,
    beforeJson,
    afterJson,
    metadataJson,
  });

  await tx.insert(schema.auditEvents).values({
    organizationId: input.targetOrganization.id,
    projectId: input.projectAfter.id,
    actorType: "system",
    actorId: null,
    targetType: "project",
    targetId: input.projectAfter.id,
    action: "admin.project.transferred_in",
    requestId: input.requestId,
    beforeJson,
    afterJson,
    metadataJson,
  });
}

function transferMetadata(
  metadataJson: Record<string, unknown>,
  transfer: {
    requestId: string;
    sourceOrganizationId: string;
    targetOrganizationId: string;
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

function sanitizeOrganization(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

function sanitizeProject(project: Project) {
  return {
    id: project.id,
    organizationId: project.organizationId,
    slug: project.slug,
    name: project.name,
    status: project.status,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function notFound(code: string) {
  return { status: "not_found" as const, code };
}

function blocked(code: string) {
  return { status: "blocked" as const, code };
}

function fail(code: string): never {
  const error = new Error(code);
  error.name = "AdminProjectsError";
  throw error;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
