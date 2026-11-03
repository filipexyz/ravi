// `ravi.knowledge.search`, the Pages site built-in Page Chat calls through
// bases_call. It returns excerpts of this site's routes that the org marked
// for page viewers, at the version each mark pinned, and only routes the
// viewer can already open. Runs, citations and usage rows carry ids, counts
// and hashes: neither the visitor's question nor page text is stored.

import { usageEventTypes, usageMetricKeys } from "@/server/console/billing/usage-metering";
import { canUserViewPagesRoute } from "@/server/console/access/grants";
import { listMarkedRoutes, type MarkedRoute } from "@/server/console/knowledge/marks";
import { buildKnowledgeQuery } from "@/server/console/knowledge/query";
import {
  reloadKnowledgeChunks,
  searchKnowledgeCandidates,
  writeKnowledgeRun,
  type KnowledgeChunkRow,
  type KnowledgeSearchScope,
} from "@/server/console/knowledge/retrieval-core";
import { neutralizeKnowledgeText } from "@/server/console/knowledge/text";
import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "@/server/console/knowledge/usage";
import { canAccessProject, type ProjectAccessWorkspace } from "@/server/console/project-access";

import { KNOWLEDGE_SEARCH_ACTION_ID } from "./catalog";
import type { PagesConnectorSite } from "./host";

export { KNOWLEDGE_SEARCH_ACTION_ID } from "./catalog";

/** Who is asking: an org member with project read, or a guest given pages of the site. */
export type PageChatViewer =
  | { kind: "member"; userId: string; workspace: ProjectAccessWorkspace }
  | { kind: "guest"; userId: string };

export type KnowledgeSearchResult = {
  path: string;
  url: string;
  anchor: string | null;
  heading: string | null;
  text: string;
};

/** Longest excerpt per result. */
export const KNOWLEDGE_SEARCH_RESULT_MAX_CHARS = 1200;
/** All excerpts together stay under the Page Chat shell's 6000-char tool-result clip. */
export const KNOWLEDGE_SEARCH_TOTAL_MAX_CHARS = 5600;

export type SearchMarkedPagesDeps = {
  listMarkedRoutes?: typeof listMarkedRoutes;
  canViewRoute?: (input: { routeId: string; siteId: string; userId: string }) => Promise<boolean>;
  canMemberReadProject?: (workspace: ProjectAccessWorkspace, projectId: string) => Promise<boolean>;
  searchCandidates?: typeof searchKnowledgeCandidates;
  reloadChunks?: typeof reloadKnowledgeChunks;
  writeRun?: typeof writeKnowledgeRun;
  recordUsage?: typeof recordKnowledgeUsage;
  now?: () => number;
};

export async function searchMarkedPagesForViewer(
  input: { site: PagesConnectorSite; viewer: PageChatViewer; query: string; limit: number; requestId: string },
  deps: SearchMarkedPagesDeps = {},
): Promise<{ results: KnowledgeSearchResult[]; issues: string[] }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { site, viewer } = input;

  const marked = await (deps.listMarkedRoutes ?? listMarkedRoutes)({
    organizationId: site.organizationId,
    siteId: site.id,
    audience: { kind: "page_viewers" },
    state: "active",
  });
  const visible = await visibleMarkedRoutes(marked, input, deps);
  if (visible.length === 0) return { results: [], issues: ["no_marked_pages"] };

  const query = buildKnowledgeQuery(input.query);
  if (!query) return { results: [], issues: ["no_searchable_terms"] };

  const limit = Math.max(1, Math.min(5, Math.floor(input.limit)));
  const scope: KnowledgeSearchScope = {
    organizationId: site.organizationId,
    projectIds: [site.projectId],
    includeOrgLevel: false,
    documentIds: [...new Set(visible.map((route) => route.mark.approvedDocumentId))],
  };
  const filters = { kinds: ["page"] as const };
  const search = await (deps.searchCandidates ?? searchKnowledgeCandidates)({ scope, query, filters, limit });
  const top = search.candidates.slice(0, limit);
  const rows = await (deps.reloadChunks ?? reloadKnowledgeChunks)({
    scope,
    chunkIds: top.map((candidate) => candidate.chunkId),
    filters,
  });
  const scoreById = new Map(top.map((candidate) => [candidate.chunkId, candidate.score]));
  const routeByDocument = new Map(visible.map((route) => [route.mark.approvedDocumentId, route]));

  const results: KnowledgeSearchResult[] = [];
  const cited: Array<{ rank: number; score: number; row: KnowledgeChunkRow }> = [];
  let budget = KNOWLEDGE_SEARCH_TOTAL_MAX_CHARS;
  for (const row of rows) {
    const route = routeByDocument.get(row.documentId);
    if (!route || budget <= 0) continue;
    const result = projectResult(row, route, Math.min(KNOWLEDGE_SEARCH_RESULT_MAX_CHARS, budget));
    if (!result.text) continue;
    budget -= result.text.length;
    results.push(result);
    cited.push({ rank: cited.length + 1, score: scoreById.get(row.chunkId) ?? 0, row });
  }

  const revoked = top.length - rows.length;
  const { runId } = await (deps.writeRun ?? writeKnowledgeRun)({
    organizationId: site.organizationId,
    projectId: site.projectId,
    audience: "page_viewer",
    status: "completed",
    actorType: "user",
    actorId: viewer.userId,
    callerJson: { surface: "page_chat", viewer: viewer.kind, siteId: site.id, markedRoutes: visible.length },
    localInstallationId: null,
    turnKey: null,
    // A visitor's words are not kept, not even folded: the run holds counts and ids.
    queryText: null,
    normalizedQuery: null,
    mode: search.mode,
    candidateCount: search.candidates.length,
    withheld: revoked > 0 ? { revoked } : {},
    deniedReason: null,
    citations: cited,
    durationMs: now() - startedAt,
    requestId: input.requestId,
    surface: "page_chat",
    prefilter: { kinds: filters.kinds, projectCount: 1 },
  });
  await (deps.recordUsage ?? recordKnowledgeUsage)([
    buildKnowledgeUsageEvent({
      organizationId: site.organizationId,
      projectId: site.projectId,
      metricKey: usageMetricKeys.knowledgePageChatSearches,
      eventType: usageEventTypes.knowledgePageChatSearch,
      id: runId,
      quantity: 1,
      requestId: input.requestId,
      dimensions: { audience: "page_viewer", kind: "page" },
    }),
  ]);

  const issues: string[] = [];
  if (search.mode === "or" && results.length > 0) issues.push("query_or_fallback");
  return { results, issues };
}

/**
 * Marked routes of this site the viewer may open: a guest only through a
 * grant for the route or its site, a member through project read.
 */
async function visibleMarkedRoutes(
  marked: MarkedRoute[],
  input: { site: PagesConnectorSite; viewer: PageChatViewer },
  deps: SearchMarkedPagesDeps,
): Promise<MarkedRoute[]> {
  const onSite = marked.filter(
    (route) =>
      route.siteId === input.site.id &&
      route.projectId === input.site.projectId &&
      route.organizationId === input.site.organizationId,
  );
  if (onSite.length === 0) return [];

  const viewer = input.viewer;
  if (viewer.kind === "member") {
    const canRead = deps.canMemberReadProject ?? ((workspace, projectId) => canAccessProject(workspace, projectId, "read"));
    return (await canRead(viewer.workspace, input.site.projectId)) ? onSite : [];
  }

  const canView = deps.canViewRoute ?? ((grant) => canUserViewPagesRoute(grant));
  const allowed: MarkedRoute[] = [];
  for (const route of onSite) {
    if (await canView({ routeId: route.routeId, siteId: input.site.id, userId: viewer.userId })) allowed.push(route);
  }
  return allowed;
}

function projectResult(row: KnowledgeChunkRow, route: MarkedRoute, maxChars: number): KnowledgeSearchResult {
  const location = row.location ?? {};
  // The route row is the trusted address; the chunk's location only adds the anchor and heading.
  const path = route.path;
  const host = route.host;
  const anchor = stringOrNull(location.anchor);
  const text = clip(neutralizeKnowledgeText(row.text), maxChars);
  return {
    path,
    url: `https://${host}${path}${anchor ? `#${anchor}` : ""}`,
    anchor,
    heading: headingFor(location),
    text,
  };
}

function headingFor(location: Record<string, unknown>): string | null {
  const headingPath = location.headingPath;
  if (Array.isArray(headingPath)) {
    const parts = headingPath.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    return parts.length > 0 ? neutralizeKnowledgeText(parts.join(" > ")).slice(0, 200) : null;
  }
  const heading = stringOrNull(headingPath) ?? stringOrNull(location.heading);
  return heading ? neutralizeKnowledgeText(heading).slice(0, 200) : null;
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
