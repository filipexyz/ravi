import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { importSPKI, jwtVerify, type JWTPayload } from "jose";
import { installFixturePolicy, fixturePolicy } from "./authorization-fixture";
import type { FleetActor } from "../../src/server/console/fleet/contract";
import type { GatewayHttpCall, DelegateGateway } from "../../src/server/console/fleet/gateway-ssh";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const sql = socket
  ? postgres({
      host: socket,
      port: 55439,
      database: "fleet_gateway_backend",
      username: "fleettest",
      max: 4,
      onnotice() {},
    })
  : null;
const admin = socket
  ? postgres({
      host: socket,
      port: 55439,
      database: "postgres",
      username: "fleettest",
      max: 1,
      onnotice() {},
    })
  : null;
const org = randomUUID(),
  user = randomUUID(),
  project = randomUUID(),
  install = randomUUID(),
  credential = randomUUID();
const actor: FleetActor = {
  organizationId: org,
  userId: user,
  sessionId: randomUUID(),
  mode: "oidc",
  role: "owner",
};
const signing = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const binding = {
  organizationId: org,
  installationId: install,
  installationRevision: 1,
  credentialRevision: 1,
  enrollmentId: randomUUID(),
  runtimeId: randomUUID(),
  runtimePublicKey: signing.publicKey,
  issuer: "https://console.invalid",
  issuerKeyId: "fixture",
  signingKeyRef: { credentialId: randomUUID(), version: 1 },
  epoch: 1,
  active: true,
};
const policy = fixturePolicy(org, user);
policy.bridgeAgents = [{ installationId: install, projectId: project, agentIds: ["main"] }];
policy.bridgeRules = [];
policy.rules = [
  {
    id: "private-session",
    effect: "allow",
    principals: [{ kind: "user", id: user }],
    projects: [project],
    actions: ["bridge.conversations.read", "bridge.conversations.send"],
  },
];
let directory = "",
  delegates = 0,
  received: JWTPayload;
let beforeDelegate = async () => {};
let beforeSignerRead = async () => {};
let remoteResponse = () => Response.json({ accepted: true });
let request: typeof import("../../src/server/console/fleet/gateway").gatewayRequest;
if (sql) {
  mock.module("../../src/server/db", () => ({ dbClient: sql }));
  mock.module("../../src/server/console/fleet/vault", () => ({
    vaultConfig: () => ({}),
    Kv2Vault: class {
      async read(ref: { credentialId: string }) {
        if (ref.credentialId === binding.signingKeyRef.credentialId) await beforeSignerRead();
        return signing.privateKey;
      }
    },
  }));
  mock.module("../../src/server/console/fleet/gateway-ssh", () => ({
    gatewayOverSsh: async (
      _installation: unknown,
      _key: unknown,
      _binding: unknown,
      call: GatewayHttpCall,
      delegate: DelegateGateway,
    ) => {
      await beforeDelegate();
      const configure = call.path.endsWith("set-display");
      const team = call.path.endsWith("team-create");
      const command = {
        fullName: team ? "sessions.conversations.team-create" : configure ? "sessions.set-display" : "sessions.conversations.send",
        path: call.path,
        scope: "resource",
        access: {
          kind: "mutate" as const,
          resource: configure ? "sessions" : "sessions.conversations",
          action: team ? "team-create" : configure ? "set-display" : "send",
          consoleScope: team ? "project" as const : "session" as const,
          resourceId: configure ? "nameOrKey" : "conversationId",
        },
      };
      const token = await delegate(
        {
          protocol: "ravi-console-gateway/1",
          runtimeId: binding.runtimeId,
          connectionId: randomUUID(),
          proof: "verified-by-transport-fixture",
          registry: { commands: [command] },
          registryDigest: "a".repeat(64),
        },
        call,
      );
      received = (
        await jwtVerify(token, await importSPKI(signing.publicKey, "EdDSA"), {
          issuer: binding.issuer,
          audience: `ravi:${binding.runtimeId}:gateway:v1`,
        })
      ).payload;
      delegates++;
      return remoteResponse();
    },
  }));
}
beforeAll(async () => {
  if (!sql || !admin) return;
  await admin`create database fleet_gateway_backend`;
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  await sql`insert into organizations(id,name,slug,status) values(${org},'Fixture',${org},'active')`;
  await sql`insert into users(id,primary_email,display_name,status) values(${user},${`${user}@example.invalid`},'Fixture','active')`;
  await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'owner','active')`;
  await sql`insert into projects(id,organization_id,slug,name) values(${project},${org},'fixture','Fixture')`;
  const identity = randomUUID();
  await sql`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identity},'oidc:https://idp.invalid',${user},${user},'fixture@example.invalid')`;
  await sql`insert into console_browser_sessions(id,token_hash,auth_identity_id,user_id,organization_id,expires_at) values(${actor.sessionId!},${randomUUID()},${identity},${user},${org},now()+interval '1 hour')`;
  await sql`insert into fleet_credentials(id,organization_id,label,kind,revision,secret_version,status) values(${credential},${org},'Fixture','ssh_private_key',1,1,'active')`;
  await sql`insert into fleet_installations(id,organization_id,label,hostname,port,username,host_fingerprint,credential_id,revision,status) values(${install},${org},'Fixture','100.64.0.1',22,'fixture',${`SHA256:${"a".repeat(43)}`},${credential},1,'active')`;
  await installFixturePolicy(sql, user, policy);
  directory = await mkdtemp(join(tmpdir(), "gateway-binding-test-"));
  const file = join(directory, "bindings.json");
  await writeFile(file, JSON.stringify([binding]), { mode: 0o600 });
  Object.assign(process.env, {
    RAVI_BRIDGE_BINDINGS_FILE: file,
    NEXT_PUBLIC_CONSOLE_URL: binding.issuer,
    RAVI_AUTH_SECRET: "synthetic-secret".repeat(4),
    RAVI_SINGLE_TENANT_ORGANIZATION_ID: org,
  });
  request = (await import("../../src/server/console/fleet/gateway")).gatewayRequest;
}, 60000);
afterAll(async () => {
  await sql?.end();
  await admin?.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const input = () => ({
  installationId: install,
  projectId: project,
  operationId: randomUUID(),
  createdAt: Date.now(),
  command: "sessions.conversations.send",
  input: { conversationId: randomUUID(), text: "private fixture", expectedVersion: 0 },
});
integration(
  "backend uses current DB authority, signs a distinct principal, and preserves uncertain delivery",
  async () => {
    const value = input();
    expect((await request(actor, value)).status).toBe(200);
    expect(received!).toMatchObject({
      sub: user,
      origin: { kind: "browser", sessionId: actor.sessionId },
      agents: [{ id: "main", capabilities: [], approvalCapabilities: [] }],
      scope: { kind: "session", conversationId: value.input.conversationId },
    });
    expect(received!.exp! - received!.iat!).toBe(30);
    const audits =
      await sql!`select actor_id,metadata from authorization_audit where request_id=${value.operationId}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]!).toMatchObject({ actor_id: user, metadata: { allowed: true } });
    expect(JSON.stringify(audits)).not.toContain("private fixture");
    expect(
      (await sql!`select state from fleet_gateway_deliveries where operation_id=${value.operationId}`)[0]!
        .state,
    ).toBe("acknowledged");
    remoteResponse = () =>
      Response.json({ error: { code: "EXECUTION_UNKNOWN", effectState: "unknown" } }, { status: 422 });
    const uncertain = input();
    expect(await (await request(actor, uncertain)).json()).toMatchObject({ effectState: "unknown" });
    expect(
      (await sql!`select state from fleet_gateway_deliveries where operation_id=${uncertain.operationId}`)[0]!
        .state,
    ).toBe("pending");
  },
);
integration("team creation checks current member policy and rechecks the roster after signer I/O",async()=>{
  remoteResponse=()=>Response.json({accepted:true});
  const member=randomUUID();
  await sql!`insert into users(id,primary_email,display_name,status) values(${member},${`${member}@example.invalid`},'Team member','active')`;
  await sql!`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${member},'developer','active')`;
  const teamPolicy=structuredClone(policy);
  teamPolicy.bridgeAgents![0]!.agentIds=["main","dev"];
  teamPolicy.rules.push({id:"team-members",effect:"allow",principals:[{kind:"user",id:member}],projects:[project],actions:["bridge.conversations.read"]});
  teamPolicy.rules[0]!.actions.push("project.write");
  await installFixturePolicy(sql!,user,teamPolicy);
  const value={...input(),command:"sessions.conversations.team-create",input:{title:"Team fixture",agentIds:["main","dev"],personIds:[member]}};
  expect((await request(actor,value)).status).toBe(200);
  expect(received!).toMatchObject({sub:user,scope:{kind:"project"},teamParticipants:expect.arrayContaining([{id:user,name:"Fixture"},{id:member,name:"Team member"}])});
  const before=delegates;
  beforeSignerRead=async()=>{await sql!`update organization_memberships set status='suspended' where organization_id=${org} and user_id=${member}`;};
  await expect(request(actor,{...value,operationId:randomUUID()})).rejects.toThrow("team_member_unavailable");
  expect(delegates).toBe(before);
  beforeSignerRead=async()=>{};
  await installFixturePolicy(sql!,user,policy);
});
integration(
  "backend rechecks after transport proof; owner role and old session cannot bypass revocation",
  async () => {
    const before = delegates;
    const configure = {
      ...input(),
      command: "sessions.set-display",
      input: { nameOrKey: randomUUID(), displayName: "Fixture" },
    };
    await expect(request(actor, configure)).rejects.toThrow("gateway_access_denied");
    expect(delegates).toBe(before);
    beforeDelegate = async () => {
      await sql!`update console_browser_sessions set revoked_at=now() where id=${actor.sessionId!}`;
    };
    await expect(request(actor, input())).rejects.toThrow("auth_required");
    expect(delegates).toBe(before);
    beforeDelegate = async () => {};
    await expect(request(actor, input())).rejects.toThrow("auth_required");
  },
);
