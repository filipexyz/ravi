/** Isolated auth database checks. Requires local initdb/pg_ctl; never uses an
 * existing database, TCP listener, real identity or provider credentials. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { getOidcConfig } from "../src/lib/auth/oidc-config";

const bin = process.env.RAVI_AUTH_TEST_PG_BIN;
if (!bin) throw new Error("Set RAVI_AUTH_TEST_PG_BIN to a directory containing initdb and pg_ctl.");
const root = await mkdtemp(join(tmpdir(), "ravi-oidc-auth-test-"));
const data = join(root, "data");
const run = async (args: string[], env = process.env) => {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};
const command = async (args: string[]) => {
  const result = await run(args);
  if (result.code !== 0) throw new Error(`Isolated Postgres command failed: ${args[0]} (${result.code}).`);
};

// Explicitly replace DB/auth variables before importing any DB module. PGHOST
// points to this freshly-created private unix socket; PostgreSQL has NO TCP bind.
Object.assign(process.env, {
  DATABASE_URL: "postgres:///postgres", PGHOST: root, PGPORT: "5432", PGUSER: userInfo().username,
  RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_AUTH_MODE: "oidc",
  RAVI_OIDC_ISSUER: "https://idp.auth-test.invalid/realms/test", RAVI_OIDC_CLIENT_ID: "console-test",
  RAVI_OIDC_CLIENT_SECRET: "synthetic-test-only", RAVI_AUTH_SECRET: "synthetic-test-secret-at-least-32-characters",
  NEXT_PUBLIC_CONSOLE_URL: "https://console.auth-test.invalid",
  RAVI_SINGLE_TENANT_ORGANIZATION_ID: "00000000-0000-4000-8000-000000000001",
  RAVI_SINGLE_TENANT_BOOTSTRAP: "true",
});
for (const key of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "PGPASSWORD", "PGSSLMODE"]) delete process.env[key];
await command([join(bin, "initdb"), "-D", data, "--auth=trust", "--no-locale", "--encoding=UTF8"]);
await command([join(bin, "pg_ctl"), "-D", data, "-l", join(root, "postgres.log"), "-o",
  `-k ${root} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=12 -c work_mem=1MB`, "-w", "start"]);

const { dbClient: sql } = await import("../src/server/db");
try {
  // These actual migrations cover the auth tables. Full product migrations are
  // deliberately left to the integrated staging acceptance.
  const initial = (await readdir("drizzle")).find((name) => name.startsWith("0000_") && name.endsWith(".sql"));
  assert(initial);
  for (const migration of [initial, "0071_console_browser_sessions.sql"]) {
    for (const statement of (await readFile(join("drizzle", migration), "utf8")).split("--> statement-breakpoint")) {
      if (statement.trim()) await sql.unsafe(statement);
    }
  }
  const config = getOidcConfig();
  const manifest = { issuer: config.issuer, organization: { id: config.organizationId, slug: "auth-test", name: "Auth Test" },
    users: [{ id: "00000000-0000-4000-8000-000000000002", subject: "test-owner", email: "owner@example.invalid", name: "Owner", role: "owner" },
      { id: "00000000-0000-4000-8000-000000000003", subject: "test-viewer", email: "viewer@example.invalid", name: "Viewer", role: "viewer" }] };
  const manifestPath = join(root, "manifest.json");
  const bootstrap = async (input = manifest) => {
    await writeFile(manifestPath, JSON.stringify(input), { mode: 0o600 });
    return run([process.execPath, resolve("scripts/bootstrap-single-tenant.ts"), manifestPath]);
  };
  assert.equal((await bootstrap()).code, 0, "bootstrap creates explicit identities");
  const before = await sql`select id, role, status from organization_memberships order by user_id`;
  assert.equal((await bootstrap()).code, 0, "bootstrap is idempotent");
  assert.deepEqual(await sql`select id, role, status from organization_memberships order by user_id`, before);
  const store = await import("../src/lib/auth/oidc-store");
  const identity = { issuer: config.issuer, subject: "test-owner", email: "owner@example.invalid", name: "Owner", emailVerified: true as const };
  const session = await store.createOidcBrowserSession(identity, config);
  assert.equal((await store.readOidcBrowserSession(session.token, config))?.userId, manifest.users[0]!.id);
  const [persisted] = await sql`select token_hash from console_browser_sessions`;
  assert.equal(persisted!.token_hash.length, 64);
  assert.notEqual(persisted!.token_hash, session.token);
  assert.equal(await store.readOidcBrowserSession("invalid", config), null);
  assert.equal(await store.readOidcBrowserSession(session.token, { ...config, organizationId: "00000000-0000-4000-8000-000000000099" }), null);
  assert.equal(await store.readOidcBrowserSession(session.token, { ...config, issuer: "https://other.invalid" }), null);
  assert.equal(await store.resolveOidcRuntimeIdentity({ issuer: config.issuer, subject: "unknown" }), null);
  await assert.rejects(store.createOidcBrowserSession({ ...identity, subject: "unknown" }, config));
  await assert.rejects(store.createOidcBrowserSession({ ...identity, emailVerified: false as never }, config));
  assert.equal((await sql`select count(*)::integer as n from users`)[0]!.n, 2);
  assert.equal((await store.resolveOidcRuntimeIdentity({ issuer: config.issuer, subject: "test-viewer" }))?.role, "viewer");

  const { getConsoleWorkspace } = await import("../src/server/console/workspace");
  const auth = { mode: "oidc" as const, oidc: { ...identity, userId: manifest.users[0]!.id },
    viewer: { name: identity.name, email: identity.email, mark: "O" } };
  assert.equal((await getConsoleWorkspace(auth)).organization.id, config.organizationId);
  await assert.rejects(getConsoleWorkspace(auth, { organizationRef: "another-org" }));

  for (const kind of ["membership", "user", "organization"] as const) {
    if (kind === "membership") await sql`update organization_memberships set status='removed' where user_id=${manifest.users[0]!.id}`;
    if (kind === "user") await sql`update users set status='disabled' where id=${manifest.users[0]!.id}`;
    if (kind === "organization") await sql`update organizations set status='suspended' where id=${config.organizationId}`;
    assert.equal(await store.readOidcBrowserSession(session.token, config), null, `${kind} revocation closes existing session`);
    assert.equal(await store.resolveOidcRuntimeIdentity(identity), null, `${kind} revocation closes runtime bridge`);
    await assert.rejects(store.createOidcBrowserSession(identity, config));
    assert.notEqual((await bootstrap()).code, 0, `bootstrap cannot reactivate ${kind}`);
    // Only this synthetic test operator restores the fixture, never login code.
    await sql`update organization_memberships set status='active' where user_id=${manifest.users[0]!.id}`;
    await sql`update users set status='active' where id=${manifest.users[0]!.id}`;
    await sql`update organizations set status='active' where id=${config.organizationId}`;
  }

  const alteredRole = { ...manifest, users: manifest.users.map((user) => user.role === "viewer" ? { ...user, role: "admin" } : user) };
  assert.notEqual((await bootstrap(alteredRole)).code, 0, "bootstrap cannot elevate existing role");
  const reassigned = { ...manifest, users: manifest.users.map((user) => ({ ...user, subject: user.subject === "test-owner" ? "test-viewer" : "test-owner" })) };
  assert.notEqual((await bootstrap(reassigned)).code, 0, "bootstrap cannot reassign subject");
  await sql`insert into organizations (id,slug,name) values ('00000000-0000-4000-8000-000000000004','other','Other')`;
  assert.notEqual((await bootstrap()).code, 0, "bootstrap refuses second organization");
  await sql`delete from organizations where id='00000000-0000-4000-8000-000000000004'`;
  await store.revokeOidcBrowserSession(session.token);
  assert.equal(await store.readOidcBrowserSession(session.token, config), null, "logout token replay denied");
  await store.revokeOidcBrowserSession(session.token);
  assert.equal((await sql`select count(*)::integer as n from audit_events where action='auth.session.revoked'`)[0]!.n, 1);
  const expired = await store.createOidcBrowserSession(identity, config);
  await sql`update console_browser_sessions set expires_at=now()-interval '1 minute' where revoked_at is null`;
  assert.equal(await store.readOidcBrowserSession(expired.token, config), null);

  // A fresh process resolves the same persisted session without copying memory.
  const fresh = await store.createOidcBrowserSession(identity, config);
  const freshRead = await run([process.execPath, "-e", "import { readOidcBrowserSession } from './src/lib/auth/oidc-store'; import { dbClient } from './src/server/db'; const session=await readOidcBrowserSession(process.env.RAVI_TEST_SESSION); await dbClient.end(); process.exit(session ? 0 : 1);"],
    { ...process.env, RAVI_TEST_SESSION: fresh.token });
  assert.equal(freshRead.code, 0, "session survives process restart");
  const { NextRequest } = await import("next/server");
  const { oidcSignOut } = await import("../src/lib/auth/oidc-routes");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = new Proxy(originalFetch, { apply() { return Promise.reject(new Error("synthetic IdP outage")); } });
    const response = await oidcSignOut(new NextRequest(`${config.origin}/logout`, {
      headers: { cookie: `__Host-ravi_console_session=${fresh.token}` },
    }));
    assert.equal(response.headers.get("location"), `${config.origin}/login?auth=signed-out`);
    assert.equal(response.cookies.get("__Host-ravi_console_session")?.value, "");
    assert.equal(await store.readOidcBrowserSession(fresh.token, config), null, "logout succeeds during IdP outage");
  } finally { globalThis.fetch = originalFetch; }
  console.log("PASS: OIDC bootstrap idempotency/rejections, hashed sessions, authoritative revocation, wrong org/issuer, roles, logout replay, expiry and fresh-process persistence.");
} finally {
  await sql.end();
  await command([join(bin, "pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
  console.log(`Disposable auth cluster stopped; synthetic evidence retained at ${root}`);
}
