import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID, generateKeyPairSync, randomBytes, createHmac } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { postgresFleetStore } from "../../src/server/console/fleet/postgres-store";
import { FleetService } from "../../src/server/console/fleet/service";
import { credentialWriteSchema, type FleetActor, type SecretVault } from "../../src/server/console/fleet/contract";
import { FleetSsoService, loadManagedOidc, SSO_TEST_CALLBACK } from "../../src/server/console/fleet/sso-service";
import { beginOidcLogin, completeOidcLogin, type OidcVerifiedIdentity } from "../../src/lib/auth/oidc-client";
import { oidcProviderFixture } from "./oidc-provider-fixture";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";

// Explicit dedicated socket only; never inherit DATABASE_URL or a running database.
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const sql = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 4, onnotice: () => {} }) : null;
const org = randomUUID(), user = randomUUID(), viewer = randomUUID(), otherOrg = randomUUID();
const actor: FleetActor = { organizationId: org, userId: user, mode: "oidc", role: "owner" };
const values = new Map<string, string>(); let writes = 0, probes = 0;
const vault: SecretVault = { async put(ref, value) { writes++; values.set(JSON.stringify(ref), value); }, async read(ref) {
  const value = values.get(JSON.stringify(ref)); if (!value) throw new Error("missing test value"); return value;
} };
const service = sql ? new FleetService(postgresFleetStore(sql), vault, async () => { probes++; return { ok: true, cliVersion: "3.261021.9" }; },
  { organizationId: org, operationKey: "synthetic-local-postgres-operation-key" }) : null;
beforeAll(async () => {
  if (!sql) return;
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  const count = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  expect((await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n).toBe(count[0]!.n);
  expect(count[0]!.n).toBe(79);
  await sql`insert into organizations (id,name,slug) values (${org},'Local test',${`fleet-${org}`}),(${otherOrg},'Other test',${`fleet-${otherOrg}`})`;
  await sql`insert into users (id,primary_email,display_name) values (${user},${`${user}@example.invalid`},'Test Owner'),(${viewer},${`${viewer}@example.invalid`},'Test Viewer')`;
  await sql`insert into organization_memberships (organization_id,user_id,role,status) values (${org},${user},'owner','active'),(${org},${viewer},'viewer','active')`;
  await installFixturePolicy(sql, user, fixturePolicy(org, user));
}, 60_000);
afterAll(async () => { await sql?.end(); });

integration("real PG: concurrent retries create one metadata record, one effect and one audit", async () => {
  const input = { operationId: randomUUID(), id: randomUUID(), label: "OIDC test", kind: "oidc_client_secret", expectedRevision: 0,
    binding: { issuer: "https://idp.example.invalid", clientId: "fleet-fixture" }, value: "synthetic-only-not-production" };
  const outcomes = await Promise.allSettled([service!.writeCredential(actor, input), service!.writeCredential(actor, input)]);
  const successes = outcomes.filter(x => x.status === "fulfilled"); expect(successes.length).toBeGreaterThanOrEqual(1);
  for (const result of outcomes) if (result.status === "rejected") expect(result.reason.message).toBe("operation_in_progress");
  const a = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<FleetService["writeCredential"]>>>).value;
  expect(await service!.writeCredential(actor, input)).toEqual(a); expect(writes).toBe(1);
  expect((await sql!`select count(*)::int n from fleet_credentials where organization_id=${org}`)[0]!.n).toBe(1);
  expect((await sql!`select count(*)::int n from audit_events where request_id=${input.operationId}`)[0]!.n).toBe(1);
  const persisted = await sql!`select row_to_json(c) as data from fleet_credentials c where organization_id=${org}`;
  expect(JSON.stringify(persisted)).not.toContain(input.value);
  await expect(service!.writeCredential(actor, { ...input, operationId: randomUUID() })).rejects.toThrow("version_conflict");
  const [receipt] = await sql!`select input_hash from fleet_mutation_receipts where operation_id=${input.operationId}`;
  expect(receipt!.input_hash).toMatch(/^v2:/);
  // Reproduce the exact persisted v1 digest, not a new compatibility write.
  function oldCanonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(oldCanonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${oldCanonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
  }
  const legacy = createHmac("sha256", "synthetic-local-postgres-operation-key").update(oldCanonical({ operation: "credential.saved", userId: actor.userId, body: credentialWriteSchema.parse(input) })).digest("hex");
  await sql!`update fleet_mutation_receipts set input_hash=${legacy} where operation_id=${input.operationId}`;
  const restarted = new FleetService(postgresFleetStore(sql!), vault, async () => { throw new Error("unexpected probe"); }, { organizationId: org, operationKey: "synthetic-local-postgres-operation-key" });
  expect(await restarted.writeCredential(actor, input)).toEqual(a); expect(writes).toBe(1);
  await expect(restarted.writeCredential(actor, { ...input, value: "different" })).rejects.toThrow("idempotency_conflict");
  expect((await sql!`select input_hash from fleet_mutation_receipts where operation_id=${input.operationId}`)[0]!.input_hash).toBe(legacy);
});
integration("real PG: stale elevated actor cannot bypass current membership, org boundary or suspension", async () => {
  await expect(service!.state({ ...actor, userId: viewer })).rejects.toThrow("forbidden");
  await expect(service!.state({ ...actor, organizationId: otherOrg })).rejects.toThrow("forbidden");
  await sql!`update organization_memberships set status='suspended' where organization_id=${org} and user_id=${user}`;
  await expect(service!.state(actor)).rejects.toThrow("authorization_identity_invalid");
  await sql!`update organization_memberships set status='active' where organization_id=${org} and user_id=${user}`;
});
integration("real PG: configuration/test/activation and revocation persist with no duplicate probe", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const c = await service!.writeCredential(actor, { operationId: randomUUID(), id: randomUUID(), label: "SSH test", kind: "ssh_private_key", expectedRevision: 0, value: key });
  const item = await service!.writeInstallation(actor, { operationId: randomUUID(), id: randomUUID(), label: "Local fixture", hostname: "100.64.0.8", port: 22,
    username: "ravi-fleet", hostFingerprint: `SHA256:${"a".repeat(43)}`, credentialId: c.id, expectedRevision: 0 });
  const input = { operationId: randomUUID(), id: item.id, expectedRevision: item.revision };
  const outcomes = await Promise.allSettled([service!.testInstallation(actor, input), service!.testInstallation(actor, input)]);
  const successes = outcomes.filter(x => x.status === "fulfilled"); expect(successes.length).toBeGreaterThanOrEqual(1);
  for (const result of outcomes) if (result.status === "rejected") expect(result.reason.message).toBe("operation_in_progress");
  const a = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<FleetService["testInstallation"]>>>).value;
  expect(await service!.testInstallation(actor, input)).toEqual(a); expect(probes).toBe(1);
  await service!.activateInstallation(actor, { operationId: randomUUID(), id: a.id, expectedRevision: a.revision });
  await service!.revokeCredential(actor, { operationId: randomUUID(), id: c.id, expectedRevision: c.revision });
  const state = await service!.state(actor);
  expect(state.installations[0]!.status).toBe("draft"); expect(state.installations[0]!.failureCode).toBe("credential_revoked");
  expect(JSON.stringify(state)).not.toContain("PRIVATE KEY");
});

integration("real PG SSO lifecycle: draft, exact login proof, explicit activation and real selection persistence (synthetic IdP/Vault)", async () => {
  const issuer = "https://idp.example.invalid", clientId = "fleet-fixture";
  const credential = await service!.writeCredential(actor, { operationId: randomUUID(), id: randomUUID(), label: "SSO lifecycle",
    kind: "oidc_client_secret", expectedRevision: 0, binding: { issuer, clientId }, value: "synthetic-sso-lifecycle-secret" });
  const identityId = randomUUID(), sessionHash = randomBytes(32).toString("hex"), secondHash = randomBytes(32).toString("hex");
  await sql!`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identityId},'oidc:https://old.example.invalid',${`original-${user}`},${user},${`${user}@example.invalid`})`;
  await sql!`insert into console_browser_sessions(token_hash,auth_identity_id,user_id,organization_id,expires_at)
    values(${sessionHash},${identityId},${user},${org},now()+interval '1 hour'),(${secondHash},${identityId},${user},${org},now()+interval '1 hour')`;
  const base = { origin: "https://console.example.invalid", secret: "synthetic-sso-test-auth-secret-32-characters", organizationId: org, sessionTtlSeconds: 3600 };
  let beginCount = 0;
  let returnedIdentity: OidcVerifiedIdentity = { issuer, subject: `candidate-${user}`, email: `${user}@example.invalid`, name: "Owner", emailVerified: true, groups: ["fleet-admins"] };
  const sso = new FleetSsoService(sql!, vault, base, {
    async begin() { beginCount++; const state = randomBytes(32).toString("base64url"); return {
      transaction: { state, nonce: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), returnTo: "/projects" },
      url: new URL(`${issuer}/authorize?state=${state}`) }; },
    async complete() { return returnedIdentity; },
  });
  const input = { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Candidate", issuer, clientId,
    credentialId: credential.id, allowPrivateNetwork: false, admissionGroups: ["fleet-admins"] };
  const draft = await sso.save(actor, sessionHash, input);
  expect(await sso.save(actor, sessionHash, input)).toEqual(draft);
  expect(await loadManagedOidc(sql!, vault, base, true)).toBeNull();
  await expect(sso.activate(actor, sessionHash, { operationId: randomUUID(), id: draft.id, expectedRevision: draft.revision, acknowledgeIdentityChange: true })).rejects.toThrow("fresh_sso_login_required");
  await expect(sso.state({ ...actor, userId: viewer }, sessionHash)).rejects.toThrow("forbidden");
  await expect(sso.state({ ...actor, organizationId: otherOrg }, sessionHash)).rejects.toThrow("forbidden");
  const testInput = { operationId: randomUUID(), id: draft.id, expectedRevision: draft.revision };
  await expect(sso.beginTest(actor, sessionHash, { ...testInput, operationId: input.operationId })).rejects.toThrow("idempotency_conflict");
  expect(beginCount).toBe(0);
  let attempt = await sso.beginTest(actor, sessionHash, testInput);
  await expect(sso.save(actor, sessionHash, { ...input, operationId: testInput.operationId, expectedRevision: draft.revision })).rejects.toThrow("idempotency_conflict");
  expect(await sso.beginTest(actor, sessionHash, testInput)).toEqual(attempt); expect(beginCount).toBe(1);
  let callback = new URL(`${SSO_TEST_CALLBACK}?state=${new URL(attempt.url).searchParams.get("state")}&code=synthetic`, base.origin);
  await expect(sso.completeTest(actor, secondHash, callback, attempt.cookie)).rejects.toThrow("sso_test_expired");
  returnedIdentity = { ...returnedIdentity, email: "someone-else@example.invalid" };
  await expect(sso.completeTest(actor, sessionHash, callback, attempt.cookie)).rejects.toThrow("sso_admin_identity_mismatch");
  // A code sent to an IdP is never automatically retried. New independent
  // login attempts exercise each negative rather than reusing a consumed code.
  await expect(sso.completeTest(actor, sessionHash, callback, attempt.cookie)).rejects.toThrow("operation_in_progress");
  attempt = await sso.beginTest(actor, sessionHash, { ...testInput, operationId: randomUUID() });
  callback = new URL(`${SSO_TEST_CALLBACK}?state=${new URL(attempt.url).searchParams.get("state")}&code=synthetic`, base.origin);
  returnedIdentity = { ...returnedIdentity, email: `${user}@example.invalid`, groups: ["unrelated"] };
  await expect(sso.completeTest(actor, sessionHash, callback, attempt.cookie)).rejects.toThrow("sso_admin_identity_mismatch");
  attempt = await sso.beginTest(actor, sessionHash, { ...testInput, operationId: randomUUID() });
  callback = new URL(`${SSO_TEST_CALLBACK}?state=${new URL(attempt.url).searchParams.get("state")}&code=synthetic`, base.origin);
  returnedIdentity = { ...returnedIdentity, groups: ["fleet-admins"] };
  const tested = await sso.completeTest(actor, sessionHash, callback, attempt.cookie);
  expect(tested.status).toBe("tested");
  await expect(sso.completeTest(actor, sessionHash, callback, attempt.cookie)).rejects.toThrow("sso_test_expired");
  await expect(sso.activate(actor, secondHash, { operationId: randomUUID(), id: tested.id, expectedRevision: tested.revision, acknowledgeIdentityChange: true })).rejects.toThrow("fresh_sso_login_required");
  const activation = { operationId: randomUUID(), id: tested.id, expectedRevision: tested.revision, acknowledgeIdentityChange: true };
  const active = await sso.activate(actor, sessionHash, activation);
  expect(active.status).toBe("active"); expect(await sso.activate(actor, sessionHash, activation)).toEqual(active);
  expect((await loadManagedOidc(sql!, vault, base, true))?.clientSecret).toBe("synthetic-sso-lifecycle-secret");
  expect((await loadManagedOidc(sql!, { ...vault, read: async () => { throw new Error("sealed"); } }, base, false))?.issuer).toBe(issuer);
  await expect(loadManagedOidc(sql!, { ...vault, read: async () => { throw new Error("sealed"); } }, base, true)).rejects.toThrow("sealed");
  const [session] = await sql!`select i.provider_user_id,s.revoked_at,s.oidc_groups from console_browser_sessions s join auth_identities i on i.id=s.auth_identity_id where s.token_hash=${sessionHash}`;
  expect(session!.provider_user_id).toBe(`candidate-${user}`); expect(session!.revoked_at).toBeNull();
  expect((await sql!`select revoked_at from console_browser_sessions where token_hash=${secondHash}`)[0]!.revoked_at).not.toBeNull();
  await expect(service!.revokeCredential(actor, { operationId: randomUUID(), id: credential.id, expectedRevision: credential.revision })).rejects.toThrow("credential_in_active_sso");
  expect(JSON.stringify(await sso.state(actor, sessionHash))).not.toContain("synthetic-sso-lifecycle-secret");
  expect((await sql!`select count(*)::int n from audit_events where request_id=${activation.operationId}`)[0]!.n).toBe(1);
});

integration("real PG + HTTPS oidc-provider + browser: candidate login and activation (Vault synthetic, loopback-only test transport)", async () => {
  const fixture = await oidcProviderFixture({ email: `${user}@example.invalid` });
  try {
    const [session] = await sql!`select token_hash from console_browser_sessions where organization_id=${org} and user_id=${user} and revoked_at is null limit 1`;
    const sessionHash: string = session!.token_hash;
    const base = { origin: fixture.origin, secret: "synthetic-real-idp-auth-secret-32-characters", organizationId: org, sessionTtlSeconds: 3600 };
    const credential = await service!.writeCredential(actor, { operationId: randomUUID(), id: randomUUID(), label: "Actual local IdP",
      kind: "oidc_client_secret", expectedRevision: 0, binding: { issuer: fixture.origin, clientId: "local-fleet" }, value: fixture.clientSecret });
    // Explicit test-only transport exception for the private fixture: TLS is
    // still verified with its own CA; production policy denies loopback (tested separately).
    const sso = new FleetSsoService(sql!, vault, base, {
      begin: (returnTo, config, path) => beginOidcLogin(returnTo, { ...config!, networkPolicy: undefined }, path),
      complete: (url, transaction, config, path) => completeOidcLogin(url, transaction, { ...config, networkPolicy: undefined }, path),
    });
    const draft = await sso.save(actor, sessionHash, { operationId: randomUUID(), id: randomUUID(), expectedRevision: 0, label: "Local IdP",
      issuer: fixture.origin, clientId: "local-fleet", credentialId: credential.id, allowPrivateNetwork: false, admissionGroups: ["fleet-admins"] });
    const started = await sso.beginTest(actor, sessionHash, { operationId: randomUUID(), id: draft.id, expectedRevision: draft.revision });
    const callback = await fixture.login(started.url);
    expect(callback.origin).toBe(fixture.origin); expect(callback.pathname).toBe(SSO_TEST_CALLBACK); expect(fixture.logins).toBe(1);
    const tested = await sso.completeTest(actor, sessionHash, callback, started.cookie);
    expect(tested.status).toBe("tested");
    const active = await sso.activate(actor, sessionHash, { operationId: randomUUID(), id: tested.id, expectedRevision: tested.revision, acknowledgeIdentityChange: true });
    expect(active.status).toBe("active");
    // New service instance reads durable state, not a closure/process setting.
    expect((await new FleetSsoService(sql!, vault, base).state(actor, sessionHash)).connections.find(x => x.status === "active")?.issuer).toBe(fixture.origin);
    expect((await loadManagedOidc(sql!, vault, base, true))?.clientId).toBe("local-fleet");
    const [identity] = await sql!`select i.provider_user_id from console_browser_sessions s join auth_identities i on i.id=s.auth_identity_id where s.token_hash=${sessionHash}`;
    expect(identity!.provider_user_id).toBe("local-owner");
    console.log(JSON.stringify({ kind: "real-local-oidc-provider", root: fixture.root, checks: 8, remote: false, vault: "synthetic", networkPolicy: "loopback test driver only" }));
  } finally { await fixture.close(); }
}, 60000);
