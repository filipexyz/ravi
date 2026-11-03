import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fixturePolicy, installFixturePolicy } from "../fleet/authorization-fixture";
import type { OidcConfig } from "../../src/lib/auth/oidc-config";
import type { OidcVerifiedIdentity } from "../../src/lib/auth/oidc-client";

const socket = process.env.FLEET_TEST_PG_SOCKET;
if (!socket?.includes("fleet-pg-test-review-race-")) throw new Error("Dedicated review cluster required");
const sql = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 8,
  prepare: false, onnotice() {}, connection: { statement_timeout: 20000 } });
let forbiddenFetchAttempts = 0;
Object.assign(globalThis, { fetch: async () => { forbiddenFetchAttempts++; throw new Error("No network/provider in admission regression"); } });
Object.assign(globalThis, { raviConsoleDbClient: sql });
beforeAll(async () => { await migrate(drizzle(sql), { migrationsFolder: "drizzle" }); }, 60000);
afterAll(async () => { await sql.end(); expect(forbiddenFetchAttempts).toBe(0); });

async function fixture() {
  // Product store/service with real SQL; a synthetic verified identity isolates
  // DB concurrency only. This is NOT a new OIDC/browser proof.
  const { createOidcBrowserSession, readOidcBrowserSession } = await import("../../src/lib/auth/oidc-store");
  const { OrganizationMembersService } = await import("../../src/server/console/fleet/members");
  const org = randomUUID(), steward = randomUUID(), target = randomUUID();
  const issuer = "https://race-fixture.invalid";
  await sql`insert into organizations(id,name,slug) values(${org},'Race review',${org})`;
  for (const user of [steward, target]) {
    await sql`insert into users(id,primary_email,display_name) values(${user},${`${user}@example.invalid`},'Review synthetic user')`;
    await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'viewer','active')`;
    await sql`insert into auth_identities(provider,provider_user_id,user_id,email) values(${`oidc:${issuer}`},${user},${user},${`${user}@example.invalid`})`;
  }
  await installFixturePolicy(sql, steward, fixturePolicy(org, steward));
  const config: OidcConfig = { issuer, origin: "https://console-fixture.invalid", clientId: "fixture", clientSecret: "synthetic-only",
    secret: "synthetic-only-not-a-deployed-secret-123456789", organizationId: org, sessionTtlSeconds: 3600 };
  const identity: OidcVerifiedIdentity = { issuer, subject: target, email: `${target}@example.invalid`, name: "Review target", emailVerified: true };
  const service = new OrganizationMembersService(sql, org);
  const actor = { organizationId: org, userId: steward, mode: "oidc", role: "viewer" };
  const change = async (status: "active" | "suspended") => {
    const targetMember = (await service.list(actor)).members.find(member => member.userId === target)!;
    return service.change(actor, { userId: target, status, expectedVersion: targetMember.version, operationId: randomUUID() });
  };
  return { org, steward, target, identity, config, service, actor, change, createOidcBrowserSession, readOidcBrowserSession };
}

async function waitBlockedBy(blocker: number) {
  for (let n = 0; n < 150; n++) {
    const [waiting] = await sql`select pid from pg_stat_activity where ${blocker}::int = any(pg_blocking_pids(pid)) limit 1`;
    if (waiting) return waiting.pid as number;
    await Bun.sleep(20);
  }
  throw new Error("Expected real database lock wait was not observed");
}

test("issuance wins: suspension waits then revokes, and reactivation cannot revive the same token", async () => {
  const { org, target, identity, config, service, actor, change, createOidcBrowserSession, readOidcBrowserSession } = await fixture();
  const member = (await service.list(actor)).members.find(member => member.userId === target)!;
  // Original repro d7b908a is preserved in Git. The safe assertion is unchanged;
  // this schedule now observes the legitimate blocking introduced by the fix.
  // Pause INSERT after the production membership check, before inserting any row.
  // The extra lock belongs only to this synthetic fixture and is never deployed.
  const lockKey = 77322419;
  await sql.unsafe(`create function review_pause_session_insert() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`);
  await sql.unsafe("create trigger review_pause_session_insert before insert on console_browser_sessions for each row execute function review_pause_session_insert()");
  const gate = await sql.reserve();
  const [holder] = await gate`select pg_backend_pid() as pid, pg_advisory_lock(${lockKey})`;
  let pending: Promise<Awaited<ReturnType<typeof createOidcBrowserSession>>> | undefined;
  let suspension: ReturnType<typeof service.change> | undefined;
  let unlocked = false;
  try {
    pending = createOidcBrowserSession(identity, config);
    const issuerPid = await waitBlockedBy(holder!.pid);
    suspension = service.change(actor, { userId: target, status: "suspended", expectedVersion: member.version, operationId: randomUUID() });
    void suspension.catch(() => undefined);
    expect(await waitBlockedBy(issuerPid)).toBeGreaterThan(0);
    await gate`select pg_advisory_unlock(${lockKey})`;
    unlocked = true;
    const session = await pending;
    expect((await suspension).member.status).toBe("suspended");
    expect(await readOidcBrowserSession(session.token, config)).toBeNull();
    const [row] = await sql`select revoked_at is null as unrevoked from console_browser_sessions where organization_id=${org} and user_id=${target}`;
    expect((await change("active")).member.status).toBe("active");
    const resurrected = await readOidcBrowserSession(session.token, config);
    expect(row!.unrevoked).toBe(false);
    console.log(JSON.stringify({ kind: "session-membership-race-observed", realInsertWait: true, suspensionCommittedBeforeInsert: false,
      insertedUnrevoked: row!.unrevoked, rejectedWhileSuspended: true, acceptedAfterReactivation: resurrected !== null, providerCalls: 0 }));
    // Deliberately retain the security expectation. A red result is the finding,
    // not a test to change into an expected vulnerability or a product fix.
    expect(resurrected).toBeNull();
    const fresh = await createOidcBrowserSession(identity, config);
    expect((await readOidcBrowserSession(fresh.token, config))?.userId).toBe(target);
    const [audits] = await sql`select count(*)::int as count from audit_events where organization_id=${org} and action='auth.session.created'`;
    expect(audits!.count).toBe(2);
  } finally {
    if (!unlocked) await gate`select pg_advisory_unlock(${lockKey})`;
    gate.release();
    await pending?.catch(() => undefined);
    await suspension?.catch(() => undefined);
    await sql.unsafe("drop trigger review_pause_session_insert on console_browser_sessions; drop function review_pause_session_insert()");
  }
}, 30000);

test("suspension wins: queued issuance rechecks admission, creates no token/audit; fresh login works after reactivation", async () => {
  const { org, target, identity, config, change, createOidcBrowserSession, readOidcBrowserSession } = await fixture();
  const lockKey = 77322420;
  await sql.unsafe(`create function review_pause_membership() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`);
  await sql.unsafe("create trigger review_pause_membership before update on organization_memberships for each row when (new.status = 'suspended') execute function review_pause_membership()");
  const gate = await sql.reserve();
  const [holder] = await gate`select pg_backend_pid() as pid, pg_advisory_lock(${lockKey})`;
  let suspension: ReturnType<typeof change> | undefined;
  let issuance: Promise<{ denied: boolean }> | undefined;
  let unlocked = false;
  try {
    suspension = change("suspended");
    void suspension.catch(() => undefined);
    const lifecyclePid = await waitBlockedBy(holder!.pid);
    issuance = createOidcBrowserSession(identity, config).then(() => ({ denied: false }), error => {
      if (error.constructor.name !== "OidcAccessDeniedError") throw error;
      return { denied: true };
    });
    void issuance.catch(() => undefined);
    expect(await waitBlockedBy(lifecyclePid)).toBeGreaterThan(0);
    await gate`select pg_advisory_unlock(${lockKey})`;
    unlocked = true;
    expect((await suspension).member.status).toBe("suspended");
    expect((await issuance).denied).toBe(true);
    const [count] = await sql`select
      (select count(*)::int from console_browser_sessions where organization_id=${org}) as sessions,
      (select count(*)::int from audit_events where organization_id=${org} and action='auth.session.created') as audits`;
    expect(count).toMatchObject({ sessions: 0, audits: 0 });
    expect((await change("active")).member.status).toBe("active");
    const fresh = await createOidcBrowserSession(identity, config);
    expect((await readOidcBrowserSession(fresh.token, config))?.userId).toBe(target);
    const { revokeOidcBrowserSession } = await import("../../src/lib/auth/oidc-store");
    await revokeOidcBrowserSession(fresh.token);
    await revokeOidcBrowserSession(fresh.token);
    expect(await readOidcBrowserSession(fresh.token, config)).toBeNull();
    await change("suspended"); await change("active");
    expect(await readOidcBrowserSession(fresh.token, config)).toBeNull();
  } finally {
    if (!unlocked) await gate`select pg_advisory_unlock(${lockKey})`;
    gate.release();
    await suspension?.catch(() => undefined); await issuance?.catch(() => undefined);
    await sql.unsafe("drop trigger review_pause_membership on organization_memberships; drop function review_pause_membership()");
  }
}, 30000);

test("issuance audit failure rolls back the session, and releases the lifecycle lock", async () => {
  const { org, identity, config, change, createOidcBrowserSession } = await fixture();
  await sql.unsafe(`create function review_fail_session_audit() returns trigger language plpgsql as $$
    begin if new.action = 'auth.session.created' then raise exception 'fixture audit rollback'; end if; return new; end $$`);
  await sql.unsafe("create trigger review_fail_session_audit before insert on audit_events for each row execute function review_fail_session_audit()");
  try {
    await expect(createOidcBrowserSession(identity, config)).rejects.toThrow();
    const [count] = await sql`select count(*)::int as count from console_browser_sessions where organization_id=${org}`;
    expect(count!.count).toBe(0);
    expect((await change("suspended")).member.status).toBe("suspended");
  } finally {
    await sql.unsafe("drop trigger review_fail_session_audit on audit_events; drop function review_fail_session_audit()");
  }
});

async function credentialFixture() {
  const f = await fixture();
  Object.assign(process.env, { RAVI_AUTH_MODE: "oidc", RAVI_SINGLE_TENANT_ORGANIZATION_ID: f.org,
    NEXT_PUBLIC_CONSOLE_URL: f.config.origin, RAVI_OIDC_ISSUER: f.config.issuer, RAVI_OIDC_CLIENT_ID: "fixture",
    RAVI_OIDC_CLIENT_SECRET: "synthetic-only", RAVI_AUTH_SECRET: f.config.secret,
    RAVI_CLI_ACCESS_TOKEN_SECRET: "synthetic-only-cli-session-race-1234567890", RAVI_PAGES_CONTROL_TOKEN: "synthetic-only-page-race-1234567890",
    RAVI_PAGES_AUTH_SESSION_SECRET: "synthetic-only-page-session-race-1234567890" });
  const browser = await f.createOidcBrowserSession(f.identity, f.config);
  const oidc = (await f.readOidcBrowserSession(browser.token, f.config))!;
  const auth = { mode: "oidc" as const, oidc, viewer: { email: oidc.email, name: oidc.name, mark: "R" } };
  const project = randomUUID(), siteId = randomUUID(), installation = randomUUID(), cliId = randomUUID();
  await sql`insert into projects(id,organization_id,name,slug) values(${project},${f.org},'Race project',${project})`;
  const host = `${siteId}.ravi.page`;
  await sql`insert into page_sites(id,organization_id,project_id,slug,default_hostname) values(${siteId},${f.org},${project},${siteId},${host})`;
  await sql`insert into local_installations(id,organization_id,name) values(${installation},${f.org},'Inert race fixture')`;
  await sql`insert into cli_sessions(id,local_installation_id,organization_id,user_id,refresh_token_hash,access_token_jti,expires_at)
    values(${cliId},${installation},${f.org},${f.target},${randomUUID()},${randomUUID()},now()+interval '1 hour')`;
  const caller = { cliSessionId: cliId, userId: f.target, membershipStatus: "active", sessionOrganizationId: f.org, sessionInstallationId: installation };
  const approver = { userId: f.target, actorType: "user" as const, email: oidc.email, emailVerified: true, impersonated: false,
    requireBrowserSession: true, browserSessionId: oidc.sessionId };
  const workspace = { mode: "oidc" as const, user: { id: f.target }, organization: { id: f.org }, membership: { role: "viewer" }, browserSessionId: oidc.sessionId };
  const site = { id: siteId, organizationId: f.org, projectId: project, defaultHostname: host, defaultVisibility: "private" as const, status: "active" as const };
  return { ...f, auth, oidc, project, site, host, installation, cliId, caller, approver, workspace };
}

type CredentialFixture = Awaited<ReturnType<typeof credentialFixture>>;
const surfaces = ["page-claim", "page-session", "page-capture", "device-approval", "cli-exchange", "link-request", "link-binding"] as const;
type Surface = typeof surfaces[number];

function expectedAdmissionDenial(error: unknown): null {
  if (error instanceof Error) {
    const e = error as Error & { status?: number; code?: string };
    if ([401, 403].includes(e.status ?? 0) || e.code === "LINK_REQUEST_USED" || e.code === "LINK_REQUEST_EXPIRED" ||
      e.code === "LINK_REQUEST_CANCELLED" || e.code === "organization_selection_required") return null;
  }
  throw error; // A configuration error, timeout or deadlock is NEVER success.
}

async function prepareSurface(f: CredentialFixture, surface: Surface) {
  const pages = await import("../../src/server/console/pages/auth");
  const device = await import("../../src/server/cli/device-auth");
  const cli = await import("../../src/server/cli/auth");
  const link = await import("../../src/server/console/ravi-link-requests");
  const requestId = randomUUID();
  const issueClaim = () => pages.createPagesClaimCode({ workspace: f.workspace, returnTo: `https://${f.host}/`, requestId,
    // Synthetic project authorization is deliberately separate from the real
    // membership/source-credential/lifecycle boundary under test here.
    canReadProject: async () => true });
  if (surface === "page-claim") return { table: "pages_claim_codes", operation: "insert", issue: issueClaim };
  if (surface === "page-session") {
    const claim = await issueClaim(), code = new URL(claim.claimUrl).searchParams.get("code")!;
    return { table: "pages_sessions", operation: "insert", issue: () => pages.consumePagesClaimCode({ code, host: f.host, requestId }) };
  }
  if (surface === "page-capture") return { table: "pages_sessions", operation: "insert", issue: () => pages.createPagesCaptureSession({
    userId: f.target, site: f.site, requestId, requireBrowserSession: true, browserSessionId: f.oidc.sessionId }) };
  if (surface === "device-approval" || surface === "cli-exchange") {
    const code = await device.createCliDeviceAuthorization({ requestUrl: f.config.origin });
    const approve = () => device.approveCliDeviceAuthorization({ auth: f.auth, userCode: code.userCode, requestId });
    if (surface === "device-approval") return { table: "cli_device_authorizations", operation: "update", issue: approve };
    await approve();
    return { table: "cli_sessions", operation: "insert", issue: () => cli.exchangeCliAuth({ requestId,
      body: { deviceCode: code.deviceCode, installation: { name: "New inert device", machineFingerprint: randomUUID() } } }) };
  }
  const create = () => link.createRaviLinkRequest({ caller: f.caller, requestId, origin: f.config.origin,
    body: { contactId: `contact-${f.target}`, expectedEmail: f.oidc.email } });
  if (surface === "link-request") return { table: "ravi_link_requests", operation: "insert", issue: create };
  const created = await create();
  if (created.payload.status !== "pending") throw new Error("Expected new request");
  const token = new URL(created.payload.approveUrl).pathname.split("/").at(-1)!;
  return { table: "ravi_actor_bindings", operation: "insert", issue: () => link.approveRaviLinkRequest({ approver: f.approver, requestId, token }) };
}

for (const surface of surfaces) {
  test(`${surface}: issuance serializes with suspension, cannot be revived/replayed after reactivation`, async () => {
    const f = await credentialFixture(), prepared = await prepareSurface(f, surface);
    const member = (await f.service.list(f.actor)).members.find(member => member.userId === f.target)!;
    const lockKey = 77322421;
    await sql.unsafe(`create function review_pause_credential() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`);
    await sql.unsafe(`create trigger review_pause_credential before ${prepared.operation} on ${prepared.table} for each row execute function review_pause_credential()`);
    const gate = await sql.reserve();
    const [holder] = await gate`select pg_backend_pid() as pid,pg_advisory_lock(${lockKey})`;
    let issuance: Promise<unknown> | undefined, suspension: ReturnType<typeof f.service.change> | undefined;
    let unlocked = false;
    try {
      issuance = prepared.issue(); void issuance.catch(() => undefined);
      const issuer = await waitBlockedBy(holder!.pid);
      suspension = f.service.change(f.actor, { userId: f.target, expectedVersion: member.version, status: "suspended", operationId: randomUUID() });
      void suspension.catch(() => undefined);
      expect(await waitBlockedBy(issuer)).toBeGreaterThan(0);
      await gate`select pg_advisory_unlock(${lockKey})`; unlocked = true;
      expect(await issuance).not.toBeNull();
      expect((await suspension).member.status).toBe("suspended");
      expect((await f.change("active")).member.status).toBe("active");
      const userColumn = surface === "link-binding" ? "console_user_id" : surface === "link-request" ? "requested_by_user_id" : "user_id";
      const rows = await sql.unsafe(`select status from ${prepared.table} where organization_id=$1 and ${userColumn}=$2`, [f.org, f.target]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => !["active", "approved", "pending"].includes(row.status))).toBe(true);
      const replay = await prepared.issue().then(result => ({ result }), error => ({ result: expectedAdmissionDenial(error) }));
      expect(replay.result).toBeNull();
    } finally {
      if (!unlocked) await gate`select pg_advisory_unlock(${lockKey})`;
      gate.release();
      await issuance?.catch(() => undefined); await suspension?.catch(() => undefined);
      await sql.unsafe(`drop trigger review_pause_credential on ${prepared.table}; drop function review_pause_credential()`);
    }
  }, 30000);

  test(`${surface}: suspension wins admission and stale source cannot mint after reactivation`, async () => {
    const f = await credentialFixture(), prepared = await prepareSurface(f, surface);
    const lockKey = 77322422;
    await sql.unsafe(`create function review_pause_lifecycle() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`);
    await sql.unsafe("create trigger review_pause_lifecycle before update on organization_memberships for each row when(new.status='suspended') execute function review_pause_lifecycle()");
    const gate = await sql.reserve();
    const [holder] = await gate`select pg_backend_pid() as pid,pg_advisory_lock(${lockKey})`;
    let suspension: ReturnType<typeof f.change> | undefined, issuance: Promise<unknown> | undefined;
    let unlocked = false;
    try {
      suspension = f.change("suspended"); void suspension.catch(() => undefined);
      const lifecycle = await waitBlockedBy(holder!.pid);
      issuance = prepared.issue().catch(expectedAdmissionDenial);
      void issuance.catch(() => undefined);
      expect(await waitBlockedBy(lifecycle)).toBeGreaterThan(0);
      await gate`select pg_advisory_unlock(${lockKey})`; unlocked = true;
      expect((await suspension).member.status).toBe("suspended");
      expect(await issuance).toBeNull();
      expect((await f.change("active")).member.status).toBe("active");
      expect(await prepared.issue().catch(expectedAdmissionDenial)).toBeNull();
    } finally {
      if (!unlocked) await gate`select pg_advisory_unlock(${lockKey})`;
      gate.release(); await suspension?.catch(() => undefined); await issuance?.catch(() => undefined);
      await sql.unsafe("drop trigger review_pause_lifecycle on organization_memberships; drop function review_pause_lifecycle()");
    }
  }, 30000);

  test(`${surface}: audit failure rolls back issuance/source consumption`, async () => {
    const f = await credentialFixture(), prepared = await prepareSurface(f, surface);
    async function snapshot() {
      const tables = ["pages_claim_codes", "pages_sessions", "cli_device_authorizations", "cli_sessions", "local_installations", "ravi_link_requests", "ravi_actor_bindings", "audit_events"];
      return Promise.all(tables.map(async table => JSON.stringify(await sql.unsafe(`select * from ${table} where organization_id=$1 order by id`, [f.org]))));
    }
    const before = await snapshot();
    await sql.unsafe(`create function review_fail_issuance_audit() returns trigger language plpgsql as $$
      begin raise exception 'fixture issuance audit rollback'; end $$`);
    await sql.unsafe("create trigger review_fail_issuance_audit before insert on audit_events for each row execute function review_fail_issuance_audit()");
    try {
      let raised = false;
      try { await prepared.issue(); } catch (error) {
        let cause: unknown = error;
        while (cause && typeof cause === "object") {
          if ((cause as { message?: string }).message?.includes("fixture issuance audit rollback")) { raised = true; break; }
          cause = (cause as { cause?: unknown }).cause;
        }
        if (!raised) throw error;
      }
      expect(raised).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      await sql.unsafe("drop trigger review_fail_issuance_audit on audit_events; drop function review_fail_issuance_audit()");
    }
  });
}

test("CLI refresh winner is revoked by suspension; rotated and original tokens remain invalid after reactivation", async () => {
  const f = await credentialFixture();
  const device = await import("../../src/server/cli/device-auth"), cli = await import("../../src/server/cli/auth");
  const code = await device.createCliDeviceAuthorization({ requestUrl: f.config.origin });
  await device.approveCliDeviceAuthorization({ auth: f.auth, userCode: code.userCode, requestId: randomUUID() });
  const issued = await cli.exchangeCliAuth({ body: { deviceCode: code.deviceCode }, requestId: randomUUID() });
  const lockKey = 77322423;
  await sql.unsafe(`create function review_pause_refresh() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${lockKey}); return new; end $$`);
  await sql.unsafe("create trigger review_pause_refresh before update on cli_sessions for each row when(new.status='active') execute function review_pause_refresh()");
  const gate = await sql.reserve();
  const [holder] = await gate`select pg_backend_pid() as pid,pg_advisory_lock(${lockKey})`;
  let renewal: ReturnType<typeof cli.refreshCliAuth> | undefined, suspension: ReturnType<typeof f.change> | undefined, unlocked = false;
  try {
    renewal = cli.refreshCliAuth({ body: { refreshToken: issued.refreshToken }, requestId: randomUUID() });
    void renewal.catch(() => undefined);
    const refresher = await waitBlockedBy(holder!.pid);
    suspension = f.change("suspended"); void suspension.catch(() => undefined);
    expect(await waitBlockedBy(refresher)).toBeGreaterThan(0);
    await gate`select pg_advisory_unlock(${lockKey})`; unlocked = true;
    const renewed = await renewal;
    expect((await suspension).member.status).toBe("suspended");
    await f.change("active");
    for (const credential of [issued, renewed]) {
      expect(await cli.refreshCliAuth({ body: { refreshToken: credential.refreshToken }, requestId: randomUUID() }).catch(expectedAdmissionDenial)).toBeNull();
      expect(await cli.getCliMe({ request: new Request(`${f.config.origin}/api/cli/me`, { headers: { authorization: `Bearer ${credential.accessToken}` } }),
        requestId: randomUUID() }).catch(expectedAdmissionDenial)).toBeNull();
    }
    expect((await sql`select status from cli_sessions where id=${issued.cliSession.id}`)[0]!.status).toBe("revoked");
  } finally {
    if (!unlocked) await gate`select pg_advisory_unlock(${lockKey})`;
    gate.release(); await renewal?.catch(() => undefined); await suspension?.catch(() => undefined);
    await sql.unsafe("drop trigger review_pause_refresh on cli_sessions; drop function review_pause_refresh()");
  }
}, 30000);

test("fresh login and explicit fresh approvals can issue Pages, CLI and link after reactivation, without reviving old browser", async () => {
  const f = await credentialFixture();
  await f.change("suspended"); await f.change("active");
  const pages = await import("../../src/server/console/pages/auth"), device = await import("../../src/server/cli/device-auth");
  const cli = await import("../../src/server/cli/auth"), link = await import("../../src/server/console/ravi-link-requests");
  const fresh = await f.createOidcBrowserSession(f.identity, f.config);
  const oidc = (await f.readOidcBrowserSession(fresh.token, f.config))!;
  expect(oidc.sessionId).not.toBe(f.oidc.sessionId);
  const auth = { ...f.auth, oidc }, workspace = { ...f.workspace, browserSessionId: oidc.sessionId };
  const code = await device.createCliDeviceAuthorization({ requestUrl: f.config.origin });
  await device.approveCliDeviceAuthorization({ auth, userCode: code.userCode, requestId: randomUUID() });
  const credential = await cli.exchangeCliAuth({ body: { deviceCode: code.deviceCode }, requestId: randomUUID() });
  expect(credential.user.id).toBe(f.target);
  const me = await cli.getCliMe({ request: new Request(`${f.config.origin}/api/cli/me`, { headers: { authorization: `Bearer ${credential.accessToken}` } }), requestId: randomUUID() });
  expect(me.user.id).toBe(f.target);
  const claim = await pages.createPagesClaimCode({ workspace, returnTo: `https://${f.host}/`, requestId: randomUUID(), canReadProject: async () => true });
  const session = await pages.consumePagesClaimCode({ code: new URL(claim.claimUrl).searchParams.get("code")!, host: f.host, requestId: randomUUID() });
  expect(session).not.toBeNull();
  const request = await link.createRaviLinkRequest({ caller: { ...f.caller, cliSessionId: credential.cliSession.id, sessionInstallationId: credential.localInstallation.id },
    body: { contactId: "new-human-approval", expectedEmail: oidc.email }, origin: f.config.origin, requestId: randomUUID() });
  if (request.payload.status !== "pending") throw new Error("Expected explicit link request");
  const approved = await link.approveRaviLinkRequest({ token: new URL(request.payload.approveUrl).pathname.split("/").at(-1)!,
    approver: { ...f.approver, browserSessionId: oidc.sessionId }, requestId: randomUUID() });
  expect(approved.binding.consoleUserId).toBe(f.target);
  expect(approved.binding.status).toBe("active");
  expect((await sql`select revoked_at is not null as revoked from console_browser_sessions where id=${f.oidc.sessionId}`)[0]!.revoked).toBe(true);
});
