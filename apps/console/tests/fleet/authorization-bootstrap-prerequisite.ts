import assert from "node:assert/strict";
import type { Sql, TransactionSql } from "postgres";

/** Test prerequisite ONLY. Composition reuses migration0073 after exact schema
 * inspection. Standalone core fixtures lack0073 and create its prerequisite.
 * Never drops/rewrites a table to make a mismatched schema pass.
 */
export async function ensureAuthorizationBootstrapPrerequisite(sql: Sql | TransactionSql) {
  const [table] = await sql`select to_regclass('public.fleet_bootstrap_grants')::text as name`;
  const created = !table!.name;
  if (created) await sql`create table fleet_bootstrap_grants (
    organization_id uuid primary key references organizations(id), token_hash text not null,
    expected_email text not null, expires_at timestamptz not null, consumed_at timestamptz,
    claimed_by uuid references users(id), attempt_id uuid, state_hash text,
    transaction_ciphertext text, authorization_url text, attempt_expires_at timestamptz,
    created_at timestamptz not null default now())`;
  const columns = await sql`select column_name,udt_name,is_nullable,column_default
    from information_schema.columns where table_schema='public' and table_name='fleet_bootstrap_grants' order by ordinal_position`;
  const expected = [
    ["organization_id","uuid","NO",null], ["token_hash","text","NO",null], ["expected_email","text","NO",null],
    ["expires_at","timestamptz","NO",null], ["consumed_at","timestamptz","YES",null], ["claimed_by","uuid","YES",null],
    ["attempt_id","uuid","YES",null], ["state_hash","text","YES",null], ["transaction_ciphertext","text","YES",null],
    ["authorization_url","text","YES",null], ["attempt_expires_at","timestamptz","YES",null], ["created_at","timestamptz","NO","now()"],
  ];
  assert.deepEqual(columns.map(c=>[c.column_name,c.udt_name,c.is_nullable,c.column_default]), expected,
    "Bootstrap prerequisite schema drift: columns/types/nullability/defaults");
  const constraints = await sql`select pg_get_constraintdef(oid) as definition,condeferrable,condeferred
    from pg_constraint where conrelid='public.fleet_bootstrap_grants'::regclass and contype in ('p','f') order by pg_get_constraintdef(oid)`;
  assert.deepEqual(constraints.map(c=>[c.definition,c.condeferrable,c.condeferred]), [
    ["FOREIGN KEY (claimed_by) REFERENCES users(id)",false,false],
    ["FOREIGN KEY (organization_id) REFERENCES organizations(id)",false,false],
    ["PRIMARY KEY (organization_id)",false,false],
  ], "Bootstrap prerequisite schema drift: primary/foreign keys");
  return created ? "created" : "reused";
}
