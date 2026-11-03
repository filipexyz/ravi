import { expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ensureAuthorizationBootstrapPrerequisite } from "./authorization-bootstrap-prerequisite";

const socket = process.env.FLEET_TEST_PG_SOCKET;
const integration = socket?.includes("fleet-pg-test-") ? test : test.skip;
integration("core prerequisite supports standalone and migrated0073; incompatible schemas fail closed", async () => {
  const admin = postgres({ host:socket,port:55439,database:"postgres",username:"fleettest",max:1,onnotice(){} });
  const clients: ReturnType<typeof postgres>[] = [];
  try {
    for (const [database, migrated] of [["prerequisite_standalone",false],["prerequisite_composed",true]] as const) {
      await admin`create database ${admin(database)}`;
      const sql = postgres({ host:socket,port:55439,database,username:"fleettest",max:1,onnotice(){} }); clients.push(sql);
      if (migrated) await migrate(drizzle(sql),{migrationsFolder:"drizzle"});
      else { await sql`create table organizations(id uuid primary key)`; await sql`create table users(id uuid primary key)`; }
      expect(await ensureAuthorizationBootstrapPrerequisite(sql)).toBe(migrated ? "reused" : "created");
      expect(await ensureAuthorizationBootstrapPrerequisite(sql)).toBe("reused");
      const [before] = await sql`select 'public.fleet_bootstrap_grants'::regclass::oid as oid`;
      await expect(sql.begin(async tx => {
        await tx`alter table fleet_bootstrap_grants alter column expires_at drop not null`;
        await ensureAuthorizationBootstrapPrerequisite(tx);
      })).rejects.toThrow("Bootstrap prerequisite schema drift");
      // The failed transaction must restore the real schema, not recreate it.
      expect(await ensureAuthorizationBootstrapPrerequisite(sql)).toBe("reused");
      expect((await sql`select 'public.fleet_bootstrap_grants'::regclass::oid as oid`)[0]!.oid).toBe(before!.oid);
      await expect(sql.begin(async tx => {
        await tx`alter table fleet_bootstrap_grants add column unexpected text`;
        await ensureAuthorizationBootstrapPrerequisite(tx);
      })).rejects.toThrow("Bootstrap prerequisite schema drift");
      expect(await ensureAuthorizationBootstrapPrerequisite(sql)).toBe("reused");
    }
  } finally { for (const client of clients) await client.end(); await admin.end(); }
},60000);
