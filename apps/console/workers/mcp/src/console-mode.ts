// Console mode of mcp.ravi.so (`/{bridge_token}/console/mcp`): an MCP server
// whose tools are the Console operation registry, run as the person the
// access token belongs to. The Worker only authenticates, maps tool names and
// proxies to the Console with the Worker HMAC; the Console re-checks the
// membership, runs the operation and owns the write confirmation.
// See `.ravi/specs/console/mcp-bridges/SPEC.md` (Console mode).

import type { BridgeRecord, McpBridgeEventStatusClass, McpBridgeEventType } from "./db";
import type { McpWorkerEnv } from "./env";
import { McpHttpError } from "./errors";
import { signConsoleRequest } from "./hmac";
import { CONSOLE_SCOPES, protectedResourceMetadataUrl, type McpAccessTokenContext } from "./oauth";

export const CONSOLE_TOOLS_LIST_PATH = "/api/internal/mcp/console/tools/list";
export const CONSOLE_TOOLS_CALL_PATH = "/api/internal/mcp/console/tools/call";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const CONSOLE_TIMEOUT_MS = 25_000;

const CONSOLE_INSTRUCTIONS =
  "Ravi Console tools run as you, with your own access to projects, Pages and Bases in this organization. Read tools run at once. Tools that change data return a preview and a confirmationToken first: show the preview to the person and call the tool again with the same arguments and the token only after they agree. Publishing a page (ravi_pages_ship) follows the same preview rule. Changing an existing page's visibility, invites and deletions are not available here.";

// Registry ids are lowercase dotted (`ravi.bases.views.query`); a segment may
// hold single underscores (`ravi.cloud_agents.runs.get`). Dots are valid in MCP
// tool names, but several clients and model APIs only accept [A-Za-z0-9_-], so
// the tool name doubles each underscore and then swaps dots for underscores
// (`ravi_cloud__agents_runs_get`). Ids without underscores keep their names, and
// the mapping is reversible. `src/server/mcp/console-tools.ts` has the same one.
const SEGMENT = "[a-z0-9]+(?:_[a-z0-9]+)*";
const OPERATION_ID_PATTERN = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})+$`);
const TOOL_NAME_PATTERN = /^[a-z0-9_]+$/;

export function toolNameForOperationId(operationId: string): string | null {
  if (operationId.length > 128 || !OPERATION_ID_PATTERN.test(operationId)) return null;
  return operationId.replaceAll("_", "__").replaceAll(".", "_");
}

/** The registry id a tool name stands for; the dotted id itself is accepted too. */
export function operationIdForToolName(name: string): string | null {
  if (name.length > 128) return null;
  if (OPERATION_ID_PATTERN.test(name)) return name;
  if (!TOOL_NAME_PATTERN.test(name)) return null;
  const operationId = name
    .split("__")
    .map((part) => part.replaceAll("_", "."))
    .join("_");
  return OPERATION_ID_PATTERN.test(operationId) && toolNameForOperationId(operationId) === name ? operationId : null;
}

export type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export type ConsoleModeContext = {
  env: McpWorkerEnv;
  requestId: string;
  bridge: BridgeRecord;
  bridgeToken: string;
  auth: McpAccessTokenContext;
  fetchImpl?: typeof fetch;
};

export type ConsoleModeOutcome = {
  /** null for a notification or a client response: answer 202 with no body. */
  body: JsonRpcResponse | null;
  event: { eventType: McpBridgeEventType; statusClass: McpBridgeEventStatusClass; toolName?: string | null } | null;
};

/** 403 with the RFC 6750 / MCP scope challenge, so the client can ask the person for more scope. */
export function consoleInsufficientScope(env: McpWorkerEnv, bridgeToken: string, scope: string) {
  return new McpHttpError(403, "insufficient_scope", `OAuth scope required: ${scope}`, {
    "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${protectedResourceMetadataUrl(env, "console", bridgeToken)}"`,
  });
}

export function requireConsoleScope(ctx: Pick<ConsoleModeContext, "env" | "bridgeToken" | "auth">, scope: string) {
  if (!ctx.auth.scopes.includes(scope)) throw consoleInsufficientScope(ctx.env, ctx.bridgeToken, scope);
}

/** Handles one JSON-RPC message on the Console endpoint. */
export async function handleConsoleJsonRpc(
  ctx: ConsoleModeContext,
  message: Record<string, unknown>,
): Promise<ConsoleModeOutcome> {
  const method = typeof message.method === "string" ? message.method : null;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = normalizeId(message.id);

  // Notifications (`notifications/initialized`, cancellations) and client
  // responses carry nothing for the Console to do.
  if (!method || !hasId) return { body: null, event: null };

  requireConsoleScope(ctx, CONSOLE_SCOPES.read);
  const params = record(message.params);

  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    return {
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ravi-console", title: "Ravi Console", version: "0.1.0" },
          instructions: CONSOLE_INSTRUCTIONS,
        },
      },
      event: { eventType: "initialize", statusClass: "ok" },
    };
  }

  if (method === "ping") return { body: { jsonrpc: "2.0", id, result: {} }, event: null };

  if (method === "tools/list") return listTools(ctx, id);
  if (method === "tools/call") return callTool(ctx, id, params);

  return {
    body: rpcError(id, -32601, `Method not found: ${method}`),
    event: { eventType: "error", statusClass: "client_error" },
  };
}

async function listTools(ctx: ConsoleModeContext, id: JsonRpcId): Promise<ConsoleModeOutcome> {
  const response = await callConsole(ctx, CONSOLE_TOOLS_LIST_PATH, callerPayload(ctx));
  if (response.status !== 200) {
    return protocolFailure(ctx, id, response, "tools_list");
  }
  const tools: unknown[] = [];
  for (const raw of Array.isArray(response.body.tools) ? response.body.tools : []) {
    const tool = record(raw);
    const name = typeof tool.operationId === "string" ? toolNameForOperationId(tool.operationId) : null;
    if (!name) continue;
    tools.push({
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object" },
      annotations: tool.annotations,
    });
  }
  return { body: { jsonrpc: "2.0", id, result: { tools } }, event: { eventType: "tools_list", statusClass: "ok" } };
}

async function callTool(
  ctx: ConsoleModeContext,
  id: JsonRpcId,
  params: Record<string, unknown>,
): Promise<ConsoleModeOutcome> {
  const name = typeof params.name === "string" ? params.name : "";
  const operationId = operationIdForToolName(name);
  const toolName = name.slice(0, 200) || null;
  if (!operationId) {
    return {
      body: rpcError(id, -32602, `Unknown tool: ${name.slice(0, 128)}`),
      event: { eventType: "tools_call", statusClass: "client_error", toolName },
    };
  }
  const args = params.arguments;
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
    return {
      body: rpcError(id, -32602, "Tool arguments must be an object"),
      event: { eventType: "tools_call", statusClass: "client_error", toolName },
    };
  }

  const response = await callConsole(ctx, CONSOLE_TOOLS_CALL_PATH, {
    ...callerPayload(ctx),
    operationId,
    arguments: (args as Record<string, unknown> | undefined) ?? {},
  });
  const event = (statusClass: McpBridgeEventStatusClass) => ({ eventType: "tools_call" as const, statusClass, toolName });

  if (response.status === 200) {
    const body = response.body;
    if (body.status === "confirmation_required") {
      return { body: { jsonrpc: "2.0", id, result: previewResult(name, body) }, event: event("ok") };
    }
    return { body: { jsonrpc: "2.0", id, result: outputResult(body.output) }, event: event("ok") };
  }

  const code = typeof response.body.error === "string" ? response.body.error : "operation_unavailable";
  if (response.status === 404 && code === "operation_not_found") {
    return { body: rpcError(id, -32602, `Unknown tool: ${name}`), event: event("client_error") };
  }
  if (response.status === 403 && code === "scope_required") {
    const scope = typeof response.body.reason === "string" ? response.body.reason : CONSOLE_SCOPES.write;
    throw consoleInsufficientScope(ctx.env, ctx.bridgeToken, scope);
  }
  const toolError = TOOL_ERROR_TEXT[code];
  if (toolError) {
    return {
      body: { jsonrpc: "2.0", id, result: errorResult(code, toolError, response.body) },
      event: event(response.status >= 500 ? "server_error" : "client_error"),
    };
  }
  return protocolFailure(ctx, id, response, "tools_call", toolName);
}

/** Registry and confirmation errors the model can act on: a tool result with `isError: true`. */
const TOOL_ERROR_TEXT: Record<string, string> = {
  payload_invalid: "The arguments are not valid for this tool. Check fieldErrors, fix the arguments and call again.",
  operation_forbidden: "The person does not have access to do this (project, view or feature). Nothing changed.",
  operation_confirmation_required:
    "This tool changes data and needs the person's confirmation. Call it without confirmationToken to get a preview first.",
  confirmation_invalid:
    "The confirmation token does not match these arguments or this person. Nothing changed. Call again without confirmationToken to get a new preview, and ask the person again.",
  confirmation_expired:
    "The confirmation token expired. Nothing changed. Call again without confirmationToken to get a new preview, and ask the person again.",
  operation_rate_limited: "Too many calls right now. Wait a minute before calling again.",
  cloud_run_write_not_approved:
    "A person has not approved this exact write for this cloud run, or denied it. Nothing changed. Do not retry it; say what you would have done.",
  operation_unavailable:
    "The Console could not finish this call. Try again later; repeating a confirmed call with the same confirmationToken never applies it twice.",
};

function protocolFailure(
  ctx: ConsoleModeContext,
  id: JsonRpcId,
  response: ConsoleResponse,
  eventType: McpBridgeEventType,
  toolName: string | null = null,
): ConsoleModeOutcome {
  const code = typeof response.body.error === "string" ? response.body.error : null;
  if (response.status === 403 && code === "scope_required") {
    const scope = typeof response.body.reason === "string" ? response.body.reason : CONSOLE_SCOPES.read;
    throw consoleInsufficientScope(ctx.env, ctx.bridgeToken, scope);
  }
  if (response.status === 403 && code === "mcp_access_revoked") {
    return {
      body: rpcError(id, -32003, "Your access to this organization or bridge has ended.", { error: code }),
      event: { eventType, statusClass: "client_error", toolName },
    };
  }
  if (response.status === 0) {
    return {
      body: rpcError(id, -32603, "The Ravi Console is unreachable. Try again shortly.", { error: "console_unreachable" }),
      event: { eventType, statusClass: "upstream_unavailable", toolName },
    };
  }
  return {
    body: rpcError(id, -32603, "The Ravi Console could not answer this request.", { error: code ?? "internal_error" }),
    event: { eventType, statusClass: response.status >= 500 || response.status === 401 ? "server_error" : "client_error", toolName },
  };
}

function previewResult(toolName: string, body: Record<string, unknown>) {
  const changes = (Array.isArray(body.changes) ? body.changes : []).map(record).map((line) => ({
    label: String(line.label ?? ""),
    value: String(line.value ?? ""),
  }));
  const token = String(body.confirmationToken ?? "");
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  const lines = [
    `Confirmation needed. ${typeof body.summary === "string" ? body.summary : "Nothing has changed yet."}`,
    ...(changes.length ? ["", "What will change:", ...changes.map((line) => `- ${line.label}: ${line.value}`)] : []),
    "",
    `Show this to the person. Only if they agree, call ${toolName} again with the same arguments plus "confirmationToken": "${token}"${expiresAt ? ` (valid until ${expiresAt})` : ""}.`,
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      status: "confirmation_required",
      operationId: body.operationId,
      changes,
      confirmationToken: token,
      expiresAt,
    },
    isError: false,
  };
}

function outputResult(output: unknown) {
  const structured = output && typeof output === "object" && !Array.isArray(output) ? output : { result: output ?? null };
  return {
    content: [{ type: "text", text: JSON.stringify(output ?? null) }],
    structuredContent: structured,
    isError: false,
  };
}

function errorResult(code: string, text: string, body: Record<string, unknown>) {
  const details: Record<string, unknown> = { error: code };
  if (body.fieldErrors && typeof body.fieldErrors === "object") details.fieldErrors = body.fieldErrors;
  if (typeof body.reason === "string") details.reason = body.reason;
  const fieldLines =
    details.fieldErrors && typeof details.fieldErrors === "object"
      ? Object.entries(details.fieldErrors as Record<string, unknown>).map(([key, value]) => `- ${key}: ${String(value)}`)
      : [];
  const reasonLines = typeof details.reason === "string" ? [details.reason] : [];
  return {
    content: [{ type: "text", text: [`${text} (${code})`, ...reasonLines, ...fieldLines].join("\n") }],
    structuredContent: details,
    isError: true,
  };
}

function callerPayload(ctx: ConsoleModeContext) {
  return {
    organizationId: ctx.bridge.organizationId,
    userId: ctx.auth.subjectUserId,
    bridgeId: ctx.bridge.id,
    scopes: ctx.auth.scopes,
    // Lets the Console tell which cloud run a run token belongs to.
    tokenId: ctx.auth.tokenId,
  };
}

type ConsoleResponse = { status: number; body: Record<string, unknown> };

/** POSTs to a Console internal route with the Worker HMAC. Status 0 means the Console was unreachable. */
async function callConsole(ctx: ConsoleModeContext, path: string, payload: unknown): Promise<ConsoleResponse> {
  const bodyText = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "X-Request-Id": ctx.requestId,
    ...(await signConsoleRequest({ env: ctx.env, method: "POST", path, bodyText })),
  };
  const fetchImpl = ctx.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${ctx.env.RAVI_CONSOLE_BASE_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: bodyText,
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(CONSOLE_TIMEOUT_MS) : undefined,
    });
  } catch {
    return { status: 0, body: {} };
  }
  let body: Record<string, unknown> = {};
  try {
    body = record(await response.json());
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function normalizeId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
