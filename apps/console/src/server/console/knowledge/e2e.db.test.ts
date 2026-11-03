import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import { createKnowledgeSource } from "@/server/console/knowledge";
import { db, schema } from "@/server/db";

import { ingestKnowledgeSource } from "./ingestion";
import { drainKnowledgeJobs, enqueueKnowledgeJob, type KnowledgeTriggerType } from "./jobs";
import {
  deleteKnowledgeSourceContent,
  ingestForProducer,
  revokeKnowledgeSourceByOrigin,
  type ProducerChunkInput,
  type ProducerIngestInput,
} from "./producer";
import { buildKnowledgeQuery } from "./query";
import { reloadKnowledgeChunks, searchKnowledgeCandidates, writeKnowledgeRun, type KnowledgeSearchScope } from "./retrieval-core";
import { ensureKnowledgeStrategy } from "./strategy";
import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "./usage";

// The P0 database E2E: producer ingest → FTS search → canonical reload →
// revoke → zero chunks, plus the manual ingest fixes, runs without text, the
// job queue and the proposal dedupe index. Runs only with
// KNOWLEDGE_TEST_DATABASE_URL (and DATABASE_URL) pointing at a database with
// the current schema (drizzle-kit push).
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `kn-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `kn-b-${suffix}` };
const owner = { id: randomUUID(), email: `knowledge-e2e-${suffix}-owner@example.test` };
const laptop = randomUUID();
const server = randomUUID();
const workspace = {
  mode: "workos" as const,
  user: { id: owner.id },
  organization: { id: orgId },
  membership: { role: "owner" },
};

const scopeA: KnowledgeSearchScope = { organizationId: orgId, projectIds: [projectA.id], includeOrgLevel: false };

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function producerInput(
  originKey: string,
  chunks: ProducerChunkInput[],
  overrides: Partial<ProducerIngestInput> = {},
): ProducerIngestInput {
  const joined = chunks.map((chunk) => chunk.text).join("\n");
  return {
    organizationId: orgId,
    projectId: projectA.id,
    originKey,
    sourceType: "meeting",
    trustTier: "said",
    title: "Kickoff Acme",
    sourceRef: { meetingBotId: originKey },
    retainUntil: null,
    document: {
      title: "Kickoff Acme",
      mimeType: "text/plain",
      parserVersion: "knowledge-test-v1",
      contentHash: sha(joined),
      sizeBytes: Buffer.byteLength(joined),
    },
    chunks,
    actor: { type: "system", id: null },
    triggerType: "meeting_ready",
    requestId: `req-${randomUUID()}`,
    ...overrides,
  };
}

function meetingChunk(text: string, speakers: string[] = ["Luís"], heading: string | null = null): ProducerChunkInput {
  return {
    stableKey: `t0:${speakers[0] ?? "x"}:p0`,
    text,
    heading,
    speakers,
    location: { kind: "meeting", meetingId: "m", part: 0, startSeconds: 0, recordedAt: "2026-10-15T14:02:11Z" },
    metadata: { segmentKind: "meeting_window" },
  };
}

async function jobCount(sourceId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledgeIngestionJobs)
    .where(eq(schema.knowledgeIngestionJobs.sourceId, sourceId));
  return row?.count ?? 0;
}

async function search(raw: string, scope: KnowledgeSearchScope = scopeA, limit = 8) {
  const query = buildKnowledgeQuery(raw);
  if (!query) throw new Error("no query");
  const result = await searchKnowledgeCandidates({ scope, query, limit });
  const rows = await reloadKnowledgeChunks({ scope, chunkIds: result.candidates.map((candidate) => candidate.chunkId) });
  return { ...result, rows };
}

describeDb("knowledge DB E2E", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([{ id: owner.id, primaryEmail: owner.email, displayName: "owner" }]);
    await db.insert(schema.organizations).values([{ id: orgId, slug: `knowledge-e2e-${suffix}`, name: "Knowledge E2E" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: orgId, userId: owner.id, role: "owner" }]);
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.localInstallations).values([
      { id: laptop, organizationId: orgId, userId: owner.id, name: "laptop" },
      { id: server, organizationId: orgId, userId: owner.id, name: "server" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.id]));
  });

  test("producer ingest → search (AND, then OR fallback) → reload → revoke → zero chunks", async () => {
    const originKey = `meeting:${randomUUID()}`;
    const ingested = await ingestForProducer(
      producerInput(originKey, [meetingChunk("Luís prometeu mandar até sexta"), meetingChunk("Marcos falou do contrato", ["Marcos"])]),
    );
    expect(ingested).toMatchObject({ status: "ingested", versionNumber: 1, chunkCount: 2, previousDocumentId: null });

    const and = await search("luis sexta");
    expect(and.mode).toBe("and");
    expect(and.candidates[0]?.pass).toBe("and");
    expect(and.rows[0]?.text).toBe("Luís prometeu mandar até sexta");
    expect(and.rows[0]).toMatchObject({ kind: "meeting", trust: "said", originKey, documentVersion: 1 });
    expect(and.rows[0]?.recordedAt.toISOString()).toBe("2026-10-15T14:02:11.000Z");

    const or = await search("luis domingo");
    expect(or.mode).toBe("or");
    expect(or.candidates.every((candidate) => candidate.pass === "or")).toBe(true);
    expect(or.rows.map((row) => row.text)).toContain("Luís prometeu mandar até sexta");

    // Stemmed match and the speaker filter.
    const stem = buildKnowledgeQuery("prometeram");
    const stemmed = await searchKnowledgeCandidates({ scope: scopeA, query: stem!, limit: 5 });
    expect(stemmed.candidates.length).toBeGreaterThan(0);
    const who = await searchKnowledgeCandidates({ scope: scopeA, query: buildKnowledgeQuery("contrato sexta")!, filters: { who: "marcos" }, limit: 5 });
    const whoRows = await reloadKnowledgeChunks({ scope: scopeA, chunkIds: who.candidates.map((c) => c.chunkId) });
    expect(whoRows.map((row) => row.text)).toEqual(["Marcos falou do contrato"]);

    // Out of scope: another project, or no project at all.
    expect((await search("luis sexta", { organizationId: orgId, projectIds: [projectB.id], includeOrgLevel: true })).rows).toHaveLength(0);
    expect((await search("luis sexta", { organizationId: randomUUID(), projectIds: [projectA.id], includeOrgLevel: true })).rows).toHaveLength(0);

    // Revoked: the source's chunks drop at reload, even for ids found before.
    const before = and.candidates.map((candidate) => candidate.chunkId);
    expect(await revokeKnowledgeSourceByOrigin({ organizationId: orgId, originKey, reason: "route_removed", requestId: "req" })).toBe(true);
    expect(await reloadKnowledgeChunks({ scope: scopeA, chunkIds: before })).toHaveLength(0);
    expect((await search("luis sexta")).rows).toHaveLength(0);
    expect(await revokeKnowledgeSourceByOrigin({ organizationId: orgId, originKey, reason: "route_removed", requestId: "req" })).toBe(false);

    // A new capture revives a revoked source.
    const revived = await ingestForProducer(producerInput(originKey, [meetingChunk("Luís prometeu mandar até sexta"), meetingChunk("Marcos falou do contrato", ["Marcos"])]));
    expect(revived.status).toBe("unchanged");
    expect((await search("luis sexta")).rows).toHaveLength(1);
  });

  test("a chunk with a null heading and no speakers gets non-null vectors that match its text", async () => {
    const originKey = `note:${randomUUID()}`;
    const result = await ingestForProducer(
      producerInput(originKey, [{ stableKey: "o0", text: "Desconto para ONG é de vinte por cento", heading: null, location: { kind: "note" } }], {
        sourceType: "manual_note",
        trustTier: "approved",
        triggerType: "proposal_approved",
      }),
    );
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") return;
    const [chunk] = await db
      .select({ simple: sql<boolean>`${schema.knowledgeChunks.searchVector} IS NOT NULL`, stem: sql<boolean>`${schema.knowledgeChunks.searchVectorStem} IS NOT NULL`, trust: schema.knowledgeChunks.trustTier })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.documentId, result.documentId));
    expect(chunk).toEqual({ simple: true, stem: true, trust: "approved" });
    const found = await search("desconto ong");
    expect(found.rows.map((row) => row.kind)).toEqual(["note"]);
  });

  test("a new version archives the old document; the same content_hash is unchanged", async () => {
    const originKey = `page:${randomUUID()}:/politica`;
    const pageInput = (text: string) =>
      producerInput(originKey, [{ stableKey: "h:Trocas", heading: "Trocas", text, location: { kind: "page", path: "/politica" } }], {
        sourceType: "ravi_page",
        trustTier: "published",
        triggerType: "page_release",
      });
    const first = await ingestForProducer(pageInput("Trocas em até sete dias"));
    const second = await ingestForProducer(pageInput("Trocas em até trinta dias"));
    const same = await ingestForProducer(pageInput("Trocas em até trinta dias"));
    expect(first.status).toBe("ingested");
    expect(second).toMatchObject({ status: "ingested", versionNumber: 2 });
    if (first.status !== "ingested" || second.status !== "ingested") return;
    expect(second.previousDocumentId).toBe(first.documentId);
    expect(same).toEqual({ status: "unchanged", sourceId: second.sourceId, documentId: second.documentId, versionNumber: 2 });

    const statuses = await db
      .select({ id: schema.knowledgeDocuments.id, status: schema.knowledgeDocuments.status })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.sourceId, second.sourceId));
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [first.documentId]: "archived",
      [second.documentId]: "chunked",
    });
    // The archived version is gone from search (the OR pass still finds the current one by "trocas").
    expect((await search("trocas sete")).rows.map((row) => row.documentId)).toEqual([second.documentId]);
    expect((await search("trocas trinta")).rows).toHaveLength(1);
    // A pinned (archived) document stays readable through documentIds.
    const pinned = await search("trocas sete", { ...scopeA, documentIds: [first.documentId] });
    expect(pinned.rows.map((row) => row.documentId)).toEqual([first.documentId]);
  });

  test("two identical sections under the same heading both insert", async () => {
    const section = { stableKey: "h:Trocas", heading: "Trocas", text: "Igual em tudo", location: { kind: "page" } };
    const result = await ingestForProducer(
      producerInput(`page:${randomUUID()}:/dup`, [section, section], { sourceType: "ravi_page", trustTier: "published", triggerType: "page_release" }),
    );
    expect(result).toMatchObject({ status: "ingested", chunkCount: 2 });
  });

  test("a producer call with jobId writes no job row; without it, exactly one", async () => {
    const withJob = await ingestForProducer(producerInput(`meeting:${randomUUID()}`, [meetingChunk("Com job")]), db);
    if (withJob.status !== "ingested") throw new Error("expected ingested");
    expect(await jobCount(withJob.sourceId)).toBe(1);

    const originKey = `meeting:${randomUUID()}`;
    const fromHandler = await ingestForProducer({ ...producerInput(originKey, [meetingChunk("Sem job")]), jobId: randomUUID() });
    if (fromHandler.status !== "ingested") throw new Error("expected ingested");
    expect(await jobCount(fromHandler.sourceId)).toBe(0);

    const empty = await ingestForProducer(producerInput(`meeting:${randomUUID()}`, []));
    expect(empty).toMatchObject({ status: "skipped", reason: "empty" });
    expect(await jobCount(empty.sourceId)).toBe(1);
  });

  test("manual ingest: idempotent replay, 409 while running, never 500, archived versions", async () => {
    const source = await createKnowledgeSource({
      body: { title: "Manual notes", sourceType: "manual_note" },
      projectRef: projectA.slug,
      requestId: "req",
      workspace,
    });
    const key = `ingest-${suffix}`;
    const ingest = (content: string, idempotencyKey: string | null = key) =>
      ingestKnowledgeSource({
        body: { content, title: "Notes", idempotencyKey },
        projectRef: projectA.slug,
        rawStore: null,
        requestId: `req-${randomUUID()}`,
        sourceId: source.id,
        workspace,
      });

    const first = await ingest("Garantia estendida de doze meses para clientes Acme.");
    const replay = await ingest("Garantia estendida de doze meses para clientes Acme.");
    expect(replay).toEqual(first);
    expect(first.chunkCount).toBe(1);
    expect(first.raw.status).toBe("pending");

    const [chunk] = await db
      .select({ stableKey: schema.knowledgeChunks.stableKey, chunkKey: schema.knowledgeChunks.chunkKey, hasVector: sql<boolean>`${schema.knowledgeChunks.searchVector} IS NOT NULL` })
      .from(schema.knowledgeChunks)
      .where(eq(schema.knowledgeChunks.documentId, first.document.id));
    expect(chunk?.stableKey).toBe("o0");
    expect(chunk?.chunkKey).toMatch(/^o0:0:[a-f0-9]{16}$/);
    expect(chunk?.hasVector).toBe(true);

    const [snapshot] = await db
      .select({ policy: schema.knowledgePermissionSnapshots.policyJson })
      .from(schema.knowledgePermissionSnapshots)
      .where(eq(schema.knowledgePermissionSnapshots.documentId, first.document.id));
    expect(snapshot?.policy).toMatchObject({ policyVersion: 2, trustTier: "said", retention: { retainUntil: null } });

    // A job still running with the key answers 409, not 500.
    const runningKey = `running-${suffix}`;
    await db.insert(schema.knowledgeIngestionJobs).values({
      organizationId: orgId,
      projectId: projectA.id,
      sourceId: source.id,
      status: "running",
      idempotencyKey: runningKey,
    });
    const conflict = await ingest("Outra coisa", runningKey).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ConsoleApiError);
    expect((conflict as ConsoleApiError).status).toBe(409);
    expect((conflict as ConsoleApiError).payload).toEqual({ error: "knowledge_ingestion_in_progress" });

    // Concurrent duplicates: each settles as the result or a 409, never anything else.
    const raceKey = `race-${suffix}`;
    const settled = await Promise.allSettled([ingest("Corrida um", raceKey), ingest("Corrida um", raceKey), ingest("Corrida um", raceKey)]);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ConsoleApiError);
        expect((outcome.reason as ConsoleApiError).status).toBe(409);
      }
    }
    expect(settled.some((outcome) => outcome.status === "fulfilled")).toBe(true);

    // A new version archives the previous one; the same content is not a new version.
    const v2 = await ingest("Garantia estendida de vinte e quatro meses.", null);
    const again = await ingest("Garantia estendida de vinte e quatro meses.", null);
    expect(again.document.id).toBe(v2.document.id);
    const statuses = await db
      .select({ status: schema.knowledgeDocuments.status })
      .from(schema.knowledgeDocuments)
      .where(eq(schema.knowledgeDocuments.sourceId, source.id));
    expect(statuses.filter((row) => row.status !== "archived")).toHaveLength(1);

    const audits = await db
      .select({ metadata: schema.auditEvents.metadataJson })
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, source.id), eq(schema.auditEvents.action, "knowledge_source.ingested")));
    for (const audit of audits) {
      expect(Object.keys(audit.metadata).sort()).toEqual(
        ["chunkCount", "contentHash", "documentId", "ingestionJobId", "parserVersion", "source", "versionNumber"].sort(),
      );
    }
  });

  test("writeKnowledgeRun stores no text: excerpt null, text_hash set, query_hash only with the key", async () => {
    const originKey = `meeting:${randomUUID()}`;
    await ingestForProducer(producerInput(originKey, [meetingChunk("Orçamento aprovado na reunião de terça")]));
    const found = await search("orcamento terca");
    expect(found.rows).toHaveLength(1);
    const row = found.rows[0]!;

    const previous = process.env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY;
    const run = async () =>
      writeKnowledgeRun({
        organizationId: orgId,
        projectId: null,
        audience: "operator",
        status: "completed",
        actorType: "cli",
        actorId: owner.id,
        callerJson: { surface: "cli", speaker: { kind: "terminal" }, conversation: "terminal", localInstallationId: laptop },
        localInstallationId: laptop,
        turnKey: "a".repeat(64),
        queryText: "orçamento terça",
        normalizedQuery: "orcamento terca",
        mode: found.mode,
        candidateCount: found.candidates.length,
        withheld: {},
        deniedReason: null,
        citations: [{ rank: 1, score: found.candidates[0]!.score, row }],
        durationMs: 12,
        requestId: "req",
        surface: "cli",
      });
    try {
      delete process.env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY;
      const withoutKey = await run();
      process.env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY = "k".repeat(40);
      const withKey = await run();

      const runs = await db
        .select({ id: schema.knowledgeRetrievalRuns.id, queryHash: schema.knowledgeRetrievalRuns.queryHash, prefilter: schema.knowledgeRetrievalRuns.prefilterJson })
        .from(schema.knowledgeRetrievalRuns)
        .where(inArray(schema.knowledgeRetrievalRuns.id, [withoutKey.runId, withKey.runId]));
      const byId = new Map(runs.map((item) => [item.id, item]));
      expect(byId.get(withoutKey.runId)?.queryHash).toBeNull();
      expect(byId.get(withKey.runId)?.queryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(byId.get(withKey.runId)?.prefilter).toMatchObject({ adapter: "pg_fts_v1", mode: "and" });

      const citations = await db
        .select()
        .from(schema.knowledgeCitations)
        .where(eq(schema.knowledgeCitations.retrievalRunId, withKey.runId));
      expect(citations).toHaveLength(1);
      expect(citations[0]).toMatchObject({ excerpt: null, textHash: row.textHash, documentVersion: 1, trustTier: "said", chunkId: row.chunkId });
      expect(JSON.stringify(citations[0]?.citationJson)).not.toContain("Orçamento");

      // deleteKnowledgeSourceContent keeps the citation with null ids, and nothing revives the source.
      const deleted = await deleteKnowledgeSourceContent({
        organizationId: orgId,
        sourceId: row.sourceId,
        actor: { type: "user", id: owner.id },
        reason: "user_deleted",
        requestId: "req",
      });
      expect(deleted).toEqual({ documents: 1, chunks: 1 });
      const [kept] = await db.select().from(schema.knowledgeCitations).where(eq(schema.knowledgeCitations.id, citations[0]!.id));
      // The source row stays (status deleted, no content), so only the document and chunk ids go null.
      expect(kept).toMatchObject({ sourceId: row.sourceId, documentId: null, chunkId: null, textHash: row.textHash });
      const [source] = await db.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, row.sourceId));
      expect(source?.status).toBe("deleted");
      expect(source?.revokedAt).not.toBeNull();
      const again = await ingestForProducer(producerInput(originKey, [meetingChunk("Orçamento aprovado na reunião de terça")]));
      expect(again).toMatchObject({ status: "skipped", reason: "source_deleted" });
      expect((await search("orcamento terca")).rows).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY;
      else process.env.RAVI_KNOWLEDGE_QUERY_HMAC_KEY = previous;
    }
  });

  test("drainKnowledgeJobs: backoff, dead letter at the 5th failure, leases", async () => {
    const source = await ingestForProducer(producerInput(`meeting:${randomUUID()}`, [meetingChunk("Fila de jobs")]));
    const enqueue = async (triggerType: KnowledgeTriggerType, key: string) =>
      enqueueKnowledgeJob({
        organizationId: orgId,
        projectId: projectA.id,
        sourceId: source.sourceId,
        triggerType,
        inputJson: {},
        idempotencyKey: `${key}-${suffix}`,
        requestId: "req",
        actor: { type: "system", id: null },
      });
    const job = async (id: string) =>
      (await db.select().from(schema.knowledgeIngestionJobs).where(eq(schema.knowledgeIngestionJobs.id, id)))[0]!;

    const first = await enqueue("faq", "fails");
    expect(first.created).toBe(true);
    expect(await enqueue("faq", "fails")).toEqual({ jobId: first.jobId, created: false });

    const failing = { faq: async () => { throw Object.assign(new Error("secret body"), { code: "boom" }); } };
    let clock = Date.now() + 1_000;
    const drain = () => drainKnowledgeJobs({ handlers: failing, workerId: "w", requestId: "req", now: () => new Date(clock) });

    expect(await drain()).toEqual({ claimed: 1, completed: 0, failed: 1, deadLettered: 0 });
    let row = await job(first.jobId);
    expect(row).toMatchObject({ status: "failed", attempts: 1, failureCode: "boom", failureMessage: "Error", lockedUntil: null });
    expect(row.nextAttemptAt!.getTime()).toBe(clock + 5_000);
    // Not due yet.
    expect((await drain()).claimed).toBe(0);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      clock += 10 * 60_000;
      const counts = await drain();
      expect(counts.claimed).toBe(1);
    }
    row = await job(first.jobId);
    expect(row).toMatchObject({ status: "canceled", failureCode: "dead_letter", attempts: 5 });
    clock += 10 * 60_000;
    expect((await drain()).claimed).toBe(0);

    // A live lease is never claimed twice; an expired one is, and one at the cap is dead-lettered.
    const live = await enqueue("page_backfill", "live");
    const expired = await enqueue("page_backfill", "expired");
    const capped = await enqueue("page_backfill", "capped");
    const now = Date.now();
    await db.update(schema.knowledgeIngestionJobs).set({ status: "running", attempts: 1, lockedBy: "other", lockedUntil: new Date(now + 60_000) }).where(eq(schema.knowledgeIngestionJobs.id, live.jobId));
    await db.update(schema.knowledgeIngestionJobs).set({ status: "running", attempts: 1, lockedBy: "dead", lockedUntil: new Date(now - 1_000) }).where(eq(schema.knowledgeIngestionJobs.id, expired.jobId));
    await db.update(schema.knowledgeIngestionJobs).set({ status: "running", attempts: 5, lockedBy: "dead", lockedUntil: new Date(now - 1_000) }).where(eq(schema.knowledgeIngestionJobs.id, capped.jobId));
    const handled: string[] = [];
    const counts = await drainKnowledgeJobs({
      handlers: { page_backfill: async (claimedJob) => { handled.push(claimedJob.id); return { resultJson: { status: "ok" } }; } },
      workerId: "w2",
      requestId: "req",
    });
    expect(handled).toEqual([expired.jobId]);
    expect(counts).toEqual({ claimed: 1, completed: 1, failed: 0, deadLettered: 1 });
    expect(await job(live.jobId)).toMatchObject({ status: "running", lockedBy: "other" });
    expect(await job(expired.jobId)).toMatchObject({ status: "completed", attempts: 2, resultJson: { status: "ok" }, lockedUntil: null });
    expect(await job(capped.jobId)).toMatchObject({ status: "canceled", failureCode: "dead_letter" });

    // A trigger type without a handler is left untouched.
    const orphan = await enqueue("meeting_backfill", "orphan");
    await drainKnowledgeJobs({ handlers: { page_backfill: async () => ({}) }, workerId: "w3", requestId: "req" });
    expect(await job(orphan.jobId)).toMatchObject({ status: "queued", attempts: 0 });
  });

  test("drainKnowledgeJobs claims one job right before it runs and writes outcomes only while it holds the lease", async () => {
    const source = await ingestForProducer(producerInput(`meeting:${randomUUID()}`, [meetingChunk("Fila preguiçosa")]));
    if (source.status !== "ingested") throw new Error("expected ingested");
    const enqueue = async (key: string) =>
      enqueueKnowledgeJob({
        organizationId: orgId,
        projectId: projectA.id,
        sourceId: source.sourceId,
        triggerType: "vector_backfill",
        inputJson: {},
        idempotencyKey: `${key}-${suffix}`,
        requestId: "req",
        actor: { type: "system", id: null },
      });
    const job = async (id: string) =>
      (await db.select().from(schema.knowledgeIngestionJobs).where(eq(schema.knowledgeIngestionJobs.id, id)))[0]!;
    const first = await enqueue("lazy-first");
    const second = await enqueue("lazy-second");
    const stolen = await enqueue("lazy-stolen");

    const seen: Array<{ id: string; secondStatus: string }> = [];
    const counts = await drainKnowledgeJobs({
      handlers: {
        vector_backfill: async (claimed) => {
          seen.push({ id: claimed.id, secondStatus: (await job(second.jobId)).status });
          // Another worker reclaims this one mid-run (its lease expired): this worker's outcome must not land.
          if (claimed.id === stolen.jobId) {
            await db.update(schema.knowledgeIngestionJobs).set({ lockedBy: "other" }).where(eq(schema.knowledgeIngestionJobs.id, stolen.jobId));
          }
          return { resultJson: { status: "ingested", documentId: source.documentId } };
        },
      },
      workerId: "lazy",
      requestId: "req",
    });
    // While the first job ran, the second was still queued: nothing waits under a lease.
    expect(seen.map((entry) => entry.id)).toEqual([first.jobId, second.jobId, stolen.jobId]);
    expect(seen[0]!.secondStatus).toBe("queued");
    expect(counts).toEqual({ claimed: 3, completed: 2, failed: 0, deadLettered: 0 });
    expect(await job(first.jobId)).toMatchObject({ status: "completed", documentId: source.documentId, lockedBy: null });
    expect(await job(stolen.jobId)).toMatchObject({ status: "running", lockedBy: "other", documentId: null });

    // A budget already spent claims nothing.
    const late = await enqueue("lazy-late");
    expect(await drainKnowledgeJobs({ handlers: { vector_backfill: async () => ({}) }, budgetMs: 0, workerId: "lazy", requestId: "req" })).toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect((await job(late.jobId)).status).toBe("queued");
    await db.delete(schema.knowledgeIngestionJobs).where(inArray(schema.knowledgeIngestionJobs.id, [late.jobId, stolen.jobId]));
  });

  test("ensureKnowledgeStrategy creates the org's rows once", async () => {
    const first = await ensureKnowledgeStrategy(orgId);
    const second = await ensureKnowledgeStrategy(orgId);
    expect(first.createdNow).toBe(true);
    expect(second).toEqual({ indexId: first.indexId, strategyId: first.strategyId, createdNow: false });
  });

  test("knowledge.chunks_stored is recorded once per document", async () => {
    const result = await ingestForProducer(producerInput(`meeting:${randomUUID()}`, [meetingChunk("Métrica um"), meetingChunk("Métrica dois")]));
    if (result.status !== "ingested") throw new Error("expected ingested");
    const event = buildKnowledgeUsageEvent({
      organizationId: orgId,
      projectId: projectA.id,
      metricKey: "knowledge.chunks_stored",
      eventType: "knowledge.document_ingested",
      id: result.documentId,
      quantity: 2,
      requestId: "req",
    });
    await recordKnowledgeUsage([event]);
    await recordKnowledgeUsage([event]);
    const events = await db
      .select({ quantity: schema.usageEvents.quantity, source: schema.usageEvents.source })
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.organizationId, orgId), eq(schema.usageEvents.idempotencyKey, event.idempotencyKey!)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "knowledge" });
    expect(Number(events[0]?.quantity)).toBe(2);
  });

  test("gap dedupe: one pending proposal per installation and dedupe key", async () => {
    const proposal = (installation: string) => ({
      organizationId: orgId,
      projectId: projectA.id,
      kind: "gap" as const,
      body: "Vocês dão desconto pra ONG?",
      localInstallationId: installation,
      dedupeKey: "d".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    await db.insert(schema.knowledgeProposals).values(proposal(laptop));
    await db.insert(schema.knowledgeProposals).values(proposal(server));
    const duplicate = await db.insert(schema.knowledgeProposals).values(proposal(laptop)).catch((error: unknown) => error);
    expect(JSON.stringify(duplicate, Object.getOwnPropertyNames(duplicate)) + String((duplicate as { cause?: unknown }).cause)).toContain("knowledge_proposals_pending_dedupe_unique");
    // Once decided, the same key may be asked again.
    await db
      .update(schema.knowledgeProposals)
      .set({ status: "approved" })
      .where(and(eq(schema.knowledgeProposals.organizationId, orgId), eq(schema.knowledgeProposals.localInstallationId, laptop)));
    await db.insert(schema.knowledgeProposals).values(proposal(laptop));
  });

  test("a re-login merges local_installations.metadata_json instead of replacing it", async () => {
    await db
      .update(schema.localInstallations)
      .set({ metadataJson: { knowledgeInstances: [{ id: "wa-main", label: "WhatsApp", channel: "whatsapp" }], source: "old" } })
      .where(eq(schema.localInstallations.id, laptop));
    await db
      .update(schema.localInstallations)
      .set({ metadataJson: sql`${schema.localInstallations.metadataJson} || ${JSON.stringify({ source: "cli-auth", userAgent: "ravi/test" })}::jsonb` })
      .where(eq(schema.localInstallations.id, laptop));
    const [row] = await db.select({ metadata: schema.localInstallations.metadataJson }).from(schema.localInstallations).where(eq(schema.localInstallations.id, laptop));
    expect(row?.metadata).toEqual({
      knowledgeInstances: [{ id: "wa-main", label: "WhatsApp", channel: "whatsapp" }],
      source: "cli-auth",
      userAgent: "ravi/test",
    });
  });
});
