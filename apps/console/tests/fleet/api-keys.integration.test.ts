import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ApiKeysService, withApiKey } from "../../src/server/console/fleet/api-keys";
import { OrganizationMembersService } from "../../src/server/console/fleet/members";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";
import type { ApiKeyReceipt } from "../../src/shared/api-keys";
import type { FleetActor } from "../../src/server/console/fleet/contract";

const socket = process.env.FLEET_TEST_PG_SOCKET;
if (!socket?.includes("fleet-pg-test-")) throw new Error("Run through tests/fleet/run-postgres.ts --api-keys; own PG required");
const admin = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} });
let sql: ReturnType<typeof postgres>;
let moveProject: typeof import("../../src/server/admin/projects").moveAdminProject;
let productDb: typeof import("../../src/server/db").dbClient;
beforeAll(async () => {
  await admin`create database fleet_keys_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_keys_fixture", username: "fleettest", max: 6, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  // Import only after the owned database exists. The runner's explicit socket
  // environment directs the real administrative path here, never to a user DB.
  ({ moveAdminProject: moveProject } = await import("../../src/server/admin/projects"));
  ({ dbClient: productDb } = await import("../../src/server/db"));
}, 60000);
afterAll(async () => { await productDb?.end(); await sql?.end(); await admin.end(); });
const mutation = () => ({ operationId: randomUUID(), reason: "Explicit isolated fixture intent" });
async function fixture() {
  const org = randomUUID(), creator = randomUUID(), holder = randomUUID(), project = randomUUID();
  await sql`insert into organizations(id,name,slug) values(${org},'Key fixture',${org})`;
  const actors: FleetActor[] = [];
  for (const user of [creator, holder]) {
    await sql`insert into users(id,primary_email,display_name) values(${user},${`${user}@example.invalid`},${user === creator ? "Creator" : "Holder"})`;
    await sql`insert into organization_memberships(organization_id,user_id,role) values(${org},${user},${user === creator ? "billing" : "owner"})`;
    const [identity] = await sql`insert into auth_identities(user_id,provider,provider_user_id,email)
      values(${user},'oidc:https://fixture.invalid',${user},${`${user}@example.invalid`}) returning id`;
    const [session] = await sql`insert into console_browser_sessions(organization_id,user_id,auth_identity_id,token_hash,expires_at)
      values(${org},${user},${identity!.id},${randomUUID()},now()+interval '1 hour') returning id`;
    actors.push({ mode: "oidc", userId: user, organizationId: org, role: user === creator ? "billing" : "owner", sessionId: session!.id });
  }
  await sql`insert into projects(id,organization_id,name,slug) values(${project},${org},'Project fixture',${project})`;
  const policy = fixturePolicy(org, creator);
  policy.rules.push({ id: "holder-read", principals: [{ kind: "user", id: holder }], effect: "allow", projects: [project], actions: ["project.read"] });
  await installFixturePolicy(sql, creator, policy);
  const service = new ApiKeysService(sql, org), members = new OrganizationMembersService(sql, org), actor = actors[0]!;
  const issue = () => ({ ...mutation(), name: "Bound credential", projectId: project, scopes: ["project.read"] as const,
    subject: { kind: "user" as const, id: holder }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const change = async (user = holder, status: "active" | "suspended" | "removed" = "suspended") => members.change(actor, {
    operationId: randomUUID(), userId: user, status, expectedVersion: (await members.list(actor)).members.find(m => m.userId === user)!.version });
  const use = (receipt: ApiKeyReceipt, overrides = {}) => withApiKey(sql, { token: receipt.token!, organizationId: org,
    projectId: project, action: "project.read", requestId: randomUUID(), ...overrides }, async (tx, subject) => {
    const [row] = await tx`select name from projects where id=${project} and organization_id=${org}`;
    return { name: row!.name, ...subject };
  });
  return { org, creator, holder, project, actor, actors, policy, service, members, issue, change, use };
}

test("explicit holder differs from creator; narrow policy works without role power, hash-only persistence, exact retry", async () => {
  const f = await fixture(), input = f.issue();
  const issued = await f.service.issue(f.actor, input), repeated = await f.service.issue(f.actor, input);
  expect(issued.token).toMatch(/^rvk_[A-Za-z0-9_-]{43}$/);
  expect(repeated.token).toBeUndefined(); expect(repeated.key).toEqual(issued.key);
  expect(await f.use(issued)).toMatchObject({ id: f.holder, kind: "user", name: "Project fixture" });
  const [row] = await sql`select * from api_keys where id=${issued.key!.id}`;
  expect(row!.created_by_user_id).toBe(f.creator); expect(row!.subject_user_id).toBe(f.holder);
  expect(row!.key_hash).toBe(createHash("sha256").update(issued.token!).digest("hex"));
  expect(JSON.stringify(await f.service.list(f.actor))).not.toContain(issued.token!);
  expect(JSON.stringify(await sql`select * from audit_events where organization_id=${f.org}`)).not.toContain(issued.token!);
  expect(JSON.stringify(await sql`select * from fleet_mutation_receipts where organization_id=${f.org}`)).not.toContain(issued.token!);
  expect((await sql`select count(*)::int n from api_keys where organization_id=${f.org}`)[0]!.n).toBe(1);
  await expect(f.service.issue(f.actor, { ...input, name: "different" })).rejects.toThrow("idempotency_conflict");
});

test("forged authority, nominal admin, cross-org/project, inactive subject and missing explicit grants deny", async () => {
  const f = await fixture(), other = await fixture(), input = f.issue();
  for (const injected of [{ organizationId: other.org }, { role: "owner" }, { userId: f.holder }, { grants: ["*"] }])
    await expect(f.service.issue(f.actor, { ...input, ...injected })).rejects.toThrow("invalid_request");
  await expect(f.service.issue(f.actors[1]!, input)).rejects.toThrow("forbidden");
  await expect(f.service.issue(f.actor, { ...input, subject: { kind: "user", id: other.holder } })).rejects.toThrow("api_key_subject_inactive");
  await expect(f.service.issue(f.actor, { ...input, projectId: other.project })).rejects.toThrow("api_key_scope_invalid");
  await expect(f.service.issue(f.actor, { ...input, subject: { kind: "user", id: f.creator } })).rejects.toThrow("api_key_subject_not_authorized");
  await expect(f.service.issue(f.actor, { ...input, scopes: [] })).rejects.toThrow("invalid_request");
  await expect(f.service.issue(f.actor, { ...input, scopes: ["organization.settings.read"] })).rejects.toThrow("api_key_scope_invalid");
  await f.change();
  await expect(f.service.issue(f.actor, input)).rejects.toThrow("api_key_subject_inactive");
});

test("subject suspension revokes atomically; reactivation preserves terminal revocation and allows new issuance", async () => {
  const f = await fixture(), first = await f.service.issue(f.actor, f.issue());
  await f.change(); await expect(f.use(first)).rejects.toThrow("api_key_invalid");
  expect((await f.service.list(f.actor)).keys[0]!.status).toBe("revoked");
  await f.change(f.holder, "active"); await expect(f.use(first)).rejects.toThrow("api_key_invalid");
  await expect(sql`update api_keys set status='active' where id=${first.key!.id}`.execute()).rejects.toThrow("api_key_revocation_terminal");
  expect(await f.use(await f.service.issue(f.actor, f.issue()))).toMatchObject({ id: f.holder });
});

test("service has independent grants; creator suspension preserves it; grant revocation and service revocation deny", async () => {
  const f = await fixture();
  const principal = (await f.service.createService(f.actor, { ...mutation(), name: "Scoped importer" })).service!;
  const input = { ...f.issue(), subject: { kind: "service", id: principal.id } };
  await expect(f.service.issue(f.actor, input)).rejects.toThrow("api_key_subject_not_authorized");
  f.policy.rules.push({ id: "service-read", principals: [{ kind: "service", id: principal.id }], effect: "allow", projects: [f.project], actions: ["project.read"] });
  // Holder becomes an explicitly granted second manager, not by owner label.
  f.policy.roles[0]!.members.push(f.holder); await installFixturePolicy(sql, f.creator, f.policy);
  const issued = await f.service.issue(f.actor, input);
  expect(await f.use(issued)).toMatchObject({ id: principal.id, kind: "service" });
  const member = (await f.members.list(f.actors[1]!)).members.find(m => m.userId === f.creator)!;
  await f.members.change(f.actors[1]!, { operationId: randomUUID(), userId: f.creator, status: "suspended", expectedVersion: member.version });
  expect(await f.use(issued)).toMatchObject({ id: principal.id });
  f.policy.rules = f.policy.rules.filter(r => r.id !== "service-read"); await installFixturePolicy(sql, f.holder, f.policy);
  await expect(f.use(issued)).rejects.toThrow("api_key_subject_not_authorized");
  f.policy.rules.push({ id: "service-read", principals: [{ kind: "service", id: principal.id }], effect: "allow", projects: [f.project], actions: ["project.read"] });
  await installFixturePolicy(sql, f.holder, f.policy);
  await f.service.revokeService(f.actors[1]!, { ...mutation(), id: principal.id, expectedRevision: principal.revision });
  await expect(f.use(issued)).rejects.toThrow("api_key_invalid");
});

test("unclassified keys are preserved, inventory blocks rollout; classification is explicit and requires rotation", async () => {
  const f = await fixture(), id = randomUUID(), token = "rvk_" + randomBytes(32).toString("base64url");
  await sql`insert into api_keys(id,organization_id,name,key_prefix,key_hash,created_by_user_id)
    values(${id},${f.org},'Legacy','legacy',${createHash("sha256").update(token).digest("hex")},${f.holder})`;
  expect((await f.service.list(f.actor)).unresolved).toBe(1);
  await f.change();
  expect((await sql`select status from api_keys where id=${id}`)[0]!.status).toBe("active");
  await expect(f.use({ operationId: randomUUID(), token })).rejects.toThrow("api_key_invalid");
  await f.change(f.holder, "active");
  const { name: _name, ...binding } = f.issue();
  const classified = await f.service.classify(f.actor, { ...binding, id, expectedRevision: 1 });
  expect(classified.key!.rotationRequired).toBe(true);
  await expect(f.use({ ...classified, token })).rejects.toThrow("api_key_invalid");
  const rotated = await f.service.rotate(f.actor, { ...mutation(), id, expectedRevision: classified.key!.revision, expiresAt: binding.expiresAt });
  expect(await f.use(rotated)).toMatchObject({ id: f.holder });
  expect((await f.service.list(f.actor)).unresolved).toBe(0);
});

test("rotation/CAS/expiration and exact project ceiling deny stale credentials and widening", async () => {
  const f = await fixture(), first = await f.service.issue(f.actor, f.issue());
  await expect(f.use(first, { projectId: null })).rejects.toThrow("api_key_scope_denied");
  await expect(f.use(first, { action: "project.write" })).rejects.toThrow("api_key_scope_denied");
  await expect(f.use(first, { organizationId: randomUUID() })).rejects.toThrow("api_key_invalid");
  const second = await f.service.rotate(f.actor, { ...mutation(), id: first.key!.id, expectedRevision: 1, expiresAt: f.issue().expiresAt });
  await expect(f.use(first)).rejects.toThrow("api_key_invalid"); expect(await f.use(second)).toMatchObject({ id: f.holder });
  await expect(f.service.revoke(f.actor, { ...mutation(), id: first.key!.id, expectedRevision: 1 })).rejects.toThrow("version_conflict");
  await sql`update api_keys set expires_at=clock_timestamp() where id=${second.key!.id}`;
  await expect(f.use(second)).rejects.toThrow("api_key_invalid");
});

test("transaction failures roll back issuance, receipts, audit and last-manager revocation", async () => {
  const f = await fixture();
  f.policy.rules.push({ id: "creator-read", principals: [{ kind: "user", id: f.creator }], effect: "allow", projects: [f.project], actions: ["project.read"] });
  await installFixturePolicy(sql, f.creator, f.policy);
  const issued = await f.service.issue(f.actor, { ...f.issue(), subject: { kind: "user", id: f.creator } });
  await expect(f.change(f.creator)).rejects.toThrow("authorization_last_manager_required");
  expect(await f.use(issued)).toMatchObject({ id: f.creator });
  const body = f.issue();
  await sql`create function key_fixture_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic_write_failure'; end $$`;
  await sql`create trigger key_fixture_fail before insert on fleet_mutation_receipts for each row execute function key_fixture_fail()`;
  try { await expect(f.service.issue(f.actor, body)).rejects.toThrow("synthetic_write_failure"); }
  finally { await sql`drop trigger key_fixture_fail on fleet_mutation_receipts`; await sql`drop function key_fixture_fail()`; }
  expect((await sql`select count(*)::int n from api_keys where organization_id=${f.org}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int n from audit_events where request_id=${body.operationId}`)[0]!.n).toBe(0);
  const retried = await f.service.issue(f.actor, body);
  expect(await f.use(retried)).toMatchObject({ id: f.holder });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function blocked(minimum = 1) {
  for (let n = 0; n < 400; n++) {
    const [row] = await sql`select count(*)::int n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`;
    if (row!.n >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected actual PG advisory-lock wait");
}
for (const first of ["issue", "suspend"] as const) test(`real blocking orders ${first} first: no credential survives suspension`, async () => {
  const f = await fixture(), locked = deferred(), release = deferred();
  const holder = sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${f.org}`},0))`;
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  const suspendInput = { operationId: randomUUID(), userId: f.holder, status: "suspended", expectedVersion:
    (await sql`select updated_at::text v from organization_memberships where organization_id=${f.org} and user_id=${f.holder}`)[0]!.v };
  let issued: Promise<ApiKeyReceipt>, suspended: Promise<unknown>;
  if (first === "issue") { issued = f.service.issue(f.actor, f.issue()); await blocked(); suspended = f.members.change(f.actor, suspendInput); }
  else { suspended = f.members.change(f.actor, suspendInput); await blocked(); issued = f.service.issue(f.actor, f.issue()); }
  const all = Promise.allSettled([issued, suspended]);
  release.resolve(); await holder;
  const [a,b] = await all;
  expect(b.status).toBe("fulfilled");
  if (first === "issue") { expect(a.status).toBe("fulfilled"); if (a.status === "fulfilled") await expect(f.use(a.value)).rejects.toThrow("api_key_invalid"); }
  else { expect(a.status).toBe("rejected"); if (a.status === "rejected") expect(a.reason.message).toBe("api_key_subject_inactive"); }
}, 15000);

for (const first of ["issue", "transfer"] as const) test(`project transfer and issuance: ${first} wins, no credential follows a moved project`, async () => {
  const f = await fixture(), target = await fixture(), locked = deferred(), release = deferred();
  const holder = sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${f.org}`},0))`;
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  const transfer = () => moveProject({ requestId: randomUUID(), body: { projectRef: f.project,
    sourceOrganizationRef: f.org, targetOrganizationRef: target.org, reason: "Isolated concurrent transfer" } });
  let issue!: Promise<ApiKeyReceipt>, move!: ReturnType<typeof transfer>;
  let results!: PromiseSettledResult<unknown>[];
  try {
    if (first === "issue") { issue = f.service.issue(f.actor, f.issue()); await blocked(); move = transfer(); }
    else { move = transfer(); await blocked(); issue = f.service.issue(f.actor, f.issue()); }
    const settled = Promise.allSettled([issue, move]);
    await blocked(2); release.resolve(); await holder; results = await settled;
  } finally { release.resolve(); await holder; }
  const [project] = await sql`select organization_id from projects where id=${f.project}`;
  if (first === "issue") {
    expect(results[0]!.status).toBe("fulfilled");
    expect(await move).toMatchObject({ status: "blocked", code: "project_api_key_transfer_unsupported" });
    expect(project!.organization_id).toBe(f.org);
    expect(await f.use(await issue)).toMatchObject({ id: f.holder });
  } else {
    expect(results[0]!.status).toBe("rejected");
    if (results[0]!.status === "rejected") expect(results[0]!.reason.message).toBe("api_key_scope_invalid");
    expect(await move).toMatchObject({ status: "moved" });
    expect(project!.organization_id).toBe(target.org);
    expect((await sql`select count(*)::int n from api_keys where project_id=${f.project}`)[0]!.n).toBe(0);
  }
}, 15000);

test("missing or corrupt policy is unavailable, not an allow or a simulated denial", async () => {
  const f = await fixture(), issued = await f.service.issue(f.actor, f.issue());
  let effects = 0;
  const use = () => withApiKey(sql, { token: issued.token!, organizationId: f.org, projectId: f.project,
    action: "project.read", requestId: randomUUID() }, async () => { effects++; });
  await sql`update authorization_policy_revisions set digest='invalid-fixture-digest' where organization_id=${f.org}`;
  await expect(use()).rejects.toMatchObject({ code: "authorization_unavailable", status: 503 });
  await sql`update authorization_policy_heads set active_revision_id=null where organization_id=${f.org}`;
  await expect(use()).rejects.toMatchObject({ code: "authorization_unavailable", status: 503 });
  expect(effects).toBe(0);
  expect((await sql`select count(*)::int n from audit_events where organization_id=${f.org} and action in ('api_key.used','api_key.denied')`)[0]!.n).toBe(0);
});

test("use holds admission through effect; later suspension denies subsequent use", async () => {
  const f = await fixture(), issued = await f.service.issue(f.actor, f.issue()), entered = deferred(), release = deferred();
  const use = withApiKey(sql, { token: issued.token!, organizationId: f.org, projectId: f.project, action: "project.read", requestId: randomUUID() },
    async tx => { entered.resolve(); await release.promise; await tx`update projects set name='Authorized effect fixture' where id=${f.project}`; });
  await entered.promise;
  const suspension = f.change(); await blocked(); release.resolve(); await use; await suspension;
  expect((await sql`select name from projects where id=${f.project}`)[0]!.name).toBe("Authorized effect fixture");
  await expect(f.use(issued)).rejects.toThrow("api_key_invalid");
}, 15000);

test("failed use rolls back effects and success audit; expired use rolls back after its effect", async () => {
  const f = await fixture();
  f.policy.rules[0]!.actions.push("project.write"); await installFixturePolicy(sql, f.creator, f.policy);
  const issued = await f.service.issue(f.actor, { ...f.issue(), scopes: ["project.write"] });
  const requestId = randomUUID();
  const input = { token: issued.token!, organizationId: f.org, projectId: f.project, action: "project.write" as const, requestId };
  await expect(withApiKey(sql, input, async tx => {
    await tx`update projects set name='Must roll back' where id=${f.project}`;
    throw new Error("synthetic_effect_failure");
  })).rejects.toThrow("synthetic_effect_failure");
  expect((await sql`select name from projects where id=${f.project}`)[0]!.name).toBe("Project fixture");
  const [deadline] = await sql`update api_keys set expires_at=clock_timestamp()+interval '300 milliseconds' where id=${issued.key!.id} returning expires_at`;
  await expect(withApiKey(sql, input, async tx => {
    await tx`update projects set name='Must also roll back' where id=${f.project}`;
    while (Date.now() <= new Date(deadline!.expires_at).getTime()) await Bun.sleep(10);
  })).rejects.toThrow("api_key_invalid");
  expect((await sql`select name from projects where id=${f.project}`)[0]!.name).toBe("Project fixture");
  expect((await sql`select count(*)::int n from audit_events where request_id=${requestId} and action='api_key.used'`)[0]!.n).toBe(0);
  expect((await sql`select count(*)::int n from audit_events where request_id=${requestId} and action='api_key.denied'`)[0]!.n).toBe(1);
});

for (const first of ["use", "revoke"] as const) test(`real blocking orders ${first} first: revocation and protected effect serialize`, async () => {
  const f = await fixture(), issued = await f.service.issue(f.actor, f.issue()), locked = deferred(), release = deferred();
  const holder = sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${f.org}`},0))`;
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  let effectCount = 0;
  const use = () => withApiKey(sql, { token: issued.token!, organizationId: f.org, projectId: f.project,
    action: "project.read", requestId: randomUUID() }, async () => { effectCount++; });
  const revoke = () => f.service.revoke(f.actor, { ...mutation(), id: issued.key!.id, expectedRevision: 1 });
  const a = first === "use" ? use() : revoke(); await blocked();
  const b = first === "use" ? revoke() : use();
  const settled = Promise.allSettled([a, b]); release.resolve(); await holder;
  const results = await settled;
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]!.status).toBe(first === "use" ? "fulfilled" : "rejected");
  if (first === "revoke" && results[1]!.status === "rejected") expect(results[1]!.reason.message).toBe("api_key_invalid");
  expect(effectCount).toBe(first === "use" ? 1 : 0);
  await expect(f.use(issued)).rejects.toThrow("api_key_invalid");
}, 15000);

test("suspension queued before use denies without invoking the effect", async () => {
  const f = await fixture(), issued = await f.service.issue(f.actor, f.issue()), locked = deferred(), release = deferred();
  const holder = sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${f.org}`},0))`;
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  const version = (await sql`select updated_at::text v from organization_memberships where organization_id=${f.org} and user_id=${f.holder}`)[0]!.v;
  const suspension = f.members.change(f.actor, { operationId: randomUUID(), userId: f.holder, status: "suspended", expectedVersion: version });
  await blocked(); let invoked = false;
  const use = withApiKey(sql, { token: issued.token!, organizationId: f.org, projectId: f.project, action: "project.read", requestId: randomUUID() }, async () => { invoked = true; });
  const settled = Promise.allSettled([suspension, use]); release.resolve(); await holder;
  const result = await settled;
  expect(result[0]!.status).toBe("fulfilled"); expect(result[1]!.status).toBe("rejected");
  if (result[1]!.status === "rejected") expect(result[1]!.reason.message).toBe("api_key_invalid");
  expect(invoked).toBe(false);
}, 15000);
