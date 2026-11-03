import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { CliAuthContext } from "@/server/cli/auth";
import { db, schema } from "@/server/db";

import { handleKnowledgeCliGet } from "./cli-api";
import { handleKnowledgeOrgCli, respondKnowledgeOrgCli, type KnowledgeOrgCliDeps } from "./org-cli-api";
import { ingestForProducer, revokeKnowledgeSourceByOrigin, type ProducerChunkInput, type ProducerIngestInput } from "./producer";

// Audience, scope and gate checks for the org Knowledge CLI routes against a
// real database (CONTRACT §4, §5.3). Runs only with KNOWLEDGE_TEST_DATABASE_URL
// (and DATABASE_URL) pointing at a database with the current schema.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgA = randomUUID();
const orgB = randomUUID();
const projectA = { id: randomUUID(), slug: `kn-aud-a-${suffix}`, name: "Acme" };
const projectB = { id: randomUUID(), slug: `kn-aud-b-${suffix}`, name: "Beta" };
const owner = { id: randomUUID(), email: `kn-aud-${suffix}-owner@example.test` };
const viewer = { id: randomUUID(), email: `kn-aud-${suffix}-viewer@example.test` };
const laptop = randomUUID();
const server = randomUUID();
const rateBox = randomUUID();
const viewerBox = randomUUID();
const orgBBox = randomUUID();
const TURN = "b".repeat(64);
const READ = "console.knowledge.read";
const WRITE = "console.knowledge.write";

const scheduled: Array<() => Promise<unknown>> = [];
const backfills: string[] = [];
const testDeps: KnowledgeOrgCliDeps = {
  schedule: (task) => scheduled.push(task),
  startBackfill: async (input) => {
    backfills.push(input.organizationId);
    return { meetings: 0, pages: 0 };
  },
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cliAuth(input: { userId: string; organizationId: string; role: string; installationId: string; scopes?: string[] }): CliAuthContext {
  return {
    accessTokenJti: `jti-${randomUUID()}`,
    user: { id: input.userId, primaryEmail: "x@example.test", displayName: null, avatarUrl: null, status: "active" },
    organization: { id: input.organizationId, slug: "org", name: "Org", status: "active" },
    membership: { id: randomUUID(), role: input.role, status: "active" },
    localInstallation: {
      id: input.installationId,
      name: "box",
      hostname: null,
      platform: null,
      raviVersion: null,
      status: "active",
      lastSeenAt: new Date(),
    },
    cliSession: { id: randomUUID(), status: "active", expiresAt: new Date(Date.now() + 900_000), lastUsedAt: null },
    scopes: input.scopes ?? [READ, WRITE],
  };
}

const ownerLaptop = cliAuth({ userId: owner.id, organizationId: orgA, role: "owner", installationId: laptop });
const ownerServer = cliAuth({ userId: owner.id, organizationId: orgA, role: "owner", installationId: server });
const ownerRate = cliAuth({ userId: owner.id, organizationId: orgA, role: "owner", installationId: rateBox });
const viewerAuth = cliAuth({ userId: viewer.id, organizationId: orgA, role: "viewer", installationId: viewerBox });
const ownerOrgB = cliAuth({ userId: owner.id, organizationId: orgB, role: "owner", installationId: orgBBox });

function call(
  auth: CliAuthContext,
  method: "GET" | "POST",
  segments: string[],
  options: { body?: unknown; header?: unknown; search?: string } = {},
) {
  const headers = new Headers();
  if (options.header !== undefined) headers.set("x-ravi-exec-context", encode(options.header));
  return handleKnowledgeOrgCli(
    {
      method,
      auth,
      segments,
      searchParams: new URLSearchParams(options.search ?? ""),
      body: options.body ?? {},
      headers,
      requestId: `req-${randomUUID()}`,
      requestUrl: "https://console.test/api/cli/knowledge/x",
    },
    testDeps,
  );
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

type SearchPayload = {
  runId: string;
  results: Array<{ ref: string; kind: string; text: string; project: { id: string } | null; url: string | null; location: unknown; next: string[] }>;
  issues: string[];
};

async function search(auth: CliAuthContext, query: string, header?: unknown) {
  const result = await call(auth, "POST", ["search"], { body: { query }, header });
  expect(result.status).toBe(200);
  return result.payload as SearchPayload;
}

function producerInput(
  originKey: string,
  text: string,
  overrides: Partial<ProducerIngestInput> & { location?: ProducerChunkInput["location"] } = {},
): ProducerIngestInput {
  const { location, ...rest } = overrides;
  return {
    organizationId: orgA,
    projectId: projectA.id,
    originKey,
    sourceType: "meeting",
    trustTier: "said",
    title: "Kickoff Acme",
    sourceRef: {},
    retainUntil: null,
    document: {
      title: "Kickoff Acme",
      mimeType: "text/plain",
      parserVersion: "knowledge-test-v1",
      contentHash: sha(text),
      sizeBytes: Buffer.byteLength(text),
    },
    chunks: [
      {
        stableKey: "t0:x:p0",
        text,
        speakers: ["Luís"],
        location: location ?? { kind: "meeting", meetingId: randomUUID(), part: 0, startSeconds: 872.4, recordedAt: "2026-10-15T14:02:11Z" },
        metadata: { speakers: [{ id: "s1", name: "Luís" }] },
      },
    ],
    actor: { type: "system", id: null },
    triggerType: "meeting_ready",
    requestId: `req-${randomUUID()}`,
    ...rest,
  };
}

const meetingOrigin = `meeting:${randomUUID()}`;
const pageOrigin = `page:${randomUUID()}:/politica`;
const noteOrigin = `note:${randomUUID()}`;
const revokedOrigin = `meeting:${randomUUID()}`;

describeDb("knowledge audience and scope (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: owner.id, primaryEmail: owner.email, displayName: "owner" },
      { id: viewer.id, primaryEmail: viewer.email, displayName: "viewer" },
    ]);
    await db.insert(schema.organizations).values([
      { id: orgA, slug: `kn-aud-a-${suffix}`, name: "Audience A" },
      { id: orgB, slug: `kn-aud-b-${suffix}`, name: "Audience B" },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgA, userId: owner.id, role: "owner" },
      { organizationId: orgA, userId: viewer.id, role: "viewer" },
      { organizationId: orgB, userId: owner.id, role: "owner" },
    ]);
    // Only org A has Knowledge.
    await db.insert(schema.entitlements).values({ organizationId: orgA, key: "console.knowledge", valueJson: { enabled: true } });
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgA, slug: projectA.slug, name: projectA.name },
      { id: projectB.id, organizationId: orgA, slug: projectB.slug, name: projectB.name },
    ]);
    await db.insert(schema.projectMemberships).values({ projectId: projectA.id, userId: viewer.id, role: "viewer" });
    await db.insert(schema.localInstallations).values([
      { id: laptop, organizationId: orgA, userId: owner.id, name: "laptop" },
      { id: server, organizationId: orgA, userId: owner.id, name: "server" },
      { id: rateBox, organizationId: orgA, userId: owner.id, name: "rate" },
      { id: viewerBox, organizationId: orgA, userId: viewer.id, name: "viewer" },
      { id: orgBBox, organizationId: orgB, userId: owner.id, name: "org-b" },
    ]);
    await db.insert(schema.raviActorBindings).values([
      { installationId: laptop, organizationId: orgA, consoleUserId: owner.id, contactId: "ct_ok", linkedBy: owner.id },
      {
        installationId: laptop,
        organizationId: orgA,
        consoleUserId: owner.id,
        contactId: "ct_revoked",
        linkedBy: owner.id,
        status: "revoked",
        revokedAt: new Date(),
      },
      // Same installation, another organization.
      { installationId: laptop, organizationId: orgB, consoleUserId: owner.id, contactId: "ct_other_org", linkedBy: owner.id },
      // Same organization, another installation.
      { installationId: server, organizationId: orgA, consoleUserId: owner.id, contactId: "ct_server", linkedBy: owner.id },
      // Active, but bound to another user.
      { installationId: laptop, organizationId: orgA, consoleUserId: viewer.id, contactId: "ct_viewer", linkedBy: owner.id },
    ]);

    await ingestForProducer(producerInput(meetingOrigin, "Luís prometeu mandar até sexta"));
    await ingestForProducer(
      producerInput(pageOrigin, "Trocas em até sete dias corridos", {
        projectId: projectB.id,
        sourceType: "ravi_page",
        trustTier: "published",
        title: "Política",
        location: { kind: "page", host: `acme-${suffix}.ravi.page`, path: "/politica", anchor: "trocas", headingPath: ["Trocas"] },
      }),
    );
    await ingestForProducer(
      producerInput(noteOrigin, "Desconto para ONG é de dez por cento", {
        projectId: null,
        sourceType: "manual_note",
        trustTier: "approved",
        title: "Nota",
        location: { kind: "note" },
      }),
    );
    await ingestForProducer(producerInput(revokedOrigin, "Orçamento revisado aprovado ontem"));
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgA}::uuid, ${orgB}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, [owner.id, viewer.id]));
  });

  test("the first search starts the backfill once; results carry the §5.3 shape", async () => {
    const first = await search(ownerLaptop, "luis sexta");
    expect(first.issues).toContain("backfill_started");
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(backfills).toEqual([orgA]);

    const second = await search(ownerLaptop, "luis sexta");
    expect(second.issues).not.toContain("backfill_started");
    const [hit] = second.results;
    expect(hit).toMatchObject({
      kind: "meeting",
      text: "Luís prometeu mandar até sexta",
      project: { id: projectA.id, slug: projectA.slug, name: projectA.name },
      location: { kind: "meeting", startSeconds: 872.4, clock: "00:14:32", part: 0 },
    });
    expect(hit?.url).toContain(`/p/${projectA.id}/meetings/`);
    expect(hit?.url).toEndWith("?t=872.4");
  });

  test("owner DM: allowed only with an active binding for this installation, org and user", async () => {
    const dm = (contactId: string) => ({ v: 1, speaker: { kind: "owner", contactId }, conversation: "dm", turnKey: TURN });
    expect((await search(ownerLaptop, "luis sexta", dm("ct_ok"))).results.length).toBeGreaterThan(0);

    for (const contactId of ["ct_revoked", "ct_other_org", "ct_server", "ct_viewer", "ct_unknown"]) {
      const before = await deniedRuns(laptop);
      const error = await failure(call(ownerLaptop, "POST", ["search"], { body: { query: "luis sexta" }, header: dm(contactId) }));
      expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR", details: { reason: "binding" } });
      expect(await deniedRuns(laptop)).toBe(before + 1);
    }
  });

  test("groups, heartbeats, triggers and contacts get 403", async () => {
    const contexts = [
      { v: 1, speaker: { kind: "owner" }, conversation: "group" },
      { v: 1, routine: { kind: "heartbeat" }, speaker: { kind: "automation" }, conversation: "automation" },
      { v: 1, routine: { kind: "trigger", id: "t1" }, speaker: { kind: "automation" }, conversation: "automation" },
      { v: 1, speaker: { kind: "contact", contactId: "ct_ok" }, conversation: "dm" },
    ];
    for (const header of contexts) {
      const error = await failure(call(ownerLaptop, "POST", ["search"], { body: { query: "luis sexta" }, header }));
      expect(error).toMatchObject({ status: 403, code: "KNOWLEDGE_TURN_NOT_OPERATOR", details: { reason: "audience" } });
    }
    const [run] = await db
      .select()
      .from(schema.knowledgeRetrievalRuns)
      .where(and(eq(schema.knowledgeRetrievalRuns.localInstallationId, laptop), eq(schema.knowledgeRetrievalRuns.status, "denied")))
      .limit(1);
    expect(run?.queryText).toBeNull();
    expect(run?.deniedReason).toStartWith("turn_not_operator:");
  });

  test("scope: readable projects plus org-level chunks; a hidden ref reads like a missing one", async () => {
    // The owner reads every project and org-level notes.
    expect((await search(ownerLaptop, "trocas sete dias")).results.map((r) => r.kind)).toContain("page");
    const ownerNote = await search(ownerLaptop, "desconto ong");
    expect(ownerNote.results[0]).toMatchObject({ kind: "note", project: null, url: null, location: { kind: "note" } });

    // The viewer reads only project A, plus org-level chunks.
    const inScope = (results: SearchPayload["results"]) => results.every((r) => r.project === null || r.project.id === projectA.id);
    const viewerMeeting = await search(viewerAuth, "luis sexta");
    expect(viewerMeeting.results[0]).toMatchObject({ kind: "meeting", text: "Luís prometeu mandar até sexta" });
    expect(inScope(viewerMeeting.results)).toBe(true);
    const viewerPage = await search(viewerAuth, "trocas sete dias");
    expect(viewerPage.results.map((r) => r.kind)).not.toContain("page");
    expect(inScope(viewerPage.results)).toBe(true);
    expect((await search(viewerAuth, "desconto ong")).results[0]).toMatchObject({ kind: "note", project: null });
    const forbiddenProject = await failure(call(viewerAuth, "POST", ["search"], { body: { query: "trocas", project: projectB.slug } }));
    expect(forbiddenProject).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const pageRef = (await search(ownerLaptop, "trocas sete dias")).results.find((r) => r.kind === "page")!.ref;
    const read = await call(ownerLaptop, "POST", ["read"], { body: { ref: pageRef, around: 2 } });
    expect(read.payload).toMatchObject({ ref: pageRef, kind: "page", chunks: [{ ref: pageRef, focus: true }] });

    const respond = (ref: string) =>
      respondKnowledgeOrgCli(
        new Request("https://console.test/api/cli/knowledge/read", { method: "POST", body: JSON.stringify({ ref }) }),
        ["read"],
        "POST",
        { ...testDeps, authenticate: async () => viewerAuth },
      );
    const hidden = await respond(pageRef);
    const missing = await respond(`kc:${randomUUID()}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = (body: { error: Record<string, unknown> }) => ({ ...body.error, requestId: undefined });
    expect(strip(await hidden.json())).toEqual(strip(await missing.json()));
    expect(hidden.headers.get("cache-control")).toBe("no-store");
  });

  test("runs: only this installation's operator runs; revoked citations are unavailable", async () => {
    const fromServer = await search(ownerServer, "orcamento revisado");
    const fromLaptop = await search(ownerLaptop, "orcamento revisado");
    expect(fromLaptop.results).toHaveLength(1);

    const listed = (await call(ownerLaptop, "GET", ["runs"], { search: "limit=50" })).payload as { runs: Array<{ runId: string }> };
    const ids = listed.runs.map((run) => run.runId);
    expect(ids).toContain(fromLaptop.runId);
    expect(ids).not.toContain(fromServer.runId);
    expect(await failure(call(ownerLaptop, "GET", ["runs", fromServer.runId]))).toMatchObject({ status: 404, code: "NOT_FOUND" });

    const withTurn = await search(ownerLaptop, "luis sexta", { v: 1, speaker: { kind: "terminal" }, conversation: "terminal", turnKey: TURN });
    const byTurn = (await call(ownerLaptop, "GET", ["runs"], { search: `turnKey=${TURN}` })).payload as { runs: Array<{ runId: string; turnKey: string }> };
    expect(byTurn.runs.map((run) => run.runId)).toContain(withTurn.runId);
    expect(byTurn.runs.every((run) => run.turnKey === TURN)).toBe(true);

    const live = (await call(ownerLaptop, "GET", ["runs", fromLaptop.runId])).payload as { citations: Array<Record<string, unknown>> };
    expect(live.citations[0]).toMatchObject({ rank: 1, available: true, kind: "meeting", title: "Kickoff Acme" });

    await revokeKnowledgeSourceByOrigin({ organizationId: orgA, originKey: revokedOrigin, reason: "test", requestId: "req" });
    const after = (await call(ownerLaptop, "GET", ["runs", fromLaptop.runId])).payload as { citations: Array<Record<string, unknown>> };
    expect(after.citations[0]).toEqual({ rank: 1, ref: fromLaptop.results[0]!.ref, available: false });
  });

  test("next: bases views, read --around for a partial meeting, and the correction that targets a chunk", async () => {
    const origin = `meeting:${randomUUID()}`;
    const meetingId = randomUUID();
    const input = producerInput(origin, "Zeppelin chega quinta");
    await ingestForProducer({
      ...input,
      document: { ...input.document, contentHash: sha("zeppelin two windows") },
      chunks: [
        input.chunks[0]!,
        { ...input.chunks[0]!, stableKey: "t60:x:p0", text: "Depois falamos do frete", location: { kind: "meeting", meetingId, part: 0, startSeconds: 60 } },
      ],
    });
    const [hit] = (await search(ownerLaptop, "zeppelin quinta")).results;
    expect(hit?.next).toEqual([`ravi knowledge read ${hit!.ref} --around 2`]);

    await ingestForProducer({
      ...producerInput(`note:${randomUUID()}`, "Correção: o zeppelin chega sexta", {
        projectId: projectA.id,
        sourceType: "manual_note",
        trustTier: "approved",
        location: { kind: "note" },
      }),
      chunks: [{ stableKey: "o0", text: "Correção: o zeppelin chega sexta", location: { kind: "note" }, metadata: { corrects: hit!.ref } }],
    });
    const corrected = (await search(ownerLaptop, "zeppelin quinta")).results;
    const target = corrected.find((result) => result.ref === hit!.ref)!;
    expect(target.next).toHaveLength(2);
    expect(target.next[1]).toMatch(/^ravi knowledge read kc:[0-9a-f-]{36}$/);

    await ingestForProducer({
      ...producerInput(`page:${randomUUID()}:/estoque`, "Estoque atual da loja", {
        sourceType: "ravi_page",
        trustTier: "published",
        location: { kind: "page", host: `acme-${suffix}.ravi.page`, path: "/estoque", anchor: null },
      }),
      chunks: [
        {
          stableKey: "h:Estoque",
          text: "Estoque atual da loja",
          location: { kind: "page", host: `acme-${suffix}.ravi.page`, path: "/estoque", anchor: null },
          metadata: { baseViews: ["view_a", "view_b", "bad view; rm", "view_c", "view_d"] },
        },
      ],
    });
    const [page] = (await search(ownerLaptop, "estoque loja")).results;
    expect(page?.next).toEqual(["ravi bases views query view_a", "ravi bases views query view_b", "ravi bases views query view_c"]);
    expect(page?.url).toBe(`https://acme-${suffix}.ravi.page/estoque`);
  });

  test("sources lists the caller's scope", async () => {
    const owners = (await call(ownerLaptop, "GET", ["sources"])).payload as { sources: Array<{ id: string; kind: string; chunks: number; lastJob: unknown; project: { id: string } | null }> };
    expect(owners.sources.map((source) => source.kind)).toContain("page");
    expect(owners.sources.every((source) => source.lastJob !== null && source.chunks >= 1)).toBe(true);
    const viewers = (await call(viewerAuth, "GET", ["sources"])).payload as { sources: Array<{ project: { id: string } | null }> };
    expect(viewers.sources.length).toBeGreaterThan(0);
    expect(viewers.sources.every((source) => source.project === null || source.project.id === projectA.id)).toBe(true);
    expect(owners.sources.some((source) => source.project?.id === projectB.id)).toBe(true);

    const paged = (await call(ownerLaptop, "GET", ["sources"], { search: "limit=2" })).payload as { sources: unknown[]; nextCursor: string | null };
    expect(paged.sources).toHaveLength(2);
    expect(paged.nextCursor).not.toBeNull();
    const rest = (await call(ownerLaptop, "GET", ["sources"], { search: `limit=2&cursor=${paged.nextCursor}` })).payload as { sources: unknown[] };
    expect(rest.sources.length).toBeGreaterThan(0);
    expect(rest.sources).not.toContainEqual(paged.sources[0]);
    expect((await call(ownerLaptop, "GET", ["sources"], { search: "failing=1" })).payload).toEqual({ sources: [], nextCursor: null });
  });

  test("gates: entitlement off gives KNOWLEDGE_DISABLED (org) and PROJECT_ACCESS_DENIED (project); no DELETE", async () => {
    expect(await failure(call(ownerOrgB, "POST", ["search"], { body: { query: "luis" } }))).toMatchObject({
      status: 403,
      code: "KNOWLEDGE_DISABLED",
      details: { reason: "feature_unavailable" },
    });
    expect(await failure(handleKnowledgeCliGet({ auth: ownerOrgB, projectRef: "any", segments: ["sources"] }))).toMatchObject({
      status: 403,
      code: "PROJECT_ACCESS_DENIED",
    });
    const route = await import("@/app/api/cli/projects/[projectRef]/knowledge/[[...segments]]/route");
    expect("DELETE" in route).toBe(false);
    expect(typeof route.GET).toBe("function");
  });

  test("the 61st search in a minute gives 429", async () => {
    for (let index = 0; index < 60; index += 1) await search(ownerRate, "luis sexta");
    expect(await failure(call(ownerRate, "POST", ["search"], { body: { query: "luis sexta" } }))).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });

  test("every response has no-store; a missing ref is a NOT_FOUND envelope", async () => {
    const respond = (path: string, method: "GET" | "POST", body?: unknown, authenticate = async () => ownerLaptop) =>
      respondKnowledgeOrgCli(
        new Request(`https://console.test/api/cli/knowledge/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        path.split("?")[0]!.split("/"),
        method,
        { ...testDeps, authenticate },
      );
    const responses = [
      await respond("search", "POST", { query: "luis sexta" }),
      await respond("read", "POST", { ref: `kc:${randomUUID()}` }),
      await respond("runs", "GET"),
      await respond("nope", "GET"),
      await respond("search", "POST", { query: "luis" }, async () => ownerOrgB),
      await respond("search", "POST", { query: "" }),
    ];
    expect(responses.map((response) => response.status)).toEqual([200, 404, 200, 404, 403, 400]);
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await responses[1]!.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("usage: one knowledge.searches event per completed search run, none for denied runs", async () => {
    const completed = await db
      .select({ id: schema.knowledgeRetrievalRuns.id })
      .from(schema.knowledgeRetrievalRuns)
      .where(
        and(
          eq(schema.knowledgeRetrievalRuns.organizationId, orgA),
          eq(schema.knowledgeRetrievalRuns.status, "completed"),
          sql`${schema.knowledgeRetrievalRuns.normalizedQuery} IS NOT NULL`,
        ),
      );
    const denied = await db
      .select({ id: schema.knowledgeRetrievalRuns.id })
      .from(schema.knowledgeRetrievalRuns)
      .where(and(eq(schema.knowledgeRetrievalRuns.organizationId, orgA), eq(schema.knowledgeRetrievalRuns.status, "denied")));
    expect(denied.length).toBeGreaterThan(0);

    const events = await db
      .select({ idempotencyKey: schema.usageEvents.idempotencyKey, metricKey: schema.usageEvents.metricKey })
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.organizationId, orgA), eq(schema.usageEvents.eventType, "knowledge.search_completed")));
    expect(events).toHaveLength(completed.length);
    const keys = new Set(events.map((event) => event.idempotencyKey));
    for (const run of completed) expect(keys.has(`knowledge.search_completed:${run.id}:knowledge.searches`)).toBe(true);
    for (const run of denied) expect(keys.has(`knowledge.search_completed:${run.id}:knowledge.searches`)).toBe(false);
  });
});

async function deniedRuns(installationId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledgeRetrievalRuns)
    .where(
      and(
        eq(schema.knowledgeRetrievalRuns.localInstallationId, installationId),
        eq(schema.knowledgeRetrievalRuns.status, "denied"),
      ),
    );
  return Number(row?.count ?? 0);
}
