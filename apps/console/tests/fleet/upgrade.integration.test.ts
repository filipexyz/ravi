import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
integration("upgrade baseline through key ownership preserves legacy identities and unclassified keys; repeat is no-op", async () => {
  const admin = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 1, onnotice() {} });
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    await admin`create database fleet_upgrade_fixture`;
    sql = postgres({ host: socket, port: 55439, database: "fleet_upgrade_fixture", username: "fleettest", max: 1, onnotice() {} });
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    expect(journal.entries[74]).toMatchObject({ tag: "0073_fleet_onboarding", idx: 74, when: 1792794000000 });
    expect(journal.entries[75]).toMatchObject({ tag: "0074_project_authorization", idx: 75, when: 1792795000000 });
    expect(journal.entries[76]).toMatchObject({ tag: "0075_fleet_io_reservations", idx: 76, when: 1792866000000 });
    expect(journal.entries[77]).toMatchObject({ tag: "0076_api_key_principals", idx: 77 });
    expect(journal.entries.at(-1)).toMatchObject({ tag: "0077_gateway_deliveries", idx: 78 });
    const base = { ...journal, entries: journal.entries.slice(0, 74) };
    const root = await mkdtemp(join(tmpdir(), "fleet-upgrade-test-")); await mkdir(join(root, "meta"), { mode: 0o700 });
    await writeFile(join(root, "meta/_journal.json"), JSON.stringify(base), { mode: 0o600 });
    for (const entry of base.entries) await writeFile(join(root, `${entry.tag}.sql`), await readFile(`drizzle/${entry.tag}.sql`), { mode: 0o600 });
    await migrate(drizzle(sql), { migrationsFolder: root });
    expect((await sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0]!.n).toBe(74);
    const org = randomUUID(), user = randomUUID(), identity = randomUUID(), session = randomUUID();
    await sql`insert into organizations(id,name,slug) values(${org},'Existing fixture','existing-fixture')`;
    await sql`insert into users(id,primary_email,display_name) values(${user},'existing@example.invalid','Existing owner')`;
    await sql`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${user},'owner','active')`;
    const legacyKey = randomUUID();
    await sql`insert into api_keys(id,organization_id,name,key_prefix,key_hash,created_by_user_id)
      values(${legacyKey},${org},'Preserved legacy','old',${randomUUID()},${user})`;
    await sql`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identity},'oidc:https://idp.example.invalid','existing-owner',${user},'existing@example.invalid')`;
    await sql`insert into console_browser_sessions(id,token_hash,auth_identity_id,user_id,organization_id,expires_at)
      values(${session},${"a".repeat(64)},${identity},${user},${org},now()+interval '1 hour')`;
    const snapshot = async () => JSON.stringify(await sql!`select jsonb_build_object(
      'org',(select to_jsonb(o) from organizations o where id=${org}),
      'user',(select to_jsonb(u) from users u where id=${user}),
      'membership',(select to_jsonb(m) from organization_memberships m where organization_id=${org}),
      'identity',(select to_jsonb(i) from auth_identities i where id=${identity}),
      'session',(select to_jsonb(s)-'oidc_groups' from console_browser_sessions s where id=${session})) data`);
    const before = await snapshot();
    const baseHistory = await sql`select hash,created_at from drizzle.__drizzle_migrations order by id`;
    const onboard = journal.entries[74];
    await writeFile(join(root, `${onboard.tag}.sql`), await readFile(`drizzle/${onboard.tag}.sql`), { mode: 0o600 });
    await writeFile(join(root, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0,75) }), { mode: 0o600 });
    await migrate(drizzle(sql), { migrationsFolder: root });
    expect((await sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0]!.n).toBe(75);
    expect(await snapshot()).toBe(before);
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    expect(await snapshot()).toBe(before);
    expect((await sql`select oidc_groups from console_browser_sessions where id=${session}`)[0]!.oidc_groups).toEqual([]);
    expect((await sql`select count(*)::int n from fleet_credentials`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from fleet_sso_connections`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from authorization_policy_heads`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from authorization_bootstrap_receipts`)[0]!.n).toBe(0);
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    expect((await sql`select count(*)::int n from drizzle.__drizzle_migrations`)[0]!.n).toBe(79);
    expect((await sql`select status,subject_kind,subject_user_id,service_principal_id,hash_version,created_by_user_id from api_keys where id=${legacyKey}`)[0])
      .toMatchObject({ status: "active", subject_kind: "unclassified", subject_user_id: null, service_principal_id: null, hash_version: "legacy", created_by_user_id: user });
    expect((await sql`select count(*)::int n from fleet_io_reservations`)[0]!.n).toBe(0);
    expect(JSON.stringify(await sql`select hash,created_at from drizzle.__drizzle_migrations order by id limit 74`)).toBe(JSON.stringify(baseHistory));
    expect(await snapshot()).toBe(before);
  } finally { await sql?.end(); await admin.end(); }
},60000);
