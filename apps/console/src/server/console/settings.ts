import { and, eq, ne } from "drizzle-orm";

import { CONSOLE_TOP_LEVEL_SEGMENTS } from "@/lib/console-paths";
import type { OrganizationSettingsData, SettingsData, Visibility } from "@/features/console/types";
import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { authorizationActorFromWorkspace, findAccessibleProjectRecord } from "./project-access";
import { decideInTransaction } from "./authorization/store";
import { getSettingsData } from "./read-model";
import {
  auditSlugRejected,
  validateConsoleSlug,
  type SlugNamespace,
  type SlugRejectionReason,
} from "./slugs";
import type { ConsoleWorkspace } from "./workspace";
import { authorizationStore } from "./authorization/store";
import type { AuthorizationExecutor } from "./authorization/identity";
import { organizationSettingsActor, organizationSettingsPayload } from "./organization-settings";

type SettingsScope = "org" | "project";
type VisibilityValue = Visibility;

type UpdateSettingsInput = {
  scope: SettingsScope;
  projectId: string | null;
  name: string;
  slug: string;
  visibility: VisibilityValue | null;
};

const VISIBILITIES = new Set<VisibilityValue>(["public", "private", "protected_link"]);
const SOURCE = "console.settings.update";
const SLUG_UNAVAILABLE_PAYLOAD = {
  error: "slug_unavailable",
  fieldErrors: {
    slug: "This slug is unavailable.",
  },
} satisfies ConsoleApiErrorPayload;

export async function updateSettings({
  body,
  requestId,
  workspace,
}: {
  body: unknown;
  requestId: string;
  workspace: ConsoleWorkspace;
}): Promise<SettingsData | OrganizationSettingsData> {
  const input = parseUpdateSettingsInput(body);
  if (input.scope === "org") {
    return updateOrganizationSettings({ input, requestId, workspace });
  }
  return updateProjectSettings({ input, requestId, workspace });
}

export function parseUpdateSettingsInput(body: unknown): UpdateSettingsInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConsoleApiError(400, { error: "invalid_request" });
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const scope = record.scope === "project" ? "project" : record.scope === "org" ? "org" : null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const slug = typeof record.slug === "string" ? record.slug.trim() : "";
  const projectId = optionalString(record.projectId, "projectId", fieldErrors);
  const visibility = parseVisibility(record.visibility, fieldErrors);

  if (!scope) fieldErrors.scope = "Choose a valid settings scope.";
  if (!name) fieldErrors.name = "Name is required.";
  if (!slug) fieldErrors.slug = "This slug is unavailable.";
  if (scope === "project" && !projectId) fieldErrors.projectId = "Project is required.";

  if (Object.keys(fieldErrors).length > 0) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors });
  }

  return {
    scope: scope as SettingsScope,
    projectId,
    name,
    slug,
    visibility,
  };
}

async function updateOrganizationSettings({
  input,
  requestId,
  workspace,
}: {
  input: UpdateSettingsInput;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  try {
    const updatedOrganization = await authorizationStore.withAuthorizedOrganization(
      organizationSettingsActor(workspace), "organization.settings.manage", async (tx) => {
      await assertOrganizationSlugAvailable(workspace, input.slug, requestId, tx);
      const [before] = await tx.select().from(schema.organizations)
        .where(eq(schema.organizations.id, workspace.organization.id)).limit(1).for("update");
      if (!before) throw new Error("Organization unavailable.");
      const [updated] = await tx
        .update(schema.organizations)
        .set({
          name: input.name,
          slug: input.slug,
          updatedAt: new Date(),
        })
        .where(eq(schema.organizations.id, workspace.organization.id))
        .returning();

      if (!updated) throw new Error("Failed to update organization settings.");

      await tx.insert(schema.auditEvents).values({
        organizationId: workspace.organization.id,
        actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
        actorId: workspace.user.id,
        targetType: "organization",
        targetId: workspace.organization.id,
        action: "organization.updated",
        requestId,
        beforeJson: {
          name: before.name,
          slug: before.slug,
        },
        afterJson: {
          name: updated.name,
          slug: updated.slug,
        },
        metadataJson: {
          source: SOURCE,
        },
      });

      return updated;
    }, requestId as `${string}-${string}-${string}-${string}-${string}`);

    // Echo only this mutation's configuration, not a second read or unrelated
    // resources. Manage-only must not fail *after* committing an allowed effect.
    return organizationSettingsPayload(updatedOrganization);
  } catch (error) {
    if (isUniqueViolation(error)) {
      await rejectSlug(workspace, input.slug, "namespace_conflict", requestId, "organization");
    }
    throw error;
  }
}

async function updateProjectSettings({
  input,
  requestId,
  workspace,
}: {
  input: UpdateSettingsInput;
  requestId: string;
  workspace: ConsoleWorkspace;
}) {
  const projectRef = input.projectId;
  if (!projectRef) throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { projectId: "Project is required." } });

  const project = await findAccessibleProjectRecord(workspace, projectRef, "admin");
  if (!project) {
    throw new ConsoleApiError(403, { error: "project_forbidden" });
  }

  await assertProjectSlugAvailable(workspace, input.slug, project.id, requestId);

  try {
    const changed = await db.transaction(async (tx) => {
      const actor = authorizationActorFromWorkspace(workspace);
      if (!(await decideInTransaction(tx, actor, project.id, "project.admin", requestId)).allowed ||
        !(await decideInTransaction(tx, actor, project.id, "project.read", requestId)).allowed) return false;
      const [updated] = await tx
        .update(schema.projects)
        .set({
          defaultVisibility: input.visibility ?? project.defaultVisibility,
          name: input.name,
          slug: input.slug,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.projects.organizationId, workspace.organization.id), eq(schema.projects.id, project.id)))
        .returning();

      if (!updated) throw new Error("Failed to update project settings.");

      await tx.insert(schema.auditEvents).values({
        organizationId: workspace.organization.id,
        projectId: project.id,
        actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
        actorId: workspace.user.id,
        targetType: "project",
        targetId: project.id,
        action: "project.updated",
        requestId,
        beforeJson: {
          defaultVisibility: project.defaultVisibility,
          name: project.name,
          slug: project.slug,
        },
        afterJson: {
          defaultVisibility: updated.defaultVisibility,
          name: updated.name,
          slug: updated.slug,
        },
        metadataJson: {
          source: SOURCE,
        },
      });
      return true;
    });

    if (!changed) throw new ConsoleApiError(403, { error: "project_forbidden" });
    const settings = await getSettingsData(workspace, "project", project.id);
    if (!settings) throw new Error("Updated project settings could not be read.");
    return settings;
  } catch (error) {
    if (isUniqueViolation(error)) {
      await rejectSlug(workspace, input.slug, "namespace_conflict", requestId, "project");
    }
    throw error;
  }
}

async function assertOrganizationSlugAvailable(
  workspace: ConsoleWorkspace,
  slug: string,
  requestId: string,
  executor: AuthorizationExecutor,
) {
  // Organization URLs start with the slug, so it can't be a path the Console serves itself.
  const rejectionReason = validateConsoleSlug(slug) ?? (CONSOLE_TOP_LEVEL_SEGMENTS.has(slug) ? "reserved_exact" : null);
  if (rejectionReason) {
    await rejectSlug(workspace, slug, rejectionReason, requestId, "organization");
  }

  const [existing] = await executor
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.slug, slug), ne(schema.organizations.id, workspace.organization.id)))
    .limit(1);

  if (existing) {
    await rejectSlug(workspace, slug, "namespace_conflict", requestId, "organization");
  }
}

async function assertProjectSlugAvailable(
  workspace: ConsoleWorkspace,
  slug: string,
  projectId: string,
  requestId: string,
) {
  const rejectionReason = validateConsoleSlug(slug, {
    ownerOrganizationSlug: workspace.organization.slug,
  });
  if (rejectionReason) {
    await rejectSlug(workspace, slug, rejectionReason, requestId, "project");
  }

  const [existing] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.organizationId, workspace.organization.id),
        eq(schema.projects.slug, slug),
        ne(schema.projects.id, projectId),
      ),
    )
    .limit(1);

  if (existing) {
    await rejectSlug(workspace, slug, "namespace_conflict", requestId, "project");
  }
}

async function rejectSlug(
  workspace: ConsoleWorkspace,
  attemptedSlug: string,
  reason: SlugRejectionReason,
  requestId: string,
  namespace: SlugNamespace,
): Promise<never> {
  await auditSlugRejected({
    attemptedSlug,
    namespace,
    reason,
    requestId,
    source: SOURCE,
    workspace,
  });

  throw new ConsoleApiError(409, SLUG_UNAVAILABLE_PAYLOAD);
}

function optionalString(value: unknown, field: string, fieldErrors: Record<string, string>) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    fieldErrors[field] = "Expected text.";
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseVisibility(value: unknown, fieldErrors: Record<string, string>): VisibilityValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && VISIBILITIES.has(value as VisibilityValue)) {
    return value as VisibilityValue;
  }
  fieldErrors.visibility = "Choose a valid visibility.";
  return null;
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "23505";
}
