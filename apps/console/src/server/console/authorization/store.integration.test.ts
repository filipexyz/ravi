import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { db, dbClient, schema } from "@/server/db";
import { createAuthorizationStore } from "./store";
import { initialPolicy as emptyPolicy, policyDigest, type ProjectAction } from "./policy";
import { authorizationAudit, authorizationPolicyHeads, authorizationPolicyRevisions } from "./schema";
import { handlePolicyRequest } from "./http";

const enabled = Boolean(process.env.RAVI_POLICY_TEST_CLUSTER && process.env.PGHOST === process.env.RAVI_POLICY_TEST_CLUSTER && process.env.DATABASE_URL === "postgres:///postgres");
const suite = enabled ? describe : describe.skip;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const org = id(1), owner = id(2), reader = id(3), outsider = id(4), projectA = id(5), projectB = id(6), install = id(7), session = id(8), binding = id(9), otherOrg = id(10);
const admin = { organizationId: org, userId: owner };
const user = { organizationId: org, userId: reader };
const store = createAuthorizationStore(db);
const mutation = (generation: number) => ({ expectedGeneration: generation, operationKey: crypto.randomUUID(), reason: "Synthetic acceptance" });
let fixtureActions: ProjectAction[] = ["project.read"];
// Explicit published assignments in this consumer fixture. Legacy membership
// role labels are not interpreted by the engine and are not the grant source.
function initialPolicy(organizationId: string, userId: string) {
  const document = emptyPolicy(organizationId, userId);
  document.roles = [{ id: id(50), name: "Fixture A readers", members: [reader], groups: [], scope: { kind: "project", projects: [projectA] } }];
  document.rules = [{ id: "fixture-a", effect: "allow", principals: [{ kind: "role", id: id(50) }], projects: [projectA], actions: [...fixtureActions] }];
  return document;
}

suite("policy store on real private PostgreSQL", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([{ id: org, slug: "policy-test", name: "Policy Test" }, { id: otherOrg, slug: "other", name: "Other" }]);
    await db.insert(schema.users).values([{ id: owner, primaryEmail: "owner@policy.invalid" }, { id: reader, primaryEmail: "reader@policy.invalid" }, { id: outsider, primaryEmail: "outsider@policy.invalid" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: org, userId: owner, role: "owner" }, { organizationId: org, userId: reader, role: "viewer" }, { organizationId: otherOrg, userId: outsider, role: "owner" }]);
    await db.insert(schema.projects).values([{ id: projectA, organizationId: org, slug: "a", name: "A" }, { id: projectB, organizationId: org, slug: "b", name: "B" }]);
    await db.insert(schema.projectMemberships).values({ projectId: projectA, userId: reader, role: "viewer" });
    await db.insert(schema.localInstallations).values({ id: install, organizationId: org, userId: owner, name: "Synthetic", subjectType: "user" });
    await db.insert(schema.cliSessions).values({ id: session, localInstallationId: install, organizationId: org, userId: owner, subjectType: "user",
      refreshTokenHash: "synthetic-refresh-only", accessTokenJti: "synthetic-jti", expiresAt: new Date(Date.now() + 3600_000) });
    await db.insert(schema.raviActorBindings).values({ id: binding, installationId: install, organizationId: org, consoleUserId: reader, contactId: "test-contact", linkedBy: reader });
    // Fixture-only active manager grant. Protected real bootstrap is covered by
    // contract.integration.test.ts, not bypassed by a production owner check.
    const document = emptyPolicy(org, owner);
    const [revision] = await db.insert(authorizationPolicyRevisions).values({ organizationId: org, document,
      digest: policyDigest(document), createdBy: owner, reason: "Synthetic consumer fixture manager" }).returning();
    await db.insert(authorizationPolicyHeads).values({ organizationId: org, activeRevisionId: revision!.id, generation: 0 });
  });
  afterAll(async () => { if (enabled) await dbClient.end(); });

  test("explicit manager grant, draft does not activate, preview requires exact state", async () => {
    expect((await store.decide(admin, projectA, "project.read")).allowed).toBe(false);
    await expect(store.read(user)).rejects.toMatchObject({ status: 403 });
    await expect(store.read({ organizationId: org, userId: outsider })).rejects.toMatchObject({ status: 403 });
    const proposal = initialPolicy(org, owner);
    const input = { ...mutation(0), document: proposal };
    const draft = await store.saveDraft(admin, input);
    expect(draft.generation).toBe(1);
    expect(await store.saveDraft(admin, input)).toEqual(draft);
    await expect(store.saveDraft(admin, { ...input, reason: "changed" })).rejects.toMatchObject({ status: 409 });
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(false);
    await expect(store.publish(admin, { ...mutation(1), previewId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    const preview = await store.preview(admin, { expectedGeneration: 1 });
    expect(preview.impact.initialActivation).toBe(false);
    expect(preview.impact.added).toBeGreaterThan(0);
    const publishInput = { ...mutation(1), previewId: preview.id };
    expect((await store.publish(admin, publishInput)).generation).toBe(2);
    expect((await store.publish(admin, publishInput)).generation).toBe(2);
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true);
    expect((await store.decide(user, projectA, "project.write")).allowed).toBe(false);
    expect((await store.decide(user, projectB, "project.read")).allowed).toBe(false);
    expect((await store.decide(admin, projectA, "project.read")).allowed).toBe(false);
    const events = await db.select().from(authorizationAudit).where(eq(authorizationAudit.action, "policy.publish"));
    expect(events.length).toBe(1);
  });

  test("membership revocation, invalid references and self-lockout fail closed", async () => {
    await db.update(schema.projectMemberships).set({ status: "removed" }).where(eq(schema.projectMemberships.userId, reader));
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true); // explicit policy assignment, not legacy membership
    await db.update(schema.projectMemberships).set({ status: "active" }).where(eq(schema.projectMemberships.userId, reader));
    await db.update(schema.organizationMemberships).set({ status: "removed" }).where(eq(schema.organizationMemberships.userId, reader));
    await expect(store.decide(user, projectA, "project.read")).rejects.toMatchObject({ status: 403 });
    // Published history remains intact, but a new assignment to an inactive
    // person is refused, even when its legacy role used to be privileged.
    await expect(store.saveDraft(admin, { ...mutation(2), document: initialPolicy(org, owner) })).rejects.toMatchObject({ status: 400 });
    await db.update(schema.organizationMemberships).set({ status: "active" }).where(eq(schema.organizationMemberships.userId, reader));
    const document = initialPolicy(org, owner);
    await expect(store.saveDraft(admin, { ...mutation(2), document: { ...document, administrators: [{ kind: "user", id: reader }] } })).rejects.toMatchObject({ status: 409 });
    await expect(store.saveDraft(admin, { ...mutation(2), document: { ...document, groups: [{ id: "bad", members: [outsider] }] } })).rejects.toMatchObject({ status: 400 });
    await expect(store.saveDraft(admin, { ...mutation(2), document: { ...document, organizationId: otherOrg } })).rejects.toMatchObject({ status: 400 });
    expect((await store.read(admin)).generation).toBe(2);
  });

  test("concurrent drafts have one winner; membership changes invalidate preview", async () => {
    fixtureActions = ["project.read", "project.write"];
    const document = initialPolicy(org, owner);
    const results = await Promise.allSettled([store.saveDraft(admin, { ...mutation(2), document }), store.saveDraft(admin, { ...mutation(2), document })]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    const preview = await store.preview(admin, { expectedGeneration: 3 });
    await db.update(schema.projectMemberships).set({ role: "developer" }).where(eq(schema.projectMemberships.userId, reader));
    await expect(store.publish(admin, { ...mutation(3), previewId: preview.id })).rejects.toMatchObject({ payload: { error: "authorization_preview_stale" } });
    const fresh = await store.preview(admin, { expectedGeneration: 3 });
    expect((await store.publish(admin, { ...mutation(3), previewId: fresh.id })).generation).toBe(4);
    expect((await store.decide(user, projectA, "project.write")).allowed).toBe(true);
  });

  test("delegation intersects human rights with installation grant and current binding/session", async () => {
    const actor = { ...user, delegation: { installationId: install, sessionId: session, bindingId: binding, accessTokenJti: "synthetic-jti" } };
    expect((await store.decide(actor, projectA, "project.read")).allowed).toBe(false);
    const document = initialPolicy(org, owner);
    document.rules.push({ id: "installation-a", effect: "allow", principals: [{ kind: "installation", id: install }], projects: [projectA], actions: ["project.read"] });
    await store.saveDraft(admin, { ...mutation(4), document });
    const preview = await store.preview(admin, { expectedGeneration: 5 });
    await store.publish(admin, { ...mutation(5), previewId: preview.id });
    expect((await store.decide(actor, projectA, "project.read")).allowed).toBe(true);
    expect((await store.decide(actor, projectA, "project.write")).allowed).toBe(false);
    expect((await store.decide(actor, projectB, "project.read")).allowed).toBe(false);
    for (const patch of [{ bindingId: null }, { sessionId: id(99) }, { accessTokenJti: "tampered" }, { installationId: id(99) }]) {
      expect((await store.decide({ ...actor, delegation: { ...actor.delegation, ...patch } }, projectA, "project.read")).allowed).toBe(false);
    }
    await db.update(schema.raviActorBindings).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.raviActorBindings.id, binding));
    expect((await store.decide(actor, projectA, "project.read")).allowed).toBe(false);
    await db.update(schema.raviActorBindings).set({ status: "active", revokedAt: null }).where(eq(schema.raviActorBindings.id, binding));
    await db.update(schema.cliSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.cliSessions.id, session));
    expect((await store.decide(actor, projectA, "project.read")).allowed).toBe(false);
    await db.update(schema.cliSessions).set({ expiresAt: new Date(Date.now() + 3600_000) }).where(eq(schema.cliSessions.id, session));
    await expect(store.read(actor)).rejects.toMatchObject({ status: 403 });
    const audit = await db.select().from(authorizationAudit).where(eq(authorizationAudit.actorId, reader));
    expect(audit.some((event) => event.metadata.installationId === install && event.metadata.bindingId === binding && event.metadata.allowed === false)).toBe(true);
    expect(audit.some((event) => event.action === "project.write" && event.metadata.allowed === true)).toBe(true);
    expect(audit.some((event) => event.action === "project.read" && event.metadata.allowed === true)).toBe(false);
  });

  test("group removal and policy rollback are new immutable revisions", async () => {
    const original = (await store.read(admin)).active!.id;
    const document = initialPolicy(org, owner);
    document.groups = [{ id: "readers", members: [reader] }];
    document.rules = [{ id: "group-a", effect: "allow", principals: [{ kind: "group", id: "readers" }], projects: [projectA], actions: ["project.read"] }];
    await store.saveDraft(admin, { ...mutation(6), document });
    await store.publish(admin, { ...mutation(7), previewId: (await store.preview(admin, { expectedGeneration: 7 })).id });
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true);
    document.groups[0]!.members = [];
    await store.saveDraft(admin, { ...mutation(8), document });
    await store.publish(admin, { ...mutation(9), previewId: (await store.preview(admin, { expectedGeneration: 9 })).id });
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(false);
    await store.prepareRollback(admin, { ...mutation(10), revisionId: original });
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(false); // rollback still just a draft
    await store.publish(admin, { ...mutation(11), previewId: (await store.preview(admin, { expectedGeneration: 11 })).id });
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true);
    expect((await store.read(admin)).active!.id).not.toBe(original);
    expect((await store.read(admin)).generation).toBe(12);
  });

  test("transaction-scoped effect refuses B and preserves audit identity", async () => {
    let called = false;
    await expect(store.withAuthorizedProject(user, projectB, "project.write", async () => { called = true; })).rejects.toMatchObject({ status: 403 });
    expect(called).toBe(false);
    const value = await store.withAuthorizedProject(user, projectA, "project.read", async () => "only-A");
    expect(value).toBe("only-A");
    const [head] = await db.select().from(authorizationPolicyHeads).where(eq(authorizationPolicyHeads.organizationId, org));
    expect(head!.generation).toBe(12);
  });

  test("policy head cannot change while an authorized database effect holds its transaction", async () => {
    let release!: () => void, entered!: () => void, getPid!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pidReady = new Promise<number>(resolve => { getPid = resolve; });
    const effect = store.withAuthorizedProject(user, projectA, "project.read", async () => { entered(); await gate; return "committed-effect"; });
    await ready;
    const contender = dbClient.begin(async tx => {
      const [row] = await tx`select pg_backend_pid() pid`;
      getPid(Number(row!.pid));
      // Same-row no-op UPDATE is enough to prove the lock boundary, without
      // bypassing policy publication or changing the fixture's active policy.
      await tx`update authorization_policy_heads set generation=generation where organization_id=${org}`;
    });
    try {
      const pid = await pidReady;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = Boolean((await dbClient`select cardinality(pg_blocking_pids(${pid}))>0 blocked`)[0]!.blocked);
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    expect(await effect).toBe("committed-effect");
    await contender;
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true);
  });

  test("HTTP uses server actor, rejects CSRF/body spoofing, edits and publishes without redeploy", async () => {
    const origin = "https://console.policy.invalid";
    const call = (path: string[], body?: unknown, actor = admin, extraHeaders: Record<string, string> = {}) => handlePolicyRequest(
      new Request(`${origin}/api/console/authorization/${path.join("/")}`, { method: body === undefined ? "GET" : "POST",
        headers: { origin, "content-type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path,
      { authenticate: async () => actor, canonicalOrigin: () => origin, store });
    expect((await call([], undefined, user)).status).toBe(403);
    expect((await call(["preview"], { expectedGeneration: 12 }, admin, { origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await call(["preview"], { expectedGeneration: 12 }, admin, { origin: "" })).status).toBe(403);
    expect((await call(["preview"], { expectedGeneration: 12 }, admin, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(["draft"], { ...mutation(12), document: initialPolicy(org, owner), userId: owner }, user)).status).toBe(400);
    const input = { ...mutation(12), document: initialPolicy(org, owner) };
    const draft = await call(["draft"], input);
    expect(draft.status).toBe(200);
    expect(draft.headers.get("cache-control")).toBe("no-store");
    const preview = await call(["preview"], { expectedGeneration: 13 });
    expect(preview.status).toBe(200);
    const receipt = await preview.json();
    expect((await call(["publish"], { ...mutation(13), previewId: receipt.id })).status).toBe(200);
    const delegated = { ...user, delegation: { installationId: install, sessionId: session, bindingId: binding, accessTokenJti: "synthetic-jti" } };
    // The published policy removes the installation grant, not the person's A membership.
    expect((await store.decide(delegated, projectA, "project.read")).allowed).toBe(false);
    expect((await store.decide(user, projectA, "project.read")).allowed).toBe(true);
    const { listAccessibleProjectRecords, findAccessibleProjectRecord } = await import("../project-access");
    const workspace = { user: { id: reader }, organization: { id: org }, membership: { role: "owner" } };
    expect((await listAccessibleProjectRecords(workspace)).map((p) => p.id)).toEqual([projectA]);
    expect(await findAccessibleProjectRecord(workspace, "b")).toBeNull();
    expect(await findAccessibleProjectRecord(workspace, projectB)).toBeNull();
    expect((await findAccessibleProjectRecord(workspace, "a"))?.id).toBe(projectA);
  });

  test("list query count is constant when project count grows; current suspension is not cached", async () => {
    const queries: string[] = [];
    const measured = createAuthorizationStore(drizzle(dbClient, { schema, logger: { logQuery(query) { queries.push(query); } } }));
    const first = await measured.accessibleProjects(user);
    const smallCount = queries.length;
    const extra = Array.from({ length: 20 }, () => { const id = crypto.randomUUID(); return { id, organizationId: org, slug: id, name: "Cost fixture" }; });
    await db.insert(schema.projects).values(extra);
    queries.length = 0;
    expect((await measured.accessibleProjects(user)).map(p => p.id)).toEqual(first.map(p => p.id));
    expect(queries.length).toBe(smallCount);
    // A filtered read list is visibility, not a refused attempt: no decision-audit row.
    expect(queries.filter(q => q.startsWith('insert into "authorization_audit"')).length).toBe(0);
    console.log(JSON.stringify({ costFixture: "project-list", smallProjects: 2, largeProjects: 22, queries: smallCount, filteredListAuditWrites: 0 }));
    await db.update(schema.organizationMemberships).set({ status: "suspended" }).where(eq(schema.organizationMemberships.userId, reader));
    await expect(measured.accessibleProjects(user)).rejects.toMatchObject({ status: 403 });
    await db.update(schema.organizationMemberships).set({ status: "active" }).where(eq(schema.organizationMemberships.userId, reader));
  });

  test("real browser edits, simulates and publishes the real HTTP/DB policy at 1280/390", async () => {
    const { testPolicyEditor } = await import("./editor-browser");
    await testPolicyEditor({ store, admin, reader: user, projectA, projectB });
  }, 120_000);

  test("native Pages/Bases paths: same-org A/B, view ceiling, retry and revoked stale write", async () => {
    const { handleBasesRequest } = await import("../bases/http");
    const { basesCallerForPagesViewer } = await import("../bases/context");
    const { resolveBasesProject, resolveBaseScope } = await import("../bases/scope");
    const { createRows } = await import("../bases/row-writes");
    const { createPageSite, listPageSitesForProject, getPageSiteForProject } = await import("../pages");
    const workspace = { mode: "workos" as const, user: { id: reader }, organization: { id: org }, membership: { role: "viewer" as const } };
    const { getArtifact, listArtifactVersions, listProjects } = await import("../read-model");
    const [artifactA, artifactB] = await db.insert(schema.artifacts).values([
      { projectId: projectA, slug: "artifact-a", name: "Artifact A" },
      { projectId: projectB, slug: "artifact-b", name: "Hidden artifact B" },
    ]).returning();
    await db.insert(schema.artifactVersions).values({ artifactId: artifactB!.id, versionNumber: 1 });
    expect(await getArtifact(workspace, artifactA!.id)).toMatchObject({ id: artifactA!.id, name: "Artifact A" });
    expect(await getArtifact(workspace, artifactB!.id)).toBe(null);
    expect(await listArtifactVersions(workspace, artifactB!.id)).toEqual([]);
    expect((await listProjects(workspace)).map(project => [project.id, project.artifactCount])).toEqual([[projectA, 1]]);
    const site = await createPageSite({ workspace, projectRef: projectA, input: { slug: "policy-page-a", defaultVisibility: "private" }, requestId: crypto.randomUUID() });
    expect((await listPageSitesForProject({ workspace, projectRef: projectA })).map((s) => s.id)).toContain(site.id);
    expect(await listPageSitesForProject({ workspace, projectRef: projectB })).toEqual([]);
    await expect(createPageSite({ workspace, projectRef: projectB, input: { slug: "never-b" }, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(getPageSiteForProject({ workspace, projectRef: projectB, siteRef: site.id })).rejects.toMatchObject({ status: 403 });
    const caller: import("../bases/context").BasesCaller = { organizationId: org, user: { id: reader, email: "reader@policy.invalid" },
      orgRole: "viewer", actorType: "user", actorId: reader, surface: "console", requestId: crypto.randomUUID(),
      source: { kind: "user", id: reader }, pageSiteId: null, localInstallationId: null, clientHint: null };
    const call = (method: string, segments: string[], body: unknown = {}, options: { caller?: typeof caller; project?: string; key?: string } = {}) => handleBasesRequest({
      caller: options.caller ?? caller, workspace: null, method, projectRef: options.project ?? projectA, segments, body,
      searchParams: new URLSearchParams(), idempotencyKey: options.key ?? null });
    const created = await call("POST", [], { name: "Policy Rows", slug: "policy-rows", properties: [{ name: "Title", key: "title", type: "text" }] });
    expect(created.status).toBe(201);
    const key = "policy-row-once";
    const first = await call("POST", ["policy-rows", "rows"], { values: { title: "Visible A" } }, { key });
    expect(first.status).toBe(201);
    const replay = await call("POST", ["policy-rows", "rows"], { values: { title: "Visible A" } }, { key });
    expect(replay.status).toBe(200);
    expect(replay.payload).toMatchObject({ idempotentReplay: true });
    const viewResponse = await call("POST", ["policy-rows", "views"], { name: "Page read only", columns: ["title"],
      access: { read: [{ kind: "page_viewer", siteId: site.id, mode: "rows" }], write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false } } });
    expect(viewResponse.status).toBe(201);
    const viewId = (viewResponse.payload as { id: string }).id;
    // Trusted internal adapter facts are synthetic here. Page cookie/Executor HTTP
    // authentication is not fabricated or claimed as tested by this service test.
    const pageCaller = basesCallerForPagesViewer({ organizationId: org, userId: reader, email: "reader@policy.invalid",
      pagesSessionId: id(90), siteId: site.id, orgRole: "viewer", requestId: crypto.randomUUID() });
    const query = await call("POST", ["policy-rows", "views", viewId, "query"], { limit: 1, search: "Visible" }, { caller: pageCaller });
    expect(query.status).toBe(200);
    expect(query.payload).toMatchObject({ rows: [{ values: { title: "Visible A" } }] });
    await expect(call("POST", ["policy-rows", "views", viewId, "rows"], { values: { title: "Forbidden Page write" } }, { caller: pageCaller, key: "page-write-denied" })).rejects.toMatchObject({ status: 403 });
    await expect(call("POST", ["policy-rows", "views", viewId, "query"], {}, { caller: { ...pageCaller, pageSiteId: id(91) } })).rejects.toMatchObject({ status: 404 });
    for (const segments of [[], ["policy-rows"], ["policy-rows", "rows"], ["policy-rows", "views", viewId]]) {
      await expect(call("GET", segments, {}, { project: projectB })).rejects.toMatchObject({ status: 404 });
    }
    const staleScope = await resolveBaseScope(await resolveBasesProject({ caller, workspace: null, projectRef: projectA }), "policy-rows");
    const current = await store.read(admin);
    const readOnly = structuredClone(current.active!.document);
    readOnly.rules.push({ id: "revoke-writes", effect: "deny", principals: [{ kind: "user", id: reader }], projects: [projectA], actions: ["project.write"] });
    const draft = await store.saveDraft(admin, { ...mutation(current.generation), document: readOnly });
    await store.publish(admin, { ...mutation(draft.generation), previewId: (await store.preview(admin, { expectedGeneration: draft.generation })).id });
    await expect(createRows({ scope: staleScope, target: { kind: "direct" }, rows: [{ values: { title: "Stale denied" } }], batch: false,
      operation: "console.bases.rows.create", idempotencyKey: "stale-scope-denied" })).rejects.toMatchObject({ status: 403 });
    // A retry must not reveal the old result after the write grant is revoked.
    await expect(call("POST", ["policy-rows", "rows"], { values: { title: "Visible A" } }, { key })).rejects.toMatchObject({ status: 403 });
    expect((await call("POST", ["policy-rows", "views", viewId, "query"], {}, { caller: pageCaller })).status).toBe(200);
    const rows = await db.select().from(schema.baseRows).where(eq(schema.baseRows.baseId, staleScope.base.id));
    expect(rows).toHaveLength(1);
    expect((await db.select().from(schema.baseRowLedger).where(eq(schema.baseRowLedger.baseId, staleScope.base.id)))).toHaveLength(1);
    const { canUserViewPagesRoute } = await import("../access/grants");
    await db.insert(schema.accessGrants).values({ organizationId: org, projectId: projectA, pageSiteId: site.id,
      objectType: "page_site", objectId: site.id, subjectId: reader, relation: "viewer" });
    expect(await canUserViewPagesRoute({ siteId: site.id, routeId: null, userId: reader })).toBe(true);
    const noReads = structuredClone(readOnly);
    noReads.rules.push({ id: "member-no-read", effect: "deny", principals: [{ kind: "user", id: reader }], projects: [projectA], actions: ["project.read"] });
    const latest = await store.read(admin);
    const denyDraft = await store.saveDraft(admin, { ...mutation(latest.generation), document: noReads });
    await store.publish(admin, { ...mutation(denyDraft.generation), previewId: (await store.preview(admin, { expectedGeneration: denyDraft.generation })).id });
    expect(await canUserViewPagesRoute({ siteId: site.id, routeId: null, userId: reader })).toBe(false);
    const afterDeny = await store.read(admin);
    const restore = await store.saveDraft(admin, { ...mutation(afterDeny.generation), document: readOnly });
    await store.publish(admin, { ...mutation(restore.generation), previewId: (await store.preview(admin, { expectedGeneration: restore.generation })).id });
    expect(await canUserViewPagesRoute({ siteId: site.id, routeId: null, userId: reader })).toBe(true);
  }, 30_000);

  test("native CLI authentication reaches the decision endpoint; forged/expired/link-revoked requests deny", async () => {
    const { signCliAccessToken } = await import("@/server/cli/tokens");
    const { handleRemoteDecision } = await import("./remote");
    // A fresh test-only signing key, never loaded from an env file or operator store.
    const previous = process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
    const secret = crypto.randomUUID() + crypto.randomUUID();
    process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = secret;
    try {
      const tokenInput = { secret, sessionId: session, localInstallationId: install, organizationId: org, userId: owner, scopes: ["console.projects.read"] };
      const signed = await signCliAccessToken(tokenInput);
      await db.update(schema.cliSessions).set({ accessTokenJti: signed.accessTokenJti, scopesJson: tokenInput.scopes }).where(eq(schema.cliSessions.id, session));
      const existing = await store.read(admin);
      const document = structuredClone(existing.active!.document);
      document.rules.push({ id: "native-install-read", effect: "allow", principals: [{ kind: "installation", id: install }], projects: [projectA], actions: ["project.read"] });
      const draft = await store.saveDraft(admin, { ...mutation(existing.generation), document });
      await store.publish(admin, { ...mutation(draft.generation), previewId: (await store.preview(admin, { expectedGeneration: draft.generation })).id });
      const body = { version: 1, resource: { type: "project", id: projectA }, action: "project.read" };
      const call = (payload: unknown = body, token = signed.accessToken, contact: string | null = "test-contact") => handleRemoteDecision(new Request("https://console.policy.invalid/api/cli/authorization/decision", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(contact ? { "x-ravi-actor-contact": contact } : {}) }, body: JSON.stringify(payload),
      }));
      const allowed = await call();
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ allowed: true, subject: { userId: reader, installationId: install, bindingId: binding }, cacheMaxAgeSeconds: 0, reusableCapability: false, agentAttestation: "not_supported" });
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      expect(await (await call({ ...body, resource: { type: "project", id: projectB } })).json()).toMatchObject({ allowed: false });
      expect((await call({ ...body, userId: owner })).status).toBe(400);
      expect((await call({ ...body, agentId: "admin" })).status).toBe(400);
      expect((await call(body, signed.accessToken, null)).status).toBe(403);
      expect((await call(body, signed.accessToken, "unlinked-contact")).status).toBe(403);
      expect((await call(body, `x${signed.accessToken.slice(1)}`)).status).toBe(401);
      const expired = await signCliAccessToken({ ...tokenInput, now: new Date(Date.now() - 3600_000) });
      expect((await call(body, expired.accessToken)).status).toBe(401);
      const divergent = await signCliAccessToken({ ...tokenInput, organizationId: otherOrg });
      expect((await call(body, divergent.accessToken)).status).toBe(401);
      await db.update(schema.raviActorBindings).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.raviActorBindings.id, binding));
      expect((await call()).status).toBe(403);
      await db.update(schema.raviActorBindings).set({ status: "active", revokedAt: null }).where(eq(schema.raviActorBindings.id, binding));
      const current = await store.read(admin);
      document.rules = document.rules.filter((rule) => rule.id !== "native-install-read");
      const revoked = await store.saveDraft(admin, { ...mutation(current.generation), document });
      await store.publish(admin, { ...mutation(revoked.generation), previewId: (await store.preview(admin, { expectedGeneration: revoked.generation })).id });
      expect(await (await call()).json()).toMatchObject({ allowed: false, reason: "no_grant" });
      await db.update(schema.cliSessions).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.cliSessions.id, session));
      expect((await call()).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
      else process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = previous;
    }
  });
  test("inbox filters before pagination and exposes no B sequence/count; delivery and ACK recheck policy", async () => {
    const { recordAgentInboxItem, upsertGlobalInboxSubscription, getInboxPulse, pollInbox, ackInboxItems } = await import("../agent-inbox");
    await db.update(schema.cliSessions).set({ status: "active", revokedAt: null, accessTokenJti: "inbox-jti", expiresAt: new Date(Date.now() + 3600_000) }).where(eq(schema.cliSessions.id, session));
    const document = initialPolicy(org, owner);
    document.rules.push({ id: "inbox-install-a", effect: "allow", principals: [{ kind: "installation", id: install }], projects: [projectA], actions: ["project.read", "project.write"] });
    document.rules.push({ id: "inbox-owner-a", effect: "allow", principals: [{ kind: "user", id: owner }], projects: [projectA], actions: ["project.read"] });
    const current = await store.read(admin);
    const draft = await store.saveDraft(admin, { ...mutation(current.generation), document });
    await store.publish(admin, { ...mutation(draft.generation), previewId: (await store.preview(admin, { expectedGeneration: draft.generation })).id });
    const authorization = { installationId: install, sessionId: session, bindingId: binding, accessTokenJti: "inbox-jti" };
    const workspace = { user: { id: reader }, organization: { id: org, name: "Test", slug: "test" }, membership: { role: "viewer" },
      localInstallation: { id: install, name: "Test", capabilitiesJson: [] }, authorization };
    const event = (projectId: string, label: string) => recordAgentInboxItem({ organizationId: org, projectId, eventType: "authorization.test",
      category: "pages", dedupeKey: `authorization:${label}`, sourceType: "test", targetType: "local_installation", targetId: install, title: label });
    const a1 = await event(projectA, "a1");
    const subscribed = await upsertGlobalInboxSubscription({ workspace });
    const before = await getInboxPulse({ workspace });
    await event(projectB, "invisible-b");
    expect((await getInboxPulse({ workspace })).watermark).toEqual(before.watermark);
    const a2 = await event(projectA, "a2");
    const first = await pollInbox({ workspace, limit: 1 });
    expect(first.version).toBe(2);
    expect(first.items.map((item) => item.id)).toEqual([a1!.id]);
    expect(first.items.map((item) => item.sequence)).toEqual([1]);
    expect(first.hasMore).toBe(true);
    expect(first.watermark.latestSequence).toBe(2);
    const acked = await ackInboxItems({ workspace, acks: [{ itemId: a1!.id, leaseId: first.leaseId }] });
    expect(acked).toMatchObject({ acknowledged: 1, lastDeliveredSequence: 1 });
    const second = await pollInbox({ workspace });
    expect(second.items.map((item) => [item.id, item.sequence])).toEqual([[a2!.id, 2]]);
    expect(second.hasMore).toBe(false);
    expect((await getInboxPulse({ workspace: { ...workspace, user: { id: owner }, authorization: { ...authorization, bindingId: null } }, subscriptionId: subscribed.subscription.id })).subscription).toBe(null);
    await expect(getInboxPulse({ workspace: { ...workspace, authorization: { ...authorization, installationId: id(999) } } })).rejects.toMatchObject({ status: 403 });

    // A real persisted subscription carries the verified actor, not an owner role.
    const { basesCallerFromCliAuth } = await import("../bases/context");
    const { resolveBasesProject, resolveBaseScope } = await import("../bases/scope");
    const { createSubscription } = await import("../bases/subscriptions");
    const { listActiveBaseSubscriptions } = await import("../bases/events");
    const [base] = await db.select().from(schema.bases).where(eq(schema.bases.projectId, projectA)).limit(1);
    const [dbUser] = await db.select().from(schema.users).where(eq(schema.users.id, reader));
    const [dbOrg] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org));
    const [dbMember] = await db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, reader));
    const [dbSession] = await db.select().from(schema.cliSessions).where(eq(schema.cliSessions.id, session));
    const [dbInstall] = await db.select().from(schema.localInstallations).where(eq(schema.localInstallations.id, install));
    const caller = basesCallerFromCliAuth({ user: dbUser!, organization: dbOrg!, membership: dbMember!, cliSession: dbSession!, localInstallation: dbInstall!, accessTokenJti: "inbox-jti",
      delegation: { bindingId: binding, contactId: "test-contact", executor: { user: dbUser!, membership: dbMember! } } }, crypto.randomUUID());
    const scope = await resolveBaseScope(await resolveBasesProject({ caller, workspace: null, projectRef: projectA }), base!.id);
    const subscribedBase = await createSubscription(scope, {});
    expect((await listActiveBaseSubscriptions(db, base!)).map((subscription) => subscription.userId)).toEqual([reader]);
    await db.update(schema.cliSessions).set({ accessTokenJti: "inbox-jti-refreshed" }).where(eq(schema.cliSessions.id, session));
    expect(await listActiveBaseSubscriptions(db, base!)).toEqual([]);
    scope.caller.authorization = { ...authorization, accessTokenJti: "inbox-jti-refreshed" };
    const renewed = await createSubscription(scope, {});
    expect(renewed.status).toBe(200);
    expect(renewed.payload.id).toBe(subscribedBase.payload.id);
    expect((await createSubscription(scope, {})).payload.id).toBe(subscribedBase.payload.id);
    expect((await listActiveBaseSubscriptions(db, base!)).map(subscription => subscription.userId)).toEqual([reader]);
    // Two people with the SAME project grant and installation still cannot
    // consume each other's view-filtered subscription events or watermark.
    workspace.authorization.accessTokenJti = "inbox-jti-refreshed";
    const ownerWorkspace = { ...workspace, user: { id: owner }, authorization: { ...workspace.authorization, bindingId: null } };
    const [ownerSubscription] = await db.insert(schema.baseSubscriptions).values({ baseId: base!.id, organizationId: org,
      projectId: projectA, localInstallationId: install, userId: owner, filterKey: "fixture-owner-recipient" }).returning();
    const { buildBaseRowInboxItem } = await import("../bases/events");
    const makeItem = (subscriptionId: string, userId: string) => buildBaseRowInboxItem({ base: base!, caller,
      change: { rowId: id(299), version: 1, verb: "created", changedPropertyCount: 1 }, occurredAt: new Date(),
      subscription: { id: subscriptionId, userId, installationId: install, email: null, filter: null } });
    const ownItem = await recordAgentInboxItem(makeItem(subscribedBase.payload.id, reader));
    const ownWatermark = (await getInboxPulse({ workspace })).watermark;
    const otherItem = await recordAgentInboxItem(makeItem(ownerSubscription!.id, owner));
    expect(otherItem!.id).not.toBe(ownItem!.id);
    expect((await getInboxPulse({ workspace })).watermark).toEqual(ownWatermark);
    const recipientPoll = await pollInbox({ workspace });
    expect(recipientPoll.items.map(item => item.id)).toContain(ownItem!.id);
    expect(recipientPoll.items.map(item => item.id)).not.toContain(otherItem!.id);
    await upsertGlobalInboxSubscription({ workspace: ownerWorkspace });
    const ownerPoll = await pollInbox({ workspace: ownerWorkspace });
    expect(ownerPoll.items.map(item => item.id)).toContain(otherItem!.id);
    expect(ownerPoll.items.map(item => item.id)).not.toContain(ownItem!.id);
    await db.update(schema.baseSubscriptions).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.baseSubscriptions.id, subscribedBase.payload.id));
    expect((await ackInboxItems({ workspace, acks: [{ itemId: ownItem!.id, leaseId: recipientPoll.leaseId }] })).acknowledged).toBe(0);
    await db.update(schema.raviActorBindings).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.raviActorBindings.id, binding));
    expect(await listActiveBaseSubscriptions(db, base!)).toEqual([]);
    expect((await pollInbox({ workspace })).items).toEqual([]);
    expect((await ackInboxItems({ workspace, acks: [{ itemId: a2!.id, leaseId: second.leaseId }] })).acknowledged).toBe(0);
    expect((await getInboxPulse({ workspace })).watermark.latestSequence).toBe(0);
  });
  test("project creation needs explicit create plus data grants, with no implicit role and atomic rollback", async () => {
    const { createProject } = await import("../projects");
    const workspace = { mode: "workos" as const, user: { id: owner }, organization: { id: org, slug: "policy-test" }, membership: { role: "owner" as const } };
    const body = { name: "Created by policy", slug: "created-by-policy", createDefaultPageSite: true };
    const create = (input = body, target: Parameters<typeof createProject>[0]["workspace"] = workspace) => createProject({ body: input, requestId: crypto.randomUUID(), workspace: target });
    const counts = async () => ({ projects: (await db.select().from(schema.projects)).length,
      sites: (await db.select().from(schema.pageSites)).length, memberships: (await db.select().from(schema.projectMemberships)).length });
    const before = await counts();
    await expect(create()).rejects.toMatchObject({ status: 403 }); // owner name is not a create grant
    expect(await counts()).toEqual(before);
    const document = emptyPolicy(org, owner);
    const activate = async () => {
      const current = await store.read(admin);
      const draft = await store.saveDraft(admin, { ...mutation(current.generation), document });
      await store.publish(admin, { ...mutation(draft.generation), previewId: (await store.preview(admin, { expectedGeneration: draft.generation })).id });
    };
    document.organizationRules.push({ id: "create-projects", effect: "allow", principals: [{ kind: "user", id: owner }], actions: ["organization.projects.create"] });
    await activate();
    await expect(create()).rejects.toMatchObject({ status: 403 }); // create alone does not grant future data
    expect(await counts()).toEqual(before);
    document.rules.push({ id: "future-projects", effect: "allow", principals: [{ kind: "user", id: owner }], projects: ["*"], actions: ["project.read", "project.write"] });
    await activate();
    const revisionBefore = (await store.read(admin)).active!.id;
    const created = await create();
    expect(created.project).toMatchObject({ name: body.name, slug: body.slug, orgId: org, members: 0 });
    expect(created.redirectTo).toContain(created.project.id);
    expect(await counts()).toEqual({ ...before, projects: before.projects + 1, sites: before.sites + 1 });
    expect((await store.read(admin)).active!.id).toBe(revisionBefore); // no hidden creator grant/revision
    expect((await store.decide(admin, created.project.id, "project.read")).allowed).toBe(true);
    expect((await store.decide(admin, created.project.id, "project.admin")).allowed).toBe(false);
    // The service may return only policy-authorized metadata. Revocation denies
    // before slug lookup, including a real existing slug, and creates no orphan.
    document.organizationRules = [];
    await activate();
    await expect(create()).rejects.toMatchObject({ status: 403 });
    const afterCreated = await counts();
    expect(afterCreated.projects).toBe(before.projects + 1);
    document.organizationRules.push({ id: "create-projects", effect: "allow", principals: [{ kind: "user", id: owner }], actions: ["organization.projects.create"] });
    await activate();
    // Fault injected ONLY in the private synthetic database, after project insert.
    await dbClient.unsafe("create function authz_test_site_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic site failure'; end $$");
    await dbClient.unsafe("create trigger authz_test_site_failure before insert on page_sites for each row execute function authz_test_site_failure()");
    const auditsBefore = (await db.select().from(schema.auditEvents)).length;
    try {
      await expect(create({ ...body, slug: "rolled-back-project" })).rejects.toThrow();
      expect(await counts()).toEqual(afterCreated);
      expect((await db.select().from(schema.auditEvents)).length).toBe(auditsBefore);
    } finally {
      await dbClient.unsafe("drop trigger authz_test_site_failure on page_sites");
      await dbClient.unsafe("drop function authz_test_site_failure()");
    }
    // Linked creation cannot use the owner's privileges or omit the installation
    // ceiling; a legacy viewer may create only through explicit policy grants.
    await db.update(schema.raviActorBindings).set({ status: "active", revokedAt: null }).where(eq(schema.raviActorBindings.id, binding));
    const linked = { ...workspace, user: { id: reader }, membership: { role: "viewer" as const }, authorization: {
      installationId: install, sessionId: session, bindingId: binding, accessTokenJti: "inbox-jti-refreshed" } };
    document.organizationRules[0]!.principals.push({ kind: "user", id: reader });
    document.rules[0]!.principals.push({ kind: "user", id: reader });
    await activate();
    const linkedBody = { ...body, slug: "linked-created" };
    await expect(create(linkedBody, linked)).rejects.toMatchObject({ status: 403 });
    document.organizationRules[0]!.principals.push({ kind: "installation", id: install });
    await activate();
    await expect(create(linkedBody, linked)).rejects.toMatchObject({ status: 403 });
    document.rules[0]!.principals.push({ kind: "installation", id: install });
    await activate();
    const linkedCreated = await create(linkedBody, linked);
    expect(linkedCreated.project.slug).toBe(linkedBody.slug);
    expect(await counts()).toEqual({ ...before, projects: before.projects + 2, sites: before.sites + 2 });
    await db.update(schema.raviActorBindings).set({ status: "revoked", revokedAt: new Date() }).where(eq(schema.raviActorBindings.id, binding));
    await expect(create({ ...body, slug: "revoked-linked" }, linked)).rejects.toMatchObject({ status: 403 });
    const { updateSettings } = await import("../settings");
    const [fullUser] = await db.select().from(schema.users).where(eq(schema.users.id, owner));
    const [fullOrg] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org));
    const [fullMembership] = await db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, owner));
    const settingsWorkspace = { mode: "workos" as const, user: fullUser!, organization: fullOrg!, membership: fullMembership! };
    const settings = () => updateSettings({ workspace: settingsWorkspace, requestId: crypto.randomUUID(), body: {
      scope: "project", projectId: created.project.id, name: "Renamed by policy", slug: body.slug, visibility: "private" } });
    await expect(settings()).rejects.toMatchObject({ status: 403 });
    document.rules.push({ id: "admin-created-project", effect: "allow", principals: [{ kind: "user", id: owner }], projects: [created.project.id], actions: ["project.admin"] });
    await activate();
    expect(await settings()).toMatchObject({ id: created.project.id, name: "Renamed by policy" });
    document.rules = document.rules.filter(rule => rule.id !== "admin-created-project");
    await activate();
    await expect(settings()).rejects.toMatchObject({ status: 403 });
  });
});
