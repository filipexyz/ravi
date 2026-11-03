import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  createPageUploadSession,
  finalizePageUploadSession,
  type PageObjectStorage,
} from "@/server/console/pages/publish";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import type { KnowledgeOperatorCaller } from "./caller";
import { publishFaqAnswer, type PublishFaqDeps } from "./faq";
import { handleKnowledgeDigest, handleKnowledgeMirror, handleKnowledgeMarks, handleKnowledgeProposalCreate } from "./f2-cli";
import { readRouteMark, suspendRouteMark, writeRouteMark } from "./marks";
import { deleteKnowledgeSourceContent, ingestForProducer, revokeKnowledgeSourceByOrigin } from "./producer";
import {
  createKnowledgeProposal,
  decideKnowledgeProposal,
  getKnowledgeProposalForCaller,
  handleKnowledgeProposalCardPost,
  handleKnowledgeRouteCardPost,
  loadKnowledgeProposalCard,
  loadKnowledgeRouteCard,
  type KnowledgeCardPostDeps,
} from "./proposals";

// The F2 loop against Postgres: proposals, decisions, /faq, the mirror, the
// digest and the one-card routes. Runs only with KNOWLEDGE_TEST_DATABASE_URL
// (and DATABASE_URL) pointing at a database with the current schema.
const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgA = randomUUID();
const orgB = randomUUID();
const users = { owner: randomUUID(), member: randomUUID(), noRead: randomUUID(), outsider: randomUUID() };
const projects = { p: randomUUID(), q: randomUUID(), r: randomUUID() };
const sites = { p: randomUUID(), q: randomUUID(), r: randomUUID() };
const hosts = { p: `kn-p-${suffix}.ravi.page`, q: `kn-q-${suffix}.ravi.page`, r: `kn-r-${suffix}.ravi.page` };
const installs = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const routes = { politica: randomUUID(), outro: randomUUID() };
const origin = "https://console.test";

// ---------------------------------------------------------------------------
// In-memory page storage and upload fetch
// ---------------------------------------------------------------------------

const objects = new Map<string, string>();
let lastHtml = "";
const uploadFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const key = new URL(String(input)).pathname.slice(1);
  const body = init?.body;
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : String(body);
  objects.set(key, text);
  lastHtml = text;
  return new Response(null, { status: 200 });
}) as typeof fetch;

const storage: PageObjectStorage = {
  stagingPrefix: (input) => `staging/${input.organizationId}/${input.projectId}/${input.uploadSessionId}`,
  async createUploadPolicy(input) {
    return {
      driver: "test",
      directUpload: true,
      stagingPrefix: input.stagingPrefix,
      files: input.files.map((file) => ({
        path: file.path,
        stagingKey: `${input.stagingPrefix}/${file.path}`,
        method: "PUT",
        url: `https://upload.test/${input.stagingPrefix}/${file.path}`,
        headers: { "content-type": file.contentType },
      })),
    };
  },
  async verifyStagedObjects(input) {
    for (const file of input.files) {
      if (!objects.has(`${input.uploadSession.stagingPrefix}/${file.path}`)) throw new Error("staged object missing");
    }
  },
  async promoteObject(input) {
    const r2Key = `org/${input.organizationId}/project/${input.projectId}/artifact/${input.artifactId}/version/${input.artifactVersionId}/${input.path}`;
    objects.set(r2Key, objects.get(`${input.stagingPrefix}/${input.path}`) ?? "");
    return { r2Key };
  },
  async writeManifest(input) {
    return { r2Key: `manifests/${input.artifactVersionId}.json` };
  },
  async writeSiteManifest(input) {
    return { r2Key: `sites/${input.hostname}.json` };
  },
  async readObjectText(input) {
    return objects.get(input.key) ?? null;
  },
};

/** Stands in for the page capture: ingests the last uploaded /faq, `approved` only when its hash matches. */
const fakeCapture: NonNullable<PublishFaqDeps["capture"]> = async (target, options) => {
  const html = lastHtml;
  const sections = [...html.matchAll(/<h2 id="([^"]+)">([^<]*)<\/h2><p>([^<]*)<\/p>/g)];
  const [site] = await db.select().from(schema.pageSites).where(eq(schema.pageSites.id, target.siteId));
  return ingestForProducer({
    organizationId: site!.organizationId,
    projectId: site!.projectId,
    originKey: `page:${target.siteId}:/faq`,
    sourceType: "ravi_page",
    trustTier: sha256(html) === options.faqHtmlSha256 ? "approved" : "published",
    title: "Perguntas frequentes",
    sourceRef: { siteId: target.siteId, routeId: target.routeId, path: "/faq", releaseId: target.releaseId },
    document: { title: "Perguntas frequentes", mimeType: "text/html", parserVersion: "knowledge-page-v1", contentHash: sha256(html), sizeBytes: html.length },
    chunks: sections.map((match) => ({
      stableKey: `h:${match[2]}`,
      heading: match[2],
      text: `${match[2]}\n${match[3]}`,
      location: { kind: "page", siteId: target.siteId, routeId: target.routeId, path: "/faq", anchor: match[1] },
    })),
    actor: { type: "system", id: null },
    triggerType: "faq",
    requestId: target.requestId,
  });
};

const faqDeps: PublishFaqDeps = { storage, fetch: uploadFetch, capture: fakeCapture };

// ---------------------------------------------------------------------------
// Callers and workspaces
// ---------------------------------------------------------------------------

function callerFor(userId: string, organizationId: string, localInstallationId: string, role = "owner"): KnowledgeOperatorCaller {
  return {
    audience: "operator",
    workspace: { mode: "workos", user: { id: userId }, organization: { id: organizationId }, membership: { role: role as "owner" } },
    localInstallationId,
    turnKey: null,
    callerJson: { surface: "cli", speaker: { kind: "terminal" }, conversation: "terminal", localInstallationId },
  };
}

async function workspaceOf(userId: string, organizationId: string): Promise<ConsoleWorkspace | null> {
  const [row] = await db
    .select({ user: schema.users, organization: schema.organizations, membership: schema.organizationMemberships })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.organizationId))
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row ? { mode: "workos", ...row } : null;
}

function webDeps(userId: string, overrides: Partial<KnowledgeCardPostDeps> & { impersonated?: boolean } = {}): KnowledgeCardPostDeps {
  return {
    getAuth: async () => ({ mode: "workos", viewer: { email: "x@example.test", name: "x" } }) as never,
    viewerFromAuth: async () => ({ userId, impersonated: overrides.impersonated ?? false }),
    workspaceFor: async (_auth, organizationId) => workspaceOf(userId, organizationId),
    ...overrides,
  };
}

function cardRequest(path: string, fields: Array<[string, string]>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  return new NextRequest(`${origin}${path}`, { method: "POST", body: form, headers });
}

function gapBody(input: { project: string; question: string; instanceId?: string; dedupeKey?: string; idempotencyKey?: string }) {
  return {
    kind: "gap",
    project: input.project,
    title: null,
    body: input.question,
    evidence: [{ ref: "km:1", textHash: "h" }],
    supersedes: null,
    requestedAudience: { kind: "contacts", instanceId: input.instanceId ?? "wa-faq", label: "WhatsApp atendimento", localInstallationId: installs.c },
    dedupeKey: input.dedupeKey ?? sha256(input.question),
    idempotencyKey: input.idempotencyKey ?? `gap:${randomUUID()}`,
  };
}

async function capturePage(siteId: string, path: string, text: string) {
  const result = await ingestForProducer({
    organizationId: orgA,
    projectId: projects.p,
    originKey: `page:${siteId}:${path}`,
    sourceType: "ravi_page",
    trustTier: "published",
    title: path,
    sourceRef: { siteId, path },
    document: { title: path, mimeType: "text/html", parserVersion: "knowledge-page-v1", contentHash: sha256(text), sizeBytes: text.length },
    chunks: [{ stableKey: "h:Trocas", heading: "Trocas", text, location: { kind: "page", siteId, path, anchor: "trocas" } }],
    actor: { type: "system", id: null },
    triggerType: "page_release",
    requestId: "req",
  });
  if (result.status !== "ingested") throw new Error(`expected ingested, got ${result.status}`);
  return result;
}

async function inboxItems(eventType: string, sourceId: string) {
  return db
    .select()
    .from(schema.agentInboxItems)
    .where(and(eq(schema.agentInboxItems.eventType, eventType), eq(schema.agentInboxItems.sourceId, sourceId)))
    .orderBy(desc(schema.agentInboxItems.createdAt));
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (caught: unknown) => caught,
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const ownerCaller = () => callerFor(users.owner, orgA, installs.a);

describeDb("knowledge F2 loop (DB)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values([
      { id: users.owner, primaryEmail: `kn-owner-${suffix}@example.test`, displayName: "owner" },
      { id: users.member, primaryEmail: `kn-member-${suffix}@example.test`, displayName: "member" },
      { id: users.noRead, primaryEmail: `kn-noread-${suffix}@example.test`, displayName: "noread" },
      { id: users.outsider, primaryEmail: `kn-outsider-${suffix}@example.test`, displayName: "outsider" },
    ]);
    await db.insert(schema.organizations).values([
      { id: orgA, slug: `kn-a-${suffix}`, name: "Knowledge A" },
      { id: orgB, slug: `kn-b-${suffix}`, name: "Knowledge B" },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgA, userId: users.owner, role: "owner" },
      { organizationId: orgB, userId: users.owner, role: "developer" },
      { organizationId: orgA, userId: users.member, role: "viewer" },
      { organizationId: orgA, userId: users.noRead, role: "viewer" },
      { organizationId: orgB, userId: users.outsider, role: "owner" },
    ]);
    await db.insert(schema.projects).values([
      { id: projects.p, organizationId: orgA, slug: `p-${suffix}`, name: "Acme" },
      { id: projects.q, organizationId: orgA, slug: `q-${suffix}`, name: "Private" },
      { id: projects.r, organizationId: orgA, slug: `r-${suffix}`, name: "Taken" },
    ]);
    await db.insert(schema.projectMemberships).values([{ projectId: projects.p, userId: users.member, role: "developer" }]);
    await db.insert(schema.localInstallations).values([
      { id: installs.a, organizationId: orgA, userId: users.owner, name: "laptop", metadataJson: { source: "cli-auth", userAgent: "ravi/1" } },
      { id: installs.b, organizationId: orgA, userId: users.owner, name: "server" },
      { id: installs.c, organizationId: orgB, userId: users.outsider, name: "other-org", metadataJson: { knowledgeInstances: [{ id: "wa-main", label: "B" }] } },
    ]);
    await db.insert(schema.pageSites).values([
      { id: sites.p, organizationId: orgA, projectId: projects.p, slug: `kn-p-${suffix}`, defaultHostname: hosts.p, defaultVisibility: "public", isDefault: true },
      { id: sites.q, organizationId: orgA, projectId: projects.q, slug: `kn-q-${suffix}`, defaultHostname: hosts.q, defaultVisibility: "private", isDefault: true },
      { id: sites.r, organizationId: orgA, projectId: projects.r, slug: `kn-r-${suffix}`, defaultHostname: hosts.r, defaultVisibility: "public", isDefault: true },
    ]);
    await db.insert(schema.pageRoutes).values([
      { id: routes.politica, organizationId: orgA, projectId: projects.p, siteId: sites.p, path: "/politica", matchType: "spa" },
      { id: routes.outro, organizationId: orgA, projectId: projects.p, siteId: sites.p, path: "/outro", matchType: "spa" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id IN (${orgA}::uuid, ${orgB}::uuid)`).catch(() => undefined);
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgA}::uuid, ${orgB}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, Object.values(users)));
  });

  // -------------------------------------------------------------------------
  test("proposals: gap dedupe per installation, idempotency, expiry and forced installation", async () => {
    const caller = ownerCaller();
    const body = gapBody({ project: `p-${suffix}`, question: "Vocês dão desconto pra ONG?", dedupeKey: "d".repeat(64), idempotencyKey: "gap:first" });
    const first = await createKnowledgeProposal({ caller, body, requestId: "req", origin });
    expect(first).toMatchObject({ deduped: false, created: true });
    expect(first.proposal.cardUrl).toBe(`${origin}/k/${first.proposal.id}`);
    const expiresIn = Date.parse(first.proposal.expiresAt) - Date.parse(first.proposal.createdAt);
    expect(Math.abs(expiresIn - 30 * 24 * 3600 * 1000)).toBeLessThan(60_000);

    const [row] = await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, first.proposal.id));
    expect(row?.localInstallationId).toBe(installs.a);
    expect(row?.requestedAudienceJson).toEqual({ kind: "contacts", localInstallationId: installs.a, instanceId: "wa-faq", label: "WhatsApp atendimento" });
    expect(row?.proposedByJson).toMatchObject({ surface: "cli" });

    const again = await createKnowledgeProposal({ caller, body: { ...body, idempotencyKey: "gap:second" }, requestId: "req", origin });
    expect(again).toMatchObject({ deduped: true });
    expect(again.proposal.id).toBe(first.proposal.id);
    expect(again.proposal.waitingCount).toBe(2);

    const other = await createKnowledgeProposal({ caller: callerFor(users.owner, orgA, installs.b), body: { ...body, idempotencyKey: "gap:third" }, requestId: "req", origin });
    expect(other.deduped).toBe(false);
    expect(other.proposal.id).not.toBe(first.proposal.id);

    const replay = await createKnowledgeProposal({ caller, body, requestId: "req", origin });
    expect(replay.proposal.id).toBe(first.proposal.id);
    const replayHandler = await handleKnowledgeProposalCreate({
      caller,
      auth: {} as CliAuthContext,
      segments: ["proposals"],
      searchParams: new URLSearchParams(),
      body,
      requestId: "req",
      requestUrl: `${origin}/api/cli/knowledge/proposals`,
    });
    expect((replayHandler.payload as { proposal: { id: string } }).proposal.id).toBe(first.proposal.id);

    // Another installation may not read it by the same key, nor by id without project access.
    const stolen = await failure(createKnowledgeProposal({ caller: callerFor(users.owner, orgA, installs.b), body, requestId: "req", origin }));
    expect((stolen as CliApiError).status).toBe(409);
    const outside = await failure(getKnowledgeProposalForCaller({ caller: callerFor(users.outsider, orgB, installs.c), id: first.proposal.id, origin }));
    expect((outside as CliApiError).status).toBe(404);
    expect((await getKnowledgeProposalForCaller({ caller, id: first.proposal.id, origin })).id).toBe(first.proposal.id);

    // An unreadable project is 404.
    const hidden = await failure(
      createKnowledgeProposal({ caller: callerFor(users.noRead, orgA, installs.a, "viewer"), body: { ...body, idempotencyKey: "gap:x" }, requestId: "req", origin }),
    );
    expect((hidden as CliApiError).status).toBe(404);
  });

  // -------------------------------------------------------------------------
  test("decisions: a non-admin member is refused; approving a note creates note:<id> with tier approved", async () => {
    const { proposal } = await createKnowledgeProposal({
      caller: ownerCaller(),
      body: { kind: "note", project: `p-${suffix}`, title: "Prazo de troca", body: "Trocas em até 30 dias.", evidence: [{ ref: "kc:1", textHash: "h" }], supersedes: null, idempotencyKey: "note:1" },
      requestId: "req",
      origin,
    });
    const member = await workspaceOf(users.member, orgA);
    const refused = await failure(decideKnowledgeProposal({ workspace: member!, id: proposal.id, decision: "approve", requestId: "req", origin }));
    expect(refused).toBeInstanceOf(ConsoleApiError);
    expect((refused as ConsoleApiError).status).toBe(403);

    const owner = await workspaceOf(users.owner, orgA);
    const wrong = await failure(decideKnowledgeProposal({ workspace: owner!, id: proposal.id, decision: "publish", requestId: "req", origin }));
    expect((wrong as ConsoleApiError).status).toBe(400);
    const approved = await decideKnowledgeProposal({ workspace: owner!, id: proposal.id, decision: "approve", requestId: "req", origin });
    expect(approved.status).toBe("approved");

    const [source] = await db
      .select()
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.organizationId, orgA), eq(schema.knowledgeSources.originKey, `note:${proposal.id}`)));
    expect(source).toMatchObject({ trustTier: "approved", sourceType: "manual_note", projectId: projects.p, status: "active" });
    const chunks = await db.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.sourceId, source!.id));
    expect(chunks.map((chunk) => chunk.trustTier)).toEqual(["approved"]);
    expect(chunks[0]?.safeMetadataJson).toMatchObject({ evidence: ["kc:1"] });
    const closed = await failure(decideKnowledgeProposal({ workspace: owner!, id: proposal.id, decision: "reject", requestId: "req", origin }));
    expect((closed as ConsoleApiError).status).toBe(409);

    // `kc:` evidence sent with an empty hash (the CLI holds no chunk text) is
    // stored with the chunk's own text_hash; a forged hash is replaced too.
    const chunk = chunks[0]!;
    const { proposal: cited } = await createKnowledgeProposal({
      caller: ownerCaller(),
      body: {
        kind: "correction",
        project: `p-${suffix}`,
        body: "Trocas em até 15 dias.",
        evidence: [
          { ref: `kc:${chunk.id}`, textHash: "" },
          { ref: `kc:${chunk.id.toUpperCase()}`, textHash: "forged" },
          { ref: "kc:00000000-0000-4000-8000-000000000000", textHash: "" },
        ],
        supersedes: `kc:${chunk.id}`,
        idempotencyKey: "correction:kc",
      },
      requestId: "req",
      origin,
    });
    const [stored] = await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, cited.id));
    expect(stored?.evidenceJson).toEqual([
      { ref: `kc:${chunk.id}`, textHash: chunk.textHash },
      { ref: `kc:${chunk.id.toUpperCase()}`, textHash: chunk.textHash },
      { ref: "kc:00000000-0000-4000-8000-000000000000", textHash: "" },
    ]);
    await decideKnowledgeProposal({ workspace: owner!, id: cited.id, decision: "reject", requestId: "req", origin });
  });

  // -------------------------------------------------------------------------
  test("transcripts: a decided transcript keeps only its body hash; deleting its source purges the body too", async () => {
    const owner = await workspaceOf(users.owner, orgA);
    const transcript = (key: string, text: string) =>
      createKnowledgeProposal({
        caller: ownerCaller(),
        body: {
          kind: "transcript",
          project: `p-${suffix}`,
          title: "Reunião",
          body: JSON.stringify({ meeting: { title: "Reunião" }, segments: [{ speaker: "Ana", startSec: 0, text }] }),
          idempotencyKey: key,
        },
        requestId: "req",
        origin,
      });
    const stored = async (id: string) => (await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, id)))[0]!;

    const rejected = (await transcript("transcript:reject", "Conversa descartada.")).proposal;
    const rejectedBody = (await stored(rejected.id)).body!;
    await decideKnowledgeProposal({ workspace: owner!, id: rejected.id, decision: "reject", requestId: "req", origin });
    expect(await stored(rejected.id)).toMatchObject({ status: "rejected", body: null, bodyHash: sha256(rejectedBody) });

    const approved = (await transcript("transcript:approve", "Fechamos o orçamento.")).proposal;
    const approvedBody = (await stored(approved.id)).body!;
    const view = await decideKnowledgeProposal({ workspace: owner!, id: approved.id, decision: "approve", requestId: "req", origin });
    expect(view).toMatchObject({ status: "approved", body: "" });
    expect(await stored(approved.id)).toMatchObject({ body: null, bodyHash: sha256(approvedBody) });
    const [source] = await db
      .select()
      .from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.organizationId, orgA), eq(schema.knowledgeSources.originKey, `transcript:${approved.id}`)));
    expect(source?.status).toBe("active");

    // Were the body still there, deleting the source's content (a person, or retention) purges it as well.
    await db.update(schema.knowledgeProposals).set({ body: approvedBody }).where(eq(schema.knowledgeProposals.id, approved.id));
    await deleteKnowledgeSourceContent({ organizationId: orgA, sourceId: source!.id, actor: { type: "user", id: users.owner }, reason: "user_deleted", requestId: "req" });
    expect(await stored(approved.id)).toMatchObject({ body: null, bodyHash: sha256(approvedBody) });
  });

  // -------------------------------------------------------------------------
  test("/faq publish: public effective visibility, approved capture, faq mark, inbox item", async () => {
    const { proposal } = await createKnowledgeProposal({
      caller: ownerCaller(),
      body: gapBody({ project: `p-${suffix}`, question: "Qual o prazo de entrega?" }),
      requestId: "req",
      origin,
    });
    const result = await publishFaqAnswer(
      { proposalId: proposal.id, answer: "Até 5 dias úteis.", faqQuestion: "Qual é o prazo de entrega?", actorUserId: users.owner, requestId: "req", origin },
      faqDeps,
    );
    expect(result.url).toBe(`https://${hosts.p}/faq`);
    expect(result.anchor).toBe("qual-e-o-prazo-de-entrega");
    expect(lastHtml).toContain('<h2 id="qual-e-o-prazo-de-entrega">');

    // Effective visibility: the site default and the active release route together.
    const [site] = await db.select().from(schema.pageSites).where(eq(schema.pageSites.id, sites.p));
    const [releaseRoute] = await db
      .select()
      .from(schema.pageReleaseRoutes)
      .where(and(eq(schema.pageReleaseRoutes.releaseId, site!.activeReleaseId!), eq(schema.pageReleaseRoutes.path, "/faq")));
    expect(site?.defaultVisibility).toBe("public");
    expect(releaseRoute?.visibility).toBe("public");

    const [stored] = await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, proposal.id));
    expect(stored).toMatchObject({ status: "approved", answerText: "Até 5 dias úteis.", faqQuestion: "Qual é o prazo de entrega?", decidedByUserId: users.owner });
    expect(stored?.resultJson).toMatchObject({ anchor: result.anchor, url: result.url, releaseId: site!.activeReleaseId });

    const [route] = await db.select().from(schema.pageRoutes).where(eq(schema.pageRoutes.id, releaseRoute!.routeId));
    const mark = readRouteMark(route?.routeConfigJson);
    expect(mark).toMatchObject({ state: "active", managedBy: "faq", faqHtmlSha256: sha256(lastHtml), approvedDocumentId: result.documentId });
    expect(mark?.audiences).toEqual([{ kind: "contacts", localInstallationId: installs.a, instanceId: "wa-faq", label: "WhatsApp atendimento" }]);

    const chunks = await db.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.documentId, result.documentId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((chunk) => chunk.trustTier))).toEqual(new Set(["approved"]));

    const items = await inboxItems("knowledge.gap.answered", proposal.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      targetType: "local_installation",
      targetId: installs.a,
      severity: "success",
      sensitivity: "metadata",
      title: "Knowledge gap answered",
      summary: null,
      dedupeKey: `knowledge:gap:${proposal.id}:answered`,
      payloadJson: { proposalId: proposal.id, projectId: projects.p },
    });
    expect(items[0]?.linksJson).toEqual({ cardUrl: `${origin}/k/${proposal.id}`, faqUrl: `${result.url}#${result.anchor}` });

    const view = await getKnowledgeProposalForCaller({ caller: ownerCaller(), id: proposal.id, origin });
    expect(view.faq).toEqual({ url: result.url, anchor: result.anchor });
    expect(view.answer).toBe("Até 5 dias úteis.");
  });

  test("/faq: a private-default site is 409 faq_site_not_public; a user /faq is 409 faq_route_taken", async () => {
    const privateGap = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `q-${suffix}`, question: "Privado?" }), requestId: "req", origin });
    const notPublic = await failure(
      publishFaqAnswer({ proposalId: privateGap.proposal.id, answer: "x", faqQuestion: "Privado?", actorUserId: users.owner, requestId: "req" }, faqDeps),
    );
    expect((notPublic as ConsoleApiError).status).toBe(409);
    expect((notPublic as ConsoleApiError).payload.error).toBe("faq_site_not_public");

    // Someone publishes their own /faq on project R's site.
    const context = { actorId: users.owner, actorType: "user" as const, membershipRole: "owner", organizationId: orgA };
    const html = "<html><body><h1>Nossa FAQ</h1></body></html>";
    const manifest = { entrypoint: "index.html", files: [{ path: "index.html", sha256: sha256(html), sizeBytes: Buffer.byteLength(html) }] };
    const session = await createPageUploadSession({ context, input: { projectRef: projects.r, siteRef: sites.r, packageManifest: manifest }, requestId: "req", storage });
    objects.set(`${session.uploadSession.stagingPrefix}/index.html`, html);
    await finalizePageUploadSession({
      context,
      input: { uploadSessionId: session.uploadSession.id, packageManifest: manifest, artifact: { slug: "user-faq" }, publish: { siteRef: sites.r, route: { path: "/faq", visibility: "public" } } },
      requestId: "req",
      storage,
    });
    const takenGap = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `r-${suffix}`, question: "Taken?" }), requestId: "req", origin });
    const taken = await failure(
      publishFaqAnswer({ proposalId: takenGap.proposal.id, answer: "x", faqQuestion: "Taken?", actorUserId: users.owner, requestId: "req" }, faqDeps),
    );
    expect((taken as ConsoleApiError).payload.error).toBe("faq_route_taken");
    const [still] = await db.select().from(schema.knowledgeProposals).where(eq(schema.knowledgeProposals.id, takenGap.proposal.id));
    expect(still?.status).toBe("pending");
  });

  test("/faq: two concurrent publishes for one project both end on the page", async () => {
    const one = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `p-${suffix}`, question: "Aceitam Pix?" }), requestId: "req", origin });
    const two = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `p-${suffix}`, question: "Tem loja física?" }), requestId: "req", origin });
    const [a, b] = await Promise.all([
      publishFaqAnswer({ proposalId: one.proposal.id, answer: "Sim.", faqQuestion: "Aceitam Pix?", actorUserId: users.owner, requestId: "req-a" }, faqDeps),
      publishFaqAnswer({ proposalId: two.proposal.id, answer: "Não.", faqQuestion: "Tem loja física?", actorUserId: users.owner, requestId: "req-b" }, faqDeps),
    ]);
    expect(lastHtml).toContain(`id="${a.anchor}"`);
    expect(lastHtml).toContain(`id="${b.anchor}"`);
    expect(lastHtml).toContain('id="qual-e-o-prazo-de-entrega"');
    expect((lastHtml.match(/<h2 /g) ?? []).length).toBe(3);
  });

  test("/faq with the real page capture: the Console-rendered hash makes the capture approved", async () => {
    const gap = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `p-${suffix}`, question: "Entregam no sábado?" }), requestId: "req", origin });
    const result = await publishFaqAnswer(
      { proposalId: gap.proposal.id, answer: "Sim, até as 12h.", faqQuestion: "Entregam no sábado?", actorUserId: users.owner, requestId: "req-real" },
      { storage, fetch: uploadFetch },
    );
    const chunks = await db.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.documentId, result.documentId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((chunk) => chunk.trustTier))).toEqual(new Set(["approved"]));
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("Sim, até as 12h.");
  });

  // -------------------------------------------------------------------------
  test("card routes: trusted origin, impersonation, contacts audiences, 303 to ?done= and the marks inbox item", async () => {
    // The installation reports its instances first (the mirror call).
    await handleKnowledgeMirror({
      caller: ownerCaller(),
      auth: { organization: { id: orgA } } as CliAuthContext,
      segments: ["mirror"],
      searchParams: new URLSearchParams(),
      body: { instances: [{ id: "wa-main", label: "WhatsApp atendimento", channel: "whatsapp" }, { id: "wa-other", label: "Outro", channel: "whatsapp" }] },
      requestId: "req",
      requestUrl: `${origin}/api/cli/knowledge/mirror`,
    });
    const reviewed = await capturePage(sites.p, "/politica", "Trocas em até sete dias.");
    await capturePage(sites.p, "/outro", "Outra página.");

    const fields = (audiences: string[], expectedDocumentId: string | null = reviewed.documentId): Array<[string, string]> => [
      ["routeId", routes.politica],
      ["action", "mark"],
      ...(expectedDocumentId ? [["expectedDocumentId", expectedDocumentId] as [string, string]] : []),
      ...audiences.map((value): [string, string] => ["audiences", value]),
    ];
    const untrusted = await handleKnowledgeRouteCardPost(
      cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"]), {}),
      webDeps(users.owner),
    );
    expect(untrusted.status).toBe(403);
    const crossSite = await handleKnowledgeRouteCardPost(
      cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"]), { "sec-fetch-site": "cross-site" }),
      webDeps(users.owner),
    );
    expect(crossSite.status).toBe(403);

    const impersonated = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"])), webDeps(users.owner, { impersonated: true }));
    expect(impersonated.status).toBe(303);
    expect(impersonated.headers.get("location")).toBe(`${origin}/k/routes/${routes.politica}?error=impersonated`);

    const otherOrg = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields([`contacts:${installs.c}:wa-main`])), webDeps(users.owner));
    expect(otherOrg.status).toBe(400);
    expect(await otherOrg.text()).toBe("Unknown contacts audience.");
    const unreported = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields([`contacts:${installs.a}:wa-nope`])), webDeps(users.owner));
    expect(unreported.status).toBe(400);
    expect(readRouteMark((await db.select().from(schema.pageRoutes).where(eq(schema.pageRoutes.id, routes.politica)))[0]?.routeConfigJson)).toBeNull();

    const notAdmin = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"])), webDeps(users.member));
    expect(notAdmin.headers.get("location")).toBe(`${origin}/k/routes/${routes.politica}?error=knowledge_mark_forbidden`);

    // A card that did not say which version it showed, or showed one that is no longer current, marks nothing.
    const unpinned = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"], null)), webDeps(users.owner));
    expect(unpinned.headers.get("location")).toBe(`${origin}/k/routes/${routes.politica}?error=knowledge_mark_stale`);
    const stale = await handleKnowledgeRouteCardPost(cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers"], randomUUID())), webDeps(users.owner));
    expect(stale.headers.get("location")).toBe(`${origin}/k/routes/${routes.politica}?error=knowledge_mark_stale`);
    expect(readRouteMark((await db.select().from(schema.pageRoutes).where(eq(schema.pageRoutes.id, routes.politica)))[0]?.routeConfigJson)).toBeNull();

    const done = await handleKnowledgeRouteCardPost(
      cardRequest("/api/console/knowledge/cards/routes", fields(["page_viewers", `contacts:${installs.a}:wa-main`])),
      webDeps(users.owner),
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${origin}/k/routes/${routes.politica}?done=mark`);
    const [marked] = await db.select().from(schema.pageRoutes).where(eq(schema.pageRoutes.id, routes.politica));
    expect(readRouteMark(marked?.routeConfigJson)?.audiences).toEqual([
      { kind: "page_viewers" },
      { kind: "contacts", localInstallationId: installs.a, instanceId: "wa-main", label: "WhatsApp atendimento" },
    ]);

    const items = await inboxItems("knowledge.marks.changed", routes.politica);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toMatchObject({
      targetType: "organization",
      targetId: orgA,
      title: "Knowledge marks changed",
      summary: null,
      sourceType: "page_route",
      payloadJson: { routeId: routes.politica, action: "mark" },
      linksJson: {},
    });
    expect(JSON.stringify(items[0])).not.toMatch(/Trocas|WhatsApp/);

    // /outro: marked for another instance only.
    await writeRouteMark({
      routeId: routes.outro,
      action: "mark",
      audiences: [{ kind: "contacts", localInstallationId: installs.a, instanceId: "wa-other", label: "Outro" }],
      actorUserId: users.owner,
      requestId: "req",
    });

    // The proposal card: dismiss a gap.
    const gap = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `p-${suffix}`, question: "Spam?" }), requestId: "req", origin });
    const dismissed = await handleKnowledgeProposalCardPost(
      cardRequest("/api/console/knowledge/cards/proposals", [["id", gap.proposal.id], ["decision", "dismiss"]]),
      webDeps(users.owner),
    );
    expect(dismissed.status).toBe(303);
    expect(dismissed.headers.get("location")).toBe(`${origin}/k/${gap.proposal.id}?done=dismiss`);
    const untrustedProposal = await handleKnowledgeProposalCardPost(
      cardRequest("/api/console/knowledge/cards/proposals", [["id", gap.proposal.id], ["decision", "dismiss"]], {}),
      webDeps(users.owner),
    );
    expect(untrustedProposal.status).toBe(403);
  });

  test("card pages: same not-found view for another org, no project read and a missing id; a two-org user sees the item's org", async () => {
    const { proposal } = await createKnowledgeProposal({ caller: ownerCaller(), body: gapBody({ project: `p-${suffix}`, question: "Visível?" }), requestId: "req", origin });
    const resolver = (userId: string) => (organizationId: string) => workspaceOf(userId, organizationId);

    const missing = await loadKnowledgeProposalCard({ id: randomUUID(), workspaceFor: resolver(users.owner) });
    const outsider = await loadKnowledgeProposalCard({ id: proposal.id, workspaceFor: resolver(users.outsider) });
    const noRead = await loadKnowledgeProposalCard({ id: proposal.id, workspaceFor: resolver(users.noRead) });
    expect(missing).toEqual({ kind: "not_found" });
    expect(outsider).toEqual(missing);
    expect(noRead).toEqual(missing);

    // The owner is a member of two orgs; the card resolves the item's org, not a selected one.
    const asked: string[] = [];
    const ownerCard = await loadKnowledgeProposalCard({
      id: proposal.id,
      workspaceFor: (organizationId) => {
        asked.push(organizationId);
        return workspaceOf(users.owner, organizationId);
      },
    });
    expect(asked).toEqual([orgA]);
    expect(ownerCard).toMatchObject({ kind: "proposal", canDecide: true, proposal: { id: proposal.id, kind: "gap", body: "Visível?", audienceLabel: "WhatsApp atendimento" } });
    const memberCard = await loadKnowledgeProposalCard({ id: proposal.id, workspaceFor: resolver(users.member) });
    expect(memberCard).toMatchObject({ kind: "proposal", canDecide: false });

    expect(await loadKnowledgeRouteCard({ routeId: routes.politica, workspaceFor: resolver(users.outsider) })).toEqual({ kind: "not_found" });
    expect(await loadKnowledgeRouteCard({ routeId: routes.politica, workspaceFor: resolver(users.noRead) })).toEqual({ kind: "not_found" });
    const routeCard = await loadKnowledgeRouteCard({ routeId: routes.politica, workspaceFor: resolver(users.owner) });
    expect(routeCard).toMatchObject({ kind: "route", canDecide: true, route: { state: "active", url: `https://${hosts.p}/politica` } });
    if (routeCard.kind === "route") expect(routeCard.route.currentDocumentId).toMatch(/^[0-9a-f-]{36}$/);
    if (routeCard.kind === "route") {
      expect(routeCard.route.audiences.find((item) => item.value === `contacts:${installs.a}:wa-main`)).toMatchObject({ checked: true, label: "Contacts of WhatsApp atendimento" });
      expect(routeCard.route.audiences.find((item) => item.value === "page_viewers")?.checked).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  test("mirror: active contacts marks for this installation and its sent instances; merge keeps metadata; revoked drops", async () => {
    const mirror = async () =>
      (
        await handleKnowledgeMirror({
          caller: ownerCaller(),
          auth: { organization: { id: orgA } } as CliAuthContext,
          segments: ["mirror"],
          searchParams: new URLSearchParams(),
          body: { instances: [{ id: "wa-main", label: "WhatsApp atendimento", channel: "whatsapp" }] },
          requestId: "req",
          requestUrl: `${origin}/api/cli/knowledge/mirror`,
        })
      ).payload as {
        ttlSeconds: number;
        raviHosts: string[];
        pages: Array<{ routeId: string; url: string; instances: string[]; version: number; sections: Array<{ stableKey: string; heading: string | null; anchor: string | null; text: string }> }>;
      };

    const first = await mirror();
    expect(first.ttlSeconds).toBe(86400);
    expect(first.raviHosts).toEqual(expect.arrayContaining([hosts.p, hosts.q, hosts.r]));
    expect(first.pages.map((page) => page.routeId)).toEqual([routes.politica]);
    expect(first.pages[0]).toMatchObject({ url: `https://${hosts.p}/politica`, instances: ["wa-main"], version: 1 });
    expect(first.pages[0]?.sections).toEqual([{ stableKey: "h:Trocas", heading: "Trocas", anchor: "trocas", text: "Trocas em até sete dias." }]);

    // Another installation of the same org sees nothing marked for installation A.
    const other = await handleKnowledgeMirror({
      caller: callerFor(users.owner, orgA, installs.b),
      auth: { organization: { id: orgA } } as CliAuthContext,
      segments: ["mirror"],
      searchParams: new URLSearchParams(),
      body: { instances: [{ id: "wa-main" }] },
      requestId: "req",
      requestUrl: origin,
    });
    expect((other.payload as { pages: unknown[] }).pages).toEqual([]);

    const [installation] = await db.select().from(schema.localInstallations).where(eq(schema.localInstallations.id, installs.a));
    expect(installation?.metadataJson).toMatchObject({ source: "cli-auth", userAgent: "ravi/1" });
    expect(installation?.metadataJson.knowledgeInstances).toEqual([
      { id: "wa-main", label: "WhatsApp atendimento", channel: "whatsapp", reportedAt: expect.any(String) },
    ]);

    await revokeKnowledgeSourceByOrigin({ organizationId: orgA, originKey: `page:${sites.p}:/politica`, reason: "test", requestId: "req" });
    expect((await mirror()).pages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  test("digest: this installation's unanswered gaps and the suspended marks in scope", async () => {
    expect(await suspendRouteMark({ routeId: routes.outro, reason: "new_version", requestId: "req" })).toBe(true);
    const response = await handleKnowledgeDigest({
      caller: ownerCaller(),
      auth: {} as CliAuthContext,
      segments: ["digest"],
      searchParams: new URLSearchParams({ since: new Date(Date.now() - 86_400_000).toISOString() }),
      body: null,
      requestId: "req",
      requestUrl: origin,
    });
    const digest = response.payload as {
      unanswered: Array<{ id: string; question: string; waitingCount: number; cardUrl: string; project: { id: string } | null }>;
      pending: { notes: number; corrections: number; transcripts: number };
      suspendedMarks: Array<{ routeId: string; url: string; reason: string; cardUrl: string }>;
    };
    const questions = digest.unanswered.map((item) => item.question);
    expect(questions).toEqual(expect.arrayContaining(["Vocês dão desconto pra ONG?", "Privado?", "Taken?", "Visível?"]));
    expect(questions).not.toContain("Qual o prazo de entrega?");
    expect(questions).not.toContain("Spam?");
    expect(digest.unanswered.find((item) => item.question === "Vocês dão desconto pra ONG?")).toMatchObject({ waitingCount: 2, project: { id: projects.p } });
    // installation B's gap is not listed for A.
    expect(digest.unanswered.filter((item) => item.question === "Vocês dão desconto pra ONG?")).toHaveLength(1);
    expect(digest.pending).toEqual({ notes: 0, corrections: 0, transcripts: 0 });
    expect(digest.suspendedMarks).toEqual([
      { routeId: routes.outro, url: `https://${hosts.p}/outro`, reason: "new_version", cardUrl: `${origin}/k/routes/${routes.outro}` },
    ]);

    const outsiderDigest = await handleKnowledgeDigest({
      caller: callerFor(users.outsider, orgB, installs.c),
      auth: {} as CliAuthContext,
      segments: ["digest"],
      searchParams: new URLSearchParams(),
      body: null,
      requestId: "req",
      requestUrl: origin,
    });
    expect(outsiderDigest.payload).toMatchObject({ unanswered: [], suspendedMarks: [] });
  });

  test("marks listing: scope, url filter and card link", async () => {
    const all = await handleKnowledgeMarks({
      caller: ownerCaller(),
      auth: {} as CliAuthContext,
      segments: ["marks"],
      searchParams: new URLSearchParams(),
      body: null,
      requestId: "req",
      requestUrl: origin,
    });
    const allMarks = (all.payload as { marks: Array<{ routeId: string; audiences: string[] }> }).marks;
    expect(allMarks.map((mark) => mark.routeId)).toEqual(expect.arrayContaining([routes.politica, routes.outro]));
    expect(allMarks.find((mark) => mark.routeId === routes.politica)?.audiences).toEqual(["page_viewers", "contacts:wa-main"]);

    const faq = await handleKnowledgeMarks({
      caller: ownerCaller(),
      auth: {} as CliAuthContext,
      segments: ["marks"],
      searchParams: new URLSearchParams({ url: `https://${hosts.p}/faq` }),
      body: null,
      requestId: "req",
      requestUrl: origin,
    });
    const payload = faq.payload as { marks: Array<{ routeId: string; state: string }>; card: { url: string } | null };
    expect(payload.marks).toHaveLength(1);
    expect(payload.card?.url).toBe(`${origin}/k/routes/${payload.marks[0]?.routeId}`);

    const outsider = await handleKnowledgeMarks({
      caller: callerFor(users.outsider, orgB, installs.c),
      auth: {} as CliAuthContext,
      segments: ["marks"],
      searchParams: new URLSearchParams({ url: `https://${hosts.p}/faq` }),
      body: null,
      requestId: "req",
      requestUrl: origin,
    });
    expect(outsider.payload).toEqual({ marks: [], card: null });
  });
});
