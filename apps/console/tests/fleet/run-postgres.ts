import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { postgresBinary, requirePostgres } from "./binaries";

// Dedicated local Postgres; no Docker start, TCP listener or inherited DATABASE_URL.
const root = await mkdtemp(join(tmpdir(), "fleet-pg-test-"));
const data = join(root, "cluster"), socket = join(root, "socket");
console.log(JSON.stringify({ root, kind: "owned-local-fixture-start" }));
await mkdir(socket, { mode: 0o700 });
await requirePostgres();
const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC",
  ...(process.env.FLEET_TEST_NODE_BIN ? { FLEET_TEST_NODE_BIN: process.env.FLEET_TEST_NODE_BIN } : {}),
  ...(process.env.FLEET_TEST_BROWSER_EXECUTABLE ? { FLEET_TEST_BROWSER_EXECUTABLE: process.env.FLEET_TEST_BROWSER_EXECUTABLE } : {}) };
async function run(args: string[], env: Record<string, string> = environment) {
  const child = Bun.spawn(args, { cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Local command failed (${code}): ${output}\n${error}`);
  return output + error;
}
let started = false;
try {
  await run([postgresBinary("initdb"), "-D", data, "-U", "fleettest", "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "UTF8"]);
  await run([postgresBinary("pg_ctl"), "-D", data, "-l", join(root, "postgres.log"), "-o", `-h '' -k ${socket} -p 55439 -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB`, "-w", "start"]); started = true;
  if (process.argv.includes("--gateway-backend")) {
    console.log(await run([process.execPath,"test","tests/fleet/gateway-backend.integration.test.ts"], {...environment,FLEET_TEST_PG_SOCKET:socket}));
  } else if (process.argv.includes("--gateway")) {
    console.log(await run([process.execPath,"test","tests/fleet/gateway-delivery.integration.test.ts"], {...environment,FLEET_TEST_PG_SOCKET:socket}));
  } else if (process.argv.includes("--desktop-browser")) {
    console.log(await run([process.execPath,"test","tests/fleet/desktop.browser.test.ts"], {...environment,FLEET_TEST_PG_SOCKET:socket}));
  } else if (process.argv.includes("--human-bridge-browser")) {
    console.log(await run([process.execPath,"test","tests/fleet/human-bridge.browser.test.ts"], {...environment,FLEET_TEST_PG_SOCKET:socket}));
  } else if (process.argv.includes("--api-keys")) {
    console.log(await run([process.execPath, "test", "tests/fleet/api-keys.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket,
      DATABASE_URL: "postgres:///fleet_keys_fixture", PGHOST: socket, PGPORT: "55439", PGUSER: "fleettest", RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true" }));
  } else if (process.argv.includes("--io-review")) {
    console.log(await run([process.execPath, "test", "tests/fleet/io-concurrency.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket,
      DATABASE_URL: "postgres:///postgres", PGHOST: socket, PGPORT: "55439", PGUSER: "fleettest", RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true" }));
  } else if (process.argv.includes("--stream-browser")) {
    console.log(await run([process.execPath, "test", "tests/fleet/stream-browser.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  } else {
  console.log(await run([process.execPath, "test", "tests/fleet/postgres.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  if (process.argv.includes("--repeat")) console.log(await run([process.execPath, "test", "tests/fleet/postgres.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  console.log(await run([process.execPath, "test", "tests/fleet/bootstrap.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  console.log(await run([process.execPath, "test", "tests/fleet/upgrade.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  console.log(await run([process.execPath, "test", "tests/fleet/organization-authorization.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  console.log(await run([process.execPath, "test", "tests/fleet/members.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  console.log(await run([process.execPath, "test", "tests/fleet/bootstrap-prerequisite.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  if (process.argv.includes("--browser")) console.log(await run([process.execPath, "test", "tests/fleet/browser.integration.test.ts"], { ...environment, FLEET_TEST_PG_SOCKET: socket }));
  }
  console.log(JSON.stringify({ result: "PASS", kind: process.argv.includes("--stream-browser") ? "local-next-stream-integration" : "local-postgres-integration",
    root, tcp: false, vault: process.argv.includes("--stream-browser") ? "absent" : "synthetic", ssh: process.argv.includes("--stream-browser") ? "not-used" : "synthetic" }));
} finally {
  if (started) await run([postgresBinary("pg_ctl"), "-D", data, "-m", "fast", "-w", "stop"]);
  console.log(JSON.stringify({ root, kind: "owned-local-fixture-stopped", stopped: started }));
}
