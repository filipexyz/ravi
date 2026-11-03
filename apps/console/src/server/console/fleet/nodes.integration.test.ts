import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeManagementService } from "./nodes";
import { FileNodeCertificateIssuer } from "./node-pki";
import { createNodeAuthority } from "./node-pki-setup";
import { initialPolicy, policyDigest } from "../authorization/policy";
import { generateNodeKey, writePrivateJson, readFleetIdentity } from "../../../../../../src/fleet/identity";
import { FleetJournal } from "../../../../../../src/fleet/journal";
import { nodeRequest, runFleetConnection } from "../../../../../../src/fleet/client";
import { fork } from "node:child_process";
import { resolve } from "node:path";
import type { FleetActor } from "./contract";
const database = process.env.RAVI_FLEET_TEST_DATABASE;
const enabled = !!database && /^postgresql:\/\/unified_test@127\.0\.0\.1:\d+\/unified_test$/.test(database);
const suite = enabled ? describe : describe.skip, uuid = () => crypto.randomUUID();
suite("outbound Fleet on disposable PostgreSQL and actual TLS", () => {
  const sql = enabled ? postgres(database!, { max: 5 }) : null!;
  const organizationId = uuid(), userId = uuid(), sessionId = uuid(), authId = uuid();
  const actor: FleetActor = { organizationId, userId, sessionId, mode: "oidc", role: "owner" };
  let directory: string, service: NodeManagementService, authority: Awaited<ReturnType<typeof createNodeAuthority>>;
  let oldCa: string | undefined, oldKey: string | undefined;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ravi-fleet-pki-test-")); authority = await createNodeAuthority("localhost");
    await writeFile(join(directory, "ca.pem"), authority.ca, { mode: 0o600 });
    await writeFile(join(directory, "key.pem"), authority.caKey, { mode: 0o600 });
    await writeFile(join(directory, "server.pem"), authority.certificate, { mode: 0o600 });
    await writeFile(join(directory, "server-key.pem"), authority.key, { mode: 0o600 });
    const build = await Bun.build({ entrypoints: [resolve('scripts/fleet-transport.ts')], outdir: directory, naming: 'transport.mjs', target: 'node', format: 'esm' });
    if (!build.success) throw new Error(build.logs.map(String).join('\n'));
    oldCa = process.env.RAVI_FLEET_CA_CERT_FILE; oldKey = process.env.RAVI_FLEET_CA_KEY_FILE;
    process.env.RAVI_FLEET_CA_CERT_FILE = join(directory, "ca.pem"); process.env.RAVI_FLEET_CA_KEY_FILE = join(directory, "key.pem");
    await sql`insert into organizations(id,slug,name) values(${organizationId},${`test-${organizationId}`},'Synthetic')`;
    await sql`insert into users(id,primary_email) values(${userId},${`${userId}@test.invalid`})`;
    await sql`insert into organization_memberships(organization_id,user_id,role) values(${organizationId},${userId},'owner')`;
    await sql`insert into auth_identities(id,provider,provider_user_id,user_id) values(${authId},'oidc:test',${userId},${userId})`;
    await sql`insert into console_browser_sessions(id,token_hash,auth_identity_id,user_id,organization_id,expires_at)
      values(${sessionId},${uuid()},${authId},${userId},${organizationId},clock_timestamp()+interval '1 hour')`;
    const document = initialPolicy(organizationId, userId);
    document.organizationRules = [{ id: 'fleet-management', effect: 'allow', principals: [{ kind: 'user', id: userId }], actions:
      ['organization.installations.read','organization.installations.manage','organization.onboarding.read','organization.onboarding.manage'] }];
    const revision = uuid();
    await sql`insert into authorization_policy_revisions(id,organization_id,document,digest,created_by,reason)
      values(${revision},${organizationId},${sql.json(document)}::jsonb,${policyDigest(document)},${userId},'Synthetic Fleet acceptance')`;
    await sql`insert into authorization_policy_heads(organization_id,active_revision_id,generation) values(${organizationId},${revision},1)`;
    drizzle(sql); // Match the Next API's shared driver; TLS child uses plain postgres-js.
    service = new NodeManagementService(sql, organizationId, new FileNodeCertificateIssuer(), { console: 'https://console.test.invalid', transport: 'https://localhost:7443' });
  });
  afterAll(async () => {
    if (oldCa === undefined) delete process.env.RAVI_FLEET_CA_CERT_FILE; else process.env.RAVI_FLEET_CA_CERT_FILE = oldCa;
    if (oldKey === undefined) delete process.env.RAVI_FLEET_CA_KEY_FILE; else process.env.RAVI_FLEET_CA_KEY_FILE = oldKey;
    await sql.end(); if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function associate(name = 'Synthetic executor') {
    const key = await generateNodeKey(), challenge = uuid().replaceAll('-', '') + uuid().replaceAll('-', '');
    const request = { name, platform: 'test', csr: key.csr, challenge };
    const started = await service.startAssociation(request);
    expect(started.verificationUrl).toContain(`/test-${organizationId}/installations/associate#`);
    const approval = { operationId: uuid(), associationId: started.associationId, challenge, fingerprint: started.fingerprint, name: `${name} approved` };
    const installation = await service.approve(actor, approval);
    expect(await service.approve(actor, approval)).toEqual(installation);
    expect((await service.startAssociation(request)).associationId).toBe(started.associationId);
    const result = await service.pollAssociation({ associationId: started.associationId, challenge });
    if (result.status !== 'approved' || !('certificate' in result)) throw new Error('Association was not approved');
    const [credential] = await sql`select fingerprint from fleet_node_credentials where installation_id=${installation.id} and revoked_at is null`;
    return { installation, fingerprint: credential!.fingerprint as string, identity: { ...key, certificate: result.certificate!, ca: result.ca!,
      installationId: installation.id, organizationId, consoleUrl: 'https://console.test.invalid', transportUrl: 'https://localhost:7443', expiresAt: result.expiresAt! } };
  }
  test("human session and membership are required even with the owner role", async () => {
    await expect(service.list({ ...actor, sessionId: undefined })).rejects.toMatchObject({ status: 401 });
    await expect(service.list({ ...actor, sessionId: uuid() })).rejects.toMatchObject({ status: 401 });
    await expect(service.list({ ...actor, mode: 'installation' })).rejects.toMatchObject({ status: 403 });
    await sql`update organization_memberships set status='removed' where organization_id=${organizationId} and user_id=${userId}`;
    await expect(service.list(actor)).rejects.toMatchObject({ status: 403 });
    await sql`update organization_memberships set status='active' where organization_id=${organizationId} and user_id=${userId}`;
  });
  test("association, real mTLS stream, durable receipt, onboarding and revocation", async () => {
    const node = await associate();
    const child = fork(join(directory, 'transport.mjs'), [], { execPath: 'node', silent: true, env: { ...process.env,
      DATABASE_URL: database!, RAVI_SINGLE_TENANT_ORGANIZATION_ID: organizationId, NEXT_PUBLIC_CONSOLE_URL: 'https://console.test.invalid',
      RAVI_FLEET_TRANSPORT_ORIGIN: 'https://localhost:7443', RAVI_FLEET_PORT: '0',
      RAVI_FLEET_TLS_CERT_FILE: join(directory, 'server.pem'), RAVI_FLEET_TLS_KEY_FILE: join(directory, 'server-key.pem') } });
    let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', value => resolve((value as { port: number }).port));
      child.once('exit', code => reject(new Error(`Transport exited ${code}: ${stderr}`)));
    });
    const identity = { ...node.identity, transportUrl: `https://localhost:${port}` };
    const abort = new AbortController(), journal = new FleetJournal(join(directory, 'journal.sqlite'));
    try {
      const input = { operationId: uuid(), installationId: node.installation.id, command: { kind: 'health' as const } };
      expect((await service.enqueue(actor, input)).status).toBe('queued');
      expect((await service.enqueue(actor, input)).id).toBe(input.operationId);
      const response = await nodeRequest(identity, '/commands', undefined, abort.signal); expect(response.status).toBe(200);
      const reader = response.body!.getReader(); let text = '';
      while (!text.includes('event: command')) { const chunk = await reader.read(); if (chunk.done) throw new Error('No command'); text += new TextDecoder().decode(chunk.value); }
      const wire = text.split('\n\n').find(part => part.startsWith('event: command'))!;
      const envelope = JSON.parse(wire.split('\n').find(line => line.startsWith('data: '))!.slice(6));
      let effects = 0;
      const receipt = await journal.execute(envelope, identity, async () => { effects++; return { kind: 'health', health: { version: 'test', platform: 'test', channels: [] } }; });
      const acknowledgement = await nodeRequest(identity, '/receipts', receipt); expect(acknowledgement.status).toBe(200); await acknowledgement.arrayBuffer();
      expect(await service.receipt(node.fingerprint, receipt)).toEqual({ accepted: true }); expect(effects).toBe(1);
      const state = await service.state(actor); expect(state.ready).toBe(true);
      expect((await service.finish(actor, { operationId: uuid(), snapshot: state.snapshot })).completed).toBe(true);
      expect((await service.showOperation(actor, input.operationId)).status).toBe('succeeded');
      const revoke = { operationId: uuid(), installationId: node.installation.id, expectedRevision: 1 };
      expect((await service.revoke(actor, revoke)).status).toBe('revoked'); expect((await service.revoke(actor, revoke)).status).toBe('revoked');
      await expect(service.heartbeat(node.fingerprint)).rejects.toMatchObject({ status: 403 });
      await expect(service.enqueue(actor, { ...input, operationId: uuid() })).rejects.toMatchObject({ status: 409 }); await reader.cancel();
    } finally { abort.abort(); journal.close(); child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
  }, 15000);
  test("lost rotation response can be recovered but not after revocation", async () => {
    const node = await associate('Rotation'), nextKey = await generateNodeKey(), input = { operationId: uuid(), csr: nextKey.csr };
    const first = await service.rotate(node.fingerprint, input); expect(await service.rotate(node.fingerprint, input)).toEqual(first);
    await expect(service.heartbeat(node.fingerprint)).rejects.toMatchObject({ status: 403 });
    await expect(service.rotate(node.fingerprint, { ...input, csr: (await generateNodeKey()).csr })).rejects.toMatchObject({ status: 409 });
    await service.revoke(actor, { operationId: uuid(), installationId: node.installation.id, expectedRevision: 1 });
    await expect(service.rotate(node.fingerprint, input)).rejects.toMatchObject({ status: 403 });
  });
  test("another installation cannot consume or acknowledge this installation's command", async () => {
    const first = await associate('First'), second = await associate('Second');
    const input = { operationId: uuid(), installationId: first.installation.id, command: { kind: 'health' as const } };
    await service.enqueue(actor, input);
    expect(await service.nextCommand(second.fingerprint)).toBeNull();
    const delivered = await service.nextCommand(first.fingerprint);
    expect(delivered?.installationId).toBe(first.installation.id);
    await expect(service.receipt(second.fingerprint, { operationId: input.operationId, digest: delivered!.digest,
      status: 'succeeded', result: { kind: 'health', health: { version: 'test', platform: 'test', channels: [] } }, error: null })).rejects.toMatchObject({ status: 409 });
    await expect(service.enqueue(actor, { ...input, installationId: second.installation.id })).rejects.toMatchObject({ status: 409 });
    const replay = await service.nextCommand(first.fingerprint); expect(replay).toEqual(delivered);
  });
  test("revoked human session cancels queued work", async () => {
    const node = await associate('Session test'), input = { operationId: uuid(), installationId: node.installation.id, command: { kind: 'health' as const } };
    await service.enqueue(actor, input); await sql`update console_browser_sessions set revoked_at=clock_timestamp() where id=${sessionId}`;
    expect(await service.nextCommand(node.fingerprint)).toBeNull();
    const [operation] = await sql`select state from fleet_node_operations where id=${input.operationId}`; expect(operation!.state).toBe('cancelled');
    await sql`update console_browser_sessions set revoked_at=null where id=${sessionId}`;
  });
  test("a native bot has one owner and uncertain configuration cannot be duplicated", async () => {
    const first = await associate('Channel owner'), second = await associate('Other executor');
    const command = { kind: 'channel.configure' as const, provider: 'slack' as const, name: 'test-slack', credentialConnection: 'synthetic-broker-reference', enabled: true,
      identity: { teamId: 'TSYNTHETIC', botUserId: 'USYNTHETIC' } };
    const input = { installationId: first.installation.id, operationId: uuid(), command };
    expect((await service.enqueue(actor,input)).status).toBe('queued');
    expect((await service.enqueue(actor,input)).id).toBe(input.operationId);
    await expect(service.enqueue(actor,{...input,operationId:uuid(),installationId:second.installation.id})).rejects.toMatchObject({code:'channel_owner_conflict'});
    await expect(service.enqueue(actor,{...input,operationId:uuid()})).rejects.toMatchObject({code:'channel_operation_pending'});
    const delivered = await service.nextCommand(first.fingerprint);
    await expect(service.receipt(first.fingerprint,{operationId:input.operationId,digest:delivered!.digest,status:'succeeded',error:null,
      result:{kind:'channel.configure',channel:{name:'wrong-name',provider:'slack',credentialConnection:command.credentialConnection,enabled:true}}})).rejects.toMatchObject({code:'invalid_receipt'});
    await service.receipt(first.fingerprint,{operationId:input.operationId,digest:delivered!.digest,status:'uncertain',result:null,error:'result_unknown'});
    await expect(service.enqueue(actor,{...input,operationId:uuid(),command:{...command,enabled:false}})).rejects.toMatchObject({code:'channel_operation_pending'});
    expect((await service.channels(actor)).channels.find(c => c.operationId === input.operationId)?.status).toBe('uncertain');
    await expect(service.channels({...actor,mode:'installation'})).rejects.toMatchObject({status:403});
  });
  test("outbound loop reconciles a stored result after human revocation without reexecuting", async () => {
    const node = await associate('Receipt recovery');
    const child = fork(join(directory,'transport.mjs'),[],{execPath:'node',silent:true,env:{...process.env,
      DATABASE_URL:database!,RAVI_SINGLE_TENANT_ORGANIZATION_ID:organizationId,NEXT_PUBLIC_CONSOLE_URL:'https://console.test.invalid',
      RAVI_FLEET_TRANSPORT_ORIGIN:'https://localhost:7443',RAVI_FLEET_PORT:'0',RAVI_FLEET_TLS_CERT_FILE:join(directory,'server.pem'),RAVI_FLEET_TLS_KEY_FILE:join(directory,'server-key.pem')}});
    const port = await new Promise<number>((resolve,reject)=>{child.once('message',value=>resolve((value as {port:number}).port));child.once('exit',()=>reject(new Error('Transport exited')));});
    const ownDirectory = join(directory,'recovering-node');
    const {csr: _csr,...identity} = node.identity;
    await writePrivateJson('identity.json',{...identity,transportUrl:`https://localhost:${port}`},ownDirectory);
    expect(await readFleetIdentity(ownDirectory)).toEqual({...identity,transportUrl:`https://localhost:${port}`});
    const input={installationId:node.installation.id,operationId:uuid(),command:{kind:'health' as const}};
    await service.enqueue(actor,input);const delivered=await service.nextCommand(node.fingerprint);
    const journal=new FleetJournal(join(ownDirectory,'receipts.sqlite'));
    await journal.execute(delivered,identity,async()=>({kind:'health',health:{version:'test',platform:'test',channels:[]}}));
    expect(journal.pending(identity.installationId)[0]?.status).toBe('succeeded');journal.close();
    await sql`update console_browser_sessions set revoked_at=clock_timestamp() where id=${sessionId}`;
    expect(await service.nextCommand(node.fingerprint)).toBeNull();
    const controller=new AbortController();let executions=0;
    const errors: string[]=[], states: string[]=[];
    const connection=runFleetConnection({directory:ownDirectory,signal:controller.signal,onState:state=>states.push(state),onError:error=>{errors.push(error instanceof Error ? error.message : String(error));},execute:async()=>{executions++;throw new Error('Stored result must not execute again');}});
    try {
      let state='';for(let n=0;n<50;n++){const [row]=await sql`select state from fleet_node_operations where id=${input.operationId}`;state=row!.state;if(state==='succeeded')break;await Bun.sleep(100);}
      expect(errors).toEqual([]);expect(states).not.toContain('revoked');expect(state).toBe('succeeded');expect(executions).toBe(0);
    } finally {
      controller.abort();await connection;
      await sql`update console_browser_sessions set revoked_at=null where id=${sessionId}`;
      const stopped = new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await stopped;
    }
  },15000);
});
