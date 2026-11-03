import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, lstat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { node24Binary, browserBinary } from "./binaries";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { chromium } from "playwright";
import { issueBootstrap } from "../../src/server/console/fleet/bootstrap";
import { oidcProviderFixture } from "./oidc-provider-fixture";
import { apiKeysBrowser } from "./api-keys-browser";

// Real Next HTTP/UI + PG + IdP. Vault deliberately absent: proves metadata survives
// and secret writes fail closed, NOT a combined Vault/managed-SSO deployment test.
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} }) : null;
let sql: ReturnType<typeof postgres> | undefined;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_browser_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_browser_fixture", username: "fleettest", max: 4, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });
function reservePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port; server.stop(true); return port!; }

integration("real browser first-owner → authorized guide/API → restart, with Vault unavailable", async () => {
  const cwd = resolve(import.meta.dir, "../..");
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (await lstat(join(cwd, name)).then(() => true, () => false)) throw new Error("Next fixture refuses a checkout with environment files");
  }
  const root = await mkdtemp(join(tmpdir(), "fleet-browser-test-"));
  const port = reservePort(), origin = `https://127.0.0.1:${port}`;
  const fixture = await oidcProviderFixture({ callbackOrigin: origin, interceptFetch: false });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let child: Bun.Subprocess | undefined;
  const logs: string[] = [], drains: Promise<unknown>[] = [];
  const pageErrors: string[] = [], failedAssets: Array<{ path: string; status: number }> = [];
  let observedPage: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  let releaseScripts: () => void = () => {};
  const org = randomUUID(), authSecret = randomBytes(32).toString("base64url");
  const secretFile = join(root, "oidc-secret");
  await writeFile(secretFile, fixture.clientSecret, { mode: 0o600 });
  const token = await issueBootstrap(sql!, { organizationId: org, name: "Browser fixture", slug: "browser-fixture", email: "owner@example.invalid" });
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC", NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=4096",
    NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: "postgres:///fleet_browser_fixture", PGHOST: socket!, PGPORT: "55439", PGUSER: "fleettest",
    RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_AUTH_MODE: "oidc", RAVI_PAGES_AI_ENABLED: "0",
    RAVI_SINGLE_TENANT_ORGANIZATION_ID: org, RAVI_AUTH_SECRET: authSecret, NEXT_PUBLIC_CONSOLE_URL: origin,
    RAVI_OIDC_ISSUER: fixture.origin, RAVI_OIDC_CLIENT_ID: "local-fleet", RAVI_OIDC_CLIENT_SECRET_FILE: secretFile,
    NODE_EXTRA_CA_CERTS: fixture.certPath, FLEET_BROWSER_PORT: String(port), FLEET_BROWSER_TLS_KEY: fixture.keyPath, FLEET_BROWSER_TLS_CERT: fixture.certPath };
  async function stop() {
    if (!child) return; const process = child; child = undefined; process.kill("SIGTERM");
    const timer = setTimeout(() => process.kill("SIGKILL"), 15000);
    try { await process.exited; } finally { clearTimeout(timer); }
    await Promise.all(drains);
  }
  async function start() {
    const process = Bun.spawn([await node24Binary(), join(import.meta.dir, "next-fixture-server.ts")], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    child = process; let ready = false;
    for (const stream of [process.stdout, process.stderr]) drains.push((async () => {
      const reader = stream.getReader(); let text = "";
      for (;;) { const part = await reader.read(); if (part.done) break; const chunk = new TextDecoder().decode(part.value); text += chunk;
        if (text.includes("FLEET_NEXT_READY")) ready = true;
        if (text.length > 10_000_000) { process.kill("SIGTERM"); throw new Error("Fixture output exceeded bound"); }
      }
      logs.push(text);
    })());
    for (let n = 0; n < 480; n++) { if (ready) return; if (process.exitCode !== null) break; await Bun.sleep(250); }
    throw new Error(`Next fixture did not become ready; private logs at ${root}`);
  }
  try {
    await start();
    browser = await chromium.launch({ executablePath: browserBinary(), headless: true, chromiumSandbox: true,
      args: [`--ignore-certificate-errors-spki-list=${fixture.spki}`] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    observedPage = page;
    page.on("pageerror", error => pageErrors.push(error.name));
    page.on("response", response => { const url = new URL(response.url());
      if (url.pathname.startsWith("/_next/") && response.status() >= 400) failedAssets.push({ path: url.pathname, status: response.status() }); });
    page.setDefaultTimeout(60000);
    const foreign: string[] = [];
    const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve; });
    await page.route("**/*", async route => {
      const target = new URL(route.request().url());
      if (![origin, fixture.origin].includes(target.origin)) { foreign.push(target.origin); return route.abort(); }
      if (target.origin === origin && route.request().resourceType() === "script") await scriptsReady;
      return route.continue();
    });
    await page.goto(`${origin}/setup`, { timeout: 120000, waitUntil: "commit" });
    await page.getByRole("heading", { name: "Primeiro acesso", exact: true }).waitFor();
    expect(await page.getByLabel("Código de configuração").isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Preparando formulário…" }).isDisabled()).toBe(true);
    releaseScripts();
    await page.getByLabel("Código de configuração").fill(token);
    expect(await page.getByRole("button", { name: "Continuar para o login" }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Continuar para o login" }).click();
    await page.getByLabel("Email", { exact: true }).fill("owner@example.invalid");
    await page.getByLabel("Password", { exact: true }).fill(fixture.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("heading", { name: "Configure sua organização", exact: true }).waitFor({ timeout: 120000 });
    expect(new URL(page.url()).origin).toBe(origin);
    const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => page.evaluate(async ({ path, body, headers }) => {
      const response = await fetch(path, body === undefined ? { headers } : { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { path, body, headers });
    expect((await call("/api/console/fleet/onboarding")).status).toBe(200);
    expect((await call("/api/console/fleet", undefined, { "x-ravi-org": randomUUID() })).status).toBe(403);
    const value = randomBytes(32).toString("base64url");
    const write = await call("/api/console/fleet/credentials/save", { id: randomUUID(), operationId: randomUUID(), expectedRevision: 0,
      label: "Unavailable vault", kind: "oidc_client_secret", value, binding: { issuer: fixture.origin, clientId: "local-fleet" } });
    expect(write).toEqual({ status: 503, body: { error: "vault_not_configured" } });
    expect((await sql!`select count(*)::int n from fleet_credentials`)[0]!.n).toBe(0);
    await sql!`update organization_memberships set role='viewer' where organization_id=${org}`;
    expect((await call("/api/console/fleet")).status).toBe(200); // Explicit grant, not the legacy label.
    const settings = await call("/api/console/settings?scope=org");
    expect(settings.status).toBe(200);
    expect(Object.keys(settings.body).sort()).toEqual(["id", "name", "slug"]);
    expect((await call("/api/console/fleet/members")).status).toBe(403); // Bootstrap's twelve exclude directory.
    const changedSettings = await call("/api/console/settings", { scope: "org", name: "Browser configured", slug: "browser-fixture" });
    expect(changedSettings.status).toBe(200);
    expect(changedSettings.body.name).toBe("Browser configured");
    const [head] = await sql!`select active_revision_id from authorization_policy_heads where organization_id=${org}`;
    await sql!`update authorization_policy_heads set active_revision_id=null where organization_id=${org}`;
    await sql!`update organization_memberships set role='owner' where organization_id=${org}`;
    expect((await call("/api/console/fleet")).status).toBe(403); // Owner with NO grant.
    expect((await call("/api/console/settings?scope=org")).status).toBe(403);
    expect((await call("/api/console/settings", { scope: "org", name: "Forbidden", slug: "browser-fixture", role: "owner", grants: ["*"] })).status).toBe(403);
    expect((await sql!`select name from organizations where id=${org}`)[0]!.name).toBe("Browser configured");
    await sql!`update authorization_policy_heads set active_revision_id=${head!.active_revision_id} where organization_id=${org}`;
    // Playwright's API client does not inherit the browser's SPKI trust. Use a
    // CA-pinned fixture request, with cookies in memory and no request-log dump.
    const csrfCookies = (await page.context().cookies(origin)).map(c => `${c.name}=${c.value}`).join("; ");
    const csrf = await fetch(`${origin}/api/console/fleet/onboarding/finish`, {
      method: "POST", tls: { ca: await readFile(fixture.certPath, "utf8") },
      headers: { Origin: "https://other.example.invalid", Cookie: csrfCookies, "Content-Type": "application/json" },
      body: JSON.stringify({ reviewed: true }),
    }).catch(() => { throw new Error("CA-pinned fixture CSRF request failed; no headers logged"); });
    expect(csrf.status).toBe(403);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(root, `guide-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    await page.getByRole("checkbox").check();
    await sql!`update organizations set name='Browser updated' where id=${org}`;
    await page.getByRole("button", { name: "Concluir revisão" }).click();
    await page.getByText("A configuração mudou. Atualize e revise antes de concluir.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Atualizar e revisar" }).click();
    await page.getByText("Browser updated", { exact: true }).last().waitFor();
    expect(await page.getByRole("checkbox").isChecked()).toBe(false);
    await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Concluir revisão" }).click();
    await page.getByText("Revisão inicial concluída", { exact: true }).waitFor();
    await stop(); await start();
    await page.reload({ timeout: 120000, waitUntil: "domcontentloaded" });
    await page.getByText("Revisão inicial concluída", { exact: true }).waitFor();
    expect((await call("/api/console/fleet/onboarding")).body.completed).toBe(true);
    expect((await sql!`select count(*)::int n from organization_memberships`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from audit_events where action='fleet.setup.claimed'`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from audit_events where action='fleet.onboarding.reviewed'`)[0]!.n).toBe(1);
    // Same real SSO session, normal Next policy API and creation form. Bootstrap
    // grants config authority only; no role label or creator auto-grant.
    const creationPath = `${origin}/browser-fixture/projects/new`;
    const createInput = { name: "Browser project", slug: "browser-project", defaultVisibility: "private", createDefaultPageSite: true };
    await page.goto(creationPath);
    await page.getByText("You can't create projects", { exact: true }).waitFor();
    expect((await call("/api/console/projects", createInput)).status).toBe(403);
    expect((await sql!`select count(*)::int n from projects where organization_id=${org}`)[0]!.n).toBe(0);
    const initialPolicy = await call("/api/console/authorization");
    expect(initialPolicy.status).toBe(200);
    expect(initialPolicy.body.active.document.organizationRules.flatMap((r: { actions: string[] }) => r.actions)).toHaveLength(12);
    const document = structuredClone(initialPolicy.body.active.document);
    const actor = initialPolicy.body.currentUserId;
    async function publishPolicy() {
      const state = await call("/api/console/authorization");
      expect(state.status).toBe(200);
      const draft = await call("/api/console/authorization/draft", { document, expectedGeneration: state.body.generation,
        operationKey: randomUUID(), reason: "Synthetic browser creation acceptance" });
      expect(draft.status).toBe(200);
      const preview = await call("/api/console/authorization/preview", { expectedGeneration: draft.body.generation });
      expect(preview.status).toBe(200);
      const published = await call("/api/console/authorization/publish", { expectedGeneration: draft.body.generation,
        previewId: preview.body.id, operationKey: randomUUID(), reason: "Synthetic reviewed acceptance" });
      expect(published.status).toBe(200);
    }
    document.organizationRules.push({ id: "browser-create", effect: "allow", principals: [{ kind: "user", id: actor }], actions: ["organization.projects.create"] });
    await publishPolicy();
    await sql!`update organization_memberships set role='billing' where organization_id=${org}`;
    await page.reload();
    await page.getByRole("heading", { name: "New project", exact: true }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill(createInput.name);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.getByText("Creation or the required data access was not granted.", { exact: false }).waitFor();
    expect((await sql!`select count(*)::int n from projects where organization_id=${org}`)[0]!.n).toBe(0);
    document.rules.push({ id: "browser-future-data", effect: "allow", projects: ["*"],
      principals: [{ kind: "user", id: actor }], actions: ["project.read", "project.write"] });
    await publishPolicy();
    // No policy changes through creation: current policy already covers the new
    // exact resource and default Page. This is not an only-my-created rule.
    const beforeCreation = (await call("/api/console/authorization")).body;
    for (const key of ["console.projects", "console.pages"]) {
      await sql!`insert into entitlements(organization_id,key,value_json) values(${org},${key},'{"enabled":false}'::jsonb)`;
      expect(await call("/api/console/projects",createInput)).toEqual({status:403,body:{error:"feature_unavailable"}});
      expect((await sql!`select count(*)::int n from projects where organization_id=${org}`)[0]!.n).toBe(0);
      await sql!`delete from entitlements where organization_id=${org} and key=${key}`;
    }
    for (const width of [1280,390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(root, `create-project-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
    const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/console/projects" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const creation = await createdResponse;
    expect(creation.status()).toBe(201);
    const created = await creation.json();
    await page.waitForURL(url => url.pathname === `/browser-fixture/p/${created.project.id}`);
    expect((await sql!`select count(*)::int n from projects where organization_id=${org}`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from page_sites where project_id=${created.project.id}`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from project_memberships where project_id=${created.project.id}`)[0]!.n).toBe(0);
    const afterCreation = (await call("/api/console/authorization")).body;
    expect(afterCreation.generation).toBe(beforeCreation.generation);
    expect(afterCreation.active.document).toEqual(beforeCreation.active.document);
    // Revocation hides the affordance and direct API remains denied, without
    // removing the existing project or broadening its policy.
    document.organizationRules = document.organizationRules.filter((rule: { id: string }) => rule.id !== "browser-create");
    await publishPolicy();
    await page.goto(creationPath);
    await page.getByText("You can't create projects", { exact: true }).waitFor();
    expect((await call("/api/console/projects", { ...createInput, slug: "revoked-browser" })).status).toBe(403);
    expect((await sql!`select count(*)::int n from projects where organization_id=${org}`)[0]!.n).toBe(1);
    // Existing provisioned test identity. This is fixture seeding, not a UI
    // provisioning API or a claim of real IdP onboarding for another person.
    const target=randomUUID();
    await sql!`insert into users(id,primary_email,display_name) values(${target},'target@example.invalid','Pessoa de teste')`;
    await sql!`insert into auth_identities(provider,provider_user_id,user_id,email)
      values(${`oidc:${fixture.origin}`},${target},${target},'target@example.invalid')`;
    await sql!`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${target},'owner','active')`;
    document.organizationRules.push({id:"browser-members",effect:"allow",principals:[{kind:"user",id:actor}],actions:["organization.members.read"]});
    await publishPolicy();
    const directory=await call("/api/console/fleet/members");
    expect(directory.status).toBe(200); expect(directory.body.members).toHaveLength(2);
    const targetMember=directory.body.members.find((m:{userId:string})=>m.userId===target);
    expect(Object.keys(targetMember).sort()).toEqual(["email","name","status","userId","version"]);
    const changeInput={userId:target,status:"suspended",expectedVersion:targetMember.version,operationId:randomUUID()};
    expect((await call("/api/console/fleet/members/status",changeInput)).status).toBe(403);
    await page.goto(`${origin}/browser-fixture/members`);
    await page.getByText("Somente consulta",{exact:true}).waitFor();
    expect(await page.getByRole("button",{name:"Suspender",exact:true}).count()).toBe(0);
    document.organizationRules.find((r:{id:string})=>r.id==="browser-members").actions.push("organization.members.manage");
    await publishPolicy(); await page.reload();
    const row=page.getByRole("listitem").filter({has:page.getByText("target@example.invalid",{exact:true})});
    await row.getByRole("button",{name:"Suspender",exact:true}).waitFor();
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      await page.screenshot({path:join(root,`members-${width}.png`),fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    }
    await row.getByRole("button",{name:"Suspender",exact:true}).focus(); await page.keyboard.press("Enter");
    const dialog=page.getByRole("dialog",{name:"Suspender?",exact:true}); await dialog.waitFor();
    await page.keyboard.press("Escape"); expect(await dialog.isVisible()).toBe(false);
    await row.getByRole("button",{name:"Suspender",exact:true}).click();
    await page.screenshot({path:join(root,"members-confirmation-390.png"),fullPage:true});
    const memberResponse=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/console/fleet/members/status" && r.request().method()==="POST");
    await dialog.getByRole("button",{name:"Confirmar alteração",exact:true}).click();
    const response=await memberResponse; expect(response.status()).toBe(200);
    const submitted=response.request().postDataJSON(), result=await response.json();
    await page.getByRole("status").filter({hasText:"Pessoa de teste: suspenso."}).waitFor();
    expect((await call("/api/console/fleet/members/status",submitted)).body).toEqual(result);
    expect((await call("/api/console/fleet/members/status",{...submitted,status:"removed"})).status).toBe(409);
    expect((await call("/api/console/fleet/members/status",{...submitted,operationId:randomUUID()})).status).toBe(409);
    expect((await call("/api/console/fleet/members/status",{...submitted,grants:["*"]})).status).toBe(400);
    expect((await call("/api/console/fleet/members",undefined,{"x-ravi-org":randomUUID()})).status).toBe(403);
    expect((await call("/api/console/settings/members/upsert",{email:"not-created@example.invalid",role:"owner"})).status).toBe(403);
    expect((await call("/api/console/settings/invites/create",{email:"not-created@example.invalid",role:"owner"})).status).toBe(403);
    const policyAfterMembers=(await call("/api/console/authorization")).body;
    expect(policyAfterMembers.active.document).toEqual(document);
    expect((await sql!`select count(*)::int n from audit_events where request_id=${submitted.operationId}`)[0]!.n).toBe(1);
    expect((await sql!`select count(*)::int n from fleet_mutation_receipts where operation_id=${submitted.operationId}`)[0]!.n).toBe(1);
    // Current permission revocation also blocks an old successful receipt.
    document.organizationRules=document.organizationRules.filter((r:{id:string})=>r.id!=="browser-members");
    await publishPolicy();
    expect((await call("/api/console/fleet/members/status",submitted)).status).toBe(403);
    await page.reload(); await page.getByText("Acesso não concedido",{exact:true}).waitFor();
    const apiKeyTokens = await apiKeysBrowser({ page, sql: sql!, origin, root, org, actor, target,
      project: created.project.id, document, publish: publishPolicy, call });
    expect(foreign).toEqual([]);
    await stop();
    expect([token, authSecret, fixture.clientSecret, fixture.password, value, ...apiKeyTokens].some(secret => logs.some(log => log.includes(secret)))).toBe(false);
    console.log(JSON.stringify({ result: "PASS", kind: "real-next-browser-pg-idp", root, vault: "absent-fail-closed", deployment: false }));
  } catch (error) {
    const pageState = await observedPage?.evaluate(() => ({ ready: document.readyState,
      path: location.pathname, scripts: document.scripts.length,
      passwordLengths: [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].map(el => el.value.length),
      submitDisabled: [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].map(el => el.disabled),
    })).catch(() => null);
    console.log(JSON.stringify({ fixtureFailure: true, root, pageErrors, failedAssets, pageState }));
    if (observedPage) await observedPage.screenshot({ path: join(root,"failure.png"), fullPage:true,
      mask:[observedPage.locator('input[type="password"]'), observedPage.getByLabel("Chave emitida", { exact: true })] }).catch(() => {});
    throw error;
  } finally {
    releaseScripts();
    await browser?.close(); await stop(); await fixture.close();
    await writeFile(join(root, "next.log"), logs.join("\n"), { mode: 0o600 });
  }
}, 360000);
