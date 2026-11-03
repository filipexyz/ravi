import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// Independent review only: same private runner, real production stores, no
// provider/browser/runtime. Expiry is real wall time, not a mocked clock.
const socket = process.env.FLEET_TEST_PG_SOCKET;
if (!socket?.includes("fleet-pg-test-review-race-")) throw new Error("Dedicated review cluster required");
const sql = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 6,
  prepare: false, onnotice() {}, connection: { statement_timeout: 15000 } });
let fetchAttempts = 0;
Object.assign(globalThis, { fetch: async () => { fetchAttempts++; throw new Error("No provider/network in expiry review"); }, raviConsoleDbClient: sql });
beforeAll(async () => { await migrate(drizzle(sql), { migrationsFolder: "drizzle" }); }, 60000);
afterAll(async () => { await sql.end(); expect(fetchAttempts).toBe(0); });

async function fixture() {
  const { createOidcBrowserSession, readOidcBrowserSession } = await import("../../src/lib/auth/oidc-store");
  const device = await import("../../src/server/cli/device-auth");
  const cli = await import("../../src/server/cli/auth");
  const link = await import("../../src/server/console/ravi-link-requests");
  const pages = await import("../../src/server/console/pages/auth");
  const org = randomUUID(), user = randomUUID(), issuer = "https://expiry-fixture.invalid";
  const config = { issuer, origin: "https://console-fixture.invalid", clientId: "fixture", clientSecret: "synthetic-only",
    secret: "synthetic-only-expiry-fixture-1234567890", organizationId: org, sessionTtlSeconds: 3600 };
  Object.assign(process.env, { RAVI_AUTH_MODE: "oidc", RAVI_SINGLE_TENANT_ORGANIZATION_ID: org,
    NEXT_PUBLIC_CONSOLE_URL: config.origin, RAVI_OIDC_ISSUER: issuer, RAVI_OIDC_CLIENT_ID: config.clientId,
    RAVI_OIDC_CLIENT_SECRET: config.clientSecret, RAVI_AUTH_SECRET: config.secret,
    RAVI_CLI_ACCESS_TOKEN_SECRET: "synthetic-only-expiry-cli-1234567890",
    RAVI_PAGES_AUTH_SESSION_SECRET: "synthetic-only-expiry-page-1234567890" });
  await sql`insert into organizations(id,name,slug) values(${org},'Expiry review',${org})`;
  await sql`insert into users(id,primary_email,display_name) values(${user},${`${user}@example.invalid`},'Synthetic reviewer')`;
  await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'viewer','active')`;
  await sql`insert into auth_identities(provider,provider_user_id,user_id,email) values(${`oidc:${issuer}`},${user},${user},${`${user}@example.invalid`})`;
  const session = await createOidcBrowserSession({ issuer, subject: user, email: `${user}@example.invalid`, name: "Synthetic reviewer", emailVerified: true }, config);
  const oidc = (await readOidcBrowserSession(session.token, config))!;
  const auth = { mode: "oidc" as const, oidc, viewer: { email: oidc.email, name: oidc.name, mark: "R" } };
  return { org, user, config, oidc, auth, device, cli, link, pages };
}

// A separate SQL connection holds the exact production Fleet lock. Confirm a
// real waiter, then hold it until the stored deadline has passed. Unexpected
// product errors and DB timeouts propagate; neither is an accepted denial.
type WaitBoundary = { row: { table: "cli_device_authorizations" | "ravi_link_requests" | "pages_claim_codes" | "cli_sessions"; id: string } }
  | { audit: string };
async function acrossExpiry<T>(org: string, deadline: Date, operation: () => Promise<T>, boundary?: WaitBoundary) {
  const gate = await sql.reserve(), key = boundary && "audit" in boundary ? `expiry-review:${org}` : `fleet:${org}`;
  let triggerCreated = false;
  if (boundary && "audit" in boundary) {
    // UUID and fixed generated lock key only; no secret is interpolated/logged.
    await sql.unsafe(`create function expiry_review_audit_wait() returns trigger language plpgsql as $$
      begin if new.request_id = '${boundary.audit}' then perform pg_advisory_xact_lock(hashtextextended('${key}',0)); end if; return new; end $$`);
    await sql.unsafe("create trigger expiry_review_audit_wait before insert on audit_events for each row execute function expiry_review_audit_wait()");
    triggerCreated = true;
  }
  await gate`begin`;
  const [holder] = await gate`select pg_backend_pid() as pid`;
  if (boundary && "row" in boundary) await gate.unsafe(`select id from ${boundary.row.table} where id=$1 for update`, [boundary.row.id]);
  else await gate`select pg_advisory_xact_lock(hashtextextended(${key},0))`;
  let pending: Promise<{ value: T | null; errorCode: string | null }> | undefined;
  let unlocked = false;
  try {
    expect(Date.now() < deadline.getTime()).toBe(true);
    pending = operation().then(value => ({ value, errorCode: null }), error => {
      if (!["AUTH_EXPIRED", "LINK_REQUEST_EXPIRED", "ORG_ACCESS_DENIED", "NOT_MEMBER"].includes(error?.code) &&
        !(error?.status === 403 && error?.payload?.error === "pages_access_denied")) throw error;
      return { value: null, errorCode: error.code as string };
    });
    void pending.catch(() => undefined);
    let observedWait = false;
    for (let n = 0; n < 120; n++) {
      const [row] = await sql`select exists(select 1 from pg_stat_activity where ${holder!.pid}::int = any(pg_blocking_pids(pid))) as waiting`;
      if (row!.waiting) { observedWait = true; break; }
      await Bun.sleep(20);
    }
    expect(observedWait).toBe(true);
    for (let n = 0; n < 240; n++) {
      const [row] = await sql`select clock_timestamp() >= ${deadline.toISOString()}::timestamptz as expired`;
      if (row!.expired) break;
      await Bun.sleep(20);
    }
    const [clock] = await sql`select clock_timestamp() > ${deadline.toISOString()}::timestamptz as expired`;
    expect(clock!.expired).toBe(true);
    await gate`commit`; unlocked = true;
    return await pending;
  } finally {
    if (!unlocked) await gate`rollback`;
    gate.release();
    await pending?.catch(() => undefined);
    if (triggerCreated) await sql.unsafe("drop trigger expiry_review_audit_wait on audit_events; drop function expiry_review_audit_wait()");
  }
}

test("CLI exchange refuses a device code expiring during the Fleet lock wait", async () => {
  const f = await fixture(), requestId = randomUUID();
  const code = await f.device.createCliDeviceAuthorization({ requestUrl: f.config.origin });
  await f.device.approveCliDeviceAuthorization({ auth: f.auth, userCode: code.userCode, requestId: randomUUID() });
  const deadline = new Date(Date.now() + 2000);
  await sql`update cli_device_authorizations set expires_at=${deadline.toISOString()} where organization_id=${f.org}`;
  const outcome = await acrossExpiry(f.org, deadline, () => f.cli.exchangeCliAuth({ body: { deviceCode: code.deviceCode }, requestId }));
  const [counts] = await sql`select
    (select count(*)::int from cli_sessions where organization_id=${f.org}) as sessions,
    (select count(*)::int from audit_events where request_id=${requestId} and action='cli_session.created') as audits`;
  let acceptedCredential = false;
  if (outcome.value) {
    const me = await f.cli.getCliMe({ request: new Request(`${f.config.origin}/api/cli/me`, {
      headers: { authorization: `Bearer ${outcome.value.accessToken}` } }), requestId: randomUUID() });
    acceptedCredential = me.user.id === f.user;
  }
  console.log(JSON.stringify({ kind: "expiry-after-fleet-wait", surface: "cli-exchange", realWait: true,
    expiredBeforeUnlock: true, acceptedCredential, ...counts }));
  expect(outcome.value === null).toBe(true);
  expect(counts).toMatchObject({ sessions: 0, audits: 0 });
}, 15000);

test("link approval refuses a request expiring during the Fleet lock wait", async () => {
  const f = await fixture(), installation = randomUUID(), cliSession = randomUUID(), requestId = randomUUID();
  await sql`insert into local_installations(id,organization_id,name) values(${installation},${f.org},'Inert expiry fixture')`;
  await sql`insert into cli_sessions(id,local_installation_id,organization_id,user_id,refresh_token_hash,access_token_jti,expires_at)
    values(${cliSession},${installation},${f.org},${f.user},${randomUUID()},${randomUUID()},now()+interval '1 hour')`;
  const created = await f.link.createRaviLinkRequest({ caller: { cliSessionId: cliSession, userId: f.user,
    membershipStatus: "active", sessionOrganizationId: f.org, sessionInstallationId: installation },
    body: { contactId: "expiry-review-contact", expectedEmail: f.oidc.email }, origin: f.config.origin, requestId: randomUUID() });
  if (created.payload.status !== "pending") throw new Error("Expected fresh pending request");
  const token = new URL(created.payload.approveUrl).pathname.split("/").at(-1)!;
  const deadline = new Date(Date.now() + 2000);
  await sql`update ravi_link_requests set expires_at=${deadline.toISOString()} where organization_id=${f.org}`;
  const outcome = await acrossExpiry(f.org, deadline, () => f.link.approveRaviLinkRequest({ token, requestId,
    approver: { userId: f.user, actorType: "user", email: f.oidc.email, emailVerified: true, impersonated: false,
      requireBrowserSession: true, browserSessionId: f.oidc.sessionId } }));
  const [counts] = await sql`select
    (select count(*)::int from ravi_actor_bindings where organization_id=${f.org} and status='active') as bindings,
    (select count(*)::int from audit_events where request_id=${requestId} and action='ravi_link.request.approved') as audits`;
  console.log(JSON.stringify({ kind: "expiry-after-fleet-wait", surface: "link-approval", realWait: true,
    expiredBeforeUnlock: true, acceptedBinding: outcome.value?.binding.status === "active", ...counts }));
  expect(outcome.value === null).toBe(true);
  expect(counts).toMatchObject({ bindings: 0, audits: 0 });
}, 15000);

test("Page claim redemption rechecks expiry after the same Fleet lock wait", async () => {
  const f = await fixture(), project = randomUUID(), site = randomUUID(), host = `${site}.ravi.page`;
  await sql`insert into projects(id,organization_id,name,slug) values(${project},${f.org},'Expiry project',${project})`;
  await sql`insert into page_sites(id,organization_id,project_id,slug,default_hostname) values(${site},${f.org},${project},${site},${host})`;
  const claim = await f.pages.createPagesClaimCode({ workspace: { mode: "oidc", organization: { id: f.org }, user: { id: f.user },
    membership: { role: "viewer" }, browserSessionId: f.oidc.sessionId }, returnTo: `https://${host}/`,
    requestId: randomUUID(), canReadProject: async () => true });
  const code = new URL(claim.claimUrl).searchParams.get("code")!;
  const deadline = new Date(Date.now() + 2000);
  await sql`update pages_claim_codes set expires_at=${deadline.toISOString()} where organization_id=${f.org}`;
  const outcome = await acrossExpiry(f.org, deadline, () => f.pages.consumePagesClaimCode({ code, host, requestId: randomUUID() }));
  const [counts] = await sql`select count(*)::int as sessions from pages_sessions where organization_id=${f.org}`;
  console.log(JSON.stringify({ kind: "expiry-after-fleet-wait", surface: "page-redemption", realWait: true,
    expiredBeforeUnlock: true, acceptedSession: outcome.value !== null, ...counts }));
  expect(outcome.value === null).toBe(true);
  expect(counts!.sessions).toBe(0);
}, 15000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Surface = "device-approval" | "cli-exchange" | "link-approval" | "page-redemption" | "cli-refresh";

async function prepare(f: Fixture, surface: Surface, requestId: string) {
  if (surface === "device-approval" || surface === "cli-exchange" || surface === "cli-refresh") {
    const code = await f.device.createCliDeviceAuthorization({ requestUrl: f.config.origin });
    const { hashToken } = await import("../../src/server/cli/tokens");
    const [device] = await sql`select id from cli_device_authorizations where device_code_hash=${hashToken(`cli-device:${code.deviceCode}`)}`;
    if (surface === "device-approval") return { table: "cli_device_authorizations" as const, id: device!.id as string,
      run: () => f.device.approveCliDeviceAuthorization({ auth: f.auth, userCode: code.userCode, requestId }) };
    await f.device.approveCliDeviceAuthorization({ auth: f.auth, userCode: code.userCode, requestId: randomUUID() });
    if (surface === "cli-exchange") return { table: "cli_device_authorizations" as const, id: device!.id as string,
      run: () => f.cli.exchangeCliAuth({ body: { deviceCode: code.deviceCode }, requestId }) };
    const session = await f.cli.exchangeCliAuth({ body: { deviceCode: code.deviceCode }, requestId: randomUUID() });
    return { table: "cli_sessions" as const, id: session.cliSession.id,
      run: () => f.cli.refreshCliAuth({ body: { refreshToken: session.refreshToken }, requestId }) };
  }
  if (surface === "link-approval") {
    const installation = randomUUID(), cliSession = randomUUID();
    await sql`insert into local_installations(id,organization_id,name) values(${installation},${f.org},'Inert fixture')`;
    await sql`insert into cli_sessions(id,local_installation_id,organization_id,user_id,refresh_token_hash,access_token_jti,expires_at)
      values(${cliSession},${installation},${f.org},${f.user},${randomUUID()},${randomUUID()},clock_timestamp()+interval '1 hour')`;
    const created = await f.link.createRaviLinkRequest({ caller: { cliSessionId: cliSession, userId: f.user,
      membershipStatus: "active", sessionOrganizationId: f.org, sessionInstallationId: installation },
      body: { contactId: "expiry-contact", expectedEmail: f.oidc.email }, origin: f.config.origin, requestId: randomUUID() });
    if (created.payload.status !== "pending") throw new Error("Expected pending request");
    const token = new URL(created.payload.approveUrl).pathname.split("/").at(-1)!;
    return { table: "ravi_link_requests" as const, id: created.payload.request.id,
      run: () => f.link.approveRaviLinkRequest({ token, requestId,
        approver: { userId: f.user, actorType: "user", email: f.oidc.email, emailVerified: true, impersonated: false,
          requireBrowserSession: true, browserSessionId: f.oidc.sessionId } }) };
  }
  const project = randomUUID(), site = randomUUID(), host = `${site}.ravi.page`;
  await sql`insert into projects(id,organization_id,name,slug) values(${project},${f.org},'Expiry project',${project})`;
  await sql`insert into page_sites(id,organization_id,project_id,slug,default_hostname) values(${site},${f.org},${project},${site},${host})`;
  const claim = await f.pages.createPagesClaimCode({ workspace: { mode: "oidc", organization: { id: f.org }, user: { id: f.user },
    membership: { role: "viewer" }, browserSessionId: f.oidc.sessionId }, returnTo: `https://${host}/`, requestId: randomUUID(), canReadProject: async () => true });
  const [source] = await sql`select id from pages_claim_codes where organization_id=${f.org}`;
  return { table: "pages_claim_codes" as const, id: source!.id as string,
    run: () => f.pages.consumePagesClaimCode({ code: new URL(claim.claimUrl).searchParams.get("code")!, host, requestId }) };
}

async function effects(org: string, requestId: string) {
  const [row] = await sql`select
    (select count(*)::int from cli_sessions where organization_id=${org}) as cli,
    (select count(*)::int from local_installations where organization_id=${org}) as installations,
    (select count(*)::int from pages_sessions where organization_id=${org}) as pages,
    (select count(*)::int from ravi_actor_bindings where organization_id=${org} and status='active') as bindings,
    (select count(*)::int from audit_events where request_id=${requestId} and action in
      ('cli_session.created','cli_session.refreshed','cli_device_authorization.approved','pages.session.created',
       'pages.claim_code.consumed','ravi_link.request.approved','ravi_link.binding.created','ravi_link.binding.reactivated')) as successes`;
  return row!;
}

for (const surface of ["device-approval", "cli-exchange", "link-approval", "page-redemption", "cli-refresh"] as const) {
  for (const wait of ["row", "audit"] as const) {
    test(`${surface}: expiry during ${wait} wait rolls back source, effects and success audit`, async () => {
      const f = await fixture(), requestId = randomUUID(), p = await prepare(f, surface, requestId);
      const deadline = new Date(Date.now() + 2000);
      await sql.unsafe(`update ${p.table} set expires_at=$1 where id=$2`, [deadline.toISOString(), p.id]);
      const [beforeSource] = await sql.unsafe(`select row_to_json(t) as value from ${p.table} t where id=$1`, [p.id]);
      const before = await effects(f.org, requestId);
      const outcome = await acrossExpiry<unknown>(f.org, deadline, () => p.run(), wait === "row" ? { row: { table: p.table, id: p.id } } : { audit: requestId });
      expect(outcome.value === null).toBe(true);
      expect(await effects(f.org, requestId)).toEqual(before);
      const [afterSource] = await sql.unsafe(`select row_to_json(t) as value from ${p.table} t where id=$1`, [p.id]);
      // Link may persist only the expired marker when rejected before any writes.
      if (surface === "link-approval" && wait === "row") expect(afterSource!.value.status).toBe("expired");
      else expect(afterSource!.value).toEqual(beforeSource!.value);
    }, 15000);
  }
}

test("CLI refresh rechecks the source deadline after Fleet", async () => {
  const f = await fixture(), requestId = randomUUID(), p = await prepare(f, "cli-refresh", requestId);
  const deadline = new Date(Date.now() + 2000);
  await sql`update cli_sessions set expires_at=${deadline.toISOString()} where id=${p.id}`;
  const before = await effects(f.org, requestId);
  expect((await acrossExpiry<unknown>(f.org, deadline, () => p.run())).value === null).toBe(true);
  expect(await effects(f.org, requestId)).toEqual(before);
}, 15000);

for (const surface of ["device-approval", "link-approval"] as const) {
  test(`${surface}: source browser expiry during credential row wait denies`, async () => {
    const f = await fixture(), requestId = randomUUID(), p = await prepare(f, surface, requestId);
    const deadline = new Date(Date.now() + 2000);
    await sql`update console_browser_sessions set expires_at=${deadline.toISOString()} where id=${f.oidc.sessionId}`;
    const before = await effects(f.org, requestId);
    const outcome = await acrossExpiry<unknown>(f.org, deadline, () => p.run(), { row: { table: p.table, id: p.id } });
    expect(outcome.value === null).toBe(true);
    expect(await effects(f.org, requestId)).toEqual(before);
  }, 15000);
}

for (const surface of ["cli-exchange", "link-approval", "page-redemption", "cli-refresh"] as const) {
  test(`${surface}: valid concurrent attempts issue once, then replay cannot issue again`, async () => {
    const f = await fixture(), requestId = randomUUID(), p = await prepare(f, surface, requestId);
    const results = await Promise.allSettled([p.run(), p.run()]);
    expect(results.filter(r => r.status === "fulfilled" && r.value !== null)).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(["AUTH_EXPIRED", "AUTH_PENDING", "LINK_REQUEST_USED"]).toContain(r.reason.code);
    const before = await effects(f.org, requestId);
    const replay = await p.run().catch(error => {
      if (!["AUTH_EXPIRED", "AUTH_PENDING", "LINK_REQUEST_USED"].includes(error?.code)) throw error;
      return null;
    });
    expect(replay === null).toBe(true);
    expect(await effects(f.org, requestId)).toEqual(before);
  }, 15000);
}

for (const surface of ["page-claim", "page-capture"] as const) {
  test(`${surface}: browser expiry during audit wait rolls back issuance`, async () => {
    const f = await fixture(), requestId = randomUUID();
    const project = randomUUID(), siteId = randomUUID(), host = `${siteId}.ravi.page`;
    await sql`insert into projects(id,organization_id,name,slug) values(${project},${f.org},'Source expiry',${project})`;
    await sql`insert into page_sites(id,organization_id,project_id,slug,default_hostname) values(${siteId},${f.org},${project},${siteId},${host})`;
    const deadline = new Date(Date.now() + 2000);
    await sql`update console_browser_sessions set expires_at=${deadline.toISOString()} where id=${f.oidc.sessionId}`;
    const before = await effects(f.org, requestId);
    const run = () => surface === "page-claim"
      ? f.pages.createPagesClaimCode({ workspace: { mode: "oidc", organization: { id: f.org }, user: { id: f.user },
        membership: { role: "viewer" }, browserSessionId: f.oidc.sessionId }, returnTo: `https://${host}/`, requestId, canReadProject: async () => true })
      : f.pages.createPagesCaptureSession({ userId: f.user, requestId, requireBrowserSession: true, browserSessionId: f.oidc.sessionId,
        site: { id: siteId, organizationId: f.org, projectId: project, defaultHostname: host, defaultVisibility: "private", status: "active" } });
    expect((await acrossExpiry<unknown>(f.org, deadline, run, { audit: requestId })).value === null).toBe(true);
    expect(await effects(f.org, requestId)).toEqual(before);
    expect((await sql`select count(*)::int as n from pages_claim_codes where organization_id=${f.org}`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from audit_events where request_id=${requestId}`)[0]!.n).toBe(0);
  }, 15000);
}

for (const wait of ["row", "audit"] as const) {
  test(`link request creation: caller expiry during ${wait} wait rolls back rotation`, async () => {
    const f = await fixture(), requestId = randomUUID(), initial = await prepare(f, "link-approval", randomUUID());
    const [source] = await sql`select cli_session_id,installation_id from ravi_link_requests where id=${initial.id}`;
    const deadline = new Date(Date.now() + 2000);
    await sql`update cli_sessions set expires_at=${deadline.toISOString()} where id=${source!.cli_session_id}`;
    const run = () => f.link.createRaviLinkRequest({ caller: { cliSessionId: source!.cli_session_id, userId: f.user,
      membershipStatus: "active", sessionOrganizationId: f.org, sessionInstallationId: source!.installation_id },
      body: { contactId: "expiry-contact", expectedEmail: f.oidc.email }, origin: f.config.origin, requestId });
    expect((await acrossExpiry(f.org, deadline, run, wait === "row"
      ? { row: { table: "ravi_link_requests", id: initial.id } } : { audit: requestId })).value === null).toBe(true);
    const requests = await sql`select id,status from ravi_link_requests where organization_id=${f.org}`;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: initial.id, status: "pending" });
    expect((await sql`select count(*)::int as n from audit_events where request_id=${requestId} and action='ravi_link.request.created'`)[0]!.n).toBe(0);
  }, 15000);
}

test("device approval: valid concurrent repeats record exactly one approval", async () => {
  const f = await fixture(), requestId = randomUUID(), p = await prepare(f, "device-approval", requestId);
  expect(await Promise.all([p.run(), p.run()])).toEqual([{ ok: true }, { ok: true }]);
  expect((await effects(f.org, requestId)).successes).toBe(1);
  await sql`update cli_device_authorizations set expires_at=clock_timestamp() where id=${p.id}`;
  await expect(p.run()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  expect((await effects(f.org, requestId)).successes).toBe(1);
}, 15000);
