import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { node24Binary, browserBinary } from "./binaries";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { chromium } from "playwright";
import { issueBootstrap } from "../../src/server/console/fleet/bootstrap";
import { managedRuntimeContentCodecFromKey } from "../../src/server/console/managed-runtime-content";
import { policySchema } from "../../src/server/console/authorization/policy";
import { hashBrowserSessionToken, OIDC_SESSION_COOKIE } from "../../src/lib/auth/oidc-transaction";
import { installFixturePolicy } from "./authorization-fixture";
import { oidcProviderFixture } from "./oidc-provider-fixture";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const options = { host: socket!, port: 55439, username: "fleettest", max: 4, onnotice() {} };
const admin = socket ? postgres({ ...options, database: "postgres" }) : null;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_stream_browser`;
  sql = postgres({ ...options, database: "fleet_stream_browser" });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });

type Capture = { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array>;
  status: number; output: string; done: boolean; error?: string };
declare global { interface Window { fleetStreams: Record<string, Capture> } }

integration("Next SSE with real SSO: current session, loaded-batch revocation, cancellation and scoped reconnect", async () => {
  const cwd = resolve(import.meta.dir, "../..");
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (await lstat(join(cwd, name)).then(() => true, () => false)) throw new Error("Refusing environment files in Next fixture");
  }
  const root = await mkdtemp(join(tmpdir(), "fleet-stream-browser-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const origin = `https://127.0.0.1:${port}`;
  const fixture = await oidcProviderFixture({ callbackOrigin: origin, interceptFetch: false });
  const org = randomUUID(), contentKey = randomBytes(32), codec = managedRuntimeContentCodecFromKey(contentKey);
  const secretFile = join(root, "oidc-secret");
  await writeFile(secretFile, fixture.clientSecret, { mode: 0o600 });
  const setup = await issueBootstrap(sql, { organizationId: org, name: "Stream browser", slug: "stream-browser", email: "owner@example.invalid" });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC", NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: "postgres:///fleet_stream_browser", PGHOST: socket!, PGPORT: "55439", PGUSER: "fleettest",
    RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_AUTH_MODE: "oidc", RAVI_PAGES_AI_ENABLED: "0",
    RAVI_SINGLE_TENANT_ORGANIZATION_ID: org, RAVI_AUTH_SECRET: randomBytes(32).toString("base64url"), NEXT_PUBLIC_CONSOLE_URL: origin,
    RAVI_MANAGED_RUNTIME_CONTENT_KEY: contentKey.toString("base64url"), RAVI_OIDC_ISSUER: fixture.origin,
    RAVI_OIDC_CLIENT_ID: "local-fleet", RAVI_OIDC_CLIENT_SECRET_FILE: secretFile, NODE_EXTRA_CA_CERTS: fixture.certPath,
    FLEET_STREAM_EVIDENCE: root, FLEET_BROWSER_PORT: String(port), FLEET_BROWSER_TLS_KEY: fixture.keyPath, FLEET_BROWSER_TLS_CERT: fixture.certPath };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let child: Bun.Subprocess | undefined;
  const logs: string[] = [], drains: Promise<void>[] = [], phases: string[] = [], forbidden: string[] = [];
  const releases: Array<() => Promise<void>> = [];
  async function stop() {
    if (!child) return;
    const current = child; child = undefined; current.kill("SIGTERM");
    const timeout = setTimeout(() => current.kill("SIGKILL"), 15000);
    try { await current.exited; await Promise.all(drains); } finally { clearTimeout(timeout); }
  }
  // Locks are fixture-only synchronization, not a product hook or an auth mock.
  // They expose exactly which real SQL statement is pending; no elapsed-time guess.
  async function hold(table: "managed_runtime_events" | "console_browser_sessions") {
    const connection = postgres({ ...options, max: 1, database: "fleet_stream_browser" });
    const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pending = connection.begin(async tx => {
      await tx`set local lock_timeout='10s'`;
      await tx.unsafe(`lock table ${table} in access exclusive mode`);
      ready.resolve(); await release.promise;
    });
    void pending.catch(ready.reject);
    let finished = false;
    const finish = async () => { if (finished) return; finished = true; release.resolve(); try { await pending; } finally { await connection.end(); } };
    releases.push(finish); await ready.promise; return finish;
  }
  async function waiting(table: "managed_runtime_events" | "console_browser_sessions") {
    for (let attempt = 0; attempt < 300; attempt++) {
      const [row] = await sql`select count(*)::int n from pg_stat_activity where datname='fleet_stream_browser'
        and pid<>pg_backend_pid() and state='active' and wait_event_type='Lock'
        and query ilike ${`select %from "${table}"%`}`;
      if (row!.n > 0) return;
      await Bun.sleep(50);
    }
    throw new Error(`Expected real pending ${table} SELECT; evidence ${root}`);
  }
  try {
    const serverProcess = Bun.spawn([await node24Binary(), join(import.meta.dir, "stream-fixture-server.ts")], { cwd, env, stdout: "pipe", stderr: "pipe" });
    child = serverProcess;
    let ready = false;
    for (const output of [serverProcess.stdout, serverProcess.stderr]) drains.push((async () => {
      const reader = output.getReader(); let text = "";
      for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value);
        if (text.includes("FLEET_NEXT_READY")) ready = true;
        if (text.length > 10_000_000) throw new Error("Bounded fixture log exceeded"); }
      logs.push(text);
    })());
    for (let n = 0; n < 480 && !ready; n++) { if (child.exitCode !== null) break; await Bun.sleep(250); }
    if (!ready) throw new Error(`Next fixture startup failed; logs ${root}`);
    browser = await chromium.launch({ executablePath: browserBinary(), headless: true,
      chromiumSandbox: true, args: [`--ignore-certificate-errors-spki-list=${fixture.spki}`] });
    const page = await browser.newPage(); page.setDefaultTimeout(60000);
    await page.route("**/*", route => {
      if (![origin, fixture.origin].includes(new URL(route.request().url()).origin)) { forbidden.push("browser-egress"); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/setup`, { timeout: 120000 });
    await page.getByLabel("Código de configuração").fill(setup);
    await page.getByRole("button", { name: "Continuar para o login" }).click();
    async function completeLogin() {
      await page.getByLabel("Email", { exact: true }).fill("owner@example.invalid");
      await page.getByLabel("Password", { exact: true }).fill(fixture.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("heading", { name: "Configure sua organização", exact: true }).waitFor({ timeout: 120000 });
      await page.evaluate(() => { window.fleetStreams = {}; });
      const cookie = (await page.context().cookies(origin)).find(c => c.name === OIDC_SESSION_COOKIE);
      if (!cookie) throw new Error("Real SSO session missing");
      return hashBrowserSessionToken(cookie.value)!;
    }
    let tokenHash = await completeLogin(); phases.push("real-oidc-bootstrap");
    const [owner] = await sql`select user_id from organization_memberships where organization_id=${org}`;
    const actor = owner!.user_id as string;
    const [bootstrapRevision] = await sql`select r.document from authorization_policy_heads h
      join authorization_policy_revisions r on r.id=h.active_revision_id where h.organization_id=${org}`;
    const doc = policySchema.parse(bootstrapRevision!.document);
    expect(doc.organizationRules.flatMap(rule => rule.actions)).toHaveLength(12);
    const a = { project: randomUUID(), instance: randomUUID(), session: randomUUID(), command: randomUUID() };
    const b = { project: randomUUID(), instance: randomUUID(), session: randomUUID(), command: randomUUID() };
    async function addEvent(sequence: number) {
      const envelope = codec.encrypt({ text: `synthetic-private-A-${sequence}` }, { organizationId: org, projectId: a.project,
        instanceId: a.instance, sessionId: a.session, commandId: a.command, purpose: "session_event" });
      await sql`insert into managed_runtime_events(organization_id,session_id,command_id,sequence,event_type,encrypted_payload_json)
        values(${org},${a.session},${a.command},${sequence},'test.message',${JSON.stringify(envelope)}::jsonb)`;
    }
    for (const [label, scope] of [["a", a], ["b", b]] as const) {
      await sql`insert into projects(id,organization_id,name,slug) values(${scope.project},${org},${label},${label})`;
      await sql`insert into managed_runtime_instances(id,organization_id,project_id,display_name,placement_class,desired_state,observed_state,status,runtime_provider)
        values(${scope.instance},${org},${scope.project},'Inert read fixture','test-only','stopped','stopped','disabled','synthetic-never-run')`;
      await sql`insert into managed_runtime_sessions(id,organization_id,project_id,instance_id,runtime_provider,status)
        values(${scope.session},${org},${scope.project},${scope.instance},'synthetic-never-run','completed')`;
      await sql`insert into managed_runtime_commands(id,organization_id,project_id,instance_id,session_id,action,actor_id,status,idempotency_key)
        values(${scope.command},${org},${scope.project},${scope.instance},${scope.session},'session_sync',${actor},'succeeded',${randomUUID()})`;
    }
    await addEvent(1); await addEvent(2);
    const path = (scope = a) => `/api/console/projects/${scope.project}/managed-runtime/instances/${scope.instance}/sessions/${scope.session}/events/stream`;
    const json = (url: string) => page.evaluate(async url => { const response = await fetch(url); return { status: response.status, body: await response.json() }; }, url);
    expect(await json(path())).toEqual({ status: 403, body: { error: "feature_unavailable" } });
    // Availability metadata permits a read fixture, NOT runtime activation. No
    // host, placement service, credentials, enqueue/dispatch worker or model exists.
    await sql`insert into entitlements(organization_id,key,value_json) values(${org},'console.managed_runtime','{"enabled":true}'::jsonb)`;
    expect((await json(path())).status).toBe(403); // nominal owner alone has no project grant
    doc.rules = [{ id: "read-a", effect: "allow", principals: [{ kind: "user", id: actor }], projects: [a.project], actions: ["project.read"] }];
    await installFixturePolicy(sql, actor, doc);
    expect((await json(path(b))).status).toBe(403);
    expect((await json(path({ ...a, session: b.session }))).status).toBe(404);
    expect((await json(path({ ...a, instance: b.instance }))).status).toBe(404);
    const crossOrg = await page.evaluate(async ({ url, org }) => { const res = await fetch(url, { headers: { "x-ravi-org": org } }); return { status: res.status, body: await res.json() }; }, { url: path(), org: randomUUID() });
    expect(crossOrg).toEqual({ status: 409, body: { error: "organization_selection_required" } });
    const anonymous = await fetch(`${origin}${path()}`, { tls: { ca: await readFile(fixture.certPath, "utf8") } });
    expect(anonymous.status).toBe(401);
    await sql`update organization_memberships set role='viewer' where organization_id=${org}`;
    expect(await json(path())).toEqual({ status: 403, body: { error: "feature_forbidden" } });
    await sql`update organization_memberships set role='owner' where organization_id=${org}`;
    phases.push("initial-scope-and-availability-negatives");
    async function open(name: string, after = 0, last?: number) {
      await page.evaluate(({ name, url, last }) => {
        const capture: Capture = { controller: new AbortController(), status: 0, output: "", done: false };
        window.fleetStreams[name] = capture;
        void (async () => { try {
          const response = await fetch(url, { signal: capture.controller.signal, headers: last === undefined ? {} : { "Last-Event-ID": String(last) } });
          capture.status = response.status; capture.reader = response.body!.getReader();
          for (;;) { const part = await capture.reader.read(); if (part.done) break; capture.output += new TextDecoder().decode(part.value); }
        } catch (error) { capture.error = (error as Error).name; } finally { capture.done = true; } })();
      }, { name, url: `${path()}?after=${after}`, last });
    }
    const capture = (name: string) => page.evaluate(name => { const c = window.fleetStreams[name]!; return { status: c.status, output: c.output, done: c.done, error: c.error }; }, name);
    const contains = (name: string, text: string) => page.waitForFunction(({ name, text }) => window.fleetStreams[name]?.output.includes(text), { name, text }, { timeout: 15000 });
    const done = (name: string) => page.waitForFunction(name => window.fleetStreams[name]?.done, name, { timeout: 15000 });
    const cancel = (name: string, reader = false) => page.evaluate(async ({ name, reader }) => {
      const c = window.fleetStreams[name]!; if (reader) await c.reader!.cancel(); else c.controller.abort();
    }, { name, reader });
    await open("initial"); await contains("initial", "id: 2\n");
    expect((await capture("initial")).status).toBe(200);
    await addEvent(3); await contains("initial", "id: 3\n");
    await cancel("initial"); await done("initial");
    await open("reconnect", 0, 2); await contains("reconnect", "id: 3\n");
    expect((await capture("reconnect")).output).not.toContain("id: 1\n");
    expect((await capture("reconnect")).output).not.toContain("id: 2\n");
    await cancel("reconnect", true); await done("reconnect"); phases.push("live-poll-and-cursor-reconnect");
    // Hold event SELECT, then hold the NEXT identity SELECT. Reaching the latter
    // proves the real route already loaded/decrypted its initial batch. Change
    // policy while emission is waiting: no product test seam or cached identity.
    const releaseEvents = await hold("managed_runtime_events");
    await open("loaded-revoked"); await waiting("managed_runtime_events");
    const releaseSession = await hold("console_browser_sessions");
    await releaseEvents(); await waiting("console_browser_sessions");
    await installFixturePolicy(sql, actor, { ...doc, rules: [] });
    await releaseSession(); await done("loaded-revoked");
    expect(await capture("loaded-revoked")).toMatchObject({ status: 200, output: 'event: stream_error\ndata: {"error":"managed_runtime_stream_unavailable"}\n\n', done: true });
    expect((await json(path())).status).toBe(403);
    await installFixturePolicy(sql, actor, doc); phases.push("loaded-decrypted-batch-discarded-before-emission");
    // Browser reader.cancel and AbortController each close an HTTP connection
    // while a REAL DB load is pending. Closing does not abort the DB query itself.
    for (const mode of ["cancel", "abort"] as const) {
      await open(mode, 3); await contains(mode, ": connected");
      const release = await hold("managed_runtime_events"); await waiting("managed_runtime_events");
      await cancel(mode, mode === "cancel"); await done(mode);
      const before = (await sql`select count(*)::int n from authorization_audit where organization_id=${org}`)[0]!.n;
      await release(); await Bun.sleep(1500);
      expect((await capture(mode)).output).not.toContain("event: session");
      expect((await sql`select count(*)::int n from authorization_audit where organization_id=${org}`)[0]!.n).toBe(before);
      phases.push(`${mode}-pending-real-db-load`);
    }
    for (const reason of ["expire", "revoke"] as const) {
      await open(reason, 3); await contains(reason, ": connected");
      if (reason === "expire") await sql`update console_browser_sessions set expires_at=now()-interval '1 second' where token_hash=${tokenHash}`;
      else await sql`update console_browser_sessions set revoked_at=now() where token_hash=${tokenHash}`;
      await done(reason);
      expect((await capture(reason)).status).toBe(200);
      expect((await capture(reason)).output).toContain('event: stream_error\ndata: {"error":"managed_runtime_stream_unavailable"}');
      expect((await json(path())).status).toBe(401);
      phases.push(`${reason}-connected-session-and-reconnect`);
      if (reason === "expire") {
        await page.context().clearCookies();
        await page.goto(`${origin}/sign-in?returnTo=/stream-browser/onboarding`);
        tokenHash = await completeLogin();
      }
    }
    const commands = await sql`select status,attempt_count,claim_owner from managed_runtime_commands where organization_id=${org}`;
    expect(commands).toHaveLength(2);
    expect(commands.every(row => row.status === "succeeded" && row.attempt_count === 0 && row.claim_owner === null)).toBe(true);
    expect((await sql`select count(*)::int n from managed_runtime_operations`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from managed_runtime_sessions`)[0]!.n).toBe(2);
    expect((await sql`select count(*)::int n from runtime_hosts`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from managed_runtime_instances where desired_state<>'stopped' or observed_state<>'stopped'`)[0]!.n).toBe(0);
    expect(forbidden).toEqual([]);
    await browser.close(); browser = undefined; await stop();
    const network = JSON.parse(await readFile(join(root, "network.json"), "utf8"));
    expect(network.deniedSockets).toBe(0);
    expect(network.blockedFrameworkVersionChecks).toBeLessThanOrEqual(1);
    expect(network.deniedFetches).toBe(network.blockedFrameworkVersionChecks);
    expect(network.deniedFetchOrigins.every((value: string) => value === "https://registry.npmjs.org")).toBe(true);
    expect(network.allowedSockets).toBeGreaterThan(0);
    phases.push("zero-runtime-provider-attempts");
    await writeFile(join(root, "result.json"), JSON.stringify({ result: "PASS", phases, network, commands: 2, attempts: 0, operations: 0 }), { mode: 0o600 });
    console.log(JSON.stringify({ result: "PASS", root, phases }));
  } finally {
    for (const release of releases.reverse()) await release();
    await browser?.close(); await stop(); await fixture.close();
    await writeFile(join(root, "next.log"), logs.join("\n"), { mode: 0o600 });
    await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
  }
}, 360000);
