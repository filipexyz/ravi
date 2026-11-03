import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import type { CliAuthContext } from "@/server/cli/auth";
import { listAccessibleProjectRecords } from "@/server/console/project-access";
import { db, schema } from "@/server/db";

import type { KnowledgeOperatorCaller } from "./caller";
import { knowledgeRouteCardUrl } from "./inbox";
import { listMarkedRoutes, readRouteMark, type KnowledgeRouteMark } from "./marks";
import { reloadKnowledgeChunks } from "./retrieval-core";
import { neutralizeKnowledgeText } from "./text";

// The daemon's mirror: the text of routes marked for this installation's
// contacts, pinned to the approved document version. Sections are reloaded
// under the full prefilter on every call, so a revoked source, a deleted chunk
// or a moved site drops out at the next sync.

const MIRROR_TTL_SECONDS = 86_400;
const MIRROR_MAX_INSTANCES = 50;
const MIRROR_MAX_SECTIONS = 200;
const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,120}$/;

const mirrorBodySchema = z.object({
  instances: z
    .array(
      z.object({
        id: z.string().regex(INSTANCE_ID),
        label: z.string().trim().max(80).optional().default(""),
        channel: z.string().trim().max(40).optional().default(""),
      }),
    )
    .max(MIRROR_MAX_INSTANCES),
});

export type ConsoleMirrorSection = { stableKey: string; heading: string | null; anchor: string | null; text: string };
export type ConsoleMirrorPage = {
  routeId: string;
  url: string;
  host: string;
  path: string;
  title: string | null;
  documentId: string;
  version: number;
  approvedAt: string | null;
  instances: string[];
  sections: ConsoleMirrorSection[];
};
export type ConsoleMirrorPayload = {
  generatedAt: string;
  ttlSeconds: number;
  raviHosts: string[];
  pages: ConsoleMirrorPage[];
};

export function parseKnowledgeMirrorBody(body: unknown) {
  const parsed = mirrorBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid mirror request: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "bad body"}.`);
  }
  const seen = new Set<string>();
  return parsed.data.instances.filter((instance) => {
    if (seen.has(instance.id)) return false;
    seen.add(instance.id);
    return true;
  });
}

export async function buildKnowledgeMirror(input: {
  auth: CliAuthContext;
  caller: KnowledgeOperatorCaller;
  body: unknown;
}): Promise<ConsoleMirrorPayload> {
  const instances = parseKnowledgeMirrorBody(input.body);
  const organizationId = input.auth.organization.id;
  const localInstallationId = input.caller.localInstallationId;
  const now = new Date();

  // Merge: other metadata keys (source, userAgent) stay.
  const reported = instances.map((instance) => ({
    id: instance.id,
    label: instance.label || instance.id,
    channel: instance.channel || null,
    reportedAt: now.toISOString(),
  }));
  await db
    .update(schema.localInstallations)
    .set({
      metadataJson: sql`jsonb_set(coalesce(${schema.localInstallations.metadataJson}, '{}'::jsonb), '{knowledgeInstances}', ${JSON.stringify(reported)}::jsonb, true)`,
      updatedAt: now,
    })
    .where(and(eq(schema.localInstallations.id, localInstallationId), eq(schema.localInstallations.organizationId, organizationId)));

  const sent = new Set(instances.map((instance) => instance.id));
  const marked = sent.size
    ? await listMarkedRoutes({ organizationId, audience: { kind: "contacts", localInstallationId }, state: "active" })
    : [];

  const pages: ConsoleMirrorPage[] = [];
  let sectionBudget = MIRROR_MAX_SECTIONS;
  for (const route of marked) {
    if (sectionBudget <= 0) break;
    const routeInstances = mirrorInstancesForMark(route.mark, localInstallationId, sent);
    if (routeInstances.length === 0) continue;
    const sections = await pinnedSections({
      organizationId,
      projectId: route.projectId,
      documentId: route.mark.approvedDocumentId,
      limit: sectionBudget,
    });
    if (sections.length === 0) continue;
    sectionBudget -= sections.length;
    pages.push({
      routeId: route.routeId,
      url: `https://${route.host}${route.path}`,
      host: route.host,
      path: route.path,
      title: route.title,
      documentId: route.mark.approvedDocumentId,
      version: route.mark.approvedVersion,
      approvedAt: route.mark.approvedAt ?? null,
      instances: routeInstances,
      sections,
    });
  }

  return {
    generatedAt: now.toISOString(),
    ttlSeconds: MIRROR_TTL_SECONDS,
    raviHosts: await listOrganizationRaviHosts(organizationId),
    pages,
  };
}

/** The instances of `sent` this installation's contacts audiences on the mark name. */
export function mirrorInstancesForMark(mark: KnowledgeRouteMark, localInstallationId: string, sent: ReadonlySet<string>): string[] {
  const ids = mark.audiences.flatMap((audience) =>
    audience.kind === "contacts" && audience.localInstallationId === localInstallationId && sent.has(audience.instanceId)
      ? [audience.instanceId]
      : [],
  );
  return [...new Set(ids)];
}

/** Every host of the organization's active sites: default hosts and active custom domains. */
export async function listOrganizationRaviHosts(organizationId: string): Promise<string[]> {
  const sites = await db
    .select({ id: schema.pageSites.id, host: schema.pageSites.defaultHostname })
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.organizationId, organizationId), eq(schema.pageSites.status, "active")));
  const hosts = new Set(sites.map((site) => site.host.toLowerCase()));
  if (sites.length > 0) {
    const domains = await db
      .select({ hostname: schema.pageDomainBindings.hostname })
      .from(schema.pageDomainBindings)
      .innerJoin(schema.domainBindings, eq(schema.domainBindings.id, schema.pageDomainBindings.domainBindingId))
      .where(
        and(
          inArray(
            schema.pageDomainBindings.pageSiteId,
            sites.map((site) => site.id),
          ),
          eq(schema.domainBindings.status, "active"),
        ),
      );
    for (const domain of domains) hosts.add(domain.hostname.toLowerCase());
  }
  return [...hosts].sort();
}

async function pinnedSections(input: { organizationId: string; projectId: string; documentId: string; limit: number }) {
  const ids = await db
    .select({ id: schema.knowledgeChunks.id })
    .from(schema.knowledgeChunks)
    .where(and(eq(schema.knowledgeChunks.documentId, input.documentId), eq(schema.knowledgeChunks.organizationId, input.organizationId)))
    .orderBy(asc(schema.knowledgeChunks.chunkOrdinal))
    .limit(input.limit);
  if (ids.length === 0) return [];
  const rows = await reloadKnowledgeChunks({
    scope: { organizationId: input.organizationId, projectIds: [input.projectId], includeOrgLevel: false, documentIds: [input.documentId] },
    chunkIds: ids.map((row) => row.id),
  });
  return rows.map((row) => ({
    stableKey: row.stableKey ?? `o${row.ordinal}`,
    heading: stringOrNull(row.metadata.heading) ?? lastHeading(row.location.headingPath),
    anchor: stringOrNull(row.location.anchor),
    text: neutralizeKnowledgeText(row.text),
  }));
}

// ---------------------------------------------------------------------------
// Marks listing for the CLI (CONTRACT §7.7)
// ---------------------------------------------------------------------------

export type KnowledgeMarksPayload = {
  marks: Array<{
    routeId: string;
    url: string;
    state: "active" | "suspended";
    audiences: string[];
    approvedVersion: number;
    approvedAt: string | null;
    cardUrl: string;
  }>;
  card: { url: string } | null;
};

/**
 * Marks of routes in projects the caller can read. With `url`, only that
 * page's marks, and `card` links its one-card page when the URL is a route of
 * the active release of a site in scope.
 */
export async function listKnowledgeMarksForCaller(input: {
  caller: KnowledgeOperatorCaller;
  url: string | null;
  origin: string;
}): Promise<KnowledgeMarksPayload> {
  const organizationId = input.caller.workspace.organization.id;
  const projects = await listAccessibleProjectRecords(input.caller.workspace);
  const projectIds = new Set(projects.map((project) => project.id));

  let routeId: string | null = null;
  if (input.url) {
    routeId = await resolveRouteForUrl(organizationId, input.url, projectIds);
    if (!routeId) return { marks: [], card: null };
  }

  const marked = (await listMarkedRoutes({ organizationId, state: "any" })).filter(
    (route) => projectIds.has(route.projectId) && (!routeId || route.routeId === routeId),
  );
  return {
    marks: marked.map((route) => ({
      routeId: route.routeId,
      url: `https://${route.host}${route.path}`,
      state: route.mark.state,
      audiences: route.mark.audiences.map((audience) => (audience.kind === "page_viewers" ? "page_viewers" : `contacts:${audience.instanceId}`)),
      approvedVersion: route.mark.approvedVersion,
      approvedAt: route.mark.approvedAt ?? null,
      cardUrl: knowledgeRouteCardUrl(input.origin, route.routeId),
    })),
    card: routeId ? { url: knowledgeRouteCardUrl(input.origin, routeId) } : null,
  };
}

/** The route id (page_routes) a public URL lands on in the active release, when its site is in scope. */
export async function resolveRouteForUrl(organizationId: string, rawUrl: string, projectIds: ReadonlySet<string>): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = normalizePath(url.pathname);

  const [byDefault] = await db
    .select({ id: schema.pageSites.id, projectId: schema.pageSites.projectId, activeReleaseId: schema.pageSites.activeReleaseId })
    .from(schema.pageSites)
    .where(and(eq(schema.pageSites.organizationId, organizationId), eq(schema.pageSites.defaultHostname, host), eq(schema.pageSites.status, "active")))
    .limit(1);
  let site = byDefault ?? null;
  if (!site) {
    const [byDomain] = await db
      .select({ id: schema.pageSites.id, projectId: schema.pageSites.projectId, activeReleaseId: schema.pageSites.activeReleaseId })
      .from(schema.pageDomainBindings)
      .innerJoin(schema.pageSites, eq(schema.pageSites.id, schema.pageDomainBindings.pageSiteId))
      .where(
        and(eq(schema.pageSites.organizationId, organizationId), eq(schema.pageDomainBindings.hostname, host), eq(schema.pageSites.status, "active")),
      )
      .limit(1);
    site = byDomain ?? null;
  }
  if (!site?.activeReleaseId || !projectIds.has(site.projectId)) return null;

  const routes = await db
    .select({ routeId: schema.pageReleaseRoutes.routeId, path: schema.pageReleaseRoutes.path })
    .from(schema.pageReleaseRoutes)
    .where(eq(schema.pageReleaseRoutes.releaseId, site.activeReleaseId));
  return routes.find((route) => normalizePath(route.path) === path)?.routeId ?? null;
}

/** True when a route row's config carries any mark (used by tests and the card). */
export function routeHasMark(routeConfigJson: unknown) {
  return readRouteMark(routeConfigJson) !== null;
}

function normalizePath(path: string) {
  const decoded = (() => {
    try {
      return decodeURI(path);
    } catch {
      return path;
    }
  })();
  const trimmed = decoded.replace(/\/+$/, "");
  return trimmed || "/";
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function lastHeading(value: unknown) {
  if (Array.isArray(value)) return stringOrNull(value.at(-1));
  if (typeof value === "string") return stringOrNull(value.split(">").at(-1)?.trim());
  return null;
}
