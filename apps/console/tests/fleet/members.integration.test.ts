import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { OrganizationMembersService } from "../../src/server/console/fleet/members";
import type { FleetActor } from "../../src/server/console/fleet/contract";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
const admin = socket ? postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} }) : null;
let sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  if (!admin) return;
  await admin`create database fleet_members_fixture`;
  sql = postgres({ host: socket, port: 55439, database: "fleet_members_fixture", username: "fleettest", max: 5, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
}, 60000);
afterAll(async () => { await sql?.end(); await admin?.end(); });

async function fixture() {
  const org = randomUUID(), user = randomUUID(), other = randomUUID();
  await sql`insert into organizations(id,name,slug) values(${org},'Members fixture',${`members-${org}`})`;
  for (const id of [user,other]) {
    await sql`insert into users(id,primary_email,display_name) values(${id},${`${id}@example.invalid`},${id===user?'Steward':'Target'})`;
    await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${id},${id===user?'billing':'owner'},'active')`;
    const [identity] = await sql`insert into auth_identities(provider,provider_user_id,user_id,email)
      values('oidc:https://fixture.invalid',${id},${id},${`${id}@example.invalid`}) returning id`;
    await sql`insert into console_browser_sessions(token_hash,auth_identity_id,user_id,organization_id,expires_at)
      values(${randomUUID()},${identity!.id},${id},${org},now()+interval '1 hour')`;
  }
  const policy = fixturePolicy(org,user); await installFixturePolicy(sql,user,policy);
  const actor: FleetActor = { mode:"oidc",organizationId:org,userId:user,role:"billing" };
  const service = new OrganizationMembersService(sql,org);
  const member = async (id=other) => (await service.list(actor)).members.find(m=>m.userId===id)!;
  const input = async (id=other, status: "active"|"suspended"|"removed"="suspended") => ({ userId:id,status,operationId:randomUUID(),expectedVersion:(await member(id)).version });
  return {org,user,other,actor,service,policy,member,input};
}

integration("directory is minimal and isolated; settings/read-only/manage-only and nominal owners do not grant mutation", async () => {
  const f=await fixture();
  const data=await f.service.list(f.actor);
  expect(Object.keys(data).sort()).toEqual(["currentUserId","members"]);
  expect(Object.keys(data.members[0]!).sort()).toEqual(["email","name","status","userId","version"]);
  const input=await f.input();
  await expect(f.service.list({...f.actor,userId:f.other,role:"owner"})).rejects.toThrow();
  await expect(f.service.change({...f.actor,userId:f.other,role:"admin"},input)).rejects.toThrow();
  await expect(f.service.list({...f.actor,organizationId:randomUUID()})).rejects.toThrow();
  f.policy.administrators=[{kind:"user",id:f.other}];
  for (const actions of [["organization.settings.read"],["organization.members.manage"],["organization.members.read"]] as const) {
    f.policy.organizationRules[0]!.actions=[...actions]; await installFixturePolicy(sql,f.user,f.policy);
    if (actions[0]==="organization.members.read") expect((await f.service.list(f.actor)).members).toHaveLength(2);
    else await expect(f.service.list(f.actor)).rejects.toThrow();
    await expect(f.service.change(f.actor,input)).rejects.toThrow();
  }
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where organization_id=${f.org}`)[0]!.n).toBe(0);
});

integration("CAS/exact retries, immutable grants, session revocation and reactivation do not revive sessions",async()=>{
  const f=await fixture(), input=await f.input();
  const head=await sql`select * from authorization_policy_heads where organization_id=${f.org}`;
  const results=await Promise.all([f.service.change(f.actor,input),f.service.change(f.actor,input)]);
  expect(results[0]).toEqual(results[1]); expect(results[0]!.member.status).toBe("suspended");
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where operation_id=${input.operationId}`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int n from audit_events where request_id=${input.operationId}`)[0]!.n).toBe(1);
  expect((await sql`select revoked_at is not null as revoked from console_browser_sessions where organization_id=${f.org} and user_id=${f.other}`)[0]!.revoked).toBe(true);
  expect((await sql`select revoked_at is null as live from console_browser_sessions where organization_id=${f.org} and user_id=${f.user}`)[0]!.live).toBe(true);
  await expect(f.service.change(f.actor,{...input,status:"removed"})).rejects.toThrow("idempotency_conflict");
  await expect(f.service.change(f.actor,{...input,operationId:randomUUID()})).rejects.toThrow("version_conflict");
  await expect(f.service.change(f.actor,{...input,role:"owner"})).rejects.toThrow("invalid_request");
  const reactivated=await f.service.change(f.actor,await f.input(f.other,"active"));
  expect(reactivated.member.status).toBe("active");
  expect((await sql`select revoked_at is not null as revoked from console_browser_sessions where organization_id=${f.org} and user_id=${f.other}`)[0]!.revoked).toBe(true);
  expect([...(await sql`select * from authorization_policy_heads where organization_id=${f.org}`)]).toEqual([...head]);
  // Revoke management; a historical receipt is not a capability.
  f.policy.organizationRules[0]!.actions=["organization.members.read","organization.authorization.read","organization.authorization.manage"];
  await installFixturePolicy(sql,f.user,f.policy);
  await expect(f.service.change(f.actor,input)).rejects.toThrow();
});

integration("last effective manager and concurrent reciprocal removals roll back effects/receipts/revocation",async()=>{
  const f=await fixture(), self=await f.input(f.user,"removed");
  await expect(f.service.change(f.actor,self)).rejects.toThrow("authorization_last_manager_required");
  expect((await f.member(f.user)).status).toBe("active");
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where operation_id=${self.operationId}`)[0]!.n).toBe(0);
  expect((await sql`select count(*)::int n from audit_events where request_id=${self.operationId}`)[0]!.n).toBe(0);
  expect((await sql`select revoked_at is null as live from console_browser_sessions where organization_id=${f.org} and user_id=${f.user}`)[0]!.live).toBe(true);
  f.policy.roles[0]!.members.push(f.other); await installFixturePolicy(sql,f.user,f.policy);
  const other=await f.input(f.other,"removed");
  const results=await Promise.allSettled([f.service.change(f.actor,other),f.service.change({...f.actor,userId:f.other},self)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect((await sql`select count(*)::int n from organization_memberships where organization_id=${f.org} and status='active'`)[0]!.n).toBe(1);
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where organization_id=${f.org}`)[0]!.n).toBe(1);
});

integration("cannot provision missing users, adopt invitation/stub or reactivate inactive identity",async()=>{
  const f=await fixture(), input=await f.input();
  await expect(f.service.change(f.actor,{...input,userId:randomUUID()})).rejects.toThrow("member_not_found");
  for(const state of ["invited","suspended"]){
    await sql`update organization_memberships set status=${state},updated_at=clock_timestamp() where organization_id=${f.org} and user_id=${f.other}`;
    if(state==="suspended") await sql`update users set status='disabled' where id=${f.other}`;
    await expect(f.service.change(f.actor,await f.input(f.other,"active"))).rejects.toThrow("member_admission_unsupported");
  }
  expect((await sql`select count(*)::int n from fleet_mutation_receipts where organization_id=${f.org}`)[0]!.n).toBe(0);
});

integration("deactivation revokes exact target Console/Pages/CLI/link admission, preserving other users and installations",async()=>{
  const f=await fixture(), project=randomUUID(),site=randomUUID(),installation=randomUUID();
  await sql`insert into projects(id,organization_id,name,slug) values(${project},${f.org},'Session fixture',${project})`;
  await sql`insert into page_sites(id,organization_id,project_id,slug,default_hostname)
    values(${site},${f.org},${project},${site},${`${site}.invalid`})`;
  await sql`insert into local_installations(id,organization_id,name) values(${installation},${f.org},'Synthetic shared installation')`;
  for(const user of [f.user,f.other]){
    await sql`insert into pages_claim_codes(code_hash,organization_id,project_id,site_id,user_id,return_url,requested_host,requested_path,expires_at)
      values(${randomUUID()},${f.org},${project},${site},${user},'https://fixture.invalid/','fixture.invalid','/',now()+interval '1 hour')`;
    await sql`insert into pages_sessions(session_token_hash,organization_id,project_id,site_id,user_id,issued_for_host,expires_at)
      values(${randomUUID()},${f.org},${project},${site},${user},'fixture.invalid',now()+interval '1 hour')`;
    await sql`insert into cli_sessions(local_installation_id,organization_id,user_id,refresh_token_hash,access_token_jti,expires_at)
      values(${installation},${f.org},${user},${randomUUID()},${randomUUID()},now()+interval '1 hour')`;
    await sql`insert into ravi_actor_bindings(installation_id,organization_id,console_user_id,contact_id,linked_by)
      values(${installation},${f.org},${user},${user},${user})`;
    await sql`insert into cli_device_authorizations(device_code_hash,user_code_hash,status,user_id,organization_id,expires_at)
      values(${randomUUID()},${randomUUID()},'approved',${user},${f.org},now()+interval '1 hour')`;
    await sql`insert into ravi_link_requests(token_hash,installation_id,organization_id,requested_by_user_id,contact_id,expires_at)
      values(${randomUUID()},${installation},${f.org},${user},${`request-${user}`},now()+interval '1 hour')`;
  }
  await f.service.change(f.actor,await f.input());
  async function states(user:string){
    return {
      pages:(await sql`select status from pages_sessions where organization_id=${f.org} and user_id=${user}`)[0]!.status,
      claim:(await sql`select status from pages_claim_codes where organization_id=${f.org} and user_id=${user}`)[0]!.status,
      cli:(await sql`select status from cli_sessions where organization_id=${f.org} and user_id=${user}`)[0]!.status,
      binding:(await sql`select status from ravi_actor_bindings where organization_id=${f.org} and console_user_id=${user}`)[0]!.status,
      device:(await sql`select status from cli_device_authorizations where organization_id=${f.org} and user_id=${user}`)[0]!.status,
      link:(await sql`select status from ravi_link_requests where organization_id=${f.org} and requested_by_user_id=${user}`)[0]!.status,
    };
  }
  const revoked={pages:"revoked",claim:"revoked",cli:"revoked",binding:"revoked",device:"denied",link:"cancelled"};
  expect(await states(f.other)).toEqual(revoked);
  expect(await states(f.user)).toEqual({pages:"active",claim:"active",cli:"active",binding:"active",device:"approved",link:"pending"});
  await f.service.change(f.actor,await f.input(f.other,"active"));
  expect(await states(f.other)).toEqual(revoked);
  expect((await sql`select status from local_installations where id=${installation}`)[0]!.status).toBe("active");
});
