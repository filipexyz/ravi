import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TransactionSql } from "postgres";
import { db, dbClient, schema } from "@/server/db";
import { createAuthorizationStore } from "./store";
import { BOOTSTRAP_CONFIGURATION_ACTIONS, initializeAuthorizationInBootstrapTransaction, type BootstrapAuthorizationProof } from "./bootstrap";
import { decideOrganizationInPostgresTransaction } from "./postgres";
import { policySchema, type ProjectPolicy } from "./policy";
import { handlePolicyRequest } from "./http";
import { ensureAuthorizationBootstrapPrerequisite } from "../../../../tests/fleet/authorization-bootstrap-prerequisite";

const enabled = Boolean(process.env.RAVI_POLICY_TEST_CLUSTER && process.env.PGHOST === process.env.RAVI_POLICY_TEST_CLUSTER && process.env.DATABASE_URL === "postgres:///postgres");
const suite = enabled ? describe : describe.skip;
const id = () => crypto.randomUUID();
const store = createAuthorizationStore(db);
const first = { organizationId: id(), userId: id(), identityId: id(), attemptId: id() };
const ownerName = id(), adminName = id(), projectA = id(), projectB = id(), roleId = id();
const admin = { organizationId: first.organizationId, userId: first.userId };
const reader = { organizationId: first.organizationId, userId: ownerName };
const mutation = (expectedGeneration: number) => ({ expectedGeneration, operationKey: id(), reason: "Synthetic contract acceptance" });

async function provisionAttempt(proof: BootstrapAuthorizationProof) {
  await dbClient`insert into organizations(id,name,slug) values(${proof.organizationId},'Contract fixture',${proof.organizationId})`;
  await dbClient`insert into fleet_bootstrap_grants(organization_id,token_hash,expected_email,expires_at,attempt_id,attempt_expires_at)
    values(${proof.organizationId},'synthetic-never-a-token','bootstrap@contract.invalid',now()+interval '5 minutes',${proof.attemptId},now()+interval '5 minutes')`;
}
/** Admitted-identity fixture, NOT an OIDC/browser acceptance test. Real production
 * adapter must run in BootstrapService.complete after its protected admission. */
async function admittedIdentity(tx: TransactionSql, proof: BootstrapAuthorizationProof) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${proof.organizationId}`},0))`;
  const existing = await tx`select user_id from organization_memberships where organization_id=${proof.organizationId}`;
  if (!existing.length) {
    await tx`insert into users(id,primary_email) values(${proof.userId},${proof.userId + '@contract.invalid'})`;
    await tx`insert into auth_identities(id,provider,provider_user_id,user_id,email)
      values(${proof.identityId},'oidc:synthetic-contract',${proof.userId},${proof.userId},${proof.userId + '@contract.invalid'})`;
    // Deliberately NOT owner/admin; admission role label grants nothing.
    await tx`insert into organization_memberships(organization_id,user_id,role) values(${proof.organizationId},${proof.userId},'viewer')`;
    await tx`update fleet_bootstrap_grants set consumed_at=now(),claimed_by=${proof.userId} where organization_id=${proof.organizationId}`;
  }
}
async function publish(document: ProjectPolicy) {
  const before = await store.read(admin);
  const draft = await store.saveDraft(admin, { ...mutation(before.generation), document });
  const preview = await store.preview(admin, { expectedGeneration: draft.generation });
  await store.publish(admin, { ...mutation(draft.generation), previewId: preview.id });
}

suite("partial authorization contract — real PostgreSQL, synthetic identity admission", () => {
  beforeAll(async () => {
    // No identity/engine/assertion change. Use the real0073 schema on composition,
    // or the checked prerequisite on standalone. Neither is an OIDC proof.
    await ensureAuthorizationBootstrapPrerequisite(dbClient);
    await provisionAttempt(first);
  });
  afterAll(async () => { if (enabled) await dbClient.end(); });

  test("two concurrent claims: one first grant, one exact receipt, no duplicate identity/audit", async () => {
    const claim = () => dbClient.begin(async tx => { await admittedIdentity(tx, first); return initializeAuthorizationInBootstrapTransaction(tx, first); });
    const results = await Promise.all([claim(), claim()]);
    expect(results.map(r => r.replay).sort()).toEqual([false, true]);
    expect(results[0]!.revisionId).toBe(results[1]!.revisionId);
    expect(Number((await dbClient`select count(*) n from authorization_bootstrap_receipts where organization_id=${first.organizationId}`)[0]!.n)).toBe(1);
    expect(Number((await dbClient`select count(*) n from authorization_audit where organization_id=${first.organizationId} and action='policy.bootstrap'`)[0]!.n)).toBe(1);
    expect(Number((await dbClient`select count(*) n from organization_memberships where organization_id=${first.organizationId}`)[0]!.n)).toBe(1);
    await expect(dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, { ...first, attemptId: id() }))).rejects.toMatchObject({ status: 409 });
    await expect(dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, { ...first, userId: id() }))).rejects.toMatchObject({ status: 409 });
    expect((await store.decideOrganization(admin, "organization.settings.manage")).allowed).toBe(true);
    expect((await store.decideOrganization(admin, "organization.projects.create")).allowed).toBe(false);
    expect((await store.decideOrganization(admin, "organization.members.read")).allowed).toBe(false);
    expect((await store.decideOrganization(admin, "organization.members.manage")).allowed).toBe(false);
    expect((await store.read(admin)).active!.document.organizationRules?.flatMap(rule => rule.actions)).toEqual([...BOOTSTRAP_CONFIGURATION_ACTIONS]);
    expect((await store.read(admin)).generation).toBe(1);
  });

  test("two different first identities cannot both claim the organization", async () => {
    const proof = { organizationId: id(), userId: id(), identityId: id(), attemptId: id() };
    await provisionAttempt(proof);
    const other = { ...proof, userId: id(), identityId: id() };
    const claim = (p: BootstrapAuthorizationProof) => dbClient.begin(async tx => {
      await admittedIdentity(tx, p); return initializeAuthorizationInBootstrapTransaction(tx, p);
    });
    const results = await Promise.allSettled([claim(proof), claim(other)]);
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    expect(results.filter(r => r.status === "rejected").length).toBe(1);
    expect(Number((await dbClient`select count(*) n from organization_memberships where organization_id=${proof.organizationId}`)[0]!.n)).toBe(1);
    expect(Number((await dbClient`select count(*) n from authorization_audit where organization_id=${proof.organizationId} and action='policy.bootstrap'`)[0]!.n)).toBe(1);
  });

  test("rollback removes identity, membership, first grant and audit; attempt remains unconsumed", async () => {
    const proof = { organizationId: id(), userId: id(), identityId: id(), attemptId: id() };
    await provisionAttempt(proof);
    await expect(dbClient.begin(async tx => {
      await admittedIdentity(tx, proof);
      await initializeAuthorizationInBootstrapTransaction(tx, proof);
      throw new Error("synthetic callback failure after grant");
    })).rejects.toThrow("synthetic callback failure");
    for (const table of ["authorization_policy_heads", "authorization_policy_revisions", "authorization_bootstrap_receipts", "authorization_audit", "organization_memberships"]) {
      const rows = await dbClient.unsafe(`select count(*) n from ${table} where organization_id=$1`, [proof.organizationId]);
      expect(Number(rows[0]!.n)).toBe(0);
    }
    expect((await dbClient`select id from users where id=${proof.userId}`).length).toBe(0);
    expect((await dbClient`select consumed_at from fleet_bootstrap_grants where organization_id=${proof.organizationId}`)[0]!.consumed_at).toBeNull();
    const retry = await dbClient.begin(async tx => { await admittedIdentity(tx, proof); return initializeAuthorizationInBootstrapTransaction(tx, proof); });
    expect(retry.replay).toBe(false);
  });

  test("separate transaction, unconsumed attempt and preexisting identity cannot self-initialize", async () => {
    const proof = { organizationId: id(), userId: id(), identityId: id(), attemptId: id() };
    await provisionAttempt(proof);
    await expect(dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, proof))).rejects.toMatchObject({ status: 409 });
    await dbClient.begin(tx => admittedIdentity(tx, proof));
    await expect(dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, proof))).rejects.toMatchObject({ status: 409 });
    const actor = { organizationId: proof.organizationId, userId: proof.userId };
    await dbClient`update organization_memberships set role='owner' where organization_id=${proof.organizationId}`;
    await expect(store.read(actor)).rejects.toMatchObject({ status: 403 });
    expect((await store.decideOrganization(actor, "organization.authorization.manage")).allowed).toBe(false);
    expect((await dbClient`select organization_id from authorization_policy_heads where organization_id=${proof.organizationId}`).length).toBe(0);
  });

  test("owner/admin labels grant nothing; initial organization manager cannot read projects", async () => {
    await db.insert(schema.users).values([{ id: ownerName, primaryEmail: "owner-name@contract.invalid" }, { id: adminName, primaryEmail: "admin-name@contract.invalid" }]);
    await db.insert(schema.organizationMemberships).values([{ organizationId: first.organizationId, userId: ownerName, role: "owner" }, { organizationId: first.organizationId, userId: adminName, role: "admin" }]);
    await db.insert(schema.projects).values([{ id: projectA, organizationId: first.organizationId, slug: "a", name: "A" }, { id: projectB, organizationId: first.organizationId, slug: "b", name: "B" }]);
    for (const userId of [ownerName, adminName]) {
      const actor = { organizationId: first.organizationId, userId };
      await expect(store.read(actor)).rejects.toMatchObject({ status: 403 });
      expect((await store.decideOrganization(actor, "organization.credentials.manage")).allowed).toBe(false);
      expect((await store.decide(actor, projectA, "project.read")).allowed).toBe(false);
    }
    expect((await store.decide(admin, projectA, "project.read")).allowed).toBe(false);
  });

  test("custom project role, rename, same-org A/B and no org power", async () => {
    const document = policySchema.parse((await store.read(admin)).active!.document);
    document.roles.push({ id: roleId, name: "Project reviewers", members: [ownerName], groups: [], scope: { kind: "project", projects: [projectA] } });
    document.rules.push({ id: "reviewer-read", effect: "allow", principals: [{ kind: "role", id: roleId }], projects: ["*"], actions: ["project.read"] });
    await publish(document);
    expect((await store.accessibleProjects(reader)).map(p => p.id)).toEqual([projectA]);
    expect((await store.decide(reader, projectB, "project.read")).allowed).toBe(false);
    expect((await store.decide(reader, projectA, "project.write")).allowed).toBe(false);
    expect((await store.decideOrganization(reader, "organization.authorization.manage")).allowed).toBe(false);
    document.roles.find(r => r.id === roleId)!.name = "admin";
    await publish(document);
    expect((await store.decide(reader, projectA, "project.read")).allowed).toBe(true);
    expect((await store.decideOrganization(reader, "organization.credentials.read")).allowed).toBe(false);
  });

  test("organization actions through SAME engine in postgres/Drizzle, revocation and API denial", async () => {
    const document = policySchema.parse((await store.read(admin)).active!.document);
    document.organizationRules.push({ id: "credentials-metadata", effect: "allow", principals: [{ kind: "user", id: ownerName }], actions: ["organization.credentials.read"] });
    await publish(document);
    expect((await store.decideOrganization(reader, "organization.credentials.read")).allowed).toBe(true);
    expect((await store.simulate(admin, { expectedGeneration: (await store.read(admin)).generation,
      userId: ownerName, source: "active", resourceKind: "organization", action: "organization.credentials.read" })).allowed).toBe(true);
    expect((await dbClient.begin(tx => decideOrganizationInPostgresTransaction(tx, reader, "organization.credentials.read", id()))).allowed).toBe(true);
    let effects = 0;
    await expect(store.withAuthorizedOrganization(reader, "organization.credentials.manage", async () => ++effects)).rejects.toMatchObject({ status: 403 });
    expect(effects).toBe(0);
    document.organizationRules = document.organizationRules.filter(r => r.id !== "credentials-metadata");
    document.roles.find(r => r.id === roleId)!.members = [];
    await publish(document);
    expect((await store.decideOrganization(reader, "organization.credentials.read")).allowed).toBe(false);
    expect((await dbClient.begin(tx => decideOrganizationInPostgresTransaction(tx, reader, "organization.credentials.read", id()))).allowed).toBe(false);
    expect((await store.decide(reader, projectA, "project.read")).allowed).toBe(false);
    const generation = (await store.read(admin)).generation;
    const request = new Request("https://contract.invalid/api/console/authorization/draft", { method: "POST", headers: { origin: "https://contract.invalid", "content-type": "application/json" },
      body: JSON.stringify({ ...mutation(generation), document }) });
    const response = await handlePolicyRequest(request, ["draft"], { authenticate: async () => reader, canonicalOrigin: () => "https://contract.invalid", store });
    expect(response.status).toBe(403);
    expect((await store.read(admin)).generation).toBe(generation);
    const replay = await dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, first));
    expect(replay.replay).toBe(true);
    expect((await store.read(admin)).generation).toBe(generation); // bootstrap replay does NOT reset policy
  });

  test("manage without policy read cannot inspect, simulate or grant itself read", async () => {
    const document = policySchema.parse((await store.read(admin)).active!.document);
    document.organizationRules.push({ id: "manage-only", effect: "allow", principals: [{ kind: "user", id: ownerName }], actions: ["organization.authorization.manage"] });
    await publish(document);
    expect((await store.decideOrganization(reader, "organization.authorization.manage")).allowed).toBe(true);
    const generation = (await store.read(admin)).generation;
    await expect(store.read(reader)).rejects.toMatchObject({ status: 403 });
    await expect(store.preview(reader, { expectedGeneration: generation })).rejects.toMatchObject({ status: 403 });
    await expect(store.simulate(reader, { expectedGeneration: generation, userId: ownerName, source: "active", projectId: projectA, action: "project.read" })).rejects.toMatchObject({ status: 403 });
    const escalation = structuredClone(document);
    escalation.administrators.push({ kind: "user", id: ownerName });
    await expect(store.saveDraft(reader, { ...mutation(generation), document: escalation })).rejects.toMatchObject({ status: 403 });
    expect((await store.read(admin)).generation).toBe(generation);
    document.organizationRules = document.organizationRules.filter(rule => rule.id !== "manage-only");
    await publish(document);
  });

  test("CAS has a single winner, exact retries are idempotent, policy deny prevents self-lockout", async () => {
    const before = await store.read(admin), document = policySchema.parse(before.active!.document);
    const input = { ...mutation(before.generation), document };
    const second = { ...input, operationKey: id() };
    const results = await Promise.allSettled([store.saveDraft(admin, input), store.saveDraft(admin, second)]);
    expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
    const winner = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof store.saveDraft>>>;
    expect(await store.saveDraft(admin, results[0]!.status === "fulfilled" ? input : second)).toEqual(winner.value);
    document.organizationRules.push({ id: "lockout", effect: "deny", principals: [{ kind: "user", id: first.userId }], actions: ["organization.authorization.manage"] });
    await expect(store.saveDraft(admin, { ...mutation(winner.value.generation), document })).rejects.toMatchObject({ payload: { error: "authorization_self_lockout" } });
    await expect(store.saveDraft(admin, { ...mutation(winner.value.generation), document: { ...document, format: 9 } })).rejects.toThrow();
  });

  test("bootstrap replay never restores a revoked original grant or gains new catalog actions", async () => {
    const document = policySchema.parse((await store.read(admin)).active!.document);
    document.organizationRules = document.organizationRules.map(rule => ({ ...rule,
      actions: rule.actions.filter(action => action !== "organization.settings.manage") }));
    await publish(document);
    const before = await store.read(admin);
    const replay = await dbClient.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, first));
    expect(replay.replay).toBe(true);
    expect((await store.read(admin)).generation).toBe(before.generation);
    expect((await store.read(admin)).active!.id).toBe(before.active!.id);
    for (const action of ["organization.settings.manage", "organization.projects.create", "organization.members.read", "organization.members.manage"] as const)
      expect((await store.decideOrganization(admin, action)).allowed).toBe(false);
    expect((await store.decide(admin, projectA, "project.read")).allowed).toBe(false);
  });
});
