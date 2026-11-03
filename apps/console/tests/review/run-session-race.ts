import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { postgresBinary, requirePostgres } from "../fleet/binaries";

// Independent review fixture. No inherited credentials, existing DB, TCP or IdP.
const root = await mkdtemp(join(tmpdir(), "fleet-pg-test-review-race-"));
const data = join(root, "cluster"), socket = join(root, "socket");
await mkdir(socket, { mode: 0o700 });
await requirePostgres();
const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
async function run(args: string[], env: Record<string, string> = environment) {
  const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error };
}
async function required(args: string[]) {
  const result = await run(args);
  if (result.code) throw new Error(`Fixture command failed: ${result.error}`);
}
let started = false;
try {
  await required([postgresBinary("initdb"), "-D", data, "-U", "fleettest", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]);
  await required([postgresBinary("pg_ctl"), "-D", data, "-l", join(root, "postgres.log"), "-o", `-h '' -k ${socket} -p 55439 -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB`, "-w", "start"]);
  started = true;
  const files = [process.argv.includes("--expiry-bootstrap") ? "tests/review/bootstrap-expiry.test.ts" : process.argv.includes("--expiry")
    ? "tests/review/issuance-expiry-wait.test.ts"
    : "tests/review/session-membership-race.test.ts"];
  if (process.argv.includes("--regressions")) files.push("tests/fleet/members.integration.test.ts",
    "tests/fleet/upgrade.integration.test.ts", "tests/fleet/organization-authorization.integration.test.ts",
    "tests/fleet/bootstrap-prerequisite.integration.test.ts"); // No browser/IdP fixture in this resource-bounded runner.
  for (const file of files) {
    const result = await run([process.execPath, "test", file], { ...environment, FLEET_TEST_PG_SOCKET: socket });
    await writeFile(join(root, file.split("/").at(-1)! + ".result.json"), JSON.stringify({ file, ...result }), { mode: 0o600 });
    console.log(result.output);
    console.error(result.error);
    if (result.code) { process.exitCode = result.code; break; }
  }
} finally {
  if (started) await required([postgresBinary("pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
  console.log(JSON.stringify({ kind: "session-race-regression", root, tcp: false, stopped: started,
    originalReproduction: "d7b908a35a00b1e1e16a2e7824273527cae5293e", candidate: "current-worktree" }));
}
