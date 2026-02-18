/**
 * Local Server Manager
 *
 * Starts nats-server as local infrastructure.
 * Just a bare nats-server for pub/sub.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { logger } from "../utils/logger.js";
import { ensureNatsBinary } from "./binary.js";
import { connectNats, closeNats } from "../nats.js";

const log = logger.child("local");

const NATS_PORT = parseInt(process.env.NATS_PORT || "4222", 10);

export interface LocalServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start the local infrastructure: nats-server only.
 *
 * Flow:
 * 1. Ensure nats-server binary
 * 2. Spawn nats-server (local-only, no auth)
 * 3. Wait for port ready
 * 4. Connect the NatsBus singleton
 */
export async function startLocalServer(): Promise<LocalServer> {
  // Step 1: Ensure nats-server binary
  const natsPath = await ensureNatsBinary();

  // Step 2: Spawn nats-server
  const url = `nats://127.0.0.1:${NATS_PORT}`;

  log.info("Starting nats-server...");
  const natsProc = spawn(natsPath, [
    "-p", String(NATS_PORT),
    "-a", "127.0.0.1",  // bind local only
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe logs
  natsProc.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log.debug(`[nats-server] ${msg}`);
  });
  natsProc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log.debug(`[nats-server] ${msg}`);
  });

  // Handle unexpected exit
  let stopped = false;
  natsProc.on("exit", (code, signal) => {
    if (!stopped) {
      log.error("nats-server exited unexpectedly", { code, signal });
    }
  });

  // Step 3: Wait for port ready
  await waitForPort(NATS_PORT);
  log.info("nats-server ready", { port: NATS_PORT });

  // Step 4: Connect NatsBus singleton
  await connectNats(url, { explicit: true });

  return {
    url,
    async stop() {
      stopped = true;
      // Close NATS client first
      await closeNats();
      // Kill nats-server
      if (!natsProc.killed) {
        natsProc.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => natsProc.on("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
        if (!natsProc.killed) {
          natsProc.kill("SIGKILL");
        }
      }
      log.info("Local server stopped");
    },
  };
}

/**
 * Wait for a TCP port to accept connections.
 */
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  const interval = 100;

  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}
