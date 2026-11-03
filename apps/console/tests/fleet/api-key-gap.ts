// Historical reproduction only: run against unmodified main before 0076.
// Owns its PostgreSQL cluster; no default database or external service.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { postgresBinary, requirePostgres } from "./binaries";
import { OrganizationMembersService } from "../../src/server/console/fleet/members";
import { fixturePolicy, installFixturePolicy } from "./authorization-fixture";

const root = await mkdtemp(join(tmpdir(), "fleet-key-gap-")), socket = join(root, "socket"), data = join(root, "cluster");
await mkdir(socket, { mode: 0o700 });
await requirePostgres();
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
async function run(args: string[]) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`Fixture command failed (${code}): ${out}\n${err}`);
}
let started = false;
let sql: ReturnType<typeof postgres> | undefined;
try {
  await run([postgresBinary("initdb"), "-D", data, "-U", "fleettest", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]);
  await run([postgresBinary("pg_ctl"), "-D", data, "-l", join(root, "postgres.log"), "-o", `-h '' -k ${socket} -p 55439 -c shared_buffers=32MB -c max_connections=10 -c work_mem=1MB`, "-w", "start"]);
  started = true;
  sql = postgres({ host: socket, port: 55439, database: "postgres", username: "fleettest", max: 3, onnotice() {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  const columns = await sql`select column_name from information_schema.columns where table_name='api_keys'`;
  if (columns.some(c => c.column_name === "subject_kind")) throw new Error("Historical gap reproduction requires main before ownership implementation");
  const org = randomUUID(), steward = randomUUID(), target = randomUUID(), otherOrg = randomUUID(), foreignProject = randomUUID();
  await sql`insert into organizations(id,name,slug) values(${org},'Key fixture',${org}),(${otherOrg},'Other fixture',${otherOrg})`;
  for (const user of [steward, target]) {
    await sql`insert into users(id,primary_email) values(${user},${`${user}@example.invalid`})`;
    await sql`insert into organization_memberships(organization_id,user_id,role) values(${org},${user},'billing')`;
  }
  await sql`insert into projects(id,organization_id,name,slug) values(${foreignProject},${otherOrg},'Other project',${foreignProject})`;
  await installFixturePolicy(sql, steward, fixturePolicy(org, steward));
  // No field exists for the intended holder: all we can record is the creator.
  await sql`insert into api_keys(organization_id,project_id,name,key_prefix,key_hash,created_by_user_id)
    values(${org},${foreignProject},'Unclassified fixture','synthetic',${randomUUID()},${target})`;
  const service = new OrganizationMembersService(sql, org);
  const actor = { mode: "oidc" as const, organizationId: org, userId: steward, role: "billing" };
  const member = (await service.list(actor)).members.find(m => m.userId === target)!;
  await service.change(actor, { operationId: randomUUID(), userId: target, expectedVersion: member.version, status: "suspended" });
  const [key] = await sql`select status,revoked_at from api_keys where organization_id=${org}`;
  if (key?.status !== "active" || key.revoked_at !== null) throw new Error("Baseline changed; inspect before claiming gap");
  const summary = { source: "main 28cc2a9", missingSubject: true, crossOrgProjectAccepted: true,
    creatorSuspendedKeyStillActive: true, verdict: "GAP_REPRODUCED", caveat: "No operational api_keys issuer or bearer validator exists in this source; active row is not proof of accepted HTTP access." };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, ...summary }));
} finally {
  await sql?.end();
  if (started) await run([postgresBinary("pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
  console.log(JSON.stringify({ root, stopped: started, tcp: false }));
}
