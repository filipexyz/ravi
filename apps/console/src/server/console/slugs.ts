import { and, eq } from "drizzle-orm";

import { suggestConsoleSlug } from "@/lib/console/slugs";
import { getSlugRejectionReason } from "@/server/console/slug-policy";
import type { SlugRejectionReason } from "@/server/console/slug-policy";
import { db, schema } from "@/server/db";
import type { ConsoleWorkspace } from "./workspace";

export type SlugNamespace = "organization" | "project" | "page_site";
export type { SlugRejectionReason } from "@/server/console/slug-policy";
type SlugAuditWorkspace = {
  mode: ConsoleWorkspace["mode"];
  user: Pick<ConsoleWorkspace["user"], "id">;
  organization: Pick<ConsoleWorkspace["organization"], "id">;
};

export function validateConsoleSlug(
  slug: string | undefined,
  options: { ownerOrganizationSlug?: string } = {},
): SlugRejectionReason | null {
  return getSlugRejectionReason(slug, {
    dnsLabel: true,
    ownerOrganizationSlug: options.ownerOrganizationSlug,
  });
}

export async function projectSlugExists(organizationId: string, slug: string) {
  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.organizationId, organizationId), eq(schema.projects.slug, slug)))
    .limit(1);

  return Boolean(project);
}

/**
 * Resolve the organization slug by id so slug validators can let an org use
 * its own reserved namespace. Returns undefined when the org is missing.
 */
export async function fetchOrganizationSlug(organizationId: string): Promise<string | undefined> {
  const [org] = await db
    .select({ slug: schema.organizations.slug })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .limit(1);
  return org?.slug ?? undefined;
}

export async function auditSlugRejected({
  attemptedSlug,
  namespace,
  reason,
  requestId,
  source,
  workspace,
}: {
  attemptedSlug: string | undefined;
  namespace: SlugNamespace;
  reason: SlugRejectionReason;
  requestId: string;
  source: string;
  workspace: SlugAuditWorkspace;
}) {
  const attemptedNormalizedSlug = attemptedSlug ? suggestConsoleSlug(attemptedSlug) : null;

  await db.insert(schema.auditEvents).values({
    organizationId: workspace.organization.id,
    actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
    actorId: workspace.user.id,
    targetType: "slug",
    targetId: attemptedNormalizedSlug,
    action: "slug.rejected",
    requestId,
    metadataJson: {
      namespace,
      attemptedNormalizedSlug,
      reason,
      requestId,
      source,
    },
  });
}
