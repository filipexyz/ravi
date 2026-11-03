import { mkdtemp, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { chromium } from 'playwright';
import { oidcProviderFixture } from './oidc-provider-fixture';
import { browserBinary, node24Binary } from './binaries';
import { issueBootstrap } from '../../src/server/console/fleet/bootstrap';
import { NodeManagementService } from '../../src/server/console/fleet/nodes';
import { FileNodeCertificateIssuer } from '../../src/server/console/fleet/node-pki';
import { initializeNodeAuthority } from '../../src/server/console/fleet/node-pki-setup';
import { generateNodeKey } from '../../../../src/fleet/identity';
import { FleetJournal } from '../../../../src/fleet/journal';

const database = process.env.RAVI_FLEET_TEST_DATABASE;
if (!database || !/^postgresql:\/\/unified_test@127\.0\.0\.1:\d+\/unified_test$/.test(database)) throw new Error('Disposable database required');
for (const name of ['.env','.env.local','.env.development','.env.development.local']) if (await lstat(name).then(() => true, () => false)) throw new Error('Refusing inherited environment file');
const admin = postgres(database, { max: 1 });
const databaseName = `unified_browser_${randomUUID().replaceAll('-', '')}`;
await admin.unsafe(`CREATE DATABASE ${databaseName}`); await admin.end();
const browserDatabase = new URL(database); browserDatabase.pathname = '/' + databaseName;
const sql = postgres(browserDatabase.href, { max: 4, onnotice() {} });
await migrate(drizzle(sql), { migrationsFolder: 'drizzle' });
const root = await mkdtemp(join(tmpdir(), 'ravi-unified-browser-'));
await writeFile('/tmp/oss-console-browser-path', root);
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }), port = reservation.port!; reservation.stop(true);
const origin = `https://127.0.0.1:${port}`, fixture = await oidcProviderFixture({ callbackOrigin: origin, interceptFetch: false });
const organizationId = randomUUID(), slug = `browser-${organizationId.slice(0,8)}`;
const token = await issueBootstrap(sql, { organizationId, name: 'Ravi Teste', slug, email: 'owner@example.invalid' });
const secretFile = join(root, 'oidc-secret'); await writeFile(secretFile, fixture.clientSecret, { mode: 0o600 });
const authority = join(root, 'authority'); await initializeNodeAuthority(authority, 'localhost');
process.env.RAVI_FLEET_CA_CERT_FILE = join(authority, 'ca.pem'); process.env.RAVI_FLEET_CA_KEY_FILE = join(authority, 'ca-key.pem');
const env = { PATH: process.env.PATH!, LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  DATABASE_URL: browserDatabase.href, RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: 'true', RAVI_AUTH_MODE: 'oidc', RAVI_PAGES_AI_ENABLED: '0',
  RAVI_SINGLE_TENANT_ORGANIZATION_ID: organizationId, RAVI_AUTH_SECRET: randomBytes(32).toString('base64url'), NEXT_PUBLIC_CONSOLE_URL: origin,
  RAVI_OIDC_ISSUER: fixture.origin, RAVI_OIDC_CLIENT_ID: 'local-fleet', RAVI_OIDC_CLIENT_SECRET_FILE: secretFile,
  NODE_EXTRA_CA_CERTS: fixture.certPath, FLEET_BROWSER_PORT: String(port), FLEET_BROWSER_TLS_KEY: fixture.keyPath, FLEET_BROWSER_TLS_CERT: fixture.certPath,
  RAVI_FLEET_CA_CERT_FILE: process.env.RAVI_FLEET_CA_CERT_FILE!, RAVI_FLEET_CA_KEY_FILE: process.env.RAVI_FLEET_CA_KEY_FILE!, RAVI_FLEET_TRANSPORT_ORIGIN: 'https://localhost:7443' };
const log = Bun.file(join(root, 'next.log')).writer();
const child = Bun.spawn([await node24Binary(), resolve('tests/fleet/unified-next-fixture-server.ts')], { env, stdout: 'pipe', stderr: 'pipe' });
let ready = false; const drains = [child.stdout,child.stderr].map(async stream => { const reader = stream.getReader(); for (;;) { const result = await reader.read(); if (result.done) break; const text = new TextDecoder().decode(result.value); if (text.includes('UNIFIED_NEXT_READY')) ready = true; log.write(text); } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [], auditFailures: string[] = [];
let observedPage: import('playwright').Page | undefined;
try {
  for (let n=0;n<240;n++) { if (ready) break; if (child.exitCode !== null) throw new Error('Next stopped before ready'); await Bun.sleep(250); }
  if (!ready) throw new Error('Next did not become ready');
  browser = await chromium.launch({ executablePath: browserBinary(), headless: true, chromiumSandbox: true, args: [`--ignore-certificate-errors-spki-list=${fixture.spki}`] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(45000); observedPage = page;
  page.on('pageerror', e => { errors.push(e.message); console.log('Browser error:', e.message); });
  page.on('response', async response => { const path = new URL(response.url()).pathname; if (path.startsWith('/api/console/') && response.status() >= 400) { const body = await response.json().catch(() => ({})); console.log('API failure:', response.status(), path, typeof body.error === 'string' ? body.error : body.error?.code); } });
  await page.route('**/*', route => [origin,fixture.origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/setup#setup=${token}`);
  for (const width of [1440,390]) { await page.setViewportSize({width,height:1000}); await page.screenshot({path:join(root, `setup-link-${width}.png`),fullPage:true}); }
  await page.getByRole('button', { name: 'Continuar para o login' }).click();
  await page.getByLabel('Email', { exact: true }).fill('owner@example.invalid'); await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Conclua sua instalação', exact: true }).waitFor({ timeout: 60000 }); console.log('Bootstrap and human login passed');
  async function capture(name: string) { for (const theme of ['light','dark']) for (const width of [1440,390]) { await page.evaluate(theme => { document.documentElement.dataset.rvTheme = theme; }, theme); await page.setViewportSize({ width, height: 1000 }); await page.screenshot({ path: join(root, `${name}-${width}-${theme}.png`), fullPage: true }); if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow ${name}-${width}`);
    await page.addScriptTag({ content: await Bun.file(require.resolve('axe-core/axe.min.js')).text() });
    const audit = await page.evaluate(async () => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa'] } }));
    await writeFile(join(root, `${name}-${width}-${theme}-a11y.json`), JSON.stringify(audit.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.target) })), null, 2));
    if (audit.violations.some((v: any) => ['critical','serious'].includes(v.impact))) auditFailures.push(`${name}-${width}-${theme}`); } }
  await capture('onboarding');
  const service = new NodeManagementService(sql, organizationId, new FileNodeCertificateIssuer(), { console: origin, transport: 'https://localhost:7443' });
  const nodeKey = await generateNodeKey(), challenge = randomBytes(32).toString('hex');
  const request = await service.startAssociation({ name: 'Ravi de teste', platform: 'Linux · ambiente isolado', csr: nodeKey.csr, challenge });
  await page.goto(request.verificationUrl); await page.getByRole('button', { name: 'Associar esta instalação', exact: true }).waitFor(); await capture('association');
  await page.getByRole('button', { name: 'Associar esta instalação', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByText('Instalação associada', { exact: true }).waitFor();
  const result = await service.pollAssociation({ associationId: request.associationId, challenge });
  if (!('installationId' in result)) throw new Error('Association not completed');
  const [credential] = await sql`select fingerprint from fleet_node_credentials where installation_id=${result.installationId!} and revoked_at is null`;
  await service.heartbeat(credential!.fingerprint);
  await page.goto(`${origin}/${slug}/onboarding`); await page.getByRole('button', { name: 'Verificar instalação' }).click();
  let envelope; for (let n=0;n<20;n++) { envelope = await service.nextCommand(credential!.fingerprint); if (envelope) break; await Bun.sleep(200); }
  if (!envelope) throw new Error('Test operation not queued');
  const journal = new FleetJournal(join(root, 'receipts.sqlite'));
  const receipt = await journal.execute(envelope, { organizationId, installationId: result.installationId! }, async () => ({ kind: 'health', health: { version: 'acceptance', platform: 'test', channels: [] } })); journal.close();
  await service.receipt(credential!.fingerprint, receipt);
  await page.getByRole('button', { name: 'Concluir instalação', exact: true }).click();
  await page.getByText('Instalação concluída', { exact: true }).waitFor(); await capture('completed');
  await page.getByRole('link', { name: 'Gerenciar instalações', exact: true }).click(); await page.getByRole('heading', { name: 'Instalações Ravi', exact: true }).waitFor(); await page.getByText('Instalação verificada', { exact: true }).waitFor(); await capture('managed');
  await page.getByRole('button', {name:'Configurar canais',exact:true}).click();
  await page.getByRole('button', {name:'Consultar conexões disponíveis'}).click();
  let inspect; for (let n=0;n<30;n++) { inspect = await service.nextCommand(credential!.fingerprint); if(inspect) break; await Bun.sleep(200); }
  if (inspect?.command.kind !== 'channels.inspect') throw new Error('Inspection not queued');
  const channelsJournal = new FleetJournal(join(root,'channel-receipts.sqlite'));
  const inspected = await channelsJournal.execute(inspect,{organizationId,installationId:result.installationId!},async()=>({kind:'channels.inspect',channels:[],connections:[{connection:'slack-synthetic',available:true,identity:{teamId:'TSYNTHETIC',botUserId:'USYNTHETIC'}}]}));
  await service.receipt(credential!.fingerprint,inspected);
  await page.getByRole('radio').check(); await page.getByLabel('Nome do canal no Ravi').fill('slack-test'); await capture('channel-form');
  await page.getByRole('button',{name:'Configurar canal',exact:true}).click();
  let configure; for (let n=0;n<30;n++) { configure = await service.nextCommand(credential!.fingerprint); if(configure) break; await Bun.sleep(200); }
  if(configure?.command.kind !== 'channel.configure') throw new Error('Configuration not queued');
  const configured=await channelsJournal.execute(configure,{organizationId,installationId:result.installationId!},async()=>({kind:'channel.configure',channel:{name:'slack-test',provider:'slack',credentialConnection:'slack-synthetic',enabled:true}}));
  await service.receipt(credential!.fingerprint,configured); channelsJournal.close();
  await page.getByText('Configuração confirmada',{exact:false}).waitFor(); await capture('channel-configured');
  if (await page.getByRole('link', { name: /Conversar|Conversas/ }).count()) throw new Error('Unexpected conversation navigation');
  if (auditFailures.length) throw new Error(`Accessibility violations: ${auditFailures.join(', ')}`);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(`PASS: real OIDC, browser association, SDK operation, receipt, completion and management at 1440/390. Evidence: ${root}`);
} catch(error) { await observedPage?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); console.error(`FAIL: ${String(error)}; evidence: ${root}`); process.exitCode = 1; }
finally { await browser?.close(); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); await child.exited; clearTimeout(timer); await Promise.all(drains); await log.end(); await fixture.close(); await sql.end(); }
