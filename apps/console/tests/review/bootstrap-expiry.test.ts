import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { BootstrapService } from "../../src/server/console/fleet/bootstrap";

const socket = process.env.FLEET_TEST_PG_SOCKET;
if (!socket?.includes("fleet-pg-test-review-race-")) throw new Error("Dedicated review cluster required");
const sql = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 5,
  prepare: false, onnotice() {}, connection: { statement_timeout: 15000 } });
let fetchAttempts = 0;
Object.assign(globalThis, { fetch: async () => { fetchAttempts++; throw new Error("No external bootstrap operation"); } });
beforeAll(async () => { await migrate(drizzle(sql), { migrationsFolder: "drizzle" }); }, 60000);
afterAll(async () => { await sql.end(); expect(fetchAttempts).toBe(0); });

async function fixture() {
  const org = randomUUID(), subject = randomUUID(), email = `${subject}@example.invalid`, token = randomBytes(32).toString("base64url");
  const config = { organizationId: org, origin: "https://bootstrap-fixture.invalid", issuer: "https://idp-fixture.invalid",
    clientId: "synthetic", clientSecret: "synthetic-only", secret: "synthetic-bootstrap-secret-1234567890", sessionTtlSeconds: 3600 };
  await sql`insert into organizations(id,name,slug) values(${org},'Expiry bootstrap',${org})`;
  // Operator grant is explicit synthetic fixture data. This does NOT exercise
  // operator delivery, real OIDC validation, browser callback or live custody.
  await sql`insert into fleet_bootstrap_grants(organization_id,token_hash,expected_email,expires_at)
    values(${org},${createHash("sha256").update(token).digest("hex")},${email},clock_timestamp()+interval '30 minutes')`;
  const state = randomUUID();
  const service = new BootstrapService(sql, config, {
    begin: async () => ({ transaction: { verifier: randomBytes(32).toString("base64url"), state, nonce: randomUUID(), returnTo: "/org/onboarding" },
      url: new URL(`${config.issuer}/authorize?state=${state}`) }),
    complete: async () => ({ issuer: config.issuer, subject, email, name: "Synthetic owner", emailVerified: true }),
  });
  const attempt = await service.begin({ token, operationId: randomUUID() });
  return { org, service, cookie: attempt.cookie, callback: new URL(`${config.origin}/callback/setup?state=${state}`) };
}

for (const deadlineColumn of ["expires_at", "attempt_expires_at"] as const) {
  test(`bootstrap: ${deadlineColumn} expiring in final audit wait cannot persist owner/grants/session`, async () => {
    const f = await fixture(), deadline = new Date(Date.now() + 2000), key = `bootstrap-expiry:${f.org}`;
    await sql.unsafe(`update fleet_bootstrap_grants set ${deadlineColumn}=$1 where organization_id=$2`, [deadline.toISOString(), f.org]);
    await sql.unsafe(`create function review_bootstrap_wait() returns trigger language plpgsql as $$
      begin if new.action='fleet.setup.claimed' then perform pg_advisory_xact_lock(hashtextextended('${key}',0)); end if; return new; end $$`);
    await sql.unsafe("create trigger review_bootstrap_wait before insert on audit_events for each row execute function review_bootstrap_wait()");
    const gate = await sql.reserve();
    const [holder] = await gate`select pg_backend_pid() as pid,pg_advisory_lock(hashtextextended(${key},0))`;
    let pending: Promise<unknown> | undefined, unlocked = false;
    try {
      expect(Date.now() < deadline.getTime()).toBe(true);
      pending = f.service.complete(f.callback, f.cookie).catch(error => {
        if (error?.code !== "setup_unavailable" || error?.status !== 403) throw error;
        return null;
      });
      void pending.catch(() => undefined);
      let observed = false;
      for (let n = 0; n < 120; n++) {
        const [row] = await sql`select exists(select 1 from pg_stat_activity where ${holder!.pid}::int=any(pg_blocking_pids(pid))) as waiting`;
        if (row!.waiting) { observed = true; break; }
        await Bun.sleep(20);
      }
      expect(observed).toBe(true);
      for (let n = 0; n < 240; n++) {
        if ((await sql`select clock_timestamp()>${deadline.toISOString()}::timestamptz as expired`)[0]!.expired) break;
        await Bun.sleep(20);
      }
      expect((await sql`select clock_timestamp()>${deadline.toISOString()}::timestamptz as expired`)[0]!.expired).toBe(true);
      await gate`select pg_advisory_unlock(hashtextextended(${key},0))`; unlocked = true;
      const admitted = (await pending) !== null;
      const [effects] = await sql`select
        (select count(*)::int from organization_memberships where organization_id=${f.org}) as members,
        (select count(*)::int from console_browser_sessions where organization_id=${f.org}) as sessions,
        (select count(*)::int from authorization_policy_heads where organization_id=${f.org}) as policies,
        (select count(*)::int from authorization_bootstrap_receipts where organization_id=${f.org}) as receipts,
        (select count(*)::int from audit_events where organization_id=${f.org} and action='fleet.setup.claimed') as successes`;
      console.log(JSON.stringify({ kind: "bootstrap-expiry-final-wait", deadlineColumn, admitted, ...effects }));
      expect(admitted).toBe(false);
      expect(effects).toEqual({ members: 0, sessions: 0, policies: 0, receipts: 0, successes: 0 });
      expect((await sql`select consumed_at,claimed_by from fleet_bootstrap_grants where organization_id=${f.org}`)[0]).toMatchObject({ consumed_at: null, claimed_by: null });
    } finally {
      if (!unlocked) await gate`select pg_advisory_unlock(hashtextextended(${key},0))`;
      gate.release(); await pending?.catch(() => undefined);
      await sql.unsafe("drop trigger review_bootstrap_wait on audit_events; drop function review_bootstrap_wait()");
    }
  }, 15000);
}

test("bootstrap: valid complete creates one explicit owner/policy and replay denies", async () => {
  const f = await fixture();
  const result = await f.service.complete(f.callback, f.cookie);
  expect(typeof result.token).toBe("string");
  await expect(f.service.complete(f.callback, f.cookie)).rejects.toMatchObject({ code: "setup_unavailable" });
  expect((await sql`select count(*)::int as n from organization_memberships where organization_id=${f.org}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int as n from authorization_bootstrap_receipts where organization_id=${f.org}`)[0]!.n).toBe(1);
});
