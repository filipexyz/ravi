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


// Real Next HTTP/UI + PG + IdP. Vault deliberately absent: proves metadata survives
// and secret writes fail closed, NOT a combined Vault/managed-SSO deployment test.
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} }) : null;
let sql: ReturnType<typeof postgres> | undefined;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_desktop_browser_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_desktop_browser_fixture", username: "fleettest", max: 4, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });
function reservePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port; server.stop(true); return port!; }

integration("complete pinned Desktop through real OIDC host, original UI and scoped protocol fixtures", async () => {
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
    NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: "postgres:///fleet_desktop_browser_fixture", PGHOST: socket!, PGPORT: "55439", PGUSER: "fleettest",
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
    const unauth=await fetch(`${origin}/desktop/browser-fixture`,{redirect:"manual",tls:{ca:await readFile(fixture.certPath,"utf8")}});
    expect(unauth.status).toBe(307);expect(unauth.headers.get("location")).toContain("returnTo=");
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
    const installationId=randomUUID(),projectId=randomUUID(),conversationId=randomUUID(),subject=randomUUID();
    const conversation={id:conversationId,agentId:"dev",title:"Desktop fixture",version:1,updatedAt:Date.now()};
    const messages:{id:string;role:string;text:string;turnId:string;createdAt:number}[]=[];
    const sent:string[]=[];
    await page.route("**/api/console/fleet/**",async route=>{
      const url=new URL(route.request().url()),respond=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(url.pathname.endsWith("/bootstrap"))return respond({subject,organizationId:org,viewer:{name:"Synthetic owner",email:"owner@example.invalid"},options:[{installationId,projectId,installationName:"Synthetic Ravi",projectName:"Synthetic project",canSend:true,canApprove:true}]});
      if(url.pathname.endsWith("/people"))return respond({people:[{id:subject,name:"Synthetic owner",email:"owner@example.invalid",agentIds:["dev","main"]}]});
      if(url.pathname.endsWith("/stream"))return route.abort();
      const envelope=route.request().postDataJSON();
      switch(envelope.command) {
        case "sessions.conversations.agents":return respond([{id:"dev",name:"Dev"},{id:"main",name:"Ravi"}]);
        case "sessions.conversations.list":return respond([conversation]);
        case "sessions.conversations.open":return respond({conversation,messages,hasOlder:false,turn:null,approvals:[],cursor:"fixture"});
        case "sessions.conversations.send":{
          sent.push(envelope.operationId);const message={id:randomUUID(),role:"user",text:envelope.input.text,turnId:randomUUID(),createdAt:Date.now()};messages.push(message);
          await Bun.sleep(700);return respond({accepted:true,conversationId,messageId:message.id,turnId:message.turnId,version:++conversation.version});
        }
        case "desktop.session.read":return respond({provider:"codex",model:"fixture-model",effort:"medium",models:[{id:"fixture-model",label:"Fixture model"}]});
        case "desktop.work.list":return respond([]);
        case "desktop.channels.list":return respond([]);
        case "desktop.loops.list":return respond([]);
        case "desktop.computer.read":return respond({host:"Fixture host",os:"Linux",cwd:"/fixture/workspace",branch:"main",uptime:"1m",cpu:10,memory:20,processes:[],changes:[],terminal:[]});
        case "sessions.conversations.renew":return respond({renewed:true,conversationId});
      }
      return respond({error:"unsupported"},422);
    });
    await page.route("**/api/internal/connectors/list",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({connections:[],providers:[{id:"google",name:"Google"}]})}));
    const response=await page.goto(`${origin}/desktop/browser-fixture`);
    expect(response!.status()).toBe(200);expect(response!.headers()["x-ravi-desktop-revision"]).toMatch(/^[0-9a-f]{40}$/);
    expect(response!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    const input=page.getByRole("textbox",{name:"Message Desktop fixture",exact:true});await input.waitFor();
    expect(await page.getByRole("tab").allTextContents()).toEqual(["Sessions","Computer","Library","Loops"]);
    expect(await page.locator('script[src*="/_next/"]').count()).toBe(0);
    await input.fill("Original composer continuity");await input.evaluate(el=>{(window as unknown as {probe:Element}).probe=el;});await input.press("Enter");
    for(const delay of [100,900]) {
      await page.waitForTimeout(delay);
      const state=await page.evaluate(()=>{const element=(window as unknown as {probe:HTMLTextAreaElement}).probe;return {same:element.isConnected,focus:document.activeElement===element,disabled:element.disabled,value:element.value};});
      expect(state).toEqual({same:true,focus:true,disabled:false,value:""});
    }
    expect(sent).toHaveLength(1);expect(await page.getByRole("main").getByText("Original composer continuity",{exact:true}).count()).toBe(1);
    for(const tab of ["Computer","Loops","Sessions"]) {await page.getByRole("tab",{name:tab,exact:true}).click();await page.waitForTimeout(150);}
    await page.getByRole("button",{name:"Connect apps",exact:true}).click();await page.getByRole("dialog",{name:"Connect apps"}).waitFor();expect(await page.getByRole("button",{name:"Connect",exact:true}).count()).toBe(1);await page.keyboard.press("Escape");
    for(const viewport of [{width:1440,height:900},{width:1024,height:600},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      if(viewport.width<700)for(const name of ["Hide details","Hide sidebar"]){const button=page.getByRole("button",{name,exact:true});if(await button.isVisible())await button.click();}
      await page.waitForTimeout(300);expect(await input.isVisible()).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await page.screenshot({path:join(root,`desktop-${viewport.width}.png`)});
    }
    expect(pageErrors).toEqual([]);expect(failedAssets).toEqual([]);expect(foreign).toEqual([]);
    console.log(JSON.stringify({result:"PASS",kind:"original-desktop-oidc-rendered",root,realModel:false,realBridgeBroker:false,checked:["authenticated-pinned-host","no-next-chrome","original-four-tabs","composer-continuity","connect-apps","mobile","short-window"]}));
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
