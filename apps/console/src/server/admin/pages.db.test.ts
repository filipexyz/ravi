import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ingestForProducer } from "@/server/console/knowledge/producer";
import { db, schema } from "@/server/db";

import { moveAdminPageSite } from "./pages";

// Moving a Pages site to another owner takes its knowledge with it nowhere:
// the old owner's `page:<siteId>:*` content is deleted, the sources are left
// `revoked` (so the next capture revives them for the new owner) and the route
// marks that pinned the documents are removed. Making a site the default of its
// own project changes nothing. Runs only with KNOWLEDGE_TEST_DATABASE_URL (and
// DATABASE_URL) set.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const sourceOrg = randomUUID();
const sourceProject = randomUUID();
const targetOrg = randomUUID();
const targetProject = randomUUID();
const siblingProject = randomUUID();
const siteId = randomUUID();
const localSiteId = randomUUID();
const localRouteId = randomUUID();
const otherSiteId = randomUUID();
const routeId = randomUUID();
const otherRouteId = randomUUID();
const host = `move-${suffix}.ravi.page`;

async function capture(site: string, path: string, text: string, projectId = sourceProject) {
  const result = await ingestForProducer({
    organizationId: sourceOrg,
    projectId,
    originKey: `page:${site}:${path}`,
    sourceType: "ravi_page",
    trustTier: "published",
    title: path,
    sourceRef: { siteId: site, path },
    document: {
      title: path,
      mimeType: "text/html",
      parserVersion: "knowledge-page-v1",
      contentHash: createHash("sha256").update(text).digest("hex"),
      sizeBytes: text.length,
    },
    chunks: [{ stableKey: "h:", text, location: { kind: "page", siteId: site, path } }],
    actor: { type: "system", id: null },
    triggerType: "page_release",
    requestId: "req",
  });
  if (result.status !== "ingested") throw new Error(`expected ingested, got ${result.status}`);
  return result;
}

describeDb("admin site move and Knowledge (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: sourceOrg, slug: `move-from-${suffix}`, name: "Move from" },
      { id: targetOrg, slug: `move-to-${suffix}`, name: "Move to" },
    ]);
    await db.insert(schema.projects).values([
      { id: sourceProject, organizationId: sourceOrg, slug: `from-${suffix}`, name: "From" },
      { id: siblingProject, organizationId: sourceOrg, slug: `sibling-${suffix}`, name: "Sibling" },
      { id: targetProject, organizationId: targetOrg, slug: `to-${suffix}`, name: "To" },
    ]);
    await db.insert(schema.pageSites).values([
      { id: siteId, organizationId: sourceOrg, projectId: sourceProject, slug: `move-${suffix}`, defaultHostname: host, defaultVisibility: "public" },
      { id: otherSiteId, organizationId: sourceOrg, projectId: sourceProject, slug: `stay-${suffix}`, defaultHostname: `stay-${suffix}.ravi.page`, defaultVisibility: "public" },
      { id: localSiteId, organizationId: sourceOrg, projectId: sourceProject, slug: `local-${suffix}`, defaultHostname: `local-${suffix}.ravi.page`, defaultVisibility: "public" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${sourceOrg}::uuid, ${targetOrg}::uuid)`);
  });

  test("making a site the default of its own project keeps its knowledge and marks", async () => {
    const page = await capture(localSiteId, "/ajuda", "Ajuda da loja");
    const mark = { v: 1, state: "active", approvedDocumentId: page.documentId };
    await db.insert(schema.pageRoutes).values([
      { id: localRouteId, organizationId: sourceOrg, projectId: sourceProject, siteId: localSiteId, path: "/ajuda", matchType: "spa", routeConfigJson: { knowledge: mark } },
    ]);

    const result = await moveAdminPageSite({
      body: { siteRef: localSiteId, targetOrganizationRef: sourceOrg, targetProjectRef: sourceProject, makeDefault: true, reason: "make default" },
      requestId: "req_default",
    });
    expect(result).toMatchObject({ status: "moved", site: { isDefault: true } });
    const [source] = await db.select({ status: schema.knowledgeSources.status }).from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, page.sourceId));
    expect(source?.status).toBe("active");
    const chunks = await db.select({ id: schema.knowledgeChunks.id }).from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.sourceId, page.sourceId));
    expect(chunks.length).toBe(1);
    const [route] = await db.select({ config: schema.pageRoutes.routeConfigJson }).from(schema.pageRoutes).where(eq(schema.pageRoutes.id, localRouteId));
    expect(route?.config).toEqual({ knowledge: mark });
  });

  test("moving a site to another project of the same organization revokes its content, and the next capture revives it there", async () => {
    const result = await moveAdminPageSite({
      body: { siteRef: localSiteId, targetOrganizationRef: sourceOrg, targetProjectRef: siblingProject, makeDefault: false, reason: "re-home" },
      requestId: "req_rehome",
    });
    expect(result).toMatchObject({ status: "moved" });
    const [source] = await db
      .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status })
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.organizationId, sourceOrg), eq(schema.knowledgeSources.originKey, `page:${localSiteId}:/ajuda`)));
    expect(source?.status).toBe("revoked");
    expect(await db.select({ id: schema.knowledgeChunks.id }).from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.sourceId, source!.id))).toEqual([]);
    const [route] = await db.select({ config: schema.pageRoutes.routeConfigJson }).from(schema.pageRoutes).where(eq(schema.pageRoutes.id, localRouteId));
    expect(route?.config).toEqual({});

    const recaptured = await capture(localSiteId, "/ajuda", "Ajuda da loja", siblingProject);
    expect(recaptured.sourceId).toBe(source!.id);
    const [revived] = await db
      .select({ status: schema.knowledgeSources.status, projectId: schema.knowledgeSources.projectId })
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, source!.id));
    expect(revived).toEqual({ status: "active", projectId: siblingProject });
  });

  test("moving a site to another organization removes its page knowledge in the old one and its marks", async () => {
    const moved = await capture(siteId, "/politica", "Trocas em até sete dias");
    const kept = await capture(otherSiteId, "/politica", "Outro site");
    const mark = { v: 1, state: "active", approvedDocumentId: moved.documentId };
    await db.insert(schema.pageRoutes).values([
      { id: routeId, organizationId: sourceOrg, projectId: sourceProject, siteId, path: "/politica", matchType: "spa", routeConfigJson: { theme: "dark", knowledge: mark } },
      { id: otherRouteId, organizationId: sourceOrg, projectId: sourceProject, siteId: otherSiteId, path: "/politica", matchType: "spa", routeConfigJson: { knowledge: mark } },
    ]);

    const result = await moveAdminPageSite({
      body: { siteRef: siteId, targetOrganizationRef: targetOrg, targetProjectRef: targetProject, reason: "test move" },
      requestId: "req_move",
    });
    expect(result).toMatchObject({ status: "moved" });

    const sources = await db
      .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status })
      .from(schema.knowledgeSources)
      .where(inArray(schema.knowledgeSources.id, [moved.sourceId, kept.sourceId]));
    // `revoked`, never `deleted`: only a person or retention deletes for good.
    expect(Object.fromEntries(sources.map((row) => [row.id, row.status]))).toEqual({ [moved.sourceId]: "revoked", [kept.sourceId]: "active" });
    const chunks = await db.select({ sourceId: schema.knowledgeChunks.sourceId }).from(schema.knowledgeChunks).where(inArray(schema.knowledgeChunks.sourceId, [moved.sourceId, kept.sourceId]));
    expect(chunks.map((chunk) => chunk.sourceId)).toEqual([kept.sourceId]);

    const [route] = await db.select().from(schema.pageRoutes).where(eq(schema.pageRoutes.id, routeId));
    expect(route).toMatchObject({ organizationId: targetOrg, projectId: targetProject, routeConfigJson: { theme: "dark" } });
    const [other] = await db.select({ config: schema.pageRoutes.routeConfigJson }).from(schema.pageRoutes).where(eq(schema.pageRoutes.id, otherRouteId));
    expect(other?.config).toEqual({ knowledge: mark });

    const audits = await db
      .select({ metadata: schema.auditEvents.metadataJson })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.organizationId, sourceOrg), eq(schema.auditEvents.requestId, "req_move")));
    expect(audits.some((audit) => JSON.stringify(audit.metadata).includes("site_moved"))).toBe(true);
  });
});
