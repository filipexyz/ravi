/** Owned, bounded Unix-socket PG fixture. No installed DB/env/remote service. */
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const cwd = await realpath(resolve(process.argv[2] ?? "."));
const bin = process.env.FLEET_TEST_POSTGRES_BIN;
const executable = (name: string) => bin ? join(bin, name) : Bun.which(name);
const pg = Object.fromEntries(["initdb", "pg_ctl", "postgres"].map(name => {
  const path = executable(name);
  if (!path) throw new Error(`Missing ${name}; set FLEET_TEST_POSTGRES_BIN or PATH. No existing database accepted.`);
  return [name, path];
})) as Record<"initdb" | "pg_ctl" | "postgres", string>;
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
async function run(args: string[], environment: Record<string, string> = env) {
  const child = Bun.spawn(args, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error };
}
const version = await run([pg.postgres, "--version"]);
if (version.code || !/PostgreSQL\) (1[6-9]|[2-9]\d)\./.test(version.output)) throw new Error("PostgreSQL >=16 required");
const root = await mkdtemp(join(tmpdir(), "fleet-bases-review-"));
const data = join(root, "data"), socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
const files = ["src/server/console/metrics/metrics.db.test.ts",
  ...["service", "workflow", "review", "widget", "compiler"].map(name => `src/server/console/bases/${name}.db.test.ts`),
  "src/server/console/pages/chat-rooms/store.db.test.ts"];
if (await Bun.file(join(cwd, "src/server/console/bases/service-principal.db.test.ts")).exists()) files.push("src/server/console/bases/service-principal.db.test.ts");
if (await Bun.file(join(cwd, "src/server/mcp/membership.db.test.ts")).exists()) files.push("src/server/mcp/membership.db.test.ts");
const summary: object[] = [];
async function required(args: string[]) {
  const result = await run(args);
  if (result.code) throw new Error(`Fixture command failed: ${result.error}`);
}
let started = false;
try {
  await required([pg.initdb, "-D", data, "-U", "fleettest", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]);
  await required([pg.pg_ctl, "-D", data, "-l", join(root, "postgres.log"), "-o",
    `-h '' -k ${socket} -p 55439 -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB`, "-w", "start"]);
  started = true;
  const client = postgres({ host: socket, port: 55439, username: "fleettest", database: "postgres", max: 1, onnotice() {} });
  try { await migrate(drizzle(client), { migrationsFolder: join(cwd, "drizzle") }); } finally { await client.end(); }
  for (const [index, file] of files.entries()) {
    const databaseUrl = "postgres:///postgres";
    const result = await run([process.execPath, "test", file, "--reporter=junit", `--reporter-outfile=${join(root, `${index}.xml`)}`], {
      ...env, DATABASE_URL: databaseUrl, PGHOST: socket, PGPORT: "55439", PGUSER: "fleettest",
      BASES_TEST_DATABASE_URL: databaseUrl, METRICS_TEST_DATABASE_URL: databaseUrl,
      RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_PAGES_AI_ENABLED: "false",
    });
    await writeFile(join(root, `${index}.json`), JSON.stringify({ file, ...result }), { mode: 0o600 });
    const counts = result.error.match(/\d+ (?:pass|fail|skip)/g) ?? [];
    summary.push({ file, code: result.code, counts });
    console.log(JSON.stringify(summary.at(-1)));
    if (result.code) process.exitCode = 1;
  }
} finally {
  if (started) await required([pg.pg_ctl, "-D", data, "-m", "fast", "-w", "stop"]);
  const evidence = { cwd, root, pgVersion: version.output.trim(), bun: Bun.version, tcp: false, stopped: started, summary };
  await writeFile(join(root, "summary.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
