/** Private Unix-socket PostgreSQL, real migrations; never reads installation env files. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";

const bin = process.env.RAVI_AUTH_TEST_PG_BIN;
if (!bin) throw new Error("Set RAVI_AUTH_TEST_PG_BIN explicitly; no existing database is accepted.");
const root = await mkdtemp(join(tmpdir(), "fleet-policy-test-"));
const data = join(root, "pgdata");
const command = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${error.slice(0, 300)}`);
  return output;
};
Object.assign(process.env, { DATABASE_URL: "postgres:///postgres", PGHOST: root, PGPORT: "5432", PGUSER: userInfo().username,
  RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_POLICY_TEST_CLUSTER: root, RAVI_PAGES_AI_ENABLED: "false" });
for (const key of ["PGPASSWORD", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "POSTGRES_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING"]) delete process.env[key];
await command([join(bin, "initdb"), "-D", data, "--auth=trust", "--no-locale", "--encoding=UTF8"]);
await command([join(bin, "pg_ctl"), "-D", data, "-l", join(root, "postgres.log"), "-o",
  `-k ${root} -c listen_addresses='' -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB`, "-w", "start"]);
try {
  const noticeCodes: Record<string, number> = {};
  const client = postgres("postgres:///postgres", { max: 5, prepare: false,
    onnotice: (notice) => { noticeCodes[notice.code ?? "unknown"] = (noticeCodes[notice.code ?? "unknown"] ?? 0) + 1; } });
  Object.assign(globalThis, { raviConsoleDbClient: client });
  const { db, dbClient } = await import("../src/server/db");
  try {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(db, { migrationsFolder: "drizzle" });
    const before = Number((await dbClient`select count(*) as n from drizzle.__drizzle_migrations`)[0]!.n);
    const upgradeOrg = "10000000-0000-4000-8000-000000000001";
    await dbClient`insert into organizations (id,slug,name) values (${upgradeOrg},'upgrade-preserved','Upgrade preservation sentinel')`;
    await migrate(db, { migrationsFolder: "drizzle" });
    assert.equal(Number((await dbClient`select count(*) as n from drizzle.__drizzle_migrations`)[0]!.n), before);
    // Until the coordinated merge, test our new migration after the published
    // baseline, without modifying shared journal or fabricating onboarding code.
    const isolated = join(root, "migrations");
    await mkdir(join(isolated, "meta"), { recursive: true });
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    for (const entry of journal.entries) await copyFile(`drizzle/${entry.tag}.sql`, join(isolated, `${entry.tag}.sql`));
    if (!journal.entries.some((entry: { tag: string }) => entry.tag === "0074_project_authorization")) {
      journal.entries.push({ idx: 75, version: "7", when: 1792795000000, tag: "0074_project_authorization", breakpoints: true });
      await copyFile("drizzle/0074_project_authorization.sql", join(isolated, "0074_project_authorization.sql"));
    }
    await writeFile(join(isolated, "meta/_journal.json"), JSON.stringify(journal));
    await migrate(db, { migrationsFolder: isolated });
    const after = Number((await dbClient`select count(*) as n from drizzle.__drizzle_migrations`)[0]!.n);
    assert.equal(after, journal.entries.length);
    assert.equal((await dbClient`select name from organizations where id=${upgradeOrg}`)[0]!.name, "Upgrade preservation sentinel");
    await migrate(db, { migrationsFolder: isolated });
    assert.equal(Number((await dbClient`select count(*) as n from drizzle.__drizzle_migrations`)[0]!.n), after);
    console.log(`PASS migrations: baseline ${before}, upgrade ${after}, existing row preserved, repeat no-op. Joint onboarding merge is separate.`);
    console.log("Migration notice counts (not suppressed failures):", JSON.stringify(noticeCodes));
  } finally { await dbClient.end(); }
  const testFile = process.argv.includes("--consumers") ? "store.integration.test.ts"
    : process.argv.includes("--members") ? "membership.integration.test.ts"
    : process.argv.includes("--streams") ? "stream.integration.test.ts" : "contract.integration.test.ts";
  const child = Bun.spawn([process.execPath, "test", resolve(`src/server/console/authorization/${testFile}`)], {
    env: process.env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code) process.exitCode = code;
} finally {
  await command([join(bin, "pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
  console.log(`Private synthetic cluster stopped; evidence retained at ${root}`);
}
