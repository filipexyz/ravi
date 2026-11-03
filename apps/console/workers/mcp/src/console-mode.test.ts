import { describe, expect, it } from "bun:test";

import { operationIdForToolName, toolNameForOperationId } from "./console-mode";
import { hmacSha256Base64, sha256Hex } from "./crypto";
import type { OAuthAccessTokenRecord } from "./db";
import { handleMcpRequest } from "./index";
import {
  BRIDGE_TOKEN,
  makeAccessToken,
  makeBridge,
  makeEnv,
  makeFakeDb,
} from "./test-support";

const CONSOLE_URL = `https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`;
const DAEMON_URL = `https://mcp.ravi.so/${BRIDGE_TOKEN}/mcp`;
const CONSOLE_PRM = `https://mcp.ravi.so/.well-known/oauth-protected-resource/${BRIDGE_TOKEN}/console/mcp`;

type ConsoleCall = { url: string; headers: Headers; body: Record<string, unknown> };

function setup(input: {
  token?: OAuthAccessTokenRecord | null;
  console?: (call: ConsoleCall) => Response | Promise<Response>;
} = {}) {
  const bridge = makeBridge();
  const token = input.token === undefined ? makeAccessToken() : input.token;
  const db = makeFakeDb([
    { match: "from mcp_bridges", rows: [bridge] },
    { match: "from mcp_oauth_tokens token", rows: token ? [token] : [] },
  ]);
  const consoleCalls: ConsoleCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    consoleCalls.push(call);
    if (!input.console) return Response.json({ error: "not_configured" }, { status: 500 });
    return input.console(call);
  }) as typeof fetch;
  const env = makeEnv();
  const send = (url: string, body?: unknown, init: { method?: string; authorization?: string | null } = {}) => {
    const headers = new Headers({ "content-type": "application/json" });
    const authorization = init.authorization === undefined ? "Bearer mcp_at_secret" : init.authorization;
    if (authorization) headers.set("authorization", authorization);
    return handleMcpRequest({
      request: new Request(url, {
        method: init.method ?? "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      db,
      requestId: "req_test",
      fetchImpl,
    });
  };
  return { bridge, db, env, consoleCalls, send };
}

const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("Console mode tool names", () => {
  it("maps registry ids to client-safe tool names and back", () => {
    expect(toolNameForOperationId("ravi.bases.views.rows.create")).toBe("ravi_bases_views_rows_create");
    expect(operationIdForToolName("ravi_bases_views_rows_create")).toBe("ravi.bases.views.rows.create");
    expect(operationIdForToolName("ravi.bases.views.query")).toBe("ravi.bases.views.query");
    expect(toolNameForOperationId("Ravi.Bad_id")).toBeNull();
    expect(operationIdForToolName("../etc")).toBeNull();
    expect(operationIdForToolName("single")).toBeNull();
  });

  it("keeps ids with underscores reversible by doubling them", () => {
    expect(toolNameForOperationId("ravi.cloud_agents.runs.get")).toBe("ravi_cloud__agents_runs_get");
    expect(operationIdForToolName("ravi_cloud__agents_runs_get")).toBe("ravi.cloud_agents.runs.get");
    expect(operationIdForToolName("ravi.cloud_agents.runs.start")).toBe("ravi.cloud_agents.runs.start");
    expect(operationIdForToolName("ravi_cloud___agents")).toBeNull();
    expect(operationIdForToolName("ravi__x")).toBeNull();
    expect(toolNameForOperationId("ravi.bad__id")).toBeNull();
  });
});

describe("Console mode transport", () => {
  it("challenges a request without a token with the Console resource metadata", async () => {
    const { send } = setup();
    const response = await send(CONSOLE_URL, rpc("initialize"), { authorization: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${CONSOLE_PRM}"`);
  });

  it("marks a rejected token as invalid_token in the challenge", async () => {
    const { send } = setup({ token: null });
    const response = await send(CONSOLE_URL, rpc("initialize"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${CONSOLE_PRM}", error="invalid_token"`,
    );
  });

  it("refuses a daemon-only token with an insufficient_scope challenge", async () => {
    const { send, consoleCalls } = setup({
      token: makeAccessToken({ scopesJson: ["mcp.bridge.connect", "mcp.bridge.tools.read", "mcp.bridge.tools.invoke"] }),
    });
    const response = await send(CONSOLE_URL, rpc("tools/list"));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="mcp.console.tools.read", resource_metadata="${CONSOLE_PRM}"`,
    );
    expect(consoleCalls).toHaveLength(0);
  });

  it("initializes as the Ravi Console server and answers notifications with 202", async () => {
    const { send } = setup();
    const response = await send(CONSOLE_URL, rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ravi-console" },
    });

    const notification = await send(CONSOLE_URL, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);

    const unknown = await send(CONSOLE_URL, rpc("resources/list"));
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("GET has no server stream on the Console endpoint", async () => {
    const { send } = setup();
    const response = await send(CONSOLE_URL, undefined, { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("tools/list proxies to the Console with the HMAC and the token's identity, and maps names", async () => {
    const { send, consoleCalls, bridge, env } = setup({
      console: () =>
        Response.json({
          tools: [
            {
              operationId: "ravi.bases.views.query",
              title: "Query a view",
              description: "Reads rows",
              class: "read",
              inputSchema: { type: "object", properties: { project: { type: "string" } } },
              annotations: { title: "Query a view", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
            { operationId: "not valid id", title: "x", description: "x", inputSchema: { type: "object" } },
          ],
        }),
    });
    const response = await send(CONSOLE_URL, rpc("tools/list"));
    const body = (await response.json()) as { result: { tools: Array<Record<string, unknown>> } };
    expect(body.result.tools).toEqual([
      {
        name: "ravi_bases_views_query",
        title: "Query a view",
        description: "Reads rows",
        inputSchema: { type: "object", properties: { project: { type: "string" } } },
        annotations: { title: "Query a view", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ]);

    expect(consoleCalls).toHaveLength(1);
    const call = consoleCalls[0]!;
    expect(call.url).toBe("https://console.ravi.bot/api/internal/mcp/console/tools/list");
    expect(call.body).toEqual({
      organizationId: bridge.organizationId,
      userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      bridgeId: bridge.id,
      scopes: ["mcp.bridge.connect", "mcp.console.tools.read", "mcp.console.tools.write"],
      tokenId: makeAccessToken().id,
    });
    expect(call.headers.get("x-request-id")).toBe("req_test");
    const timestamp = call.headers.get("x-ravi-hmac-timestamp")!;
    const signingString = [timestamp, "POST", "/api/internal/mcp/console/tools/list", await sha256Hex(JSON.stringify(call.body))].join("\n");
    expect(call.headers.get("x-ravi-hmac-key-id")).toBe("worker-k1");
    expect(call.headers.get("x-ravi-hmac-signature")).toBe(
      await hmacSha256Base64({ key: env.RAVI_MCP_WORKER_HMAC_KEY_CURRENT, message: signingString }),
    );
  });

  it("tools/call runs a read and returns its output as text and structured content", async () => {
    const { send, consoleCalls, db } = setup({
      console: () => Response.json({ status: "ok", operationId: "ravi.bases.views.query", class: "read", output: { rows: [] } }),
    });
    const response = await send(
      CONSOLE_URL,
      rpc("tools/call", { name: "ravi_bases_views_query", arguments: { project: "demo", viewId: "v1" } }),
    );
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ rows: [] }) }],
      structuredContent: { rows: [] },
      isError: false,
    });
    expect(consoleCalls[0]!.body).toMatchObject({
      operationId: "ravi.bases.views.query",
      arguments: { project: "demo", viewId: "v1" },
    });
    const event = db.queries.find((query) => query.query.includes("insert into mcp_bridge_events"));
    expect(event?.values).toContain("tools_call");
    expect(event?.values).toContain("ravi_bases_views_query");
    expect(JSON.stringify(event?.values)).not.toContain("v1");
  });

  it("a write returns the preview and token as a normal result the client shows to the person", async () => {
    const { send } = setup({
      console: () =>
        Response.json({
          status: "confirmation_required",
          operationId: "ravi.bases.views.rows.create",
          class: "write",
          summary: "Create a row. Nothing has changed yet.",
          changes: [{ label: "name", value: "Ana" }],
          confirmationToken: "rmc1.payload.sig",
          expiresAt: "2026-10-18T12:05:00.000Z",
        }),
    });
    const response = await send(
      CONSOLE_URL,
      rpc("tools/call", { name: "ravi_bases_views_rows_create", arguments: { project: "demo", viewId: "v1", values: { name: "Ana" } } }),
    );
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError: boolean };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({
      status: "confirmation_required",
      operationId: "ravi.bases.views.rows.create",
      changes: [{ label: "name", value: "Ana" }],
      confirmationToken: "rmc1.payload.sig",
      expiresAt: "2026-10-18T12:05:00.000Z",
    });
    const text = body.result.content[0]!.text;
    expect(text).toContain("- name: Ana");
    expect(text).toContain("Show this to the person");
    expect(text).toContain('"confirmationToken": "rmc1.payload.sig"');
  });

  it("maps registry errors to tool errors, unknown tools to -32602 and a missing write scope to a challenge", async () => {
    const replies: Response[] = [
      Response.json({ error: "operation_forbidden", reason: "Only owners, admins and developers publish Pages." }, { status: 403 }),
      Response.json({ error: "payload_invalid", fieldErrors: { viewId: "Required" } }, { status: 400 }),
      Response.json({ error: "confirmation_expired" }, { status: 409 }),
      Response.json({ error: "operation_not_found" }, { status: 404 }),
      Response.json({ error: "scope_required", reason: "mcp.console.tools.write" }, { status: 403 }),
      Response.json({ error: "mcp_access_revoked" }, { status: 403 }),
    ];
    const { send } = setup({ console: () => replies.shift()! });
    const call = () => send(CONSOLE_URL, rpc("tools/call", { name: "ravi_bases_views_rows_create", arguments: {} }));

    const forbidden = (await (await call()).json()) as {
      result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> };
    };
    expect(forbidden.result.isError).toBe(true);
    expect(forbidden.result.structuredContent).toEqual({
      error: "operation_forbidden",
      reason: "Only owners, admins and developers publish Pages.",
    });
    expect(forbidden.result.content[0]!.text).toContain("Only owners, admins and developers publish Pages.");

    const invalid = (await (await call()).json()) as { result: { content: Array<{ text: string }>; structuredContent: unknown } };
    expect(invalid.result.structuredContent).toEqual({ error: "payload_invalid", fieldErrors: { viewId: "Required" } });
    expect(invalid.result.content[0]!.text).toContain("- viewId: Required");

    const expired = (await (await call()).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(expired.result.isError).toBe(true);
    expect(expired.result.content[0]!.text).toContain("ask the person again");

    const notFound = (await (await call()).json()) as { error: { code: number } };
    expect(notFound.error.code).toBe(-32602);

    const scope = await call();
    expect(scope.status).toBe(403);
    expect(scope.headers.get("www-authenticate")).toContain('scope="mcp.console.tools.write"');

    const revoked = (await (await call()).json()) as { error: { code: number; data: unknown } };
    expect(revoked.error).toMatchObject({ code: -32003, data: { error: "mcp_access_revoked" } });
  });

  it("an unknown tool name never reaches the Console, and an unreachable Console is a JSON-RPC error", async () => {
    const { send, consoleCalls } = setup({
      console: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const bad = (await (await send(CONSOLE_URL, rpc("tools/call", { name: "Bad Name!" }))).json()) as {
      error: { code: number };
    };
    expect(bad.error.code).toBe(-32602);
    expect(consoleCalls).toHaveLength(0);

    const down = (await (await send(CONSOLE_URL, rpc("tools/list"))).json()) as { error: { code: number; data: unknown } };
    expect(down.error).toMatchObject({ code: -32603, data: { error: "console_unreachable" } });
  });
});

describe("Daemon bridge transport stays as it was", () => {
  it("still answers tools/call with the daemon-offline error and gains only the auth challenge", async () => {
    const { send, consoleCalls } = setup({
      token: makeAccessToken({ scopesJson: ["mcp.bridge.connect", "mcp.bridge.tools.read", "mcp.bridge.tools.invoke"] }),
    });
    const call = (await (await send(DAEMON_URL, rpc("tools/call", { name: "x" }))).json()) as { error: { code: number } };
    expect(call.error.code).toBe(-32004);
    expect(consoleCalls).toHaveLength(0);

    const unauthenticated = await send(DAEMON_URL, rpc("tools/list"), { authorization: null });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="https://mcp.ravi.so/.well-known/oauth-protected-resource/${BRIDGE_TOKEN}/mcp"`,
    );
  });

  it("Console scopes grant nothing on the daemon path", async () => {
    const { send } = setup();
    const response = await send(DAEMON_URL, rpc("tools/list"));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp.bridge.tools.read"');
  });
});

describe("Authorization metadata", () => {
  it("serves RFC 9728 metadata per MCP server and for the host", async () => {
    const { send } = setup();
    const consoleMeta = await (await send(CONSOLE_PRM, undefined, { method: "GET", authorization: null })).json();
    expect(consoleMeta).toEqual({
      resource: CONSOLE_URL,
      authorization_servers: [`https://mcp.ravi.so/${BRIDGE_TOKEN}`],
      scopes_supported: ["mcp.console.tools.read", "mcp.console.tools.write"],
      bearer_methods_supported: ["header"],
      resource_name: "Ravi Console",
    });

    const daemonMeta = (await (
      await send(`https://mcp.ravi.so/.well-known/oauth-protected-resource/${BRIDGE_TOKEN}/mcp`, undefined, {
        method: "GET",
        authorization: null,
      })
    ).json()) as Record<string, unknown>;
    expect(daemonMeta.resource).toBe(DAEMON_URL);
    expect(daemonMeta.scopes_supported).toContain("mcp.bridge.tools.invoke");

    const hostMeta = (await (
      await send("https://mcp.ravi.so/.well-known/oauth-protected-resource", undefined, { method: "GET", authorization: null })
    ).json()) as Record<string, unknown>;
    expect(hostMeta.resource).toBe("https://mcp.ravi.so");
    expect(hostMeta.authorization_servers).toEqual(["https://mcp.ravi.so"]);
  });

  it("serves a per-bridge issuer whose registration endpoint carries the bridge", async () => {
    const { send } = setup();
    const meta = (await (
      await send(`https://mcp.ravi.so/.well-known/oauth-authorization-server/${BRIDGE_TOKEN}`, undefined, {
        method: "GET",
        authorization: null,
      })
    ).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(`https://mcp.ravi.so/${BRIDGE_TOKEN}`);
    expect(meta.registration_endpoint).toBe(`https://mcp.ravi.so/oauth/mcp/register?bridge_token=${BRIDGE_TOKEN}`);
    expect(meta.token_endpoint).toBe("https://mcp.ravi.so/oauth/mcp/token");
    expect(meta.scopes_supported).toContain("mcp.console.tools.write");
  });
});
