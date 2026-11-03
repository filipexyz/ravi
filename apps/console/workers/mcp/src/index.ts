import {
  aggregateUsage,
  findBridgeByToken,
  insertBridgeEvent,
  openMcpDb,
  updateBridgeLastUsed,
  type BridgeRecord,
  type McpBridgeEventStatusClass,
  type McpBridgeEventType,
  type McpDb,
} from "./db";
import { handleConsoleJsonRpc, requireConsoleScope } from "./console-mode";
import type { McpWorkerEnv } from "./env";
import { jsonError, jsonSuccess, McpHttpError } from "./errors";
import {
  authorizeRedirect,
  accessTokenAllowsScope,
  authenticateAccessToken,
  bridgeCapabilities,
  CONSOLE_SCOPES,
  discovery,
  exchangeToken,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  registerClient,
  revokeToken,
  type McpAccessTokenContext,
  type McpResourceKind,
} from "./oauth";
import { checkRateLimit, SlidingWindowRateLimitDO } from "./rate-limit";

export default {
  async fetch(request: Request, env: McpWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const db = openMcpDb(env.RAVI_CONSOLE_DB);
    const response = await handleMcpRequest({ request, env, db, requestId: crypto.randomUUID() });
    ctx.waitUntil(db.close().catch(() => {}));
    return response;
  },

  async scheduled(_event: ScheduledEvent, env: McpWorkerEnv, ctx: ExecutionContext) {
    const db = openMcpDb(env.RAVI_CONSOLE_DB);
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    ctx.waitUntil(aggregateUsage(db, day).finally(() => db.close()));
  },
} satisfies ExportedHandler<McpWorkerEnv>;

export class BridgeRateLimitDO extends SlidingWindowRateLimitDO {}
export class ClientRateLimitDO extends SlidingWindowRateLimitDO {}

type RouteContext = {
  request: Request;
  url: URL;
  env: McpWorkerEnv;
  db: McpDb;
  requestId: string;
  /** Console calls; injectable for tests. */
  fetchImpl?: typeof fetch;
};

/** The Worker's request handler, with its database (and Console fetch) passed in. */
export async function handleMcpRequest(input: {
  request: Request;
  env: McpWorkerEnv;
  db: McpDb;
  requestId: string;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  try {
    return await route({ ...input, url: new URL(input.request.url) });
  } catch (error) {
    return handleError(error, input.requestId);
  }
}

async function route(ctx: RouteContext): Promise<Response> {
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  if (ctx.url.pathname === "/.well-known/oauth-authorization-server") {
    return jsonSuccess(discovery(ctx.env), ctx.requestId);
  }

  if (segments[0] === ".well-known") return routeWellKnown(ctx, segments.slice(1));

  if (segments[0] === "oauth" && segments[1] === "mcp") {
    return routeOAuth(ctx, segments.slice(2));
  }

  if (segments.length === 2 && segments[1] === "mcp") {
    return routeMcpTransport(ctx, segments[0]!);
  }

  if (segments.length === 3 && segments[1] === "console" && segments[2] === "mcp") {
    return routeConsoleTransport(ctx, segments[0]!);
  }

  if (segments.length === 0) {
    return jsonSuccess({ ok: true, service: "ravi-mcp" }, ctx.requestId);
  }

  throw new McpHttpError(404, "not_found", "Unknown route");
}

/**
 * RFC 9728 protected resource metadata (host-wide and per MCP server, path
 * inserted) and RFC 8414 metadata of a bridge's issuer. Static: no lookup, so
 * the answer says nothing about whether a bridge token exists.
 */
function routeWellKnown(ctx: RouteContext, segments: string[]) {
  if (ctx.request.method !== "GET") throw new McpHttpError(405, "method_not_allowed", "Method not allowed");
  const [kind, token, ...rest] = segments;
  if (kind === "oauth-protected-resource") {
    if (!token) return jsonSuccess(protectedResourceMetadata(ctx.env), ctx.requestId);
    const resource = resourceKindFromPath(rest);
    if (resource) return jsonSuccess(protectedResourceMetadata(ctx.env, { kind: resource, bridgeToken: token }), ctx.requestId);
  }
  if (kind === "oauth-authorization-server" && token && rest.length === 0) {
    return jsonSuccess(discovery(ctx.env, token), ctx.requestId);
  }
  throw new McpHttpError(404, "not_found", "Unknown well-known route");
}

function resourceKindFromPath(rest: string[]): McpResourceKind | null {
  if (rest.length === 1 && rest[0] === "mcp") return "bridge";
  if (rest.length === 2 && rest[0] === "console" && rest[1] === "mcp") return "console";
  return null;
}

async function routeOAuth(ctx: RouteContext, segments: string[]) {
  if (matches(ctx, segments, "POST", ["register"])) {
    const body = await readJsonBody(ctx.request);
    const bridgeToken = bridgeTokenFromRequest(ctx);
    return jsonSuccess(await registerClient({ db: ctx.db, bridgeToken, body }), ctx.requestId, {
      status: 201,
    });
  }

  if (matches(ctx, segments, "GET", ["authorize"])) {
    return authorizeRedirect({ db: ctx.db, env: ctx.env, url: ctx.url });
  }

  if (matches(ctx, segments, "POST", ["token"])) {
    const body = await readFormOrJson(ctx.request);
    return jsonSuccess(
      await exchangeToken({
        db: ctx.db,
        env: ctx.env,
        body,
        authorizationHeader: ctx.request.headers.get("authorization"),
      }),
      ctx.requestId,
    );
  }

  if (matches(ctx, segments, "POST", ["revoke"])) {
    const body = await readFormOrJson(ctx.request);
    return jsonSuccess(await revokeToken({ db: ctx.db, body }), ctx.requestId);
  }

  throw new McpHttpError(404, "not_found", "Unknown OAuth route");
}

async function routeMcpTransport(ctx: RouteContext, bridgeToken: string) {
  const startedAt = Date.now();
  if (!["GET", "POST", "DELETE"].includes(ctx.request.method)) {
    throw new McpHttpError(405, "method_not_allowed", "Method not allowed");
  }

  const bridge = await findBridgeByToken(ctx.db, bridgeToken);
  if (!bridge) throw new McpHttpError(404, "not_found", "Bridge not found");

  const resourceMetadata = protectedResourceMetadataUrl(ctx.env, "bridge", bridgeToken);
  const auth = await authenticateWithChallenge(ctx, bridge, resourceMetadata);

  await enforceRateLimits(ctx, bridge, auth, startedAt);
  await updateBridgeLastUsed(ctx.db, bridge.id);
  const requireScope = (scope: string) => requireBridgeScope(auth, scope, resourceMetadata);

  if (ctx.request.method === "GET") {
    requireScope("mcp.bridge.connect");
    await recordTransportEvent(ctx, bridge, auth, {
      eventType: "connect",
      statusClass: "ok",
      startedAt,
    });
    return sseFallback(ctx, bridge);
  }

  if (ctx.request.method === "DELETE") {
    requireScope("mcp.bridge.connect");
    await recordTransportEvent(ctx, bridge, auth, {
      eventType: "disconnect",
      statusClass: "ok",
      startedAt,
    });
    return new Response(null, { status: 204, headers: { "X-Ravi-Request-Id": ctx.requestId } });
  }

  const body = await readJsonBody(ctx.request);
  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;
  requireScope(requiredScopeForMcpMethod(method));

  if (method === "initialize") {
    await recordTransportEvent(ctx, bridge, auth, {
      eventType: "initialize",
      statusClass: "ok",
      startedAt,
    });
    return mcpJson(ctx, {
      jsonrpc: "2.0",
      id,
      result: {
        ...bridgeCapabilities(bridge),
        instructions: "Ravi MCP Bridges Phase 1 transport is online. Daemon-side routing lands in Phase 2.",
      },
    });
  }

  if (method === "ping") {
    return mcpJson(ctx, { jsonrpc: "2.0", id, result: {} });
  }

  if (method === "tools/list") {
    await recordTransportEvent(ctx, bridge, auth, {
      eventType: "tools_list",
      statusClass: "ok",
      startedAt,
    });
    return mcpJson(ctx, {
      jsonrpc: "2.0",
      id,
      result: { tools: toolsFromCache(bridge) },
    });
  }

  await recordTransportEvent(ctx, bridge, auth, {
    eventType: eventTypeForMcpMethod(method),
    statusClass: "upstream_unavailable",
    startedAt,
    toolName: toolNameFromBody(body),
  });
  return mcpJson(ctx, {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32004,
      message: "MCP bridge daemon is not connected yet.",
    },
  });
}

async function enforceRateLimits(
  ctx: RouteContext,
  bridge: BridgeRecord,
  auth: McpAccessTokenContext,
  startedAt: number,
) {
  const bridgeLimit = rateLimitOverride(
    bridge,
    "bridgePerMinute",
    Number.parseInt(ctx.env.RAVI_MCP_DEFAULT_BRIDGE_RATE_LIMIT_PER_MINUTE, 10) || 120,
  );
  const clientLimit = rateLimitOverride(
    bridge,
    "clientPerHour",
    Number.parseInt(ctx.env.RAVI_MCP_DEFAULT_CLIENT_RATE_LIMIT_PER_HOUR, 10) || 600,
  );
  const bridgeAllowed = await checkRateLimit({
    namespace: ctx.env.RAVI_MCP_RATE_LIMIT_BRIDGE,
    key: `${bridge.id}:${Math.floor(Date.now() / 60_000)}`,
    limit: bridgeLimit,
    windowSeconds: 60,
  });
  const clientAllowed = await checkRateLimit({
    namespace: ctx.env.RAVI_MCP_RATE_LIMIT_CLIENT,
    key: `${bridge.id}:${auth.oauthClientId}:${Math.floor(Date.now() / 3_600_000)}`,
    limit: clientLimit,
    windowSeconds: 3600,
  });
  if (!bridgeAllowed || !clientAllowed) {
    await recordTransportEvent(ctx, bridge, auth, {
      eventType: "rate_limited",
      statusClass: "client_error",
      startedAt,
    });
    throw new McpHttpError(429, "mcp_rate_limited", "Rate limit exceeded");
  }
}

/**
 * Console mode: `/{bridge_token}/console/mcp`. Same bridge, OAuth token, rate
 * limits and telemetry as the daemon path; tools come from the Console
 * operation registry and need the `mcp.console.*` scopes. No server-initiated
 * stream (GET is 405); every answer is a single JSON response.
 */
async function routeConsoleTransport(ctx: RouteContext, bridgeToken: string) {
  const startedAt = Date.now();
  if (!["GET", "POST", "DELETE"].includes(ctx.request.method)) {
    throw new McpHttpError(405, "method_not_allowed", "Method not allowed");
  }

  const bridge = await findBridgeByToken(ctx.db, bridgeToken);
  if (!bridge) throw new McpHttpError(404, "not_found", "Bridge not found");

  const auth = await authenticateWithChallenge(
    ctx,
    bridge,
    protectedResourceMetadataUrl(ctx.env, "console", bridgeToken),
  );
  const consoleCtx = { env: ctx.env, requestId: ctx.requestId, bridge, bridgeToken, auth, fetchImpl: ctx.fetchImpl };
  requireConsoleScope(consoleCtx, CONSOLE_SCOPES.read);

  await enforceRateLimits(ctx, bridge, auth, startedAt);
  await updateBridgeLastUsed(ctx.db, bridge.id);

  if (ctx.request.method === "GET") {
    throw new McpHttpError(405, "method_not_allowed", "This server sends no server-initiated stream", {
      Allow: "POST, DELETE",
    });
  }
  if (ctx.request.method === "DELETE") {
    return new Response(null, { status: 204, headers: { "X-Ravi-Request-Id": ctx.requestId } });
  }

  const body = await readJsonBody(ctx.request);
  const outcome = await handleConsoleJsonRpc(consoleCtx, body);
  if (outcome.event) {
    await recordTransportEvent(ctx, bridge, auth, { ...outcome.event, startedAt });
  }
  if (!outcome.body) {
    return new Response(null, { status: 202, headers: { "X-Ravi-Request-Id": ctx.requestId } });
  }
  return mcpJson(ctx, outcome.body);
}

/** Authenticates the bearer token; a 401 carries the RFC 9728 `resource_metadata` challenge. */
async function authenticateWithChallenge(ctx: RouteContext, bridge: BridgeRecord, resourceMetadata: string) {
  const authorizationHeader = ctx.request.headers.get("authorization");
  try {
    return await authenticateAccessToken({ db: ctx.db, bridge, authorizationHeader });
  } catch (error) {
    if (error instanceof McpHttpError && error.status === 401) {
      const tokenError = authorizationHeader ? ', error="invalid_token"' : "";
      throw error.withHeaders({
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"${tokenError}`,
      });
    }
    throw error;
  }
}

function requireBridgeScope(auth: McpAccessTokenContext, scope: string, resourceMetadata: string): void {
  if (!accessTokenAllowsScope(auth, scope)) {
    throw new McpHttpError(403, "mcp_forbidden", `OAuth scope required: ${scope}`, {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadata}"`,
    });
  }
}

function requiredScopeForMcpMethod(method: string): string {
  if (method === "tools/list") return "mcp.bridge.tools.read";
  if (method === "tools/call") return "mcp.bridge.tools.invoke";
  if (method.startsWith("resources/")) return "mcp.bridge.resources.read";
  if (method.startsWith("prompts/")) return "mcp.bridge.prompts.read";
  return "mcp.bridge.connect";
}

function eventTypeForMcpMethod(method: string): McpBridgeEventType {
  if (method === "tools/call") return "tools_call";
  if (method.startsWith("resources/")) return "resources_read";
  if (method.startsWith("prompts/")) return "prompts_get";
  return "daemon_offline";
}

async function recordTransportEvent(
  ctx: RouteContext,
  bridge: BridgeRecord,
  auth: McpAccessTokenContext,
  input: {
    eventType: McpBridgeEventType;
    statusClass: McpBridgeEventStatusClass;
    startedAt: number;
    toolName?: string | null;
  },
) {
  await insertBridgeEvent(ctx.db, {
    bridge,
    eventType: input.eventType,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    statusClass: input.statusClass,
    requestId: ctx.requestId,
    oauthClientId: auth.oauthClientId,
    clientUserAgent: ctx.request.headers.get("user-agent"),
    toolName: input.toolName,
  });
}

function rateLimitOverride(bridge: BridgeRecord, key: string, fallback: number) {
  const value = bridge.rateLimitOverridesJson?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mcpJson(ctx: RouteContext, body: unknown) {
  const sessionId = ctx.request.headers.get("mcp-session-id") ?? randomSessionId();
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
      "X-Ravi-Request-Id": ctx.requestId,
    },
  });
}

function sseFallback(ctx: RouteContext, bridge: BridgeRecord) {
  const sessionId = ctx.request.headers.get("mcp-session-id") ?? randomSessionId();
  const body = [
    "event: endpoint",
    `data: ${JSON.stringify({ endpoint: `/${bridge.id}/mcp`, bridgeId: bridge.id })}`,
    "",
    "event: ping",
    `data: ${JSON.stringify({ ok: true })}`,
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Mcp-Session-Id": sessionId,
      "X-Ravi-Request-Id": ctx.requestId,
    },
  });
}

function toolsFromCache(bridge: BridgeRecord) {
  const tools = bridge.cachedToolsJson?.tools;
  return Array.isArray(tools) ? tools : [];
}

function toolNameFromBody(body: Record<string, unknown>): string | null {
  const params = body.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name : null;
}

function handleError(error: unknown, requestId: string) {
  if (error instanceof McpHttpError) return jsonError(error.status, error.code, requestId, error.headers);
  return jsonError(500, "internal_error", requestId);
}

function matches(ctx: RouteContext, segments: string[], method: string, pattern: string[]) {
  if (ctx.request.method !== method || segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part === segments[index]);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new McpHttpError(400, "payload_invalid", "Body is not valid JSON");
  }
}

async function readFormOrJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return readJsonBody(request);
}

function bridgeTokenFromRequest(ctx: RouteContext) {
  const direct = ctx.url.searchParams.get("bridge_token");
  if (direct) return direct;
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  return segments.length === 3 && segments[2] === "register" ? ctx.url.searchParams.get("bridge") : null;
}

function randomSessionId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
  scheduled?(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> | void;
}
