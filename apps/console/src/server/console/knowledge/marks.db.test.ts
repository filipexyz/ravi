import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";

import {
  listMarkedRoutes,
  readActiveRouteMark,
  readRouteMark,
  suspendRouteMark,
  writeRouteMark,
  type KnowledgeMarkAudience,
} from "./marks";
import { ingestForProducer } from "./producer";

// Route marks against Postgres: pinning, unmarking, suspension, audit rows and
// the injected inbox call. Runs only with KNOWLEDGE_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a database with the current schema.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const host = `marks-${suffix}.ravi.page`;
const owner = { id: randomUUID(), email: `knowledge-marks-${suffix}@example.test` };
const installation = randomUUID();
const routes = { politica: randomUUID(), faq: randomUUID(), empty: randomUUID(), review: randomUUID() };

const AUDIENCES: KnowledgeMarkAudience[] = [
  { kind: "page_viewers" },
  { kind: "contacts", localInstallationId: installation, instanceId: "wa-main", label: "WhatsApp atendimento" },
];

function recorder() {
  const calls: Array<{ organizationId: string; routeId: string; action: string }> = [];
  return { calls, recordMarksChanged: async (input: { organizationId: string; routeId: string; action: string }) => void calls.push(input) };
}

async function capture(path: string, text: string, htmlSha256?: string) {
  const result = await ingestForProducer({
    organizationId: orgId,
    projectId,
    originKey: `page:${siteId}:${path}`,
    sourceType: "ravi_page",
    trustTier: "published",
    title: path,
    sourceRef: { siteId, path, host },
    document: {
      title: path,
      mimeType: "text/html",
      parserVersion: "knowledge-page-v1",
      contentHash: createHash("sha256").update(text).digest("hex"),
      sizeBytes: text.length,
      ...(htmlSha256 ? { sourceLocation: { kind: "page", siteId, path, htmlSha256 } } : {}),
    },
    chunks: [{ stableKey: "h:Trocas", heading: "Trocas", text, location: { kind: "page", siteId, host, path } }],
    actor: { type: "system", id: null },
    triggerType: "page_release",
    requestId: "req",
  });
  if (result.status !== "ingested") throw new Error(`expected ingested, got ${result.status}`);
  return result;
}

async function routeConfig(routeId: string) {
  const [row] = await db
    .select({ config: schema.pageRoutes.routeConfigJson })
    .from(schema.pageRoutes)
    .where(eq(schema.pageRoutes.id, routeId));
  return row?.config ?? null;
}

async function audits(routeId: string) {
  return db
    .select({ action: schema.auditEvents.action, metadata: schema.auditEvents.metadataJson })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.targetType, "page_route"), eq(schema.auditEvents.targetId, routeId)))
    .orderBy(schema.auditEvents.createdAt);
}

describeDb("knowledge route marks (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([{ id: owner.id, primaryEmail: owner.email, displayName: "owner" }]);
    await db.insert(schema.organizations).values([{ id: orgId, slug: `knowledge-marks-${suffix}`, name: "Knowledge marks" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: orgId, userId: owner.id, role: "owner" }]);
    await db.insert(schema.projects).values([{ id: projectId, organizationId: orgId, slug: `marks-${suffix}`, name: "Marks" }]);
    await db.insert(schema.localInstallations).values([{ id: installation, organizationId: orgId, userId: owner.id, name: "laptop" }]);
    await db.insert(schema.pageSites).values([
      { id: siteId, organizationId: orgId, projectId, slug: `marks-${suffix}`, defaultHostname: host, defaultVisibility: "public" },
    ]);
    await db.insert(schema.pageRoutes).values([
      { id: routes.politica, organizationId: orgId, projectId, siteId, path: "/politica", matchType: "spa", routeConfigJson: { theme: "dark" } },
      { id: routes.faq, organizationId: orgId, projectId, siteId, path: "/faq", matchType: "spa" },
      { id: routes.empty, organizationId: orgId, projectId, siteId, path: "/vazio", matchType: "spa" },
      { id: routes.review, organizationId: orgId, projectId, siteId, path: "/revisao", matchType: "spa" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.id]));
  });

  test("marking a route with no captured document is 409 knowledge_route_not_captured", async () => {
    const inbox = recorder();
    const error = await writeRouteMark(
      { routeId: routes.empty, action: "mark", audiences: AUDIENCES, actorUserId: owner.id, requestId: "req" },
      db,
      inbox,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).status).toBe(409);
    expect((error as ConsoleApiError).payload).toEqual({ error: "knowledge_route_not_captured" });
    expect(inbox.calls).toEqual([]);
    expect(await routeConfig(routes.empty)).toEqual({});
  });

  test("a mark pins the current document; reapprove re-pins; suspend and unmark", async () => {
    const v1 = await capture("/politica", "Trocas em até sete dias");
    const inbox = recorder();

    const { mark } = await writeRouteMark(
      { routeId: routes.politica, action: "mark", audiences: AUDIENCES, actorUserId: owner.id, requestId: "req" },
      db,
      inbox,
    );
    expect(mark).toMatchObject({
      v: 1,
      state: "active",
      approvedDocumentId: v1.documentId,
      approvedVersion: 1,
      approvedContentHash: createHash("sha256").update("Trocas em até sete dias").digest("hex"),
      approvedBy: owner.id,
      managedBy: "web",
      faqHtmlSha256: null,
      suspendedAt: null,
      suspendedReason: null,
    });
    const config = await routeConfig(routes.politica);
    expect(config?.theme).toBe("dark");
    expect(readRouteMark(config)).toEqual(mark);
    expect(await readActiveRouteMark(routes.politica)).toEqual(mark);

    // The release copy never carries the key.
    const [releaseCopies] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pageReleaseRoutes)
      .where(and(eq(schema.pageReleaseRoutes.routeId, routes.politica), sql`${schema.pageReleaseRoutes.routeConfigJson} ? 'knowledge'`));
    expect(releaseCopies?.count).toBe(0);

    expect((await listMarkedRoutes({ organizationId: orgId, siteId, audience: { kind: "page_viewers" } })).map((route) => route.routeId)).toEqual([routes.politica]);
    expect(
      await listMarkedRoutes({ organizationId: orgId, audience: { kind: "contacts", localInstallationId: installation, instanceId: "wa-main" } }),
    ).toMatchObject([{ routeId: routes.politica, host, path: "/politica", projectId, title: "/politica" }]);
    expect(await listMarkedRoutes({ organizationId: orgId, audience: { kind: "contacts", localInstallationId: randomUUID() } })).toEqual([]);

    // A new version suspends it; a suspended mark is not "active".
    const v2 = await capture("/politica", "Trocas em até trinta dias");
    expect(await suspendRouteMark({ routeId: routes.politica, reason: "new_version", requestId: "req" }, db, inbox)).toBe(true);
    expect(await suspendRouteMark({ routeId: routes.politica, reason: "new_version", requestId: "req" }, db, inbox)).toBe(false);
    expect(await readActiveRouteMark(routes.politica)).toBeNull();
    expect(readRouteMark(await routeConfig(routes.politica))).toMatchObject({ state: "suspended", suspendedReason: "new_version", approvedDocumentId: v1.documentId });
    expect(await listMarkedRoutes({ organizationId: orgId, state: "suspended" })).toHaveLength(1);
    expect(await listMarkedRoutes({ organizationId: orgId })).toHaveLength(0);

    const reapproved = await writeRouteMark(
      { routeId: routes.politica, action: "reapprove", audiences: [{ kind: "page_viewers" }], actorUserId: owner.id, requestId: "req" },
      db,
      inbox,
    );
    expect(reapproved.mark).toMatchObject({ state: "active", approvedDocumentId: v2.documentId, approvedVersion: 2, suspendedReason: null });

    const unmarked = await writeRouteMark(
      { routeId: routes.politica, action: "unmark", audiences: [], actorUserId: owner.id, requestId: "req" },
      db,
      inbox,
    );
    expect(unmarked.mark).toBeNull();
    expect(await routeConfig(routes.politica)).toEqual({ theme: "dark" });
    expect(await readActiveRouteMark(routes.politica)).toBeNull();

    // One inbox call per change, ids only; one audit row per change, ids only.
    expect(inbox.calls).toEqual([
      { organizationId: orgId, routeId: routes.politica, action: "mark" },
      { organizationId: orgId, routeId: routes.politica, action: "suspend" },
      { organizationId: orgId, routeId: routes.politica, action: "reapprove" },
      { organizationId: orgId, routeId: routes.politica, action: "unmark" },
    ]);
    const rows = await audits(routes.politica);
    expect(rows.map((row) => row.action)).toEqual([
      "knowledge.route_mark.marked",
      "knowledge.route_mark.suspended",
      "knowledge.route_mark.reapproved",
      "knowledge.route_mark.unmarked",
    ]);
    for (const row of rows) expect(JSON.stringify(row.metadata)).not.toMatch(/Trocas|WhatsApp/);
  });

  test("managedBy faq stores the rendered page's hash and requires it", async () => {
    await capture("/faq", "Vocês dão desconto pra ONG? Sim, vinte por cento.");
    const inbox = recorder();
    const missing = await writeRouteMark(
      { routeId: routes.faq, action: "mark", audiences: [], actorUserId: owner.id, managedBy: "faq", requestId: "req" },
      db,
      inbox,
    ).catch((caught: unknown) => caught);
    expect((missing as ConsoleApiError).status).toBe(400);

    const hash = createHash("sha256").update("<html lang=\"pt-BR\"></html>").digest("hex");
    const { mark } = await writeRouteMark(
      { routeId: routes.faq, action: "mark", audiences: [AUDIENCES[1]!], actorUserId: owner.id, managedBy: "faq", faqHtmlSha256: hash, requestId: "req" },
      db,
      inbox,
    );
    expect(mark).toMatchObject({ managedBy: "faq", faqHtmlSha256: hash });
    expect(await readActiveRouteMark(routes.faq)).toMatchObject({ managedBy: "faq", faqHtmlSha256: hash });
    expect(inbox.calls).toEqual([{ organizationId: orgId, routeId: routes.faq, action: "mark" }]);

    // A web mark never keeps a hash.
    const web = await writeRouteMark(
      { routeId: routes.faq, action: "reapprove", audiences: [], actorUserId: owner.id, faqHtmlSha256: hash, requestId: "req" },
      db,
      inbox,
    );
    expect(web.mark).toMatchObject({ managedBy: "web", faqHtmlSha256: null });
  });

  test("a mark pins the version the person reviewed and the entry HTML it came from", async () => {
    const reviewedHtml = createHash("sha256").update("<html>v1</html>").digest("hex");
    const reviewed = await capture("/revisao", "Prazo de sete dias", reviewedHtml);
    // The page changes after the card was rendered.
    const newer = await capture("/revisao", "Prazo de trinta dias", createHash("sha256").update("<html>v2</html>").digest("hex"));
    const inbox = recorder();
    const stale = await writeRouteMark(
      { routeId: routes.review, action: "mark", audiences: AUDIENCES, actorUserId: owner.id, expectedDocumentId: reviewed.documentId, requestId: "req" },
      db,
      inbox,
    ).catch((caught: unknown) => caught);
    expect((stale as ConsoleApiError).status).toBe(409);
    expect((stale as ConsoleApiError).payload).toEqual({ error: "knowledge_mark_stale" });
    expect(await routeConfig(routes.review)).toEqual({});
    expect(inbox.calls).toEqual([]);

    const { mark } = await writeRouteMark(
      { routeId: routes.review, action: "mark", audiences: AUDIENCES, actorUserId: owner.id, expectedDocumentId: newer.documentId, requestId: "req" },
      db,
      inbox,
    );
    expect(mark).toMatchObject({
      approvedDocumentId: newer.documentId,
      approvedHtmlSha256: createHash("sha256").update("<html>v2</html>").digest("hex"),
    });
  });

  test("an inbox failure never undoes a committed mark", async () => {
    const { mark } = await writeRouteMark(
      { routeId: routes.faq, action: "reapprove", audiences: [{ kind: "page_viewers" }], actorUserId: owner.id, requestId: "req" },
      db,
      { recordMarksChanged: async () => { throw new Error("inbox down"); } },
    );
    expect(await readActiveRouteMark(routes.faq)).toEqual(mark);
  });
});
