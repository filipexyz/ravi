/**
 * Host-side unix-socket CLI gateway.
 *
 * Isolated provider sandboxes (Codex shell, and other restricted CLIs) cannot
 * be given a raw loopback hole. They MAY reach this socket when the host
 * daemon created it at `~/.ravi/cli-gateway.sock` (mode 0600) and the caller
 * presents a live `RAVI_CONTEXT_KEY`.
 *
 * The HTTP listener on `RAVI_HTTP_PORT` stays optional and loopback-bound.
 * This unix listener is independent of that port.
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (error) {
      log.warn("Failed to remove stale host CLI gateway socket", { socketPath, error });
    }
  }

  const server = createServer((req, res) => {
    void handleUnixRequest(req, res, ctx, handleRequest).catch((error) => {
      log.error("Host CLI gateway request failed", { error });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "InternalError" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    log.warn("Failed to restrict host CLI gateway socket mode", { socketPath, error });
  }

  log.info("Host CLI gateway ready", { socketPath });

  return {
    socketPath,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) reject(closeError);
          else resolve();
        });
      });
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // Best-effort cleanup; a replacement daemon will unlink on start.
        }
      }
      log.info("Host CLI gateway stopped", { socketPath });
    },
  };
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
