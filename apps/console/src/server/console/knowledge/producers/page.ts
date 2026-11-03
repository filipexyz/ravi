import { and, eq, inArray, like } from "drizzle-orm";
import { parseDocument } from "htmlparser2";
import { createHash } from "node:crypto";

import { createPageObjectStorageFromEnv, readR2Key, type PageObjectStorage } from "@/server/console/pages/publish";
import { extractPageText, isPageReadHtmlPath } from "@/server/console/pages/read-extract";
import { db, schema } from "@/server/db";

import { isKnowledgeEnabledForOrganization } from "../enabled";
import { enqueueKnowledgeJob, type KnowledgeTriggerType } from "../jobs";
import { readActiveRouteMark, suspendRouteMark, type KnowledgeRouteMark } from "../marks";
import {
  ingestForProducer,
  revokeKnowledgeSourceByOrigin,
  upsertKnowledgeSourceForOrigin,
  type ProducerChunkInput,
  type ProducerIngestResult,
} from "../producer";
import { scheduleKnowledgeDrain } from "../schedule";
import { foldKnowledgeText, neutralizeKnowledgeText } from "../text";
import { splitAtSentences } from "./meeting";

// Ravi Pages routes as knowledge. Every active release is read route by route
// (`exact` and `spa` HTML routes; `prefix` routes are skipped in v1), split at
// h1–h3 into sections, and stored as `page:<siteId>:<path>` at tier
// `published`, or `approved` only for the Console's own /faq bytes. A path the
// active release no longer serves is revoked and its mark suspended. A mark is
// pinned to the exact entry HTML it approved (`approvedHtmlSha256`): any other
// bytes served at a marked route suspend it, whether or not the capture works.

export const PAGE_PARSER_VERSION = "knowledge-page-v1";
const ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SECTION_MAX_CHARS = 1200;
const ANCHOR_WORDS = 6;
const CAPTURED_MATCH_TYPES = new Set(["exact", "spa"]);

type ReleaseRoute = typeof schema.pageReleaseRoutes.$inferSelect;
type PageCaptureTrigger = "page_release" | "page_backfill";

type ReleaseCaptureDeps = {
  enabled?: (organizationId: string) => Promise<boolean>;
  drain?: (requestId: string) => void;
  storage?: PageObjectStorage;
  readMark?: typeof readActiveRouteMark;
  suspendMark?: typeof suspendRouteMark;
};

/**
 * The publish hook's work: for a release that is (still) the site's active
 * one, one capture job per captured route, and every page source of the site
 * whose path left the active set revoked with its mark suspended.
 */
export async function onActiveSiteManifestWritten(
  input: { siteId: string; releaseId: string; requestId: string },
  deps: ReleaseCaptureDeps = {},
): Promise<void> {
  const site = await loadSite(input.siteId);
  // A newer activation took over; its own hook captures it.
  if (!site || site.status !== "active" || site.activeReleaseId !== input.releaseId) return;
  // Before anything else, and whatever the capture later does: a marked route now serving other bytes stops being heard.
  await suspendChangedMarks({ site, releaseId: input.releaseId, requestId: input.requestId }, deps);
  if (!(await (deps.enabled ?? isKnowledgeEnabledForOrganization)(site.organizationId))) return;

  const captured = await enqueueReleaseCaptures({ site, releaseId: input.releaseId, trigger: "page_release", requestId: input.requestId });
  await revokeRemovedPaths({ site, paths: new Set(captured.map((route) => route.path)), requestId: input.requestId }, deps);
  if (captured.length) (deps.drain ?? scheduleKnowledgeDrain)(input.requestId);
}

/**
 * Enqueues a capture job per captured route of the release; returns those
 * routes. The key carries the activation instant, so activating an older
 * release again captures it again.
 */
export async function enqueueReleaseCaptures(input: {
  site: SiteRow;
  releaseId: string;
  trigger: PageCaptureTrigger;
  requestId: string;
}): Promise<ReleaseRoute[]> {
  const routes = capturedRoutes(await db.select().from(schema.pageReleaseRoutes).where(eq(schema.pageReleaseRoutes.releaseId, input.releaseId)));
  const [release] = await db
    .select({ activatedAt: schema.pageSiteReleases.activatedAt })
    .from(schema.pageSiteReleases)
    .where(eq(schema.pageSiteReleases.id, input.releaseId))
    .limit(1);
  const activation = release?.activatedAt?.getTime() ?? 0;
  for (const route of routes) {
    await db.transaction(async (tx) => {
      const originKey = pageOriginKey(input.site.id, route.path);
      const [existing] = await tx
        .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status })
        .from(schema.knowledgeSources)
        .where(and(eq(schema.knowledgeSources.organizationId, input.site.organizationId), eq(schema.knowledgeSources.originKey, originKey)))
        .limit(1);
      // An existing source is left as it is until the capture writes it (a revoked one is revived only by new content).
      const source =
        existing ??
        (await upsertKnowledgeSourceForOrigin(
          {
            organizationId: input.site.organizationId,
            projectId: input.site.projectId,
            originKey,
            sourceType: "ravi_page",
            trustTier: "published",
            title: route.path,
            sourceRef: pageSourceRef(input.site, route, input.releaseId),
            actor: { type: "system", id: null },
            requestId: input.requestId,
            allowRevive: false,
          },
          tx,
        ));
      if (source.status === "deleted") return;
      await enqueueKnowledgeJob(
        {
          organizationId: input.site.organizationId,
          projectId: input.site.projectId,
          sourceId: source.id,
          triggerType: input.trigger,
          inputJson: { schemaVersion: 1, siteId: input.site.id, releaseId: input.releaseId, routeId: route.routeId },
          idempotencyKey: `${input.trigger}:${input.releaseId}:${route.routeId}:${activation}`,
          requestId: input.requestId,
          actor: { type: "system", id: null },
        },
        tx,
      );
    });
  }
  return routes;
}

export async function capturePageRoute(
  input: {
    siteId: string;
    releaseId: string;
    routeId: string;
    requestId: string;
    jobId?: string;
    /** The job's trigger (`page_release`, `page_backfill`, `faq`); defaults to `page_release`. */
    trigger?: KnowledgeTriggerType;
  },
  deps: {
    storage?: PageObjectStorage;
    readMark?: typeof readActiveRouteMark;
    suspendMark?: typeof suspendRouteMark;
    ingest?: typeof ingestForProducer;
    faqHtmlSha256?: string | null;
  } = {},
): Promise<ProducerIngestResult | { status: "no_source" }> {
  const site = await loadSite(input.siteId);
  if (!site || site.status !== "active") return { status: "no_source" };
  // Only the active release is read: an older job must not store text the site no longer serves.
  if (site.activeReleaseId !== input.releaseId) return { status: "no_source" };
  const [route] = await db
    .select()
    .from(schema.pageReleaseRoutes)
    .where(and(eq(schema.pageReleaseRoutes.releaseId, input.releaseId), eq(schema.pageReleaseRoutes.routeId, input.routeId)))
    .limit(1);
  if (!route || !isCapturedRoute(route)) return { status: "no_source" };
  // An spa route that shares its path with an exact one is not this page: the exact route owns the origin.
  if (route.matchType !== "exact") {
    const siblings = await db
      .select({
        routeId: schema.pageReleaseRoutes.routeId,
        path: schema.pageReleaseRoutes.path,
        matchType: schema.pageReleaseRoutes.matchType,
        entrypoint: schema.pageReleaseRoutes.entrypoint,
      })
      .from(schema.pageReleaseRoutes)
      .where(and(eq(schema.pageReleaseRoutes.releaseId, input.releaseId), eq(schema.pageReleaseRoutes.path, route.path)));
    if (!capturedRoutes(siblings).some((sibling) => sibling.routeId === route.routeId)) return { status: "no_source" };
  }
  const [release] = await db
    .select({ activatedAt: schema.pageSiteReleases.activatedAt })
    .from(schema.pageSiteReleases)
    .where(eq(schema.pageSiteReleases.id, input.releaseId))
    .limit(1);

  const readMark = deps.readMark ?? readActiveRouteMark;
  const suspendMark = deps.suspendMark ?? suspendRouteMark;
  const html = await readEntryHtml(site, route, deps.storage);
  if (html === null) {
    // The bytes the site serves cannot be read, so nobody can tell they are still the approved ones.
    if (await readMark(route.routeId)) await suspendMark({ routeId: route.routeId, reason: "new_version", requestId: input.requestId });
    return { status: "no_source" };
  }

  const host = site.defaultHostname;
  const extraction = extractPageText({ baseUrl: `https://${host}`, path: route.entrypoint, source: html });
  const recordedAt = (release?.activatedAt ?? new Date()).toISOString();
  const baseViews = pageBaseViews(html);
  const chunks = buildPageChunks({
    markdown: extraction.markdown,
    headings: htmlHeadings(html),
    location: { kind: "page", siteId: site.id, routeId: route.routeId, host, path: route.path, recordedAt },
    baseViews,
  });

  const htmlSha256 = sha256Hex(html);
  const mark = await readMark(route.routeId);
  const approved =
    (typeof deps.faqHtmlSha256 === "string" && deps.faqHtmlSha256 === htmlSha256) ||
    (mark?.managedBy === "faq" && mark.faqHtmlSha256 === htmlSha256);
  const title = extraction.title.trim() || route.path;

  const result = await (deps.ingest ?? ingestForProducer)({
    organizationId: site.organizationId,
    projectId: site.projectId,
    originKey: pageOriginKey(site.id, route.path),
    sourceType: "ravi_page",
    trustTier: approved ? "approved" : "published",
    title,
    sourceRef: pageSourceRef(site, route, input.releaseId),
    document: {
      title,
      mimeType: "text/html",
      parserVersion: PAGE_PARSER_VERSION,
      // Other bytes are another version even when the text reads the same: a mark approves bytes, not only text.
      contentHash: sha256Hex(JSON.stringify([htmlSha256, chunks.map((chunk) => [chunk.stableKey, chunk.text, chunk.location.anchor ?? null])])),
      sizeBytes: Buffer.byteLength(html, "utf8"),
      sourceLocation: {
        kind: "page",
        siteId: site.id,
        routeId: route.routeId,
        host,
        path: route.path,
        releaseId: input.releaseId,
        artifactVersionId: route.artifactVersionId,
        htmlSha256,
      },
    },
    chunks,
    actor: { type: "system", id: null },
    triggerType: input.trigger ?? "page_release",
    requestId: input.requestId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
  });

  // A mark is pinned to one version: new content suspends it until a person re-approves. The Console's own
  // /faq write re-pins its mark right after; someone else's bytes at /faq suspend it like any page. The mark
  // is read again after the ingest, so one written meanwhile (against the previous version) is not missed.
  if (result.status === "ingested") {
    const current = await readMark(route.routeId);
    if (current && current.approvedDocumentId !== result.documentId && (current.managedBy === "web" || !approved)) {
      await suspendMark({ routeId: route.routeId, reason: "new_version", requestId: input.requestId });
    }
  }
  return result;
}

/** True when the bytes served at a marked route are the ones its mark approved. */
export function servedHtmlMatchesMark(
  mark: Pick<KnowledgeRouteMark, "managedBy" | "faqHtmlSha256" | "approvedHtmlSha256">,
  htmlSha256: string | null,
): boolean {
  if (!htmlSha256) return false;
  if (mark.approvedHtmlSha256 === htmlSha256) return true;
  return mark.managedBy === "faq" && mark.faqHtmlSha256 === htmlSha256;
}

export function pageOriginKey(siteId: string, path: string) {
  return `page:${siteId}:${path}`;
}

type SiteRow = {
  id: string;
  organizationId: string;
  projectId: string;
  defaultHostname: string;
  activeReleaseId: string | null;
  status: string;
};

export async function loadSite(siteId: string): Promise<SiteRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) return null;
  const [site] = await db
    .select({
      id: schema.pageSites.id,
      organizationId: schema.pageSites.organizationId,
      projectId: schema.pageSites.projectId,
      defaultHostname: schema.pageSites.defaultHostname,
      activeReleaseId: schema.pageSites.activeReleaseId,
      status: schema.pageSites.status,
    })
    .from(schema.pageSites)
    .where(eq(schema.pageSites.id, siteId))
    .limit(1);
  return site ?? null;
}

/**
 * For every captured route of the release that carries an active mark: when the
 * entry HTML it now serves is not the HTML the mark approved (or cannot be
 * read), the mark is suspended right away, before any capture job runs.
 */
async function suspendChangedMarks(input: { site: SiteRow; releaseId: string; requestId: string }, deps: ReleaseCaptureDeps) {
  const readMark = deps.readMark ?? readActiveRouteMark;
  const routes = capturedRoutes(await db.select().from(schema.pageReleaseRoutes).where(eq(schema.pageReleaseRoutes.releaseId, input.releaseId)));
  for (const route of routes) {
    const mark = await readMark(route.routeId);
    if (!mark) continue;
    const html = await readEntryHtml(input.site, route, deps.storage);
    if (servedHtmlMatchesMark(mark, html === null ? null : sha256Hex(html))) continue;
    await (deps.suspendMark ?? suspendRouteMark)({ routeId: route.routeId, reason: "new_version", requestId: input.requestId });
  }
}

/** The route's entry HTML from page storage, or null when the storage keeps no bytes for it. */
async function readEntryHtml(site: SiteRow, route: ReleaseRoute, storageOverride?: PageObjectStorage): Promise<string | null> {
  const storage = storageOverride ?? createPageObjectStorageFromEnv();
  if (!storage.readObjectText) return null;
  const [file] = await db
    .select({ storageJson: schema.assets.storageJson })
    .from(schema.assets)
    .where(and(eq(schema.assets.artifactVersionId, route.artifactVersionId), eq(schema.assets.path, route.entrypoint)))
    .limit(1);
  const key = (file ? readR2Key(file.storageJson) : null) ?? entryObjectKey(site, route);
  return storage.readObjectText({ key, maxBytes: ENTRY_MAX_BYTES });
}

async function revokeRemovedPaths(input: { site: SiteRow; paths: ReadonlySet<string>; requestId: string }, deps: ReleaseCaptureDeps) {
  const prefix = pageOriginKey(input.site.id, "");
  const sources = await db
    .select({ originKey: schema.knowledgeSources.originKey, sourceRefJson: schema.knowledgeSources.sourceRefJson })
    .from(schema.knowledgeSources)
    .where(
      and(
        eq(schema.knowledgeSources.organizationId, input.site.organizationId),
        like(schema.knowledgeSources.originKey, `${prefix}%`),
        eq(schema.knowledgeSources.status, "active"),
      ),
    );
  const removed = sources.filter((source) => source.originKey && !input.paths.has(source.originKey.slice(prefix.length)));
  if (removed.length === 0) return;

  const routeIds = new Map<string, string>();
  const paths = removed.map((source) => source.originKey!.slice(prefix.length));
  for (const route of await db
    .select({ id: schema.pageRoutes.id, path: schema.pageRoutes.path })
    .from(schema.pageRoutes)
    .where(and(eq(schema.pageRoutes.siteId, input.site.id), inArray(schema.pageRoutes.path, paths)))) {
    routeIds.set(route.path, route.id);
  }
  for (const source of removed) {
    const path = source.originKey!.slice(prefix.length);
    await revokeKnowledgeSourceByOrigin({
      organizationId: input.site.organizationId,
      originKey: source.originKey!,
      reason: "route_removed",
      requestId: input.requestId,
    });
    const recorded = typeof source.sourceRefJson.routeId === "string" ? source.sourceRefJson.routeId : null;
    for (const routeId of new Set([recorded, routeIds.get(path)].filter((id): id is string => Boolean(id)))) {
      await (deps.suspendMark ?? suspendRouteMark)({ routeId, reason: "route_removed", requestId: input.requestId });
    }
  }
}

function isCapturedRoute(route: Pick<ReleaseRoute, "matchType" | "entrypoint">) {
  return CAPTURED_MATCH_TYPES.has(route.matchType) && isPageReadHtmlPath(route.entrypoint);
}

/**
 * The release's captured routes. One path is one origin key, so when an exact
 * and an spa route share a path only the exact one is captured.
 */
export function capturedRoutes<T extends Pick<ReleaseRoute, "matchType" | "entrypoint" | "path">>(routes: readonly T[]): T[] {
  const captured = routes.filter(isCapturedRoute);
  const exactPaths = new Set(captured.filter((route) => route.matchType === "exact").map((route) => route.path));
  return captured.filter((route) => route.matchType === "exact" || !exactPaths.has(route.path));
}

function pageSourceRef(site: SiteRow, route: Pick<ReleaseRoute, "routeId" | "path">, releaseId: string) {
  return { siteId: site.id, routeId: route.routeId, path: route.path, host: site.defaultHostname, releaseId };
}

/** Where publish stores a file when its row carries no key (same layout as publish.ts). */
function entryObjectKey(site: SiteRow, route: ReleaseRoute) {
  return `org/${site.organizationId}/project/${site.projectId}/artifact/${route.artifactId}/version/${route.artifactVersionId}/${route.entrypoint}`;
}

type HtmlHeading = { level: number; folded: string; id: string | null };

type Section = { headingPath: string[]; heading: string | null; body: string[] };

/**
 * Sections at h1–h3 (`h:` + the heading path joined by `>`), each over 1200
 * chars split at paragraphs into `#2`, `#3`…; the anchor is the heading's `id`
 * in the HTML, else a `:~:text=` fragment of its first six words.
 */
export function buildPageChunks(input: {
  markdown: string;
  headings: readonly HtmlHeading[];
  location: { kind: "page"; siteId: string; routeId: string; host: string; path: string; recordedAt: string };
  baseViews: readonly string[];
}): ProducerChunkInput[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let current: Section = { headingPath: [], heading: null, body: [] };
  for (const line of input.markdown.split("\n")) {
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      sections.push(current);
      const level = match[1]!.length;
      const text = neutralizeKnowledgeText(match[2]!).replace(/\s+/g, " ").trim();
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, text });
      current = { headingPath: stack.map((entry) => entry.text), heading: text, body: [] };
    } else current.body.push(line);
  }
  sections.push(current);

  const used = new Set<number>();
  const chunks: ProducerChunkInput[] = [];
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    if (!body && !section.heading) continue;
    const text = neutralizeKnowledgeText([section.heading, body].filter(Boolean).join("\n\n")).trim();
    if (!text) continue;
    const anchor = section.heading ? headingAnchor(section.heading, input.headings, used) : null;
    const stableKey = `h:${section.headingPath.join(">")}`;
    splitSection(text).forEach((piece, index) => {
      chunks.push({
        stableKey: index === 0 ? stableKey : `${stableKey}#${index + 1}`,
        text: piece,
        heading: section.heading,
        location: { ...input.location, anchor, headingPath: section.headingPath },
        metadata: { baseViews: [...input.baseViews] },
      });
    });
  }
  return chunks;
}

function splitSection(text: string): string[] {
  if (text.length <= SECTION_MAX_CHARS) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).flatMap((part) => splitAtSentences(part.trim(), SECTION_MAX_CHARS))) {
    if (!paragraph) continue;
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > SECTION_MAX_CHARS && current) {
      pieces.push(current);
      current = paragraph;
    } else current = next;
  }
  if (current) pieces.push(current);
  return pieces;
}

function headingAnchor(heading: string, headings: readonly HtmlHeading[], used: Set<number>): string {
  const folded = foldKnowledgeText(heading);
  const index = headings.findIndex((candidate, at) => !used.has(at) && candidate.folded === folded);
  if (index >= 0) {
    used.add(index);
    const id = headings[index]!.id;
    if (id) return id;
  }
  const words = heading.replace(/&lt;/g, "<").replace(/&gt;/g, ">").split(/\s+/).filter(Boolean).slice(0, ANCHOR_WORDS).join(" ");
  return `:~:text=${encodeURIComponent(words)}`;
}

type DomNode = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: DomNode[] };

/** h1–h3 in document order, with their `id` when they carry a safe one. */
export function htmlHeadings(html: string): HtmlHeading[] {
  const headings: HtmlHeading[] = [];
  walk(parseDocument(html, { decodeEntities: true, lowerCaseTags: true }) as unknown as DomNode, (node) => {
    const level = /^h([1-3])$/.exec(node.name ?? "")?.[1];
    if (!level) return;
    const id = node.attribs?.id?.trim() ?? "";
    headings.push({
      level: Number(level),
      folded: foldKnowledgeText(textOf(node)),
      id: /^[A-Za-z][\w:.-]{0,127}$/.test(id) ? id : null,
    });
  });
  return headings;
}

/** View ids from `<ravi-view view="…">` and `[data-ravi-view]`, unique, in page order. */
export function pageBaseViews(html: string): string[] {
  const views = new Set<string>();
  walk(parseDocument(html, { decodeEntities: true, lowerCaseTags: true }) as unknown as DomNode, (node) => {
    const candidates = [node.name === "ravi-view" ? node.attribs?.view : undefined, node.attribs?.["data-ravi-view"]];
    for (const value of candidates) {
      const view = value?.trim();
      if (view && /^[A-Za-z0-9_.:-]{1,200}$/.test(view)) views.add(view);
    }
  });
  return [...views].slice(0, 20);
}

function walk(node: DomNode, visit: (node: DomNode) => void) {
  if (node.type === "tag" || node.type === "script" || node.type === "style") visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  return (node.children ?? []).map(textOf).join(" ");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
