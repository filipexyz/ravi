import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, dbClient, schema } from "@/server/db";
import { createOidcBrowserSession, readOidcBrowserSession, resolveOidcWorkspace, revokeOidcBrowserSession } from "@/lib/auth/oidc-store";
import { oidcProvider, type OidcConfig } from "@/lib/auth/oidc-config";
import { hashBrowserSessionToken } from "@/lib/auth/oidc-transaction";
import { createManagedRuntimeStreamSource } from "../managed-runtime-stream-source";
import { createManagedRuntimeEventStream } from "../managed-runtime-event-stream";
import { managedRuntimeContentCodecFromKey } from "../managed-runtime-content";
import type { ConsoleWorkspace } from "../workspace";
import { createAuthorizationStore } from "./store";
import { initialPolicy, policyDigest, type ProjectPolicy } from "./policy";
import { authorizationPolicyHeads, authorizationPolicyRevisions } from "./schema";

const enabled = Boolean(process.env.RAVI_POLICY_TEST_CLUSTER && process.env.PGHOST === process.env.RAVI_POLICY_TEST_CLUSTER && process.env.DATABASE_URL === "postgres:///postgres");
const suite = enabled ? describe : describe.skip;
const id = () => crypto.randomUUID();
const org = id(), owner = id(), user = id(), projectA = id(), projectB = id();
const instanceA = id(), instanceB = id(), sessionA = id(), sessionB = id();
const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 29));
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;
const store = createAuthorizationStore(db), actor = { userId: owner, organizationId: org };
const config: OidcConfig = { issuer: "https://issuer.stream.invalid", origin: "https://console.stream.invalid", organizationId: org,
  clientId: "synthetic", clientSecret: "synthetic-not-used-for-network", secret: "synthetic-secret-for-local-test-only", sessionTtlSeconds: 3600 };
const mutation = (expectedGeneration: number) => ({ expectedGeneration, operationKey: id(), reason: "Synthetic stream acceptance" });
function document() {
  const doc = initialPolicy(org, owner);
  doc.rules = [{ id: "reader-a", effect: "allow", principals: [{ kind: "user", id: user }], projects: [projectA], actions: ["project.read"] }];
  return doc;
}
async function publish(doc: ProjectPolicy) {
  const current = await store.read(actor);
  const draft = await store.saveDraft(actor, { ...mutation(current.generation), document: doc });
  const preview = await store.preview(actor, { expectedGeneration: draft.generation });
  await store.publish(actor, { ...mutation(draft.generation), previewId: preview.id });
}
// Admitted identity fixture, NOT a provider/login acceptance. Session persistence,
// expiry and revocation functions are real; no auth module is mocked or changed.
async function openSession() {
  const session = await createOidcBrowserSession({ issuer: config.issuer, subject: user,
    email: "reader@stream.invalid", name: "Stream reader", emailVerified: true }, config);
  let resolutions = 0;
  const resolveWorkspace = async (): Promise<ConsoleWorkspace | null> => {
    resolutions++;
    const identity = await readOidcBrowserSession(session.token, config);
    if (!identity) return null;
    const current = await resolveOidcWorkspace(identity, config);
    return current ? { mode: "oidc", user: current.user, organization: current.organization, membership: current.membership } : null;
  };
  return { token: session.token, resolveWorkspace, resolutions: () => resolutions };
}
async function openSource() {
  const browser = await openSession();
  const source = await createManagedRuntimeStreamSource({ resolveWorkspace: browser.resolveWorkspace,
    projectRef: "a", instanceId: instanceA, sessionId: sessionA, codec });
  return { source, browser };
}
function errorOnly(output: string) {
  expect(output).toBe('event: stream_error\ndata: {"error":"managed_runtime_stream_unavailable"}\n\n');
  expect(output).not.toContain("private");
  expect(output).not.toContain("id:");
}

suite("managed SSE — private PostgreSQL + real session store, no runtime execution", () => {
  beforeAll(async () => {
    globalThis.fetch = Object.assign(async () => {
      fetchAttempts++; throw new Error("External fetch prohibited in private stream acceptance");
    }, { preconnect: () => { fetchAttempts++; throw new Error("Preconnect prohibited"); } }) as typeof fetch;
    await db.insert(schema.organizations).values({ id: org, name: "Stream fixture", slug: org });
    await db.insert(schema.users).values([{ id: owner, primaryEmail: "manager@stream.invalid" }, { id: user, primaryEmail: "reader@stream.invalid" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: org, userId: owner, role: "viewer" }, { organizationId: org, userId: user, role: "viewer" }]);
    await db.insert(schema.authIdentities).values({ userId: user, provider: oidcProvider(config.issuer), providerUserId: user });
    await db.insert(schema.projects).values([{ id: projectA, organizationId: org, name: "A", slug: "a" }, { id: projectB, organizationId: org, name: "B", slug: "b" }]);
    for (const [projectId, instanceId, sessionId] of [[projectA, instanceA, sessionA], [projectB, instanceB, sessionB]] as const) {
      await db.insert(schema.managedRuntimeInstances).values({ id: instanceId, organizationId: org, projectId, displayName: "Inert fixture", placementClass: "test-only" });
      await db.insert(schema.managedRuntimeSessions).values({ id: sessionId, organizationId: org, projectId, instanceId, runtimeProvider: "synthetic-never-run" });
      const commandId = id();
      // Already completed synthetic record only; never call enqueue/claim/report.
      await db.insert(schema.managedRuntimeCommands).values({ id: commandId, organizationId: org, projectId, instanceId, sessionId,
        action: "session_sync", actorId: user, status: "succeeded", idempotencyKey: id() });
      for (const sequence of [1, 2]) {
        await db.insert(schema.managedRuntimeEvents).values({ organizationId: org, sessionId, commandId, sequence, eventType: "test.message",
          encryptedPayloadJson: codec.encrypt({ text: `private-${projectId}-${sequence}` }, { organizationId: org, projectId, instanceId, sessionId, commandId, purpose: "session_event" }) });
      }
    }
    const doc = document();
    const [revision] = await db.insert(authorizationPolicyRevisions).values({ organizationId: org, document: doc, digest: policyDigest(doc), createdBy: owner, reason: "Synthetic fixture" }).returning();
    await db.insert(authorizationPolicyHeads).values({ organizationId: org, activeRevisionId: revision!.id, generation: 0 });
  });
  afterAll(async () => { globalThis.fetch = originalFetch; if (enabled) await dbClient.end(); });

  test("A-only human reads real encrypted A events; B and nested mismatch deny before payload", async () => {
    const { source, browser } = await openSource();
    const page = await source.loadEvents(0);
    expect(page.items.map(e => e.sequence)).toEqual([1, 2]);
    expect(page.items[0]!.payload).toEqual({ text: `private-${projectA}-1` });
    await source.authorizeEmission();
    expect(browser.resolutions()).toBe(3);
    expect((await source.loadEvents(1)).items.map(e => e.sequence)).toEqual([2]);
    await expect(createManagedRuntimeStreamSource({ resolveWorkspace: browser.resolveWorkspace,
      projectRef: "b", instanceId: instanceB, sessionId: sessionB, codec })).rejects.toMatchObject({ status: 403 });
    await expect(createManagedRuntimeStreamSource({ resolveWorkspace: browser.resolveWorkspace,
      projectRef: "a", instanceId: instanceA, sessionId: sessionB, codec })).rejects.toMatchObject({ status: 404 });
    expect((await store.decide({ userId: user, organizationId: org }, projectA, "project.write")).allowed).toBe(false);
  });

  test("policy publication after load rejects the initial batch; old source sees a later explicit regrant", async () => {
    const { source } = await openSource();
    const initialPage = await source.loadEvents(0);
    const revoked = document(); revoked.rules = [];
    await publish(revoked);
    errorOnly(await new Response(createManagedRuntimeEventStream({ ...source, initialPage, initialSequence: 0 })).text());
    await expect(source.loadEvents(0)).rejects.toMatchObject({ status: 403 });
    await publish(document());
    await source.authorizeEmission();
    expect((await source.loadEvents(1)).items).toHaveLength(1);
  });

  test("revocation while a poll is pending discards its decrypted page, without altering delivered data", async () => {
    const { source } = await openSource();
    const loaded = await source.loadEvents(0);
    const output = await new Response(createManagedRuntimeEventStream({ ...source,
      initialPage: { items: loaded.items.slice(0, 1), nextSequence: 1 }, initialSequence: 0, pollIntervalMs: 1,
      loadEvents: async cursor => {
        const page = await source.loadEvents(cursor);
        const revoked = document(); revoked.rules = []; await publish(revoked);
        return page;
      },
    })).text();
    expect(output).toContain(`private-${projectA}-1`);
    expect(output).not.toContain(`private-${projectA}-2`);
    expect(output).not.toContain("id: 2");
    expect(output).toContain("stream_error");
    await publish(document());
  });

  test("browser-session revocation blocks emission and reconnect for the same opaque token", async () => {
    const { source, browser } = await openSource();
    const initialPage = await source.loadEvents(0);
    await revokeOidcBrowserSession(browser.token);
    errorOnly(await new Response(createManagedRuntimeEventStream({ ...source, initialPage, initialSequence: 0 })).text());
    await expect(source.loadEvents(0)).rejects.toMatchObject({ status: 401 });
    await expect(createManagedRuntimeStreamSource({ resolveWorkspace: browser.resolveWorkspace,
      projectRef: "a", instanceId: instanceA, sessionId: sessionA, codec })).rejects.toMatchObject({ status: 401 });
  });

  test("session expiry and membership removal each invalidate the already loaded batch", async () => {
    for (const reason of ["expired", "removed"]) {
      const { source, browser } = await openSource();
      const initialPage = await source.loadEvents(0);
      if (reason === "expired") await db.update(schema.consoleBrowserSessions).set({ expiresAt: new Date(0) })
        .where(eq(schema.consoleBrowserSessions.tokenHash, hashBrowserSessionToken(browser.token)!));
      else await db.update(schema.organizationMemberships).set({ status: "removed" }).where(eq(schema.organizationMemberships.userId, user));
      try {
        errorOnly(await new Response(createManagedRuntimeEventStream({ ...source, initialPage, initialSequence: 0 })).text());
        await expect(source.authorizeEmission()).rejects.toMatchObject({ status: 401 });
      } finally {
        if (reason === "removed") await db.update(schema.organizationMemberships).set({ status: "active" }).where(eq(schema.organizationMemberships.userId, user));
      }
    }
  });

  test("scope is pinned to project UUID despite slug change, and nested scope is rechecked", async () => {
    const { source } = await openSource();
    await db.update(schema.projects).set({ slug: "renamed-a" }).where(eq(schema.projects.id, projectA));
    try {
      expect((await source.loadEvents(0)).items).toHaveLength(2);
      const initialPage = await source.loadEvents(0);
      await db.update(schema.managedRuntimeSessions).set({ projectId: projectB }).where(eq(schema.managedRuntimeSessions.id, sessionA));
      errorOnly(await new Response(createManagedRuntimeEventStream({ ...source, initialPage, initialSequence: 0 })).text());
    } finally {
      await db.update(schema.managedRuntimeSessions).set({ projectId: projectA }).where(eq(schema.managedRuntimeSessions.id, sessionA));
      await db.update(schema.projects).set({ slug: "a" }).where(eq(schema.projects.id, projectA));
    }
  });

  test("a resolver cannot swap human, organization, auth mode or add delegation midstream", async () => {
    const browser = await openSession();
    const workspace = (await browser.resolveWorkspace())!;
    let replacement: typeof workspace | null = null;
    const source = await createManagedRuntimeStreamSource({ resolveWorkspace: async () => replacement ?? browser.resolveWorkspace(),
      projectRef: "a", instanceId: instanceA, sessionId: sessionA, codec });
    for (const patch of [{ user: { ...workspace.user, id: owner } },
      { organization: { ...workspace.organization, id: id() } }, { mode: "anonymous" as const },
      { authorization: { installationId: id(), sessionId: id(), bindingId: null, accessTokenJti: "synthetic" } }]) {
      replacement = { ...workspace, ...patch };
      await expect(source.loadEvents(0)).rejects.toMatchObject({ status: 403 });
      await expect(source.authorizeEmission()).rejects.toMatchObject({ status: 403 });
    }
    const delegated = { ...workspace, authorization: { installationId: id(), sessionId: id(), bindingId: null, accessTokenJti: "synthetic" } };
    await expect(createManagedRuntimeStreamSource({ resolveWorkspace: async () => delegated,
      projectRef: "a", instanceId: instanceA, sessionId: sessionA, codec })).rejects.toMatchObject({ status: 403 });
  });

  test("fixture never dispatched commands, created a runtime or called a provider", async () => {
    const commands = await db.select().from(schema.managedRuntimeCommands).where(eq(schema.managedRuntimeCommands.organizationId, org));
    expect(commands).toHaveLength(2);
    expect(commands.every(row => row.status === "succeeded" && row.claimOwner === null && row.attemptCount === 0)).toBe(true);
    expect(await db.select().from(schema.managedRuntimeOperations).where(eq(schema.managedRuntimeOperations.organizationId, org))).toHaveLength(0);
    expect(await db.select().from(schema.managedRuntimeSessions).where(eq(schema.managedRuntimeSessions.organizationId, org))).toHaveLength(2);
    expect(fetchAttempts).toBe(0);
  });
});
