/**
 * SDK gateway HTTP handler.
 *
 * Pure request handler that the daemon's webhook HTTP server mounts at
 * `/api/v1/*`. The gateway is NOT a separate listener — it shares the daemon's
 * single `Bun.serve` so we expose one port (`RAVI_HTTP_PORT`) for callbacks,
 * tool bridge, and the SDK API.
 *
 * The transport layer never emits audit events — that lives in the dispatcher
 * so the CLI and gateway share a single audit code path.
 */

import { logger } from "../../utils/logger.js";
import { getRegistry, type RegistrySnapshot } from "../../cli/registry-snapshot.js";
import { emitJson } from "../openapi/emit.js";
import { buildRouteTable, buildMetaPayload, type RouteTable, API_PREFIX } from "./route-table.js";
import { resolveAuth, type AuthFailureReason, type GatewayAuthConfig } from "./auth.js";
import { dispatch } from "./dispatcher.js";
import { errorResponse, json, methodNotAllowed, notFound, unauthorized } from "./errors.js";
import { hasLiveAdminContext } from "../../runtime/context-registry.js";

const log = logger.child("sdk:gateway");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

interface ServeLike {
  port: number;
  hostname: string;
  stop(force?: boolean): void;
}

declare const Bun: {
  serve(options: { hostname: string; port: number; fetch(request: Request): Response | Promise<Response> }): ServeLike;
};

export interface GatewayConfig {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  allowSuperadmin?: boolean;
  auth?: GatewayAuthConfig;
  registry?: RegistrySnapshot;
}

export interface GatewayHandle {
  url: string;
  host: string;
  port: number;
  registryHash: string;
  stop(): Promise<void>;
}

/**
 * Per-request context shared across all gateway operations. Built once at
 * server startup via {@link createGatewayHandlerContext} and threaded into
 * {@link handleGatewayRequest}.
 */
export interface GatewayHandlerContext {
  table: RouteTable;
  auth: GatewayAuthConfig;
  allowSuperadmin: boolean;
  maxBodyBytes: number;
}

export const GATEWAY_VERSION = "0.1.0";

/** Build the per-server context the request handler needs. */
export function createGatewayHandlerContext(config: GatewayConfig = {}): GatewayHandlerContext {
  const registry = config.registry ?? getRegistry();
  return {
    table: buildRouteTable(registry),
    auth: config.auth ?? {},
    allowSuperadmin: Boolean(config.allowSuperadmin),
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
}

/**
 * Handle a request that targets the gateway namespace. Returns `null` if the
 * URL does not start with `/api/v1` so the caller can fall through to other
 * routes; otherwise returns a `Response`. Any path under `/api/v1/*` that does
 * not match a known route still resolves here (with 404), since that namespace
 * belongs to the gateway.
 */
export async function handleGatewayRequest(request: Request, ctx: GatewayHandlerContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
    return null;
  }
  const origin = request.headers.get("origin");
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin, requestedHeaders) });
  }
  const startedAt = Date.now();
  const response = await processGatewayRequest(request, url, ctx);
  return logged(request, url, response.status, startedAt, withCorsHeaders(response, origin, requestedHeaders));
}

function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && origin.startsWith("chrome-extension://");
}

function corsHeaders(origin: string | null, requestedHeaders: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders ?? "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function withCorsHeaders(response: Response, origin: string | null, requestedHeaders: string | null): Response {
  const extra = corsHeaders(origin, requestedHeaders);
  if (Object.keys(extra).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) merged.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

/**
 * Test-only helper. Spins up an isolated `Bun.serve` so unit tests can hit the
 * gateway with `fetch()`. Production deployments mount the gateway inside the
 * daemon's webhook HTTP server (single listener) — see
 * `src/webhooks/http-server.ts`.
 */
export function startGateway(config: GatewayConfig = {}): GatewayHandle {
  const host = config.host ?? DEFAULT_HOST;
  const port = config.port ?? DEFAULT_PORT;
  const ctx = createGatewayHandlerContext(config);

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: async (request) => {
      const gatewayResponse = await handleGatewayRequest(request, ctx);
      if (gatewayResponse) return gatewayResponse;
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json(200, { ok: true, service: "ravi-sdk-gateway" });
      }
      return notFound(url.pathname);
    },
  }) as ServeLike;

  const url = `http://${host}:${server.port}`;
  log.info("SDK gateway started (test-only standalone listener)", {
    url,
    commandCount: ctx.table.byPath.size,
    registryHash: ctx.table.registryHash,
    allowSuperadmin: ctx.allowSuperadmin,
  });

  return {
    url,
    host,
    port: server.port,
    registryHash: ctx.table.registryHash,
    async stop() {
      server.stop(true);
      log.info("SDK gateway stopped", { url });
    },
  };
}

async function processGatewayRequest(request: Request, url: URL, ctx: GatewayHandlerContext): Promise<Response> {
  if (url.pathname === `${API_PREFIX}/_meta/registry`) {
    if (request.method !== "GET") return methodNotAllowed(request.method, url.pathname);
    return json(200, buildMetaPayload(ctx.table));
  }

  if (url.pathname === `${API_PREFIX}/_meta/version`) {
    if (request.method !== "GET") return methodNotAllowed(request.method, url.pathname);
    return json(200, { gateway: GATEWAY_VERSION, registryHash: ctx.table.registryHash });
  }

  if (url.pathname === `${API_PREFIX}/_meta/openapi.json`) {
    if (request.method !== "GET") return methodNotAllowed(request.method, url.pathname);
    const body = emitJson(ctx.table.registry);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const cmd = ctx.table.byPath.get(url.pathname);
  if (!cmd) {
    return notFound(url.pathname);
  }

  if (request.method !== "POST") {
    return methodNotAllowed(request.method, url.pathname);
  }

  const isOpenRoute = cmd.scope === "open";
  const resolved = resolveAuth(request, ctx.auth);
  if (!isOpenRoute) {
    if (!hasLiveAdminContext()) {
      return unauthorized(
        "no admin context configured; run 'ravi daemon init-admin-key' on the daemon host before issuing gateway requests",
      );
    }
    if (!resolved.authenticated) {
      return unauthorized(authFailureMessage(resolved.reason));
    }
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > ctx.maxBodyBytes) {
    return errorResponse(413, "PayloadTooLarge", { limitBytes: ctx.maxBodyBytes });
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch (error) {
    log.warn("gateway: failed to read body", { path: url.pathname, error });
    return errorResponse(400, "BadRequest", { message: "Failed to read request body." });
  }

  if (raw.length > ctx.maxBodyBytes) {
    return errorResponse(413, "PayloadTooLarge", { limitBytes: ctx.maxBodyBytes });
  }

  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return errorResponse(400, "BadRequest", { message: "Request body is not valid JSON." });
    }
  }

  const result = await dispatch(cmd, body, resolved.context, {
    allowSuperadmin: ctx.allowSuperadmin,
    contextRecord: resolved.contextRecord,
  });
  return result.response;
}

function authFailureMessage(reason: AuthFailureReason): string {
  switch (reason) {
    case "missing":
      return "missing Authorization header (expected 'Bearer rctx_*')";
    case "malformed":
      return "malformed Authorization header (expected 'Bearer rctx_*')";
    case "unknown":
      return "unknown context key";
    case "revoked":
      return "context has been revoked";
    case "expired":
      return "context has expired";
    default:
      return "authentication required";
  }
}

function logged(request: Request, url: URL, status: number, startedAt: number, response: Response): Response {
  const durationMs = Date.now() - startedAt;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  log[level]("gateway request", {
    method: request.method,
    path: url.pathname,
    status,
    durationMs,
  });
  return response;
}
