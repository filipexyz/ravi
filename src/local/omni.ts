/**
 * Omni API Server Manager
 *
 * Spawns the omni-v2 API server as a child process, handling:
 * - Bundle build (on first run or missing dist)
 * - Database migrations
 * - API key bootstrap (stored in ~/.ravi/omni-api-key)
 * - Process lifecycle (start, wait for ready, stop)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

const log = logger.child("omni");

const OMNI_API_KEY_FILE = join(homedir(), ".ravi", "omni-api-key");
const DEFAULT_OMNI_API_PORT = 8882;
const OMNI_DB_NAME = "omni";

export interface OmniServer {
  apiUrl: string;
  apiKey: string;
  stop(): Promise<void>;
}

/**
 * Get or create the omni API key.
 * Stored in ~/.ravi/omni-api-key across restarts.
 */
function getOrCreateOmniApiKey(): string {
  const raviDir = join(homedir(), ".ravi");
  mkdirSync(raviDir, { recursive: true });

  if (existsSync(OMNI_API_KEY_FILE)) {
    const key = readFileSync(OMNI_API_KEY_FILE, "utf-8").trim();
    if (key) return key;
  }

  // Generate a new key
  const key = `omni_sk_${randomUUID().replace(/-/g, "")}`;
  writeFileSync(OMNI_API_KEY_FILE, key, { mode: 0o600 });
  log.info("Generated new omni API key");
  return key;
}

/**
 * Ensure the omni bundle is built.
 * Builds if dist/bundle/index.js is missing.
 */
async function ensureOmniBundleBuilt(omniDir: string): Promise<void> {
  const bundlePath = join(omniDir, "packages", "api", "dist", "bundle", "index.js");
  if (existsSync(bundlePath)) {
    return;
  }

  log.info("Building omni API bundle (first time)...");
  await runCommand(
    "bun",
    [
      "build",
      "packages/api/src/index.ts",
      "--outdir", "packages/api/dist/bundle",
      "--target", "bun",
    ],
    { cwd: omniDir }
  );
  log.info("Omni bundle built");
}

/**
 * Run database migrations for omni.
 */
async function runOmniMigrations(omniDir: string, databaseUrl: string): Promise<void> {
  log.info("Running omni database migrations...");

  const migrateScript = join(omniDir, "packages", "db", "src", "migrate.ts");
  if (!existsSync(migrateScript)) {
    log.warn("Migration script not found, skipping", { path: migrateScript });
    return;
  }

  await runCommand("bun", ["run", migrateScript], {
    cwd: join(omniDir, "packages", "db"), // migrate.ts uses ./drizzle relative to package dir
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  log.info("Omni migrations completed");
}

/**
 * Run a command and wait for it to complete.
 */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log.debug(`[omni-build] ${msg}`);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) log.debug(`[omni-build] ${msg}`);
    });

    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}: ${cmd} ${args.join(" ")}`));
    });

    proc.on("error", reject);
  });
}

/**
 * Wait for the omni HTTP API to be ready.
 *
 * Polls GET /health (or falls back to any non-5xx response).
 * A 404 is treated as "server is up but no /health route" which is fine.
 * Only retries on connection errors (ECONNREFUSED) or 5xx responses.
 */
async function waitForHttp(apiUrl: string, timeoutMs = 30_000): Promise<void> {
  const healthUrl = `${apiUrl}/health`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(2000),
      });
      // Any non-5xx status means the server is up and handling requests
      if (res.status < 500) return;
      log.debug("Omni /health returned 5xx, retrying...", { status: res.status });
    } catch {
      // ECONNREFUSED or timeout — not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error(`Omni API at ${apiUrl} did not become ready within ${timeoutMs}ms`);
}

/**
 * Start the omni API server as a child process.
 *
 * Requires:
 * - OMNI_DIR in process.env (or omniDir option)
 * - DATABASE_URL in process.env (or databaseUrl option)
 */
export async function startOmniServer(opts?: {
  omniDir?: string;
  natsUrl?: string;
  databaseUrl?: string;
  apiPort?: number;
}): Promise<OmniServer> {
  const omniDir = opts?.omniDir ?? process.env.OMNI_DIR;
  if (!omniDir) {
    throw new Error("OMNI_DIR not set. Configure via ravi setup or ~/.ravi/.env");
  }

  const natsUrl = opts?.natsUrl ?? process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const apiPort = opts?.apiPort ?? parseInt(process.env.OMNI_API_PORT || String(DEFAULT_OMNI_API_PORT), 10);
  const databaseUrl = opts?.databaseUrl ??
    process.env.DATABASE_URL ??
    `postgresql://postgres:postgres@127.0.0.1:8432/${OMNI_DB_NAME}`;

  const apiUrl = `http://127.0.0.1:${apiPort}`;

  // Get or create API key
  const apiKey = getOrCreateOmniApiKey();

  // Ensure bundle is built
  await ensureOmniBundleBuilt(omniDir);

  // Run migrations
  await runOmniMigrations(omniDir, databaseUrl);

  // Spawn the omni server
  const bundlePath = join(omniDir, "packages", "api", "dist", "bundle", "index.js");
  log.info("Starting omni API server...", { port: apiPort, natsUrl });

  const omniEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    NATS_URL: natsUrl,
    DATABASE_URL: databaseUrl,
    API_PORT: String(apiPort),
    OMNI_API_KEY: apiKey,
    // Disable omni's own nats/pgserve management (ravi manages these)
    NATS_MANAGED: "false",
    PGSERVE_MANAGED: "false",
    LOG_LEVEL: process.env.RAVI_LOG_LEVEL ?? "info",
  };

  const omniProc = spawn("bun", [bundlePath], {
    cwd: omniDir,
    env: omniEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  omniProc.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) log.debug(`[omni] ${msg}`);
  });
  omniProc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) log.debug(`[omni] ${msg}`);
  });

  let stopped = false;
  omniProc.on("exit", (code, signal) => {
    if (!stopped) {
      log.error("Omni API server exited unexpectedly", { code, signal });
    }
  });

  // Wait for HTTP API to be ready (polls /health, not just TCP)
  await waitForHttp(apiUrl);
  log.info("Omni API server ready", { apiUrl });

  return {
    apiUrl,
    apiKey,
    async stop() {
      stopped = true;
      if (!omniProc.killed) {
        omniProc.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => omniProc.on("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 8000)),
        ]);
        if (!omniProc.killed) {
          omniProc.kill("SIGKILL");
        }
      }
      log.info("Omni API server stopped");
    },
  };
}
