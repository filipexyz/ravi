import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import { recordKnowledgeMarksChanged } from "./inbox";

// Route marks live in `page_routes.route_config_json.knowledge`, and only this
// module reads or writes them. The release copy (`page_release_routes`) never
// carries the key: anything holding a release row looks the mark up by
// `route_id` with `readActiveRouteMark`.

export const KNOWLEDGE_ROUTE_CONFIG_KEY = "knowledge";

const contactsAudienceSchema = z.object({
  kind: z.literal("contacts"),
  localInstallationId: z.string().uuid(),
  instanceId: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  label: z.string().max(200),
});
const pageViewersAudienceSchema = z.object({ kind: z.literal("page_viewers") });
const audienceSchema = z.discriminatedUnion("kind", [contactsAudienceSchema, pageViewersAudienceSchema]);

const routeMarkSchema = z.object({
  v: z.literal(1),
  state: z.enum(["active", "suspended"]),
  audiences: z.array(audienceSchema).max(100),
  approvedDocumentId: z.string().uuid(),
  approvedVersion: z.number().int().positive(),
  approvedContentHash: z.string(),
  approvedHtmlSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  approvedBy: z.string(),
  approvedAt: z.string(),
  managedBy: z.enum(["web", "faq"]),
  faqHtmlSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  suspendedAt: z.string().nullable(),
  suspendedReason: z.enum(["new_version", "route_removed"]).nullable(),
});

export type KnowledgeRouteMarkV1 = {
  v: 1;
  state: "active" | "suspended";
  audiences: Array<
    | { kind: "contacts"; localInstallationId: string; instanceId: string; label: string }
    | { kind: "page_viewers" }
  >;
  /** knowledge_documents.id the mark is pinned to. */
  approvedDocumentId: string;
  /** Its version_number. */
  approvedVersion: number;
  /** Its content_hash. */
  approvedContentHash: string;
  /**
   * sha256 hex of the entry HTML that document was captured from: the bytes
   * the mark approves. Any other bytes served at the route suspend the mark.
   * Absent on marks written before it existed (such a mark suspends on the next release).
   */
  approvedHtmlSha256?: string | null;
  /** users.id */
  approvedBy: string;
  /** ISO */
  approvedAt: string;
  /** "faq": the Console's own /faq route, re-pinned on each FAQ write. */
  managedBy: "web" | "faq";
  /** "faq" only: sha256 hex of the index.html the Console rendered; null for "web". */
  faqHtmlSha256: string | null;
  suspendedAt: string | null;
  suspendedReason: "new_version" | "route_removed" | null;
};

export type KnowledgeRouteMark = KnowledgeRouteMarkV1;
export type KnowledgeMarkAudience = KnowledgeRouteMarkV1["audiences"][number];

export type MarkedRoute = {
  routeId: string;
  siteId: string;
  projectId: string;
  organizationId: string;
  host: string;
  path: string;
  title: string | null;
  mark: KnowledgeRouteMark;
};

type RecordMarksChanged = (input: { organizationId: string; routeId: string; action: string }) => Promise<void>;
type MarkDeps = { recordMarksChanged?: RecordMarksChanged };

const READABLE_DOCUMENT_STATUSES = ["chunked", "indexed"] as const;

/** The mark inside a route's `route_config_json`, validated; anything invalid is "no mark". Pure. */
export function readRouteMark(routeConfigJson: unknown): KnowledgeRouteMark | null {
  let config = routeConfigJson;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      return null;
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const parsed = routeMarkSchema.safeParse((config as Record<string, unknown>)[KNOWLEDGE_ROUTE_CONFIG_KEY]);
  return parsed.success ? (parsed.data as KnowledgeRouteMark) : null;
}

/** The route's mark when it is `active`, read from `page_routes` (never a release copy). */
export async function readActiveRouteMark(routeId: string, database: typeof db = db): Promise<KnowledgeRouteMark | null> {
  if (!isUuid(routeId)) return null;
  const [route] = await database
    .select({ routeConfigJson: schema.pageRoutes.routeConfigJson })
    .from(schema.pageRoutes)
    .where(eq(schema.pageRoutes.id, routeId))
    .limit(1);
  const mark = readRouteMark(route?.routeConfigJson);
  return mark?.state === "active" ? mark : null;
}

/** Drops the reserved `knowledge` key from caller-supplied route config, so publish can never write a mark. */
export function stripReservedRouteConfig(
  routeConfigJson: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!routeConfigJson) return routeConfigJson;
  if (!Object.prototype.hasOwnProperty.call(routeConfigJson, KNOWLEDGE_ROUTE_CONFIG_KEY)) return routeConfigJson;
  const { [KNOWLEDGE_ROUTE_CONFIG_KEY]: _reserved, ...rest } = routeConfigJson;
  return rest;
}

export async function listMarkedRoutes(
  input: {
    organizationId: string;
    siteId?: string;
    projectId?: string;
    audience?: { kind: "page_viewers" } | { kind: "contacts"; localInstallationId: string; instanceId?: string };
    state?: "active" | "suspended" | "any";
  },
  database: typeof db = db,
): Promise<MarkedRoute[]> {
  const conditions: SQL[] = [
    eq(schema.pageRoutes.organizationId, input.organizationId),
    sql`${schema.pageRoutes.routeConfigJson} ? ${KNOWLEDGE_ROUTE_CONFIG_KEY}`,
  ];
  if (input.siteId) conditions.push(eq(schema.pageRoutes.siteId, input.siteId));
  if (input.projectId) conditions.push(eq(schema.pageRoutes.projectId, input.projectId));

  const rows = await database
    .select({
      routeId: schema.pageRoutes.id,
      siteId: schema.pageRoutes.siteId,
      projectId: schema.pageRoutes.projectId,
      organizationId: schema.pageRoutes.organizationId,
      path: schema.pageRoutes.path,
      routeConfigJson: schema.pageRoutes.routeConfigJson,
      host: schema.pageSites.defaultHostname,
    })
    .from(schema.pageRoutes)
    .innerJoin(schema.pageSites, eq(schema.pageRoutes.siteId, schema.pageSites.id))
    .where(and(...conditions))
    .orderBy(schema.pageRoutes.path);

  const state = input.state ?? "active";
  const marked = rows.flatMap((row) => {
    const mark = readRouteMark(row.routeConfigJson);
    if (!mark) return [];
    if (state !== "any" && mark.state !== state) return [];
    if (input.audience && !markHasAudience(mark, input.audience)) return [];
    return [{ ...row, mark }];
  });
  if (marked.length === 0) return [];

  const documentIds = [...new Set(marked.map((row) => row.mark.approvedDocumentId))];
  const titles = await database
    .select({ id: schema.knowledgeDocuments.id, title: schema.knowledgeDocuments.title })
    .from(schema.knowledgeDocuments)
    .where(
      and(
        eq(schema.knowledgeDocuments.organizationId, input.organizationId),
        inArray(schema.knowledgeDocuments.id, documentIds),
      ),
    );
  const titleById = new Map(titles.map((row) => [row.id, row.title]));
  return marked.map((row) => ({
    routeId: row.routeId,
    siteId: row.siteId,
    projectId: row.projectId,
    organizationId: row.organizationId,
    host: row.host,
    path: row.path,
    title: titleById.get(row.mark.approvedDocumentId) ?? null,
    mark: row.mark,
  }));
}

/**
 * Marks, re-approves or unmarks a route. Marking pins the route's current
 * knowledge document (id, version, content hash, entry HTML hash). With
 * `expectedDocumentId` (the version the person reviewed, or the one /faq just
 * captured) a newer current document is 409 `knowledge_mark_stale`, so a mark
 * never approves text nobody saw. Callers: the web card routes and the /faq
 * writer (`managedBy: "faq"`, with the rendered page's hash).
 */
export async function writeRouteMark(
  input: {
    routeId: string;
    action: "mark" | "reapprove" | "unmark";
    audiences: KnowledgeMarkAudience[];
    actorUserId: string;
    managedBy?: "web" | "faq";
    faqHtmlSha256?: string | null;
    expectedDocumentId?: string | null;
    requestId: string;
  },
  database: typeof db = db,
  deps: MarkDeps = {},
): Promise<{ mark: KnowledgeRouteMark | null }> {
  const managedBy = input.managedBy ?? "web";
  const faqHtmlSha256 = managedBy === "faq" ? (input.faqHtmlSha256 ?? null) : null;
  if (managedBy === "faq" && !faqHtmlSha256?.match(/^[a-f0-9]{64}$/)) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { faqHtmlSha256: "Required for /faq marks." } });
  }
  const audiences = parseAudiences(input.audiences);

  const outcome = await database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge_mark:${input.routeId}`}))`);
    const route = await loadRoute(tx, input.routeId);
    if (!route) throw new ConsoleApiError(404, { error: "page_route_not_found" });

    if (input.action === "unmark") {
      await tx
        .update(schema.pageRoutes)
        .set({ routeConfigJson: sql`coalesce(${schema.pageRoutes.routeConfigJson}, '{}'::jsonb) - ${KNOWLEDGE_ROUTE_CONFIG_KEY}::text`, updatedAt: new Date() })
        .where(eq(schema.pageRoutes.id, route.id));
      await insertMarkAudit(tx, route, "unmarked", { actorType: "user", actorId: input.actorUserId, requestId: input.requestId, documentId: null });
      return { route, mark: null };
    }

    const document = await currentRouteDocument(tx, route);
    if (!document) throw new ConsoleApiError(409, { error: "knowledge_route_not_captured" });
    if (input.expectedDocumentId && input.expectedDocumentId !== document.id) {
      throw new ConsoleApiError(409, { error: "knowledge_mark_stale" });
    }
    const htmlSha256 = document.sourceLocationJson?.htmlSha256;
    const mark: KnowledgeRouteMark = {
      v: 1,
      state: "active",
      audiences,
      approvedDocumentId: document.id,
      approvedVersion: document.versionNumber,
      approvedContentHash: document.contentHash ?? "",
      approvedHtmlSha256: typeof htmlSha256 === "string" && /^[a-f0-9]{64}$/.test(htmlSha256) ? htmlSha256 : null,
      approvedBy: input.actorUserId,
      approvedAt: new Date().toISOString(),
      managedBy,
      faqHtmlSha256,
      suspendedAt: null,
      suspendedReason: null,
    };
    await writeMark(tx, route.id, mark);
    await insertMarkAudit(tx, route, input.action === "mark" ? "marked" : "reapproved", {
      actorType: "user",
      actorId: input.actorUserId,
      requestId: input.requestId,
      documentId: document.id,
      extra: { versionNumber: document.versionNumber, managedBy, audienceCount: audiences.length },
    });
    return { route, mark };
  });

  await notifyMarksChanged(deps, { organizationId: outcome.route.organizationId, routeId: outcome.route.id, action: input.action });
  return { mark: outcome.mark };
}

/** Suspends an active mark (a new version was captured, or the route left the active release). */
export async function suspendRouteMark(
  input: { routeId: string; reason: "new_version" | "route_removed"; requestId: string },
  database: typeof db = db,
  deps: MarkDeps = {},
): Promise<boolean> {
  if (!isUuid(input.routeId)) return false;
  const outcome = await database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge_mark:${input.routeId}`}))`);
    const route = await loadRoute(tx, input.routeId);
    if (!route) return null;
    const mark = readRouteMark(route.routeConfigJson);
    if (!mark || mark.state !== "active") return null;
    const suspended: KnowledgeRouteMark = {
      ...mark,
      state: "suspended",
      suspendedAt: new Date().toISOString(),
      suspendedReason: input.reason,
    };
    await writeMark(tx, route.id, suspended);
    await insertMarkAudit(tx, route, "suspended", {
      actorType: "system",
      actorId: null,
      requestId: input.requestId,
      documentId: mark.approvedDocumentId,
      extra: { reason: input.reason },
    });
    return route;
  });
  if (!outcome) return false;
  await notifyMarksChanged(deps, { organizationId: outcome.organizationId, routeId: outcome.id, action: "suspend" });
  return true;
}

/** True when the mark lists the audience (for contacts, the installation and, when given, the instance). */
export function markHasAudience(
  mark: KnowledgeRouteMark,
  audience: { kind: "page_viewers" } | { kind: "contacts"; localInstallationId: string; instanceId?: string },
): boolean {
  return mark.audiences.some((item) => {
    if (audience.kind === "page_viewers") return item.kind === "page_viewers";
    return (
      item.kind === "contacts" &&
      item.localInstallationId === audience.localInstallationId &&
      (audience.instanceId === undefined || item.instanceId === audience.instanceId)
    );
  });
}

type RouteRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  path: string;
  routeConfigJson: Record<string, unknown>;
};

async function loadRoute(tx: Pick<typeof db, "select">, routeId: string): Promise<RouteRecord | null> {
  if (!isUuid(routeId)) return null;
  const [route] = await tx
    .select({
      id: schema.pageRoutes.id,
      organizationId: schema.pageRoutes.organizationId,
      projectId: schema.pageRoutes.projectId,
      siteId: schema.pageRoutes.siteId,
      path: schema.pageRoutes.path,
      routeConfigJson: schema.pageRoutes.routeConfigJson,
    })
    .from(schema.pageRoutes)
    .where(eq(schema.pageRoutes.id, routeId))
    .limit(1);
  return route ?? null;
}

async function currentRouteDocument(tx: Pick<typeof db, "select">, route: RouteRecord) {
  const [document] = await tx
    .select({
      id: schema.knowledgeDocuments.id,
      versionNumber: schema.knowledgeDocuments.versionNumber,
      contentHash: schema.knowledgeDocuments.contentHash,
      sourceLocationJson: schema.knowledgeDocuments.sourceLocationJson,
    })
    .from(schema.knowledgeDocuments)
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeDocuments.sourceId, schema.knowledgeSources.id))
    .where(
      and(
        eq(schema.knowledgeSources.organizationId, route.organizationId),
        eq(schema.knowledgeSources.originKey, `page:${route.siteId}:${route.path}`),
        eq(schema.knowledgeSources.status, "active"),
        inArray(schema.knowledgeDocuments.status, [...READABLE_DOCUMENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.knowledgeDocuments.versionNumber))
    .limit(1);
  return document ?? null;
}

async function writeMark(tx: Pick<typeof db, "update">, routeId: string, mark: KnowledgeRouteMark) {
  await tx
    .update(schema.pageRoutes)
    .set({
      routeConfigJson: sql`jsonb_set(coalesce(${schema.pageRoutes.routeConfigJson}, '{}'::jsonb), ${`{${KNOWLEDGE_ROUTE_CONFIG_KEY}}`}::text[], ${JSON.stringify(mark)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.pageRoutes.id, routeId));
}

async function insertMarkAudit(
  tx: Pick<typeof db, "insert">,
  route: RouteRecord,
  verb: "marked" | "reapproved" | "unmarked" | "suspended",
  input: { actorType: "user" | "system"; actorId: string | null; requestId: string; documentId: string | null; extra?: Record<string, unknown> },
) {
  await tx.insert(schema.auditEvents).values({
    organizationId: route.organizationId,
    projectId: route.projectId,
    actorType: input.actorType,
    actorId: input.actorId,
    targetType: "page_route",
    targetId: route.id,
    action: `knowledge.route_mark.${verb}`,
    requestId: input.requestId,
    metadataJson: { routeId: route.id, siteId: route.siteId, documentId: input.documentId, ...input.extra },
  });
}

async function notifyMarksChanged(deps: MarkDeps, input: { organizationId: string; routeId: string; action: string }) {
  const record = deps.recordMarksChanged ?? ((value) => recordKnowledgeMarksChanged(value));
  try {
    await record(input);
  } catch {
    // The mark is committed; the inbox item is a notification and never undoes it.
    console.warn("[knowledge] marks-changed inbox item was not recorded", { routeId: input.routeId, action: input.action });
  }
}

function parseAudiences(audiences: readonly KnowledgeMarkAudience[]): KnowledgeMarkAudience[] {
  const parsed = z.array(audienceSchema).max(100).safeParse(audiences);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { audiences: "Invalid audience." } });
  }
  const seen = new Set<string>();
  return parsed.data.filter((audience) => {
    const key = audience.kind === "page_viewers" ? "page_viewers" : `contacts:${audience.localInstallationId}:${audience.instanceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
