/**
 * Host-side unix-socket CLI gateway.
 *
 * Isolated provider sandboxes (Codex shell, and other restricted CLIs) cannot
 * be given a raw loopback hole. They MAY reach this socket when the host
 * daemon created it at `~/.ravi/cli-gateway.sock` (mode 0600) and the caller
 * presents a live `RAVI_CONTEXT_KEY`.
 *
 * Handlers run in-process on the daemon. Do not block the event loop on
 * `process.stdin` from this path (audit metadata, TTY probes, prompts).
 *
 * The HTTP listener on `RAVI_HTTP_PORT` stays optional and loopback-bound.
 * This unix listener is independent of that port.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, lstatSync, renameSync, type Stats, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import { HOST_CLI_GATEWAY_ENV, getHostCliGatewaySocketPath, probeUnixSocket } from "../isolation/execution-plane.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "../sdk/gateway/server.js";
import type { GatewayConfig, GatewayHandlerContext } from "../sdk/gateway/server.js";

const log = logger.child("cli:host-gateway");

export { HOST_CLI_GATEWAY_ENV, HOST_CLI_GATEWAY_INTERNAL_ENV } from "../isolation/execution-plane.js";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HostCliGatewayHandle {
  socketPath: string;
  stop(): Promise<void>;
}

export interface StartHostCliGatewayOptions {
  socketPath?: string;
  gateway?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
  handleRequest?: (request: Request) => Promise<Response> | Response;
}

export function isHostCliGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HOST_CLI_GATEWAY_ENV]?.trim();
  return raw !== "0" && raw?.toLowerCase() !== "false" && raw?.toLowerCase() !== "off";
}

export async function startHostCliGateway(
  options: StartHostCliGatewayOptions = {},
): Promise<HostCliGatewayHandle | null> {
  const env = options.env ?? process.env;
  if (!isHostCliGatewayEnabled(env)) {
    log.info("Host CLI gateway disabled");
    return null;
  }

  const socketPath = options.socketPath ?? getHostCliGatewaySocketPath(getRaviStateDir(env));
  const ctx = options.handleRequest ? null : createGatewayHandlerContext(options.gateway ?? {});
  const handleRequest = options.handleRequest;

  const server = createServer((req, res) => {
    void handleUnixRequest(req, res, ctx, handleRequest).catch((error) => {
      log.error("Host CLI gateway request failed", { error });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "InternalError" }));
    });
  });

  // listen() on an existing path silently takes it over, even from a live
  // daemon (Bun 1.3). So the server listens on a private temporary name and
  // the public name is claimed with link(2), which fails with EEXIST when
  // anyone holds it: of two daemons starting at once exactly one wins.
  // Same directory (link(2) cannot cross filesystems) and a short basename:
  // unix socket paths are limited to ~104 bytes (sun_path).
  const bindPath = join(dirname(socketPath), `.cg${randomBytes(4).toString("hex")}`);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bindPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve();
      });
    });

  let ownSocket: Stats;
  try {
    // Restrict before publishing, so the public name is never looser than 0600.
    chmodSync(bindPath, 0o600);
  } catch (error) {
    log.warn("Failed to restrict host CLI gateway socket mode", { socketPath, error });
  }
  try {
    const claimed = await claimSocketPath(bindPath, socketPath);
    if (!claimed) {
      await closeServer();
      return null;
    }
    ownSocket = claimed;
  } finally {
    // The server keeps listening on the inode; only the temporary name goes.
    // close() later unlinks this temporary name, never the public one.
    unlinkQuietly(bindPath);
  }

  log.info("Host CLI gateway ready", { socketPath });

  return {
    socketPath,
    async stop() {
      // Remove the public name while still listening: as long as this socket
      // is live no other daemon replaces it, so a name holding our inode here
      // is still ours. A successor's socket (different inode) is left alone.
      const current = lstatOrNull(socketPath);
      if (current && sameFile(current, ownSocket)) unlinkQuietly(socketPath);
      await closeServer();
      log.info("Host CLI gateway stopped", { socketPath });
    },
  };
}

/**
 * Publish the socket listening at `bindPath` under `socketPath` with link(2).
 * When the name is taken, refuse unless it is a socket of ours nobody accepts
 * connections on (a crashed daemon's leftover): that one is moved aside and the
 * claim retried once. Returns the socket's stats, or null to start without the
 * gateway:
 * - a live socket: another daemon is serving it; never touch it;
 * - not a socket (a regular file, a dir, a symlink): not ours to delete;
 * - a socket owned by another user.
 */
async function claimSocketPath(bindPath: string, socketPath: string): Promise<Stats | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      linkSync(bindPath, socketPath);
      // Same inode as the public name, without racing anyone for that name.
      return lstatSync(bindPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        log.error("Host CLI gateway not started: cannot publish the socket", { socketPath, error });
        return null;
      }
    }
    if (attempt > 0 || !(await removeStaleSocket(socketPath))) return null;
  }
  return null;
}

/** Move a dead socket of ours out of the way. true when the name may be free now. */
async function removeStaleSocket(socketPath: string): Promise<boolean> {
  const stale = lstatOrNull(socketPath);
  if (!stale) return true;
  if (!stale.isSocket()) {
    log.error("Host CLI gateway not started: the socket path holds something that is not a socket", {
      socketPath,
    });
    return false;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stale.uid !== uid) {
    log.error("Host CLI gateway not started: the socket belongs to another user", { socketPath, owner: stale.uid });
    return false;
  }
  if (await probeUnixSocket(socketPath)) {
    log.error("Host CLI gateway not started: another process is serving the socket (is a second daemon running?)", {
      socketPath,
    });
    return false;
  }
  // rename() takes whatever holds the name now; a concurrent starter may have
  // replaced the dead socket since the probe. Check the inode of what was
  // moved, and put a live successor's socket back instead of deleting it.
  const aside = `${socketPath}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
  try {
    renameSync(socketPath, aside);
  } catch (error) {
    // ENOENT: a concurrent starter already moved it; retry the claim.
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
  }
  const moved = lstatOrNull(aside);
  if (moved && sameFile(moved, stale)) {
    unlinkQuietly(aside);
    return true;
  }
  try {
    linkSync(aside, socketPath);
  } catch (error) {
    log.warn("Could not put back a socket that replaced the stale one", { socketPath, error });
  }
  unlinkQuietly(aside);
  log.error("Host CLI gateway not started: another daemon claimed the socket", { socketPath });
  return false;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove.
  }
}

export async function hostCliGatewayReachable(socketPath = getHostCliGatewaySocketPath()): Promise<boolean> {
  return probeUnixSocket(socketPath);
}

async function handleUnixRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayHandlerContext | null,
  handleRequest?: (request: Request) => Promise<Response> | Response,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "PayloadTooLarge", limitBytes: MAX_BODY_BYTES }));
      req.destroy();
      return;
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  const method = req.method ?? "GET";
  const target = req.url ?? "/";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const request = new Request(`http://ravi-cli-gateway.local${target}`, {
    method,
    headers,
    ...(method !== "GET" && method !== "HEAD" && rawBody.length > 0 ? { body: rawBody } : {}),
  });

  const response =
    (handleRequest ? await handleRequest(request) : ctx ? await handleGatewayRequest(request, ctx) : null) ??
    new Response(JSON.stringify({ error: "NotFound" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });

  const body = Buffer.from(await response.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(response.status, outHeaders);
  res.end(body);
}
