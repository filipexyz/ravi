import { orgPath, orgSegment } from "@/lib/console-paths";
import type { Project } from "@/features/console/types";
import { eq } from "drizzle-orm";
import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { createDefaultPageSiteForProject, pageSitesRepositoryForDb } from "./pages";
import { projectOwnedPagesSlug } from "./pages/project-owned";
import { authorizationActorFromWorkspace, type ProjectAccessWorkspace } from "./project-access";
import { authorizeProjectCreationInTransaction } from "./authorization/store";
import {
  auditSlugRejected,
  projectSlugExists,
  validateConsoleSlug,
  type SlugRejectionReason,
} from "./slugs";
import type { ConsoleWorkspace } from "./workspace";

export { ConsoleApiError } from "@/server/console/api-error";

export type CreateProjectResponse = {
  project: Project;
  redirectTo: string;
};

type VisibilityValue = "public" | "private" | "protected_link";
type ProjectCreateWorkspace = {
  mode: ConsoleWorkspace["mode"];
  user: Pick<ConsoleWorkspace["user"], "id">;
  organization: Pick<ConsoleWorkspace["organization"], "id" | "slug">;
  membership: Pick<ConsoleWorkspace["membership"], "role">;
  authorization?: ProjectAccessWorkspace["authorization"];
};

type CreateProjectInput = {
  name: string;
  slug: string;
  description: string | null;
  defaultVisibility: VisibilityValue;
  createDefaultPageSite: boolean;
  defaultPageSiteSlug: string | null;
};

const VISIBILITIES = new Set<VisibilityValue>(["public", "private", "protected_link"]);
const SOURCE = "console.projects.create";
const SLUG_UNAVAILABLE_PAYLOAD = {
  error: "slug_unavailable",
  fieldErrors: {
    slug: "This slug is unavailable.",
  },
} satisfies ConsoleApiErrorPayload;

export async function createProject({
  body,
  requestId,
  workspace,
}: {
  body: unknown;
  requestId: string;
  workspace: ProjectCreateWorkspace;
}): Promise<CreateProjectResponse> {
  if (workspace.mode === "anonymous") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }

  const input = parseCreateProjectInput(body);
  try {
    const project = await db.transaction(async (tx) => {
      const candidateId = crypto.randomUUID();
      if (!await authorizeProjectCreationInTransaction(tx, authorizationActorFromWorkspace(workspace), candidateId, requestId)) return null;
      const organizationSlug = await getOrganizationSlug(workspace.organization.id);
      const defaultPageSiteSlug = projectOwnedPagesSlug({ organizationSlug, projectSlug: input.slug });
      if (input.defaultPageSiteSlug && input.defaultPageSiteSlug !== defaultPageSiteSlug) {
        throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: {
          defaultPageSiteSlug: `Default Pages host is ${defaultPageSiteSlug}.ravi.page.`,
        } });
      }
      // Do not reveal slug occupancy before checking creation and data grants.
      await assertProjectSlugAvailable(workspace, input.slug, requestId);
      if (input.createDefaultPageSite) await assertProjectSlugAvailable(workspace, defaultPageSiteSlug, requestId, "page_site");
      const [project] = await tx
        .insert(schema.projects)
        .values({
          id: candidateId,
          organizationId: workspace.organization.id,
          slug: input.slug,
          name: input.name,
          description: input.description,
          defaultVisibility: input.defaultVisibility,
          metadataJson: {},
        })
        .returning();

      if (!project) throw new Error("Failed to create project.");

      await tx.insert(schema.auditEvents).values({
        organizationId: workspace.organization.id,
        projectId: project.id,
        actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
        actorId: workspace.user.id,
        targetType: "project",
        targetId: project.id,
        action: "project.created",
        requestId,
        metadataJson: {
          slug: input.slug,
          name: input.name,
          source: SOURCE,
        },
      });

      if (input.createDefaultPageSite) {
        await createDefaultPageSiteForProject({
          defaultVisibility: input.defaultVisibility,
          project: {
            id: project.id,
            organizationId: workspace.organization.id,
          },
          requestId,
          repository: pageSitesRepositoryForDb(tx),
          slug: defaultPageSiteSlug,
          source: `${SOURCE}.default_page_site`,
          workspace,
        });
      }

      // The current policy grants this exact response within the transaction;
      // do not commit first and then discover the caller cannot read the result.
      return { id: project.id, orgId: project.organizationId, name: project.name,
        slug: project.slug, description: project.description ?? "", artifactCount: 0,
        members: 0, lastActive: project.updatedAt.getTime() } satisfies Project;
    });

    if (!project) throw new ConsoleApiError(403, { error: "project_creation_forbidden" });

    return {
      project,
      redirectTo: orgPath(orgSegment(workspace.organization), `/p/${project.id}`),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      await rejectSlug(workspace, input.slug, "namespace_conflict", requestId);
    }
    throw error;
  }
}

async function getOrganizationSlug(organizationId: string) {
  const [organization] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);

  if (!organization) throw new ConsoleApiError(403, { error: "forbidden" });
  return organization.slug;
}

function parseCreateProjectInput(body: unknown): CreateProjectInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConsoleApiError(400, { error: "invalid_request" });
  }

  const record = body as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const slug = typeof record.slug === "string" ? record.slug : "";
  const description = optionalString(record.description, "description", fieldErrors);
  const defaultVisibility = parseVisibility(record.defaultVisibility, fieldErrors);
  const createDefaultPageSite = parseBoolean(record.createDefaultPageSite, "createDefaultPageSite", fieldErrors);
  const defaultPageSiteSlug = optionalString(record.defaultPageSiteSlug, "defaultPageSiteSlug", fieldErrors);

  if (!name) fieldErrors.name = "Name is required.";

  if (Object.keys(fieldErrors).length > 0) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors });
  }

  return {
    name,
    slug,
    description,
    defaultVisibility,
    createDefaultPageSite,
    defaultPageSiteSlug,
  };
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

function parseVisibility(value: unknown, fieldErrors: Record<string, string>): VisibilityValue {
  if (value === undefined || value === null) return "private";
  if (typeof value === "string" && VISIBILITIES.has(value as VisibilityValue)) {
    return value as VisibilityValue;
  }
  fieldErrors.defaultVisibility = "Choose a valid visibility.";
  return "private";
}

function parseBoolean(value: unknown, field: string, fieldErrors: Record<string, string>) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  fieldErrors[field] = "Expected true or false.";
  return false;
}

async function assertProjectSlugAvailable(
  workspace: ProjectCreateWorkspace,
  slug: string,
  requestId: string,
  namespace: "project" | "page_site" = "project",
) {
  const rejectionReason = validateConsoleSlug(slug, {
    ownerOrganizationSlug: workspace.organization.slug,
  });
  if (rejectionReason) {
    await rejectSlug(workspace, slug, rejectionReason, requestId, namespace);
  }

  const exists =
    namespace === "project"
      ? await projectSlugExists(workspace.organization.id, slug)
      : await pageSitesRepositoryForDb(db).findSiteBySlug(slug);

  if (exists) {
    await rejectSlug(workspace, slug, "namespace_conflict", requestId, namespace);
  }
}

async function rejectSlug(
  workspace: ProjectCreateWorkspace,
  attemptedSlug: string | undefined,
  reason: SlugRejectionReason,
  requestId: string,
  namespace: "project" | "page_site" = "project",
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

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "23505";
}
