import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { writeRouteMark, type KnowledgeMarkAudience } from "@/server/console/knowledge/marks";
import { ingestForProducer } from "@/server/console/knowledge/producer";
import { writeKnowledgeRun } from "@/server/console/knowledge/retrieval-core";
import { db, schema } from "@/server/db";

import type { PagesConnectorSite } from "./host";
import { searchMarkedPagesForViewer, type PageChatViewer } from "./knowledge-search";

// `ravi.knowledge.search` against Postgres: only this site's routes marked for
// page viewers, at the pinned version, filtered by the guest's grants; one run
// (audience page_viewer, no text) and one usage event per search. Runs only
// with KNOWLEDGE_TEST_DATABASE_URL (and DATABASE_URL) pointing at a database
// with the current schema; creates and deletes its own fixtures.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const otherSiteId = randomUUID();
const host = `ks-${suffix}.ravi.page`;
const owner = { id: randomUUID(), email: `knowledge-search-owner-${suffix}@example.test` };
const guestUser = { id: randomUUID(), email: `knowledge-search-guest-${suffix}@example.test` };
const strangerUser = { id: randomUUID(), email: `knowledge-search-stranger-${suffix}@example.test` };
const installation = randomUUID();
const routes = {
  trocas: randomUUID(),
  entrega: randomUUID(),
  interno: randomUUID(),
  contatos: randomUUID(),
  outroSite: randomUUID(),
};

const site: PagesConnectorSite = {
  id: siteId,
  organizationId: orgId,
  projectId,
  defaultHostname: host,
  defaultVisibility: "private",
  status: "active",
  activeReleaseId: null,
};

const member: PageChatViewer = {
  kind: "member",
  userId: owner.id,
  workspace: { user: { id: owner.id }, organization: { id: orgId }, membership: { role: "owner" } },
};
const guest: PageChatViewer = { kind: "guest", userId: guestUser.id };
const stranger: PageChatViewer = { kind: "guest", userId: strangerUser.id };

const noInbox = { recordMarksChanged: async () => {} };

async function capture(input: { siteId?: string; path: string; heading: string; text: string }) {
  const sid = input.siteId ?? siteId;
  const result = await ingestForProducer({
    organizationId: orgId,
    projectId,
    originKey: `page:${sid}:${input.path}`,
    sourceType: "ravi_page",
    trustTier: "published",
    title: input.path,
    sourceRef: { siteId: sid, path: input.path, host },
    document: {
      title: input.path,
      mimeType: "text/html",
      parserVersion: "knowledge-page-v1",
      contentHash: createHash("sha256").update(input.text).digest("hex"),
      sizeBytes: input.text.length,
    },
    chunks: [
      {
        stableKey: `h:${input.heading}`,
        heading: input.heading,
        text: input.text,
        location: { kind: "page", siteId: sid, host, path: input.path, anchor: "prazo", headingPath: [input.heading] },
      },
    ],
    actor: { type: "system", id: null },
    triggerType: "page_release",
    requestId: "req_capture",
  });
  if (result.status !== "ingested") throw new Error(`expected ingested, got ${result.status}`);
  return result;
}

async function mark(routeId: string, audiences: KnowledgeMarkAudience[] = [{ kind: "page_viewers" }]) {
  await writeRouteMark({ routeId, action: "mark", audiences, actorUserId: owner.id, requestId: "req_mark" }, db, noInbox);
}

// Records each run id so the test can find its rows.
function tracked() {
  const runIds: string[] = [];
  return {
    runIds,
    deps: {
      writeRun: async (input: Parameters<typeof writeKnowledgeRun>[0]) => {
        const result = await writeKnowledgeRun(input);
        runIds.push(result.runId);
        return result;
      },
    },
  };
}

async function pageViewerRunCount() {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(schema.knowledgeRetrievalRuns)
    .where(and(eq(schema.knowledgeRetrievalRuns.organizationId, orgId), eq(schema.knowledgeRetrievalRuns.audience, "page_viewer")));
  return Number(row?.count ?? 0);
}

const search = (viewer: PageChatViewer, query: string, deps = {}) =>
  searchMarkedPagesForViewer({ site, viewer, query, limit: 5, requestId: `req_${randomUUID().slice(0, 8)}` }, deps);

describeDb("ravi.knowledge.search (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: owner.id, primaryEmail: owner.email, displayName: "owner" },
      { id: guestUser.id, primaryEmail: guestUser.email, displayName: "guest" },
      { id: strangerUser.id, primaryEmail: strangerUser.email, displayName: "stranger" },
    ]);
    await db.insert(schema.organizations).values([{ id: orgId, slug: `knowledge-search-${suffix}`, name: "Knowledge search" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: orgId, userId: owner.id, role: "owner" }]);
    await db.insert(schema.projects).values([{ id: projectId, organizationId: orgId, slug: `ks-${suffix}`, name: "KS" }]);
    await db.insert(schema.localInstallations).values([{ id: installation, organizationId: orgId, userId: owner.id, name: "laptop" }]);
    await db.insert(schema.pageSites).values([
      { id: siteId, organizationId: orgId, projectId, slug: `ks-${suffix}`, defaultHostname: host, defaultVisibility: "private" },
      {
        id: otherSiteId,
        organizationId: orgId,
        projectId,
        slug: `ks-other-${suffix}`,
        defaultHostname: `ks-other-${suffix}.ravi.page`,
        defaultVisibility: "private",
      },
    ]);
    await db.insert(schema.pageRoutes).values([
      { id: routes.trocas, organizationId: orgId, projectId, siteId, path: "/trocas", matchType: "spa" },
      { id: routes.entrega, organizationId: orgId, projectId, siteId, path: "/entrega", matchType: "spa" },
      { id: routes.interno, organizationId: orgId, projectId, siteId, path: "/interno", matchType: "spa" },
      { id: routes.contatos, organizationId: orgId, projectId, siteId, path: "/contatos", matchType: "spa" },
      { id: routes.outroSite, organizationId: orgId, projectId, siteId: otherSiteId, path: "/trocas", matchType: "spa" },
    ]);
    // The guest was given /entrega only; the stranger was given nothing.
    await db.insert(schema.accessGrants).values([
      {
        organizationId: orgId,
        projectId,
        pageSiteId: siteId,
        objectType: "page_route",
        objectId: routes.entrega,
        subjectId: guestUser.id,
        createdByActorId: owner.id,
      },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.id, guestUser.id, strangerUser.id]));
  });

  test("no marked pages gives no_marked_pages and writes no run", async () => {
    await capture({ path: "/trocas", heading: "Prazo", text: "Trocas aceitas em até sete dias corridos com nota fiscal." });
    expect(await search(member, "trocas")).toEqual({ results: [], issues: ["no_marked_pages"] });
    expect(await pageViewerRunCount()).toBe(0);
  });

  test("returns only page_viewers-marked routes of this site, at the pinned version", async () => {
    await mark(routes.trocas);
    await capture({ path: "/entrega", heading: "Entrega", text: "Entrega expressa para capitais em dois dias úteis." });
    await mark(routes.entrega);
    // Captured but never marked, marked for contacts only, and marked on another site.
    await capture({ path: "/interno", heading: "Cofre", text: "Trocas internas: senha do cofre fica com o gerente." });
    await capture({ path: "/contatos", heading: "Contatos", text: "Trocas por WhatsApp somente para clientes." });
    await mark(routes.contatos, [{ kind: "contacts", localInstallationId: installation, instanceId: "wa-main", label: "WhatsApp" }]);
    await capture({ siteId: otherSiteId, path: "/trocas", heading: "Prazo", text: "Trocas no outro site em trinta dias." });
    await mark(routes.outroSite);

    const result = await search(member, "trocas");
    expect(result.results).toEqual([
      {
        path: "/trocas",
        url: `https://${host}/trocas#prazo`,
        anchor: "prazo",
        heading: "Prazo",
        text: "Trocas aceitas em até sete dias corridos com nota fiscal.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("cofre");
    expect(JSON.stringify(result)).not.toContain("WhatsApp");
    expect(JSON.stringify(result)).not.toContain("trinta");

    // A newer version nobody approved: its new text is not returned, the pinned text still is.
    await capture({ path: "/trocas", heading: "Prazo", text: "Trocas aceitas em até sete dias. Garantia estendida de um ano." });
    expect((await search(member, "garantia estendida")).results).toEqual([]);
    const pinned = await search(member, "trocas sete dias");
    expect(pinned.results[0]?.text).toBe("Trocas aceitas em até sete dias corridos com nota fiscal.");
    expect(JSON.stringify(pinned)).not.toContain("Garantia");
  });

  test("a guest gets only the marked routes canUserViewPagesRoute allows", async () => {
    expect((await search(guest, "trocas")).results).toEqual([]);
    const entrega = await search(guest, "entrega expressa");
    expect(entrega.results.map((item) => item.path)).toEqual(["/entrega"]);
    expect(await search(stranger, "entrega")).toEqual({ results: [], issues: ["no_marked_pages"] });
  });

  test("one run with audience page_viewer and no text, and one usage event", async () => {
    const before = await pageViewerRunCount();
    const { runIds, deps } = tracked();
    const result = await search(guest, "entrega expressa capitais", deps);
    expect(result.results).toHaveLength(1);
    expect(await pageViewerRunCount()).toBe(before + 1);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0]!;

    const [run] = await db.select().from(schema.knowledgeRetrievalRuns).where(eq(schema.knowledgeRetrievalRuns.id, runId));
    expect(run).toMatchObject({
      audience: "page_viewer",
      status: "completed",
      actorType: "user",
      actorId: guestUser.id,
      queryText: null,
      normalizedQuery: null,
      queryHash: null,
      returnedChunkCount: 1,
    });
    expect(run?.callerJson).toMatchObject({ surface: "page_chat", viewer: "guest", siteId });
    const runText = JSON.stringify(run);
    for (const word of ["entrega", "expressa", "capitais"]) expect(runText.toLowerCase()).not.toContain(word);

    const citations = await db
      .select()
      .from(schema.knowledgeCitations)
      .where(eq(schema.knowledgeCitations.retrievalRunId, runId));
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ excerpt: null, trustTier: "published", documentVersion: 1 });
    expect(JSON.stringify(citations).toLowerCase()).not.toContain("capitais");

    const events = await db
      .select()
      .from(schema.usageEvents)
      .where(
        and(
          eq(schema.usageEvents.organizationId, orgId),
          eq(schema.usageEvents.idempotencyKey, `knowledge.page_chat_search:${runId}:knowledge.page_chat_searches`),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "knowledge",
      metricKey: "knowledge.page_chat_searches",
      eventType: "knowledge.page_chat_search",
    });
    expect(Number(events[0]?.quantity)).toBe(1);
    const [total] = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.organizationId, orgId), eq(schema.usageEvents.metricKey, "knowledge.page_chat_searches")));
    expect(Number(total?.count)).toBe(await pageViewerRunCount());
  });
});
