import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

/** Explicit fixture binaries or PATH; never start/download/install a service. */
export function postgresBinary(name: "postgres" | "initdb" | "pg_ctl") {
  const path = process.env.FLEET_TEST_POSTGRES_BIN ? join(process.env.FLEET_TEST_POSTGRES_BIN, name) : Bun.which(name);
  if (!path || !existsSync(path)) throw new Error(`Missing ${name}: set FLEET_TEST_POSTGRES_BIN or PATH (PostgreSQL16+).`);
  return path;
}
export async function requirePostgres() {
  const process = Bun.spawn([postgresBinary("postgres"), "--version"], { stdout: "pipe", stderr: "pipe" });
  const [code, version] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  if (code || !/PostgreSQL\) (1[6-9]|[2-9]\d)\./.test(version)) throw new Error("PostgreSQL16+ required by fixture");
}
export async function node24Binary() {
  const path = process.env.FLEET_TEST_NODE_BIN ?? Bun.which("node");
  if (!path) throw new Error("Node24+ required: set FLEET_TEST_NODE_BIN or PATH");
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [code, version] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const major = Number(/^v(\d+)\./.exec(version)?.[1]);
  if (code || !Number.isInteger(major) || major < 24) throw new Error("Node24+ required (OIDC provider/runtime contract); Node22 is not supported by this fixture");
  return path;
}
export function browserBinary() {
  const path = process.env.FLEET_TEST_BROWSER_EXECUTABLE ?? Bun.which("chromium") ?? Bun.which("google-chrome") ?? chromium.executablePath();
  if (!existsSync(path)) throw new Error("Browser unavailable: set FLEET_TEST_BROWSER_EXECUTABLE to an installed Chromium/Chrome or provision Playwright browser separately");
  return path;
}
