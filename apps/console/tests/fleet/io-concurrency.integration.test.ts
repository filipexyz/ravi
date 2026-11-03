import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { FleetService } from "../../src/server/console/fleet/service";
import { postgresFleetStore } from "../../src/server/console/fleet/postgres-store";
import { FleetSsoService } from "../../src/server/console/fleet/sso-service";
import { readOrganizationAccess } from "../../src/server/console/fleet/authorization";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";
import { createOidcBrowserSession } from "../../src/lib/auth/oidc-store";
import { dbClient } from "../../src/server/db";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const sql = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 5, onnotice() {} }) : null;
beforeAll(async () => { if (sql) await migrate(drizzle(sql), { migrationsFolder: "drizzle" }); }, 60000);
afterAll(async () => { await sql?.end(); await dbClient.end(); });
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("unrelated operation blocked by external I/O")), 1500); })]); }
  finally { clearTimeout(timer); }
}
async function fixture() {
  const org = randomUUID(), user = randomUUID(), identityId = randomUUID(), sessionHash = randomBytes(32).toString("hex");
  const email = `${user}@example.invalid`, issuer = "https://fixture.example.invalid";
  await sql!`insert into organizations(id,name,slug) values(${org},'IO fixture',${org})`;
  await sql!`insert into users(id,primary_email,display_name) values(${user},${email},'Custom steward')`;
  await sql!`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'viewer','active')`;
  await sql!`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identityId},${`oidc:${issuer}`},${user},${user},${email})`;
  const [session] = await sql!`insert into console_browser_sessions(token_hash,auth_identity_id,user_id,organization_id,expires_at) values(${sessionHash},${identityId},${user},${org},now()+interval '1 hour') returning id`;
  const policy = fixturePolicy(org, user); await installFixturePolicy(sql!, user, policy);
  const actor = { organizationId: org, userId: user, mode: "oidc", role: "viewer", sessionId: session!.id as string };
  const identity = { issuer, subject: user, email, emailVerified: true as const, name: "Custom steward", groups: [] };
  const config = { organizationId: org, origin: "https://console.example.invalid", secret: "synthetic-io-fixture-secret-long-enough", sessionTtlSeconds: 3600, issuer, clientId: "test", clientSecret: "synthetic" };
  const vault = { async put() {}, async read() { return "synthetic-private-fixture"; } };
  return { org, user, sessionHash, actor, policy, identity, config, vault };
}
integration("slow SSH has no global lock: navigation/login/revocation proceed; stale result cannot publish", async () => {
  const f = await fixture(), gate = barrier(); let probes = 0;
  const service = new FleetService(postgresFleetStore(sql!), f.vault, async () => { probes++; await gate.wait(); return { ok: true, cliVersion: "3.261021.9" }; },
    { organizationId: f.org, operationKey: f.config.secret });
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const credential = await service.writeCredential(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "SSH", kind: "ssh_private_key", value: key });
  const installation = await service.writeInstallation(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Private", hostname: "100.64.0.8", username: "ravi", hostFingerprint: `SHA256:${"a".repeat(43)}`, credentialId: credential.id });
  const request = { operationId: randomUUID(), id: installation.id, expectedRevision: installation.revision };
  const pending = service.testInstallation(f.actor, request).then(result => ({ result }), error => ({ error }));
  try {
    await bounded(gate.entered);
    expect((await bounded(readOrganizationAccess(sql!, f.org, f.actor))).actions["organization.installations.manage"]).toBe(true);
    expect((await bounded(createOidcBrowserSession(f.identity, f.config))).token).toBeTruthy();
    await expect(bounded(service.testInstallation(f.actor, request))).rejects.toThrow("operation_in_progress");
    await bounded(service.revokeCredential(f.actor, { operationId: randomUUID(), id: credential.id, expectedRevision: credential.revision }));
  } finally { gate.release(); }
  const outcome = await pending; expect("error" in outcome && outcome.error.message).toBe("version_conflict");
  expect(probes).toBe(1);
  expect((await sql!`select count(*)::int n from fleet_mutation_receipts where operation_id=${request.operationId}`)[0]!.n).toBe(0);
  expect((await service.installations(f.actor))[0]!.status).toBe("draft");
});
integration("slow IdP has no global lock: native login proceeds; suspended callback cannot complete or replay", async () => {
  const f = await fixture(), gate = barrier(); let calls = 0;
  const service = new FleetService(postgresFleetStore(sql!), f.vault, async () => ({ ok: true, cliVersion: "unused" }), { organizationId: f.org, operationKey: f.config.secret });
  const credential = await service.writeCredential(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "IdP", kind: "oidc_client_secret", value: "synthetic", binding: { issuer: f.config.issuer, clientId: "test" } });
  const sso = new FleetSsoService(sql!, f.vault, f.config, {
    async begin() { const state = randomBytes(32).toString("hex"); return { transaction: { state, nonce: state, verifier: state, returnTo: "/projects" }, url: new URL(`${f.config.issuer}/authorize?state=${state}`) }; },
    async complete() { calls++; await gate.wait(); return f.identity; },
  });
  const draft = await sso.save(f.actor, f.sessionHash, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Candidate", issuer: f.config.issuer, clientId: "test", credentialId: credential.id, allowPrivateNetwork: false, admissionGroups: [] });
  const started = await sso.beginTest(f.actor, f.sessionHash, { operationId: randomUUID(), id: draft.id, expectedRevision: draft.revision });
  const callback = new URL(`/callback/fleet?state=${new URL(started.url).searchParams.get("state")}&code=synthetic`, f.config.origin);
  const pending = sso.completeTest(f.actor, f.sessionHash, callback, started.cookie).then(result => ({ result }), error => ({ error }));
  try {
    await bounded(gate.entered);
    expect((await bounded(createOidcBrowserSession(f.identity, f.config))).token).toBeTruthy();
    await bounded(sql!`update organization_memberships set status='suspended' where organization_id=${f.org} and user_id=${f.user}`);
  } finally { gate.release(); }
  const outcome = await pending; expect("error" in outcome && outcome.error.message).toBe("authorization_identity_invalid");
  expect(calls).toBe(1);
  expect((await sql!`select status from fleet_sso_connections where id=${draft.id}`)[0]!.status).toBe("draft");
  expect((await sql!`select count(*)::int n from fleet_sso_challenges where organization_id=${f.org} and consumed_at is not null`)[0]!.n).toBe(0);
  await sql!`update organization_memberships set status='active' where organization_id=${f.org} and user_id=${f.user}`;
  await expect(sso.completeTest(f.actor, f.sessionHash, callback, started.cookie)).rejects.toThrow("operation_in_progress");
  expect(calls).toBe(1);
});

for (const change of ["session", "policy", "configuration", "lease"] as const) {
  integration(`SSH finalization revalidates ${change}, not only membership`, async () => {
    const f = await fixture(), gate = barrier();
    const service = new FleetService(postgresFleetStore(sql!), f.vault, async () => { await gate.wait(); return { ok: true, cliVersion: "synthetic" }; }, { organizationId: f.org, operationKey: f.config.secret });
    const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const credential = await service.writeCredential(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "SSH", kind: "ssh_private_key", value: key });
    const installInput = { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Private", hostname: "100.64.0.8", username: "ravi", hostFingerprint: `SHA256:${"a".repeat(43)}`, credentialId: credential.id };
    const installation = await service.writeInstallation(f.actor, installInput);
    const request = { operationId: randomUUID(), id: installation.id, expectedRevision: installation.revision };
    const pending = service.testInstallation(f.actor, request).then(result => ({ result }), error => ({ error }));
    try {
      await bounded(gate.entered);
      if (change === "session") await bounded(sql!`update console_browser_sessions set revoked_at=now() where id=${f.actor.sessionId}`);
      if (change === "policy") {
        const document = structuredClone(f.policy);
        document.organizationRules![0]!.actions = document.organizationRules![0]!.actions.filter(action => action !== "organization.installations.manage");
        await bounded(installFixturePolicy(sql!, f.user, document));
      }
      if (change === "configuration") await bounded(service.writeInstallation(f.actor, { ...installInput, operationId: randomUUID(), expectedRevision: installation.revision, hostname: "100.64.0.9" }));
      // Synthetic clock/lease fault only in the private fixture, not a retry takeover.
      if (change === "lease") await sql!`update fleet_io_reservations set expires_at=now()-interval '1 second' where operation_id=${request.operationId}`;
    } finally { gate.release(); }
    const outcome = await pending;
    expect("error" in outcome && outcome.error.message).toBe({ session: "auth_required", policy: "forbidden", configuration: "version_conflict", lease: "operation_outcome_unknown" }[change]);
    expect((await sql!`select count(*)::int n from fleet_mutation_receipts where operation_id=${request.operationId}`)[0]!.n).toBe(0);
    expect((await sql!`select status from fleet_installations where id=${installation.id}`)[0]!.status).toBe("draft");
  });
}

integration("revocation during Vault read prevents sending the old secret to SSH", async () => {
  const f = await fixture(), gate = barrier(); let probes = 0;
  const vault = { ...f.vault, async read() { await gate.wait(); return "synthetic-revoked-secret"; } };
  const service = new FleetService(postgresFleetStore(sql!), vault, async () => { probes++; return { ok: true, cliVersion: "synthetic" }; }, { organizationId: f.org, operationKey: f.config.secret });
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const credential = await service.writeCredential(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "SSH", kind: "ssh_private_key", value: key });
  const installation = await service.writeInstallation(f.actor, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Private", hostname: "100.64.0.8", username: "ravi", hostFingerprint: `SHA256:${"a".repeat(43)}`, credentialId: credential.id });
  const pending = service.testInstallation(f.actor, { operationId: randomUUID(), id: installation.id, expectedRevision: installation.revision }).then(result => ({ result }), error => ({ error }));
  try { await bounded(gate.entered); await bounded(service.revokeCredential(f.actor, { operationId: randomUUID(), id: credential.id, expectedRevision: credential.revision })); }
  finally { gate.release(); }
  expect("error" in await pending).toBe(true); expect(probes).toBe(0);
});
