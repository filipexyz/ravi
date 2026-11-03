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
import { type BridgeSnapshot } from "../../src/shared/human-bridge";

// Real Next HTTP/UI + PG + IdP. Vault deliberately absent: proves metadata survives
// and secret writes fail closed, NOT a combined Vault/managed-SSO deployment test.
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} }) : null;
let sql: ReturnType<typeof postgres> | undefined;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_bridge_browser_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_bridge_browser_fixture", username: "fleettest", max: 4, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });
function reservePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port; server.stop(true); return port!; }

integration("rendered bridge desktop/mobile and flow states (protocol fixture; not end-to-end acceptance)", async () => {
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
    NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: "postgres:///fleet_bridge_browser_fixture", PGHOST: socket!, PGPORT: "55439", PGUSER: "fleettest",
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
    // Render the real Next page after real local OIDC login. Only bridge responses
    // are fixtures here; actual SSH/native-model acceptance is recorded separately.
    const installationId=randomUUID(),projectId=randomUUID(),conversationId=randomUUID();
    const conversation={id:conversationId,agentId:"bridge-test",title:"Revisão do relatório",version:1,updatedAt:Date.now()};
    let snapshot:BridgeSnapshot={conversation,messages:[],turn:null,approvals:[],hasOlder:false,cursor:"fixture-cursor"};
    let optionsFail=true,unknownSend=false,accessDenied=false;
    const sent:string[]=[],receipts=new Map();
    await page.route("**/api/console/fleet/gateway/**",async route=>{
      const url=new URL(route.request().url()),respond=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
      if(url.pathname.endsWith("/options"))return optionsFail?respond({error:"bridge_unavailable"},503):respond({options:[{installationId,projectId,installationName:"Ravi de teste",projectName:"Projeto de teste",agentIds:["bridge-test"],canSend:true,canApprove:true}]});
      if(url.pathname.endsWith("/stream"))return route.abort();
      const envelope=route.request().postDataJSON();
      const request={...envelope.input,requestId:envelope.operationId,command:envelope.command};
      if(accessDenied)return respond({error:"NOT_FOUND_OR_DENIED",effectState:"none"},403);
      let data:unknown={conversationId};
      if(request.command==="sessions.conversations.list")data=[conversation];
      else if(request.command==="sessions.conversations.open")data=snapshot;
      else if(request.command==="sessions.conversations.send"){
        sent.push(request.requestId);
        if(!receipts.has(request.requestId)){
          snapshot={...snapshot,messages:[...snapshot.messages,{id:randomUUID(),role:"user",text:request.text,turnId:"fixture-turn",createdAt:Date.now()}],turn:{id:randomUUID(),status:"running",cancelRequested:false}};
          receipts.set(request.requestId,data);
        }
        if(unknownSend){unknownSend=false;return route.abort();}
      } else if(request.command==="sessions.conversations.cancel")snapshot={...snapshot,turn:{...snapshot.turn!,status:"cancelled",cancelRequested:true}};
      else if(request.command==="sessions.conversations.decide")snapshot={...snapshot,approvals:snapshot.approvals.map(a=>({...a,state:request.decision==="approve"?"approved":"rejected",version:a.version+1})),turn:{...snapshot.turn!,status:"completed"}};
      return respond(data);
    });
    await page.goto(`${origin}/browser-fixture/conversations`);
    await page.getByRole("button",{name:"Tentar carregar novamente"}).waitFor();optionsFail=false;
    await page.getByRole("button",{name:"Tentar carregar novamente"}).click();
    await page.getByRole("button",{name:"Nova conversa",exact:true}).waitFor();
    await page.screenshot({path:join(root,"bridge-empty-1280.png"),fullPage:true});
    await page.getByRole("button",{name:"Nova conversa",exact:true}).click();
    await page.getByLabel("Mensagem para Ravi").fill("Quero revisar o relatório de hoje.");unknownSend=true;
    await page.getByRole("button",{name:"Enviar",exact:true}).click();
    await page.getByRole("button",{name:"Verificar tentativa"}).waitFor();
    expect(await page.getByLabel("Mensagem para Ravi").inputValue()).toBe("Quero revisar o relatório de hoje.");
    await page.getByRole("button",{name:"Verificar tentativa"}).click();
    await page.getByRole("button",{name:"Cancelar execução"}).waitFor();expect(sent).toHaveLength(2);expect(sent[0]).toBe(sent[1]);
    await page.getByRole("button",{name:"Cancelar execução"}).click();
    await page.getByText("Execução cancelada",{exact:true}).waitFor();
    snapshot={...snapshot,turn:{id:randomUUID(),status:"awaiting_approval",cancelRequested:false},messages:[...snapshot.messages,{id:randomUUID(),role:"assistant",text:"Preparei a ação e preciso da sua decisão para continuar.",turnId:"fixture-turn",createdAt:Date.now()}]};
    snapshot.approvals=[{id:randomUUID(),turnId:snapshot.turn!.id,capability:{permission:"execute",objectType:"executable",objectId:"printf"},description:"printf BRIDGE_APPROVAL_OK",actionDigest:"a".repeat(64),version:1,state:"pending",expiresAt:Date.now()+300000}];
    await page.getByRole("button",{name:/Revisão do relatório/}).click();
    await page.getByRole("button",{name:"Aprovar esta ação"}).waitFor();
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});await page.screenshot({path:join(root,`bridge-approval-${width}.png`),fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      expect(await page.getByRole("button",{name:"Aprovar esta ação"}).isVisible()).toBe(true);
    }
    await page.getByRole("button",{name:"Aprovar esta ação"}).click();await page.getByText("Aprovada",{exact:true}).waitFor();
    await page.screenshot({path:join(root,"bridge-completed-390.png"),fullPage:true});
    accessDenied=true;await page.getByRole("button",{name:"← Conversas",exact:true}).click();
    await page.getByRole("button",{name:/Revisão do relatório/}).click();await page.getByRole("alert").filter({hasText:"Seu acesso atual"}).waitFor();
    expect(await page.getByText("Quero revisar o relatório de hoje.",{exact:true}).count()).toBe(0);
    expect(pageErrors).toEqual([]);expect(failedAssets).toEqual([]);
    console.log(JSON.stringify({result:"PASS",kind:"bridge-rendered-flow-fixture",root,realModel:false,realBridgeBroker:false,checked:["desktop","mobile","load-retry","same-request-retry","cancel","approval","reconnect-state"]}));
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
