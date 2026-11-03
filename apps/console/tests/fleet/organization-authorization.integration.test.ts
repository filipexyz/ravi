import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { FleetService } from "../../src/server/console/fleet/service";
import { postgresFleetStore } from "../../src/server/console/fleet/postgres-store";
import { OnboardingService } from "../../src/server/console/fleet/onboarding";
import { FleetSsoService } from "../../src/server/console/fleet/sso-service";
import type { FleetActor, SecretVault } from "../../src/server/console/fleet/contract";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} }) : null;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_org_authorization_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_org_authorization_fixture", username: "fleettest", max: 4, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
},60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });
async function fixture() {
  const org = randomUUID(), user = randomUUID(), other = randomUUID();
  await sql`insert into organizations(id,name,slug) values(${org},'Policy fixture',${`org-${org}`})`;
  await sql`insert into users(id,primary_email,display_name) values(${user},${`${user}@example.invalid`},'Synthetic steward'),(${other},${`${other}@example.invalid`},'Unassigned')`;
  await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'viewer','active'),(${org},${other},'owner','active')`;
  const actor: FleetActor = { organizationId: org, userId: user, mode: "oidc", role: "viewer" };
  let writes = 0, reads = 0, probes = 0;
  const vault: SecretVault = { async put() { writes++; }, async read() { reads++; return "synthetic-unused-secret"; } };
  const service = new FleetService(postgresFleetStore(sql), vault, async () => { probes++; return { ok: true, cliVersion: "3.261021.9" }; },
    { organizationId: org, operationKey: "synthetic-policy-fixture-operation-key" });
  const policy = fixturePolicy(org, user);
  const credential = () => ({ operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Scoped fixture", kind: "oidc_client_secret",
    value: "synthetic-fixture-only", binding: { issuer: "https://idp.example.invalid", clientId: "fixture" } });
  return { org, user, other, actor, policy, service, vault, credential, effects: () => ({ reads,writes,probes }) };
}

integration("organization decisions: custom scoped roles, rename, owner/admin without grants denied and audit survives", async () => {
  const f = await fixture();
  await expect(f.service.state({ ...f.actor, userId: f.other, role: "owner" })).rejects.toThrow("forbidden");
  await installFixturePolicy(sql, f.user, f.policy);
  expect(await f.service.credentials(f.actor)).toEqual([]);
  f.policy.roles[0]!.name = "Totally renamed steward";
  await installFixturePolicy(sql, f.user, f.policy);
  expect(await f.service.credentials({ ...f.actor, role: "arbitrary-label" })).toEqual([]);
  for (const role of ["owner", "admin"]) {
    await sql`update organization_memberships set role=${role} where organization_id=${f.org} and user_id=${f.other}`;
    const input = f.credential();
    await expect(f.service.writeCredential({ ...f.actor, userId: f.other, role }, input)).rejects.toThrow("forbidden");
    const [audit] = await sql`select metadata from authorization_audit where organization_id=${f.org} and actor_id=${f.other} and request_id=${input.operationId}`;
    expect(audit!.metadata.allowed).toBe(false);
    expect((await sql`select count(*)::int n from fleet_mutation_receipts where operation_id=${input.operationId}`)[0]!.n).toBe(0);
  }
  expect(f.effects()).toEqual({ reads:0,writes:0,probes:0 });
  // An organization role is not a wildcard across resources/projects/orgs.
  const restricted = structuredClone(f.policy);
  restricted.administrators = [{ kind: "user", id: f.other }];
  restricted.organizationRules[0]!.actions = ["organization.credentials.read"];
  await installFixturePolicy(sql, f.user, restricted);
  expect(await f.service.credentials(f.actor)).toEqual([]);
  await expect(f.service.installations(f.actor)).rejects.toThrow("forbidden");
  await expect(new OnboardingService(sql, f.org).state(f.actor)).rejects.toThrow("forbidden");
  await expect(f.service.credentials({ ...f.actor, organizationId: randomUUID() })).rejects.toThrow("forbidden");
});

integration("manage does not imply read; revocation blocks historical retry before vault or effects", async () => {
  const f = await fixture();
  f.policy.administrators = [{ kind: "user", id: f.other }];
  f.policy.organizationRules[0]!.actions = ["organization.credentials.manage"];
  await installFixturePolicy(sql, f.user, f.policy);
  const input = f.credential(), saved = await f.service.writeCredential(f.actor, input);
  expect(saved.revision).toBe(1); expect(f.effects().writes).toBe(1);
  await expect(f.service.credentials(f.actor)).rejects.toThrow("forbidden");
  expect(await f.service.writeCredential(f.actor, input)).toEqual(saved);
  f.policy.organizationRules = [];
  await installFixturePolicy(sql, f.user, f.policy);
  await expect(f.service.writeCredential(f.actor, input)).rejects.toThrow("forbidden");
  expect(f.effects()).toEqual({ reads:0,writes:1,probes:0 });
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where operation_id=${input.operationId}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int n from fleet_credentials where organization_id=${f.org}`)[0]!.n).toBe(1);
});

integration("SSO uses explicit sso action plus current session, not a role or another resource grant", async () => {
  const f = await fixture(), identity = randomUUID(), sessionHash = "b".repeat(64);
  await sql`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identity},'oidc:https://idp.example.invalid',${f.user},${f.user},${`${f.user}@example.invalid`})`;
  await sql`insert into console_browser_sessions(token_hash,auth_identity_id,user_id,organization_id,expires_at) values(${sessionHash},${identity},${f.user},${f.org},now()+interval '1 hour')`;
  const sso = new FleetSsoService(sql, f.vault, { organizationId: f.org, origin: "https://console.example.invalid", secret: "synthetic-session-secret-for-sso-tests", sessionTtlSeconds: 3600 });
  await installFixturePolicy(sql, f.user, f.policy);
  expect((await sso.state(f.actor,sessionHash)).connections).toEqual([]);
  f.policy.administrators = [{ kind: "user", id: f.other }]; f.policy.organizationRules[0]!.actions = ["organization.credentials.manage"];
  await installFixturePolicy(sql, f.user, f.policy);
  await expect(sso.state({ ...f.actor, role: "admin" },sessionHash)).rejects.toThrow("forbidden");
  f.policy.organizationRules[0]!.actions = ["organization.sso.read"];
  await installFixturePolicy(sql, f.user, f.policy);
  expect((await sso.state(f.actor,sessionHash)).connections).toEqual([]);
  await sql`update console_browser_sessions set revoked_at=now() where token_hash=${sessionHash}`;
  await expect(sso.state(f.actor,sessionHash)).rejects.toThrow("forbidden");
  expect(f.effects()).toEqual({ reads:0,writes:0,probes:0 });
});
