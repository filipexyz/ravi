import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";

import type { SystemMeetingSegment } from "@/server/console/meetings/system";
import type { PageObjectStorage } from "@/server/console/pages/publish";
import { db, schema } from "@/server/db";

import { createKnowledgeJobHandlers } from "./job-handlers";
import { drainKnowledgeJobs } from "./jobs";
import type { KnowledgeRouteMark, MarkedRoute } from "./marks";
import { ingestForProducer } from "./producer";
import { captureMeetingForKnowledge, enqueueMeetingKnowledgeCapture } from "./producers/meeting";
import { capturePageRoute, onActiveSiteManifestWritten } from "./producers/page";
import { runKnowledgeRetention } from "./retention";
import { backfillSearchVectors, repairMeetings } from "./tick";

// Producers, the tick and retention against Postgres. Runs only with
// KNOWLEDGE_TEST_DATABASE_URL (and DATABASE_URL) pointing at a throwaway
// database with the current schema: the tick and retention steps scan every
// organization in it.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectId = randomUUID();
const siteId = randomUUID();
const artifactId = randomUUID();
const host = `capture-${suffix}.ravi.page`;
const NOW = new Date("2026-10-17T12:00:00.000Z");

const routes = { home: randomUUID(), old: randomUUID(), docs: randomUUID(), fresh: randomUUID(), faq: randomUUID() };
const releases = { one: randomUUID(), two: randomUUID(), three: randomUUID(), four: randomUUID() };
const objects = new Map<string, string>();
const storage = {
  readObjectText: async ({ key }: { key: string; maxBytes: number }) => objects.get(key) ?? null,
} as unknown as PageObjectStorage;

const HOME_HTML = `<!doctype html><html><head><title>Loja</title></head><body>
<h1 id="politica">Política</h1><p>Regras gerais da loja.</p>
<h2>Prazo de devolução da compra</h2><p>Trinta dias corridos.</p>
<ravi-view view="view_pedidos"></ravi-view>
</body></html>`;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function versionWithEntry(versionNumber: number, path: string, html: string) {
  const versionId = randomUUID();
  await db.insert(schema.artifactVersions).values({ id: versionId, artifactId, versionNumber });
  const key = `test/${suffix}/${versionId}/index.html`;
  objects.set(key, html);
  await db.insert(schema.assets).values({ artifactId, artifactVersionId: versionId, path: "index.html", storageJson: { r2Key: key } });
  return { versionId, path, key };
}

async function releaseRoute(
  releaseId: string,
  routeId: string,
  path: string,
  versionId: string,
  matchType: "exact" | "spa" | "prefix" = "spa",
) {
  await db.insert(schema.pageReleaseRoutes).values({
    organizationId: orgId,
    projectId,
    siteId,
    releaseId,
    routeId,
    path,
    matchType,
    artifactId,
    artifactVersionId: versionId,
    entrypoint: "index.html",
    assetBase: "/",
  });
}

async function activate(releaseId: string) {
  await db.update(schema.pageSites).set({ activeReleaseId: releaseId }).where(eq(schema.pageSites.id, siteId));
}

async function source(originKey: string) {
  const [row] = await db
    .select()
    .from(schema.knowledgeSources)
    .where(and(eq(schema.knowledgeSources.organizationId, orgId), eq(schema.knowledgeSources.originKey, originKey)));
  return row ?? null;
}

async function chunksOf(documentId: string) {
  return db
    .select({ stableKey: schema.knowledgeChunks.stableKey, trustTier: schema.knowledgeChunks.trustTier, location: schema.knowledgeChunks.locationJson, metadata: schema.knowledgeChunks.safeMetadataJson })
    .from(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.documentId, documentId))
    .orderBy(schema.knowledgeChunks.chunkOrdinal);
}

function webMark(patch: Partial<KnowledgeRouteMark> = {}): KnowledgeRouteMark {
  return { v: 1, state: "active", approvedDocumentId: randomUUID(), managedBy: "web", faqHtmlSha256: null, ...patch } as KnowledgeRouteMark;
}

function recorder() {
  const calls: Array<{ routeId: string; reason: string }> = [];
  return {
    calls,
    suspendMark: async (input: { routeId: string; reason: "new_version" | "route_removed"; requestId: string }) => {
      calls.push({ routeId: input.routeId, reason: input.reason });
      return true;
    },
  };
}

function segment(start: number, text: string): SystemMeetingSegment {
  return { speaker: "Ana", speakerId: "1", isHost: true, startSeconds: start, endSeconds: start + 2, startedAt: null, text, part: 0, callSeconds: start };
}

function okLoader(meetingId: string, startedAt: string, segments: SystemMeetingSegment[]) {
  return async () => ({
    status: "ok" as const,
    meeting: { id: meetingId, projectId, title: null, startedAt, language: "pt" },
    segments,
    recordings: [{ startedAt, completedAt: null, expiresAt: null }],
  });
}

async function meeting(patch: Partial<typeof schema.meetingBots.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(schema.meetingBots).values({
    id,
    organizationId: orgId,
    projectId,
    providerBotId: `bot_${id.slice(0, 8)}`,
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    botName: "Ravi",
    language: "pt",
    status: "done",
    maxRecordingSeconds: 3600,
    createdAt: new Date(NOW.getTime() - 3600_000),
    ...patch,
  });
  return id;
}

describeDb("knowledge capture (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([{ id: orgId, slug: `knowledge-capture-${suffix}`, name: "Knowledge capture" }]);
    await db.insert(schema.projects).values([
      { id: projectId, organizationId: orgId, slug: `capture-${suffix}`, name: "Capture", metadataJson: { knowledge: { meetingRetentionMonths: 6 } } },
    ]);
    await db.insert(schema.pageSites).values([{ id: siteId, organizationId: orgId, projectId, slug: `capture-${suffix}`, defaultHostname: host, defaultVisibility: "public" }]);
    await db.insert(schema.pageRoutes).values(
      Object.entries(routes).map(([name, id]) => ({ id, organizationId: orgId, projectId, siteId, path: name === "home" ? "/" : `/${name}`, matchType: "spa" as const })),
    );
    await db.insert(schema.artifacts).values([{ id: artifactId, projectId, slug: `capture-${suffix}`, name: "Capture" }]);
    await db.insert(schema.pageSiteReleases).values([
      { id: releases.one, organizationId: orgId, projectId, siteId, releaseNumber: 1, status: "active", activatedAt: NOW },
      { id: releases.two, organizationId: orgId, projectId, siteId, releaseNumber: 2, status: "active", activatedAt: NOW },
      { id: releases.three, organizationId: orgId, projectId, siteId, releaseNumber: 3, status: "active", activatedAt: NOW },
      { id: releases.four, organizationId: orgId, projectId, siteId, releaseNumber: 4, status: "active", activatedAt: NOW },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM knowledge_ingestion_jobs WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM knowledge_proposals WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM page_release_routes WHERE site_id = ${siteId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
  });

  describe("meeting capture", () => {
    test("source meeting:<id>, said, retain_until from the project's months; a re-capture is unchanged", async () => {
      const meetingId = await meeting();
      const loader = okLoader(meetingId, "2026-10-01T10:00:00.000Z", [segment(0, "Bom dia"), segment(10, "Vamos começar")]);
      const first = await captureMeetingForKnowledge({ organizationId: orgId, meetingId, requestId: "req", trigger: "meeting_ready" }, { loader });
      expect(first.status).toBe("ingested");
      const row = await source(`meeting:${meetingId}`);
      expect(row).toMatchObject({ sourceType: "meeting", trustTier: "said", status: "active" });
      expect(row!.retainUntil?.toISOString()).toBe("2027-04-01T10:00:00.000Z");
      if (first.status !== "ingested") throw new Error("expected ingested");
      const chunks = await chunksOf(first.documentId);
      expect(chunks.map((chunk) => [chunk.stableKey, chunk.trustTier])).toEqual([["t0:1:p0", "said"]]);

      const again = await captureMeetingForKnowledge({ organizationId: orgId, meetingId, requestId: "req", trigger: "meeting_repair" }, { loader });
      expect(again).toMatchObject({ status: "unchanged", documentId: first.documentId });
    });

    test("gone completes the job without a retry", async () => {
      const meetingId = await meeting();
      const queued = await enqueueMeetingKnowledgeCapture({ organizationId: orgId, projectId, meetingId, title: null, trigger: "meeting_ready", requestId: "req" });
      expect(queued).toMatchObject({ queued: true, created: true });
      const handlers = createKnowledgeJobHandlers({
        captureMeeting: (input) => captureMeetingForKnowledge(input, { loader: async () => ({ status: "gone" }) }),
      });
      await drainKnowledgeJobs({ handlers: { meeting_ready: handlers.meeting_ready! }, limit: 50, budgetMs: 30_000, workerId: "test", requestId: "req" });
      const [job] = await db.select().from(schema.knowledgeIngestionJobs).where(eq(schema.knowledgeIngestionJobs.id, queued.jobId!));
      expect(job).toMatchObject({ status: "completed", attempts: 1, failureCode: null });
      expect(job!.resultJson).toEqual({ schemaVersion: 1, status: "gone" });
    });
  });

  describe("page capture", () => {
    let one: { versionId: string };

    test("a spa route is captured with h: keys, anchors and baseViews; a prefix route is skipped", async () => {
      one = await versionWithEntry(1, "/", HOME_HTML);
      const old = await versionWithEntry(2, "/old", "<html><body><h1>Antiga</h1><p>Página antiga.</p></body></html>");
      const docs = await versionWithEntry(3, "/docs", "<html><body><h1>Docs</h1><p>Documentação.</p></body></html>");
      await releaseRoute(releases.one, routes.home, "/", one.versionId);
      await releaseRoute(releases.one, routes.old, "/old", old.versionId, "exact");
      await releaseRoute(releases.one, routes.docs, "/docs", docs.versionId, "prefix");
      await activate(releases.one);
      const marks = recorder();
      const deps = { storage, readMark: async () => null, suspendMark: marks.suspendMark };

      const home = await capturePageRoute({ siteId, releaseId: releases.one, routeId: routes.home, requestId: "req" }, deps);
      if (home.status !== "ingested") throw new Error(`expected ingested, got ${home.status}`);
      const chunks = await chunksOf(home.documentId);
      expect(chunks.map((chunk) => chunk.stableKey)).toEqual(["h:Política", "h:Política>Prazo de devolução da compra"]);
      expect(chunks.map((chunk) => (chunk.location as { anchor: string }).anchor)).toEqual([
        "politica",
        `:~:text=${encodeURIComponent("Prazo de devolução da compra")}`,
      ]);
      expect(chunks[0]!.location).toMatchObject({ kind: "page", siteId, routeId: routes.home, host, path: "/" });
      expect(chunks[0]!.metadata).toMatchObject({ baseViews: ["view_pedidos"] });
      expect(chunks[0]!.trustTier).toBe("published");
      expect(await source(`page:${siteId}:/`)).toMatchObject({ sourceType: "ravi_page", trustTier: "published" });

      expect((await capturePageRoute({ siteId, releaseId: releases.one, routeId: routes.old, requestId: "req" }, deps)).status).toBe("ingested");
      expect(await capturePageRoute({ siteId, releaseId: releases.one, routeId: routes.docs, requestId: "req" }, deps)).toEqual({ status: "no_source" });
      expect(await source(`page:${siteId}:/docs`)).toBeNull();
      expect(marks.calls).toEqual([]);
    });

    test("the release step enqueues captured routes only and revokes a path the new release lacks", async () => {
      await releaseRoute(releases.two, routes.home, "/", one.versionId);
      await activate(releases.two);
      const marks = recorder();
      const drained: string[] = [];
      await onActiveSiteManifestWritten(
        { siteId, releaseId: releases.two, requestId: "req_two" },
        { enabled: async () => true, drain: (requestId) => void drained.push(requestId), suspendMark: marks.suspendMark },
      );
      expect((await source(`page:${siteId}:/old`))?.status).toBe("revoked");
      expect((await source(`page:${siteId}:/`))?.status).toBe("active");
      expect(marks.calls).toEqual([{ routeId: routes.old, reason: "route_removed" }]);
      expect(drained).toEqual(["req_two"]);
      const jobs = await db
        .select({ key: schema.knowledgeIngestionJobs.idempotencyKey })
        .from(schema.knowledgeIngestionJobs)
        .where(and(eq(schema.knowledgeIngestionJobs.organizationId, orgId), like(schema.knowledgeIngestionJobs.idempotencyKey, `page_release:${releases.two}:%`)));
      expect(jobs.map((job) => job.key)).toEqual([`page_release:${releases.two}:${routes.home}:${NOW.getTime()}`]);
    });

    test("activating an older release revokes the paths only the newer one had", async () => {
      const fresh = await versionWithEntry(4, "/fresh", "<html><body><h1>Nova</h1><p>Página nova.</p></body></html>");
      await releaseRoute(releases.three, routes.home, "/", one.versionId);
      await releaseRoute(releases.three, routes.fresh, "/fresh", fresh.versionId);
      await activate(releases.three);
      const deps = { storage, readMark: async () => null, suspendMark: recorder().suspendMark };
      expect((await capturePageRoute({ siteId, releaseId: releases.three, routeId: routes.fresh, requestId: "req" }, deps)).status).toBe("ingested");
      // A job of the old release that runs late reads nothing.
      expect(await capturePageRoute({ siteId, releaseId: releases.two, routeId: routes.home, requestId: "req" }, deps)).toEqual({ status: "no_source" });

      await activate(releases.two);
      const marks = recorder();
      await onActiveSiteManifestWritten({ siteId, releaseId: releases.two, requestId: "req" }, { enabled: async () => true, drain: () => {}, suspendMark: marks.suspendMark });
      expect((await source(`page:${siteId}:/fresh`))?.status).toBe("revoked");
      expect((await source(`page:${siteId}:/`))?.status).toBe("active");
      expect(marks.calls).toEqual([{ routeId: routes.fresh, reason: "route_removed" }]);
    });

    test("a new version suspends a web mark through the injected suspendMark", async () => {
      const changed = await versionWithEntry(5, "/", HOME_HTML.replace("Trinta dias", "Quarenta dias"));
      await db.update(schema.pageReleaseRoutes).set({ artifactVersionId: changed.versionId }).where(and(eq(schema.pageReleaseRoutes.releaseId, releases.two), eq(schema.pageReleaseRoutes.routeId, routes.home)));
      const marks = recorder();
      const result = await capturePageRoute(
        { siteId, releaseId: releases.two, routeId: routes.home, requestId: "req" },
        { storage, readMark: async () => webMark(), suspendMark: marks.suspendMark },
      );
      expect(result.status).toBe("ingested");
      expect(marks.calls).toEqual([{ routeId: routes.home, reason: "new_version" }]);
    });

    test("/faq bytes whose hash differs from the mark are published and suspend it; the matching hash is approved", async () => {
      const foreign = "<html><body><h1>FAQ</h1><p>Texto de outra pessoa.</p></body></html>";
      const own = "<html><body><h1>FAQ</h1><p>Texto aprovado pelo Console.</p></body></html>";
      const version = await versionWithEntry(6, "/faq", foreign);
      await releaseRoute(releases.two, routes.faq, "/faq", version.versionId);
      const faqMark = webMark({ managedBy: "faq", faqHtmlSha256: sha256(own) });

      const marks = recorder();
      const published = await capturePageRoute(
        { siteId, releaseId: releases.two, routeId: routes.faq, requestId: "req" },
        { storage, readMark: async () => faqMark, suspendMark: marks.suspendMark },
      );
      if (published.status !== "ingested") throw new Error("expected ingested");
      expect(new Set((await chunksOf(published.documentId)).map((chunk) => chunk.trustTier))).toEqual(new Set(["published"]));
      expect(marks.calls).toEqual([{ routeId: routes.faq, reason: "new_version" }]);

      objects.set(`test/${suffix}/${version.versionId}/index.html`, own);
      const approvedMarks = recorder();
      const approved = await capturePageRoute(
        { siteId, releaseId: releases.two, routeId: routes.faq, requestId: "req" },
        { storage, readMark: async () => faqMark, suspendMark: approvedMarks.suspendMark },
      );
      if (approved.status !== "ingested") throw new Error("expected ingested");
      expect(new Set((await chunksOf(approved.documentId)).map((chunk) => chunk.trustTier))).toEqual(new Set(["approved"]));
      expect(approvedMarks.calls).toEqual([]);
    });
  });

  describe("page capture fixes", () => {
    const keysFor = async (releaseId: string) =>
      (
        await db
          .select({ key: schema.knowledgeIngestionJobs.idempotencyKey })
          .from(schema.knowledgeIngestionJobs)
          .where(and(eq(schema.knowledgeIngestionJobs.organizationId, orgId), like(schema.knowledgeIngestionJobs.idempotencyKey, `page_release:${releaseId}:%`)))
      )
        .map((job) => job.key)
        .sort();
    const quiet = { enabled: async () => true, drain: () => {}, storage, readMark: async () => null };

    test("activating a release again (a rollback) enqueues its captures again; a repair of the same activation does not", async () => {
      const before = await keysFor(releases.two);
      const again = new Date(NOW.getTime() + 60_000);
      await db.update(schema.pageSiteReleases).set({ activatedAt: again }).where(eq(schema.pageSiteReleases.id, releases.two));
      await activate(releases.two);
      await onActiveSiteManifestWritten({ siteId, releaseId: releases.two, requestId: "req_rollback" }, { ...quiet, suspendMark: recorder().suspendMark });
      const after = await keysFor(releases.two);
      expect(after).toContain(`page_release:${releases.two}:${routes.home}:${again.getTime()}`);
      expect(after.length).toBeGreaterThan(before.length);
      await onActiveSiteManifestWritten({ siteId, releaseId: releases.two, requestId: "req_repair" }, { ...quiet, suspendMark: recorder().suspendMark });
      expect(await keysFor(releases.two)).toEqual(after);
    });

    test("an spa route that shares its path with an exact route is not captured; the exact one is", async () => {
      const exact = await versionWithEntry(7, "/dup", "<html><body><h1>Exata</h1><p>Página exata.</p></body></html>");
      const spa = await versionWithEntry(8, "/dup", "<html><body><h1>SPA</h1><p>Página da SPA.</p></body></html>");
      const exactRoute = randomUUID();
      const spaRoute = randomUUID();
      await db.insert(schema.pageRoutes).values([
        { id: exactRoute, organizationId: orgId, projectId, siteId, path: "/dup", matchType: "exact" },
        { id: spaRoute, organizationId: orgId, projectId, siteId, path: "/dup", matchType: "spa" },
      ]);
      const home = await versionWithEntry(9, "/", HOME_HTML);
      await releaseRoute(releases.four, routes.home, "/", home.versionId);
      await releaseRoute(releases.four, exactRoute, "/dup", exact.versionId, "exact");
      await releaseRoute(releases.four, spaRoute, "/dup", spa.versionId, "spa");
      await activate(releases.four);
      await onActiveSiteManifestWritten({ siteId, releaseId: releases.four, requestId: "req_four" }, { ...quiet, suspendMark: recorder().suspendMark });
      expect(await keysFor(releases.four)).toEqual(
        [`page_release:${releases.four}:${routes.home}:${NOW.getTime()}`, `page_release:${releases.four}:${exactRoute}:${NOW.getTime()}`].sort(),
      );

      const deps = { storage, readMark: async () => null, suspendMark: recorder().suspendMark };
      expect(await capturePageRoute({ siteId, releaseId: releases.four, routeId: spaRoute, requestId: "req" }, deps)).toEqual({ status: "no_source" });
      const captured = await capturePageRoute({ siteId, releaseId: releases.four, routeId: exactRoute, requestId: "req", trigger: "page_backfill" }, deps);
      if (captured.status !== "ingested") throw new Error(`expected ingested, got ${captured.status}`);
      const [document] = await db
        .select({ location: schema.knowledgeDocuments.sourceLocationJson })
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.id, captured.documentId));
      expect(document?.location).toMatchObject({ artifactVersionId: exact.versionId, htmlSha256: sha256("<html><body><h1>Exata</h1><p>Página exata.</p></body></html>") });
    });

    test("a release serving other bytes at a marked route suspends the mark at once, even with Knowledge off; the approved bytes keep it", async () => {
      const approved = webMark({ approvedHtmlSha256: sha256(HOME_HTML) });
      const run = async (mark: KnowledgeRouteMark, deps: { storage?: PageObjectStorage } = {}) => {
        const marks = recorder();
        await onActiveSiteManifestWritten(
          { siteId, releaseId: releases.four, requestId: "req_marks" },
          { enabled: async () => false, drain: () => {}, storage: deps.storage ?? storage, readMark: async (routeId) => (routeId === routes.home ? mark : null), suspendMark: marks.suspendMark },
        );
        return marks.calls;
      };
      expect(await run(approved)).toEqual([]);
      expect(await run(webMark({ approvedHtmlSha256: sha256("<html>outra</html>") }))).toEqual([{ routeId: routes.home, reason: "new_version" }]);
      // A /faq mark also accepts the bytes the Console rendered.
      expect(await run(webMark({ managedBy: "faq", faqHtmlSha256: sha256(HOME_HTML), approvedHtmlSha256: null }))).toEqual([]);
      // Bytes nobody can read are not the approved ones.
      const empty = { readObjectText: async () => null } as unknown as PageObjectStorage;
      expect(await run(approved, { storage: empty })).toEqual([{ routeId: routes.home, reason: "new_version" }]);
    });

    test("a capture with no bytes suspends an active mark; a mark written during the ingest is read again", async () => {
      const marks = recorder();
      const empty = { readObjectText: async () => null } as unknown as PageObjectStorage;
      const none = await capturePageRoute(
        { siteId, releaseId: releases.four, routeId: routes.home, requestId: "req" },
        { storage: empty, readMark: async () => webMark(), suspendMark: marks.suspendMark },
      );
      expect(none).toEqual({ status: "no_source" });
      expect(marks.calls).toEqual([{ routeId: routes.home, reason: "new_version" }]);

      let reads = 0;
      const late = recorder();
      const result = await capturePageRoute(
        { siteId, releaseId: releases.four, routeId: routes.home, requestId: "req" },
        { storage, readMark: async () => (reads++ === 0 ? null : webMark()), suspendMark: late.suspendMark },
      );
      expect(result.status).toBe("ingested");
      expect(reads).toBe(2);
      expect(late.calls).toEqual([{ routeId: routes.home, reason: "new_version" }]);
    });
  });

  describe("tick", () => {
    test("meeting repair enqueues at most 25 with key meeting_repair:<id>, skipping deleted sources and finished repairs", async () => {
      const deletedMeeting = await meeting({ createdAt: new Date(NOW.getTime() - 60_000) });
      await enqueueMeetingKnowledgeCapture({ organizationId: orgId, projectId, meetingId: deletedMeeting, title: null, trigger: "meeting_ready", requestId: "req" });
      await db.execute(sql`UPDATE knowledge_sources SET status = 'deleted' WHERE organization_id = ${orgId}::uuid AND origin_key = ${`meeting:${deletedMeeting}`}`);
      await db.execute(sql`DELETE FROM knowledge_ingestion_jobs WHERE organization_id = ${orgId}::uuid AND idempotency_key = ${`meeting_ready:${deletedMeeting}`}`);

      const goneMeeting = await meeting({ createdAt: new Date(NOW.getTime() - 60_000) });
      const gone = await enqueueMeetingKnowledgeCapture({ organizationId: orgId, projectId, meetingId: goneMeeting, title: null, trigger: "meeting_repair", requestId: "req" });
      await db
        .update(schema.knowledgeIngestionJobs)
        .set({ status: "completed", resultJson: { schemaVersion: 1, status: "gone" }, finishedAt: NOW })
        .where(eq(schema.knowledgeIngestionJobs.id, gone.jobId!));

      const missing: string[] = [];
      for (let index = 0; index < 27; index += 1) missing.push(await meeting({ createdAt: new Date(NOW.getTime() - (index + 2) * 60_000) }));
      const tooOld = await meeting({ createdAt: new Date(NOW.getTime() - 8 * 24 * 3600_000) });

      const queued = await repairMeetings({ requestId: "req_tick", now: NOW }, { enabled: async (organizationId) => organizationId === orgId });
      expect(queued).toBe(25);
      const jobs = await db
        .select({ key: schema.knowledgeIngestionJobs.idempotencyKey, createdAt: schema.knowledgeIngestionJobs.createdAt })
        .from(schema.knowledgeIngestionJobs)
        .where(and(eq(schema.knowledgeIngestionJobs.organizationId, orgId), eq(schema.knowledgeIngestionJobs.triggerType, "meeting_repair"), eq(schema.knowledgeIngestionJobs.requestId, "req_tick")));
      const keys = new Set(jobs.map((job) => job.key ?? ""));
      expect(keys.size).toBe(25);
      for (const key of keys) expect(key).toMatch(/^meeting_repair:[0-9a-f-]{36}$/);
      expect(keys.has(`meeting_repair:${deletedMeeting}`)).toBe(false);
      expect(keys.has(`meeting_repair:${tooOld}`)).toBe(false);
      expect([...keys].every((key) => missing.includes(key.slice("meeting_repair:".length)))).toBe(true);

      // A second tick picks up the rest, and nothing twice.
      expect(await repairMeetings({ requestId: "req_tick_2", now: NOW }, { enabled: async (organizationId) => organizationId === orgId })).toBe(2);
      expect(await repairMeetings({ requestId: "req_tick_3", now: NOW }, { enabled: async (organizationId) => organizationId === orgId })).toBe(0);
    });

    test("vector backfill fills null vectors", async () => {
      const [chunk] = await db
        .select({ id: schema.knowledgeChunks.id })
        .from(schema.knowledgeChunks)
        .where(eq(schema.knowledgeChunks.organizationId, orgId))
        .limit(1);
      await db.update(schema.knowledgeChunks).set({ searchVector: null, searchVectorStem: null }).where(eq(schema.knowledgeChunks.id, chunk!.id));
      expect(await backfillSearchVectors()).toBeGreaterThanOrEqual(1);
      const [after] = await db
        .select({ id: schema.knowledgeChunks.id })
        .from(schema.knowledgeChunks)
        .where(and(eq(schema.knowledgeChunks.id, chunk!.id), isNull(schema.knowledgeChunks.searchVector)));
      expect(after).toBeUndefined();
    });

    test("retention: query text, meeting content past retain_until, proposals, pinned archived documents", async () => {
      const oldRun = randomUUID();
      const newRun = randomUUID();
      await db.insert(schema.knowledgeRetrievalRuns).values([
        { id: oldRun, organizationId: orgId, status: "completed", queryText: "segredo antigo", normalizedQuery: "segredo antigo", createdAt: new Date(NOW.getTime() - 31 * 24 * 3600_000) },
        { id: newRun, organizationId: orgId, status: "completed", queryText: "recente", normalizedQuery: "recente", createdAt: new Date(NOW.getTime() - 5 * 24 * 3600_000) },
      ]);

      const expiredMeeting = await meeting();
      const captured = await captureMeetingForKnowledge(
        { organizationId: orgId, meetingId: expiredMeeting, requestId: "req", trigger: "meeting_ready" },
        { loader: okLoader(expiredMeeting, "2026-01-01T10:00:00.000Z", [segment(0, "Conteúdo antigo")]), projectMetadata: async () => ({ knowledge: { meetingRetentionMonths: 1 } }) },
      );
      expect(captured.status).toBe("ingested");

      const proposal = randomUUID();
      await db.insert(schema.knowledgeProposals).values({ id: proposal, organizationId: orgId, projectId, kind: "note", body: "nota", expiresAt: new Date(NOW.getTime() - 60_000) });
      // Closed proposals: a gap and a transcript decided 31 days ago lose their bodies; a recent gap and an old note keep theirs.
      const later = new Date(NOW.getTime() + 24 * 3600_000);
      const closed = { oldGap: randomUUID(), oldTranscript: randomUUID(), recentGap: randomUUID(), oldNote: randomUUID() };
      const closedAt = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);
      await db.insert(schema.knowledgeProposals).values([
        { id: closed.oldGap, organizationId: orgId, projectId, kind: "gap", status: "approved", body: "Vocês abrem domingo?", decidedAt: closedAt(31), expiresAt: later },
        { id: closed.oldTranscript, organizationId: orgId, projectId, kind: "transcript", status: "withdrawn", body: "{}", updatedAt: closedAt(31), expiresAt: later },
        { id: closed.recentGap, organizationId: orgId, projectId, kind: "gap", status: "rejected", body: "Tem estacionamento?", decidedAt: closedAt(5), expiresAt: later },
        { id: closed.oldNote, organizationId: orgId, projectId, kind: "note", status: "rejected", body: "Nota rejeitada", decidedAt: closedAt(31), expiresAt: later },
      ]);

      const origin = `page:${siteId}:/versions`;
      const versions: string[] = [];
      for (const text of ["v1", "v2", "v3"]) {
        const result = await ingestForProducer({
          organizationId: orgId,
          projectId,
          originKey: origin,
          sourceType: "ravi_page",
          trustTier: "published",
          title: "/versions",
          sourceRef: { siteId, path: "/versions" },
          document: { title: "/versions", mimeType: "text/html", parserVersion: "knowledge-page-v1", contentHash: sha256(text), sizeBytes: 2 },
          chunks: [{ stableKey: "h:", text: `Versão ${text}`, location: { kind: "page", siteId, path: "/versions" } }],
          actor: { type: "system", id: null },
          triggerType: "page_release",
          requestId: "req",
        });
        if (result.status !== "ingested") throw new Error("expected ingested");
        versions.push(result.documentId);
      }
      const [pinned, unpinned, current] = versions as [string, string, string];
      await db
        .update(schema.knowledgeDocuments)
        .set({ updatedAt: new Date(NOW.getTime() - 100 * 24 * 3600_000) })
        .where(inArray(schema.knowledgeDocuments.id, [pinned, unpinned]));

      const marked = [{ routeId: routes.home, siteId, projectId, organizationId: orgId, host, path: "/versions", title: null, mark: webMark({ approvedDocumentId: pinned, state: "suspended" }) }];
      const result = await runKnowledgeRetention(
        { requestId: "req_retention", now: () => NOW },
        { listMarkedRoutes: async (input) => (input.organizationId === orgId ? (marked as MarkedRoute[]) : []) },
      );
      expect(result.queryTexts).toBeGreaterThanOrEqual(1);
      expect(result.meetingSources).toBeGreaterThanOrEqual(1);
      expect(result.proposalsExpired).toBeGreaterThanOrEqual(1);
      expect(result.proposalBodies).toBeGreaterThanOrEqual(2);

      const runs = await db
        .select({ id: schema.knowledgeRetrievalRuns.id, queryText: schema.knowledgeRetrievalRuns.queryText, normalizedQuery: schema.knowledgeRetrievalRuns.normalizedQuery })
        .from(schema.knowledgeRetrievalRuns)
        .where(inArray(schema.knowledgeRetrievalRuns.id, [oldRun, newRun]));
      expect(Object.fromEntries(runs.map((run) => [run.id, [run.queryText, run.normalizedQuery]]))).toEqual({
        [oldRun]: [null, null],
        [newRun]: ["recente", "recente"],
      });

      const bodies = await db
        .select({ id: schema.knowledgeProposals.id, body: schema.knowledgeProposals.body, bodyHash: schema.knowledgeProposals.bodyHash })
        .from(schema.knowledgeProposals)
        .where(inArray(schema.knowledgeProposals.id, [proposal, ...Object.values(closed)]));
      const byId = Object.fromEntries(bodies.map((row) => [row.id, row]));
      expect(byId[proposal]).toEqual({ id: proposal, body: null, bodyHash: sha256("nota") });
      expect(byId[closed.oldGap]).toEqual({ id: closed.oldGap, body: null, bodyHash: sha256("Vocês abrem domingo?") });
      expect(byId[closed.oldTranscript]).toEqual({ id: closed.oldTranscript, body: null, bodyHash: sha256("{}") });
      expect(byId[closed.recentGap]?.body).toBe("Tem estacionamento?");
      expect(byId[closed.oldNote]?.body).toBe("Nota rejeitada");

      expect((await source(`meeting:${expiredMeeting}`))?.status).toBe("deleted");
      const leftover = await db.select({ id: schema.knowledgeChunks.id }).from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.sourceId, (await source(`meeting:${expiredMeeting}`))!.id));
      expect(leftover).toEqual([]);

      const [expired] = await db.select({ status: schema.knowledgeProposals.status }).from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, proposal));
      expect(expired?.status).toBe("expired");

      const documents = await db
        .select({ id: schema.knowledgeDocuments.id })
        .from(schema.knowledgeDocuments)
        .where(inArray(schema.knowledgeDocuments.id, versions));
      expect(new Set(documents.map((document) => document.id))).toEqual(new Set([pinned, current]));
    });
  });
});
