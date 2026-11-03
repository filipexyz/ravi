import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { BootstrapService, issueBootstrap } from "../../src/server/console/fleet/bootstrap";
import { beginOidcLogin, completeOidcLogin } from "../../src/lib/auth/oidc-client";
import { hashBrowserSessionToken } from "../../src/lib/auth/oidc-transaction";
import { OnboardingService } from "../../src/server/console/fleet/onboarding";
import { oidcProviderFixture } from "./oidc-provider-fixture";
import { compilePolicy } from "../../src/server/console/authorization/engine";
import { policySchema, ORGANIZATION_ACTIONS } from "../../src/server/console/authorization/policy";
import { initializeAuthorizationInBootstrapTransaction } from "../../src/server/console/authorization/bootstrap";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice: () => {} }) : null;
let sql: ReturnType<typeof postgres> | undefined;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_bootstrap_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_bootstrap_fixture", username: "fleettest", max: 4, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });

integration("first owner requires one-time code + real verified IdP login; no public takeover/replay", async () => {
  const fixture = await oidcProviderFixture();
  try {
    const org = randomUUID();
    const config = { origin: fixture.origin, issuer: fixture.origin, clientId: "local-fleet", clientSecret: fixture.clientSecret,
      organizationId: org, secret: "synthetic-bootstrap-auth-secret-over-32-characters", sessionTtlSeconds: 3600 };
    const service = new BootstrapService(sql!, config, { begin: beginOidcLogin, complete: completeOidcLogin });
    const input = { organizationId: org, name: "Bootstrap fixture", slug: "bootstrap-fixture", email: "owner@example.invalid" };
    const first = await issueBootstrap(sql!, input);
    expect(first.length).toBe(43);
    expect(JSON.stringify(await sql!`select * from fleet_bootstrap_grants`)).not.toContain(first);
    await expect(service.begin({ token: randomBytes(32).toString("base64url"), operationId: randomUUID() })).rejects.toThrow("setup_unavailable");
    await sql!`update fleet_bootstrap_grants set expires_at=now()-interval '1 second'`;
    await expect(service.begin({ token: first, operationId: randomUUID() })).rejects.toThrow("setup_unavailable");
    const token = await issueBootstrap(sql!, input);
    await expect(service.begin({ token: first, operationId: randomUUID() })).rejects.toThrow("setup_unavailable");
    let start = { token, operationId: randomUUID() };
    let attempt = await service.begin(start); expect(await service.begin(start)).toEqual(attempt);
    let callback = await fixture.login(attempt.url);
    expect(callback.pathname).toBe("/callback/setup"); expect(fixture.logins).toBe(1);
    await expect(service.complete(callback, `${attempt.cookie}tampered`)).rejects.toThrow("setup_unavailable");
    // Real IdP completion, then a DB failure AFTER the initializer: no partial
    // identity, session, consumed code, policy or receipt can escape the transaction.
    await sql!`create function fixture_fail_claim() returns trigger language plpgsql as $$
      begin if NEW.action='fleet.setup.claimed' then raise exception 'fixture_claim_failure'; end if; return NEW; end $$`;
    await sql!`create trigger fixture_claim_failure before insert on audit_events for each row execute function fixture_fail_claim()`;
    try {
      await expect(service.complete(callback, attempt.cookie)).rejects.toThrow("fixture_claim_failure");
      for (const table of ["users", "auth_identities", "organization_memberships", "console_browser_sessions", "authorization_policy_heads", "authorization_policy_revisions", "authorization_bootstrap_receipts", "authorization_audit"]) {
        expect((await sql!`select count(*)::int n from ${sql!(table)}`)[0]!.n).toBe(0);
      }
      const [rolledBack] = await sql!`select consumed_at,claimed_by,attempt_id from fleet_bootstrap_grants where organization_id=${org}`;
      expect(rolledBack).toMatchObject({ consumed_at: null, claimed_by: null, attempt_id: start.operationId });
    } finally {
      await sql!`drop trigger fixture_claim_failure on audit_events`;
      await sql!`drop function fixture_fail_claim()`;
    }
    // The external authorization code was consumed; obtain a new real code.
    start = { token, operationId: randomUUID() }; attempt = await service.begin(start);
    callback = await fixture.login(attempt.url); expect(fixture.logins).toBe(2);
    // Both requests have a real code/cookie; the org transaction admits only one owner.
    const results = await Promise.allSettled([service.complete(callback, attempt.cookie), service.complete(callback, attempt.cookie)]);
    if (!results.some(x => x.status === "fulfilled")) console.log(JSON.stringify({ fixtureFailure: results.map(x => x.status === "rejected" ? {
      name: x.reason?.name, code: x.reason?.code, constraint: x.reason?.constraint_name, column: x.reason?.column_name,
    } : null) }));
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(x => x.status === "rejected")).toHaveLength(1);
    const successful = results.find(x => x.status === "fulfilled") as PromiseFulfilledResult<{ token: string; expiresAt: Date }>;
    const [session] = await sql!`select s.*,m.role,i.provider_user_id from console_browser_sessions s join organization_memberships m on m.user_id=s.user_id and m.organization_id=s.organization_id
      join auth_identities i on i.id=s.auth_identity_id where s.token_hash=${hashBrowserSessionToken(successful.value.token)!}`;
    expect(session!.role).toBe("owner"); expect(session!.provider_user_id).toBe("local-owner");
    expect((await sql!`select count(*)::int n from organization_memberships`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from audit_events where action='fleet.setup.claimed'`)[0]!.n).toBe(1);
    const [revision] = await sql!`select r.document from authorization_policy_revisions r join authorization_policy_heads h on h.active_revision_id=r.id where h.organization_id=${org}`;
    const policy = policySchema.parse(revision!.document);
    const engine = await compilePolicy(policy);
    const facts = { organizationId: org, userId: session!.user_id as string, active: true, organizationRole: "viewer" };
    // Explicit contract, not the expanding action catalog. No project creation
    // or member-management power is silently added by a later action definition.
    const initialGrants: (typeof ORGANIZATION_ACTIONS)[number][] = [
      "organization.settings.read", "organization.settings.manage",
      "organization.onboarding.read", "organization.onboarding.manage",
      "organization.sso.read", "organization.sso.manage",
      "organization.credentials.read", "organization.credentials.manage",
      "organization.installations.read", "organization.installations.manage",
      "organization.authorization.read", "organization.authorization.manage",
    ];
    expect(policy.organizationRules.flatMap(rule => rule.actions).sort()).toEqual([...initialGrants].sort());
    for (const action of ORGANIZATION_ACTIONS) expect((await engine.decideOrganization(facts, action)).allowed).toBe(initialGrants.includes(action));
    expect(policy.rules).toHaveLength(0);
    expect((await sql!`select count(*)::int n from authorization_bootstrap_receipts`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from authorization_audit where action='policy.bootstrap'`)[0]!.n).toBe(1);
    await expect(issueBootstrap(sql!, input)).rejects.toThrow("setup_unavailable");
    await expect(service.begin(start)).rejects.toThrow("setup_unavailable");
    const persisted = JSON.stringify(await sql!`select * from fleet_bootstrap_grants`);
    expect(persisted).not.toContain(token); expect(persisted).not.toContain(attempt.cookie);
    const guide = new OnboardingService(sql!, org), actor = { organizationId: org, userId: session!.user_id as string, mode: "oidc", role: "owner" };
    const before = await guide.state(actor); expect(before.completed).toBe(false); expect(before.activeTransports).toBe(0);
    // The DTO label is not authority; explicit policy remains bound to the user.
    expect((await guide.state({ ...actor, role: "viewer" })).snapshot).toBe(before.snapshot);
    await sql!`update organizations set name='Changed by operator' where id=${org}`;
    await expect(guide.finish(actor, { operationId: randomUUID(), snapshot: before.snapshot, reviewed: true })).rejects.toThrow("version_conflict");
    const state = await guide.state(actor), finish = { operationId: randomUUID(), snapshot: state.snapshot, reviewed: true };
    expect((await guide.finish(actor, finish)).completed).toBe(true); expect((await guide.finish(actor, finish)).completed).toBe(true);
    expect((await new OnboardingService(sql!, org).state(actor)).completed).toBe(true);
    expect((await sql!`select count(*)::int n from audit_events where action='fleet.onboarding.reviewed'`)[0]!.n).toBe(1);
    const [head] = await sql!`select active_revision_id from authorization_policy_heads where organization_id=${org}`;
    await sql!`update authorization_policy_heads set active_revision_id=null,generation=generation+1 where organization_id=${org}`;
    const replay = await sql!.begin(tx => initializeAuthorizationInBootstrapTransaction(tx, {
      organizationId: org, userId: session!.user_id, identityId: session!.auth_identity_id, attemptId: start.operationId,
    }));
    expect(replay).toEqual({ revisionId: head!.active_revision_id, replay: true });
    expect((await sql!`select active_revision_id,generation from authorization_policy_heads where organization_id=${org}`)[0]).toMatchObject({ active_revision_id: null, generation: 2 });
    await expect(guide.state(actor)).rejects.toThrow("forbidden");
    await expect(service.complete(callback, attempt.cookie)).rejects.toThrow("setup_unavailable");
    expect((await sql!`select count(*)::int n from authorization_bootstrap_receipts`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from authorization_audit where action='policy.bootstrap'`)[0]!.n).toBe(1);
    console.log(JSON.stringify({ kind: "real-bootstrap-oidc-and-onboarding", root: fixture.root, remote: false }));
  } finally { await fixture.close(); }
},60000);
