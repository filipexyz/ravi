/**
 * The hand-written 2026-07-28 dispatch of the MCP gateway (spec mcp, Raw
 * Dispatch).
 *
 * `@modelcontextprotocol/client` 2.4.0 has no tasks and no file uploads: its
 * `callTool` throws on a `task` or `upload_required` result, and its typed
 * `request()` does not offer `tasks/*`. Those go through this module, used
 * only for HTTP rows in the modern era whose server declares the tasks or the
 * files extension (`mcpUsesRawDispatch`).
 *
 * Wire (one JSON-RPC POST per request, no session):
 * - headers `content-type: application/json`, `accept: application/json,
 *   text/event-stream`, `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, and
 *   `Mcp-Name` (`params.name` for `tools/call`, `params.uri` for
 *   `resources/read`, `params.taskId` for `tasks/*`), plus the bearer of the
 *   row's stored login;
 * - `params._meta` carries the envelope under the SDK's own key constants:
 *   protocol version, client info and client capabilities. The capabilities
 *   are fixed for the life of one dispatcher, so every request of one logical
 *   call declares the same extensions: `io.modelcontextprotocol/tasks: {}`
 *   when the server advertises tasks, `io.modelcontextprotocol/files:
 *   {upload: {}}` only when uploads are on for the attachment and the server
 *   advertises `files.upload` (a bare `{}` is ignored by servers).
 * - the answer is plain JSON or an SSE stream; the first message that carries
 *   the request's id is the answer.
 *
 * Results of `tools/call`: `complete`, `input_required`, `task` and
 * `upload_required`, read whether or not they carry `content` (the Console
 * sends none on `task` and `upload_required`). `input_required` is never
 * answered here: `callMcpToolRaw` runs the one shared loop (`input-loop.ts`).
 *
 * Failures are `McpRawDispatchError` with a kind and `outcomeUnknown`: true
 * when the server may have run the request (a transport failure after the
 * request left, a timeout, a 5xx, an unreadable answer). A `tools/call` whose
 * outcome is unknown MUST NOT be sent again; this module never resends one,
 * except once after a 401 (the server ran nothing), with a refreshed token.
 * HTTP 429 is `rate_limited` with the server's `Retry-After`: a back-off, not
 * a failure, and never retried here. `ping` and `initialize` are refused
 * locally (a modern server answers 404 `-32601` to them).
 *
 * Nothing that leaves this module carries the URL, a header, the bearer or the
 * request body: error texts pass `safeMcpErrorText` with the row's secrets.
 */

import {
  type AuthProvider,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type ElicitResult,
  type FetchLike,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";

import {
  classifyMcpFailure,
  MCP_CLIENT_INFO,
  MCP_DEFAULT_RETRY_AFTER_MS,
  MCP_MODERN_PROTOCOL_VERSION,
  McpConnectionError,
  type McpFailureKind,
  McpLoginRequired,
  mcpChallengeScopes,
  parseMcpRetryAfter,
  safeMcpErrorText,
} from "./connections.js";
import { type McpInputAnswer, runMcpInputRequiredLoop } from "./input-loop.js";
import { mcpDisplayUrl, parseMcpServerUrl } from "./names.js";
import { createMcpAuthProvider } from "./oauth-provider.js";
import type { McpServerRecord } from "./registry-db.js";
import { type McpServerSecret, readMcpServerSecret } from "./secrets.js";

import {
  MCP_FILES_EXTENSION,
  MCP_TASKS_EXTENSION,
  mcpServerDeclaresFileUpload,
  mcpServerDeclaresTasks,
  mcpUsesRawDispatch,
} from "./extensions.js";
import { mcpLoginCommand } from "./login-options.js";

export {
  MCP_FILES_EXTENSION,
  MCP_TASKS_EXTENSION,
  mcpServerDeclaresFileUpload,
  mcpServerDeclaresTasks,
  mcpUsesRawDispatch,
} from "./extensions.js";
/** The longest one raw request may take when the caller gives no timeout. */
export const MCP_RAW_DEFAULT_TIMEOUT_MS = 60_000;
/** The largest answer body read; a larger one is unreadable (outcome unknown). */
export const MCP_RAW_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Retry-After bounds and default (ms), shared with the SDK path (`connections.ts`). */
export {
  MCP_DEFAULT_RETRY_AFTER_MS as MCP_RAW_DEFAULT_RETRY_AFTER_MS,
  MCP_MAX_RETRY_AFTER_MS as MCP_RAW_MAX_RETRY_AFTER_MS,
  MCP_MIN_RETRY_AFTER_MS as MCP_RAW_MIN_RETRY_AFTER_MS,
  parseMcpRetryAfter,
} from "./connections.js";
const TASK_ID_MAX = 200;
const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_EXTENSION_KEY = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;
/** Methods that do not exist on 2026-07-28 and are never sent on a modern row. */
const REFUSED_METHODS = new Set(["ping", "initialize", "notifications/initialized"]);

// ============================================================================
// Errors
// ============================================================================

export type McpRawErrorKind =
  /** A JSON-RPC error not listed below. */
  | "protocol"
  /** -32020: headers missing or disagreeing with the body. */
  | "header_mismatch"
  /** -32021: the request lacks a client capability the server needs. */
  | "missing_capability"
  /** -32022: the server does not speak this protocol revision. */
  | "unsupported_version"
  /** -32601: the method does not exist on the server. */
  | "method_not_found"
  /** -32602: invalid params (unknown tool or task, invalid requestState). */
  | "invalid_params"
  /** 401 twice, or a login the daemon cannot use or refresh. */
  | "needs_login"
  /** 403 `insufficient_scope`: the login lacks a scope; only a new login widens it. */
  | "insufficient_scope"
  /** Any other 403. */
  | "forbidden"
  /** 429: back off until `retryAfterMs`. */
  | "rate_limited"
  /** Another HTTP status without a JSON-RPC answer. */
  | "http"
  /** The answer could not be read as the request's JSON-RPC answer. */
  | "invalid_response"
  | "timeout"
  | "cancelled"
  /** The request may have left, and no answer came back. */
  | "transport"
  /** Refused before anything was sent (a method or name Ravi never sends). */
  | "invalid_request";

export class McpRawDispatchError extends Error {
  readonly kind: McpRawErrorKind;
  /** The server may have run the request. A `tools/call` with this set is never sent again. */
  readonly outcomeUnknown: boolean;
  readonly httpStatus: number | null;
  /** The JSON-RPC error code, when the server sent one. */
  readonly code: number | null;
  /** A fixed code from `error.data` (`reason` or `error`), when it is a plain identifier. */
  readonly dataCode: string | null;
  /** 429: how long to wait before the next request to this server. */
  readonly retryAfterMs: number | null;
  /** -32021: the extension names the server says it needs. */
  readonly requiredExtensions: readonly string[];
  /** 403 `insufficient_scope`: the scopes the challenge names (plain scope tokens only). */
  readonly requiredScopes: readonly string[];

  constructor(input: {
    kind: McpRawErrorKind;
    message: string;
    outcomeUnknown: boolean;
    httpStatus?: number | null;
    code?: number | null;
    dataCode?: string | null;
    retryAfterMs?: number | null;
    requiredExtensions?: readonly string[];
    requiredScopes?: readonly string[];
  }) {
    super(input.message);
    this.name = "McpRawDispatchError";
    this.kind = input.kind;
    this.outcomeUnknown = input.outcomeUnknown;
    this.httpStatus = input.httpStatus ?? null;
    this.code = input.code ?? null;
    this.dataCode = input.dataCode ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.requiredExtensions = input.requiredExtensions ?? [];
    this.requiredScopes = input.requiredScopes ?? [];
  }
}

/**
 * What a raw failure means for the row, in the terms of `classifyMcpFailure`
 * (which it falls back to for any other error).
 */
export function classifyMcpRawFailure(error: unknown, server: Pick<McpServerRecord, "authKind">): McpFailureKind {
  if (!(error instanceof McpRawDispatchError)) return classifyMcpFailure(error, server);
  const hasLogin = server.authKind !== "none";
  switch (error.kind) {
    case "needs_login":
    case "insufficient_scope":
      return hasLogin ? "needs_login" : "refused";
    case "forbidden":
      return "refused";
    case "timeout":
      return "timeout";
    case "unsupported_version":
      return "unsupported_version";
    default:
      return "error";
  }
}

const JSONRPC_KINDS: Record<number, McpRawErrorKind> = {
  [-32020]: "header_mismatch",
  [-32021]: "missing_capability",
  [-32022]: "unsupported_version",
  [-32601]: "method_not_found",
  [-32602]: "invalid_params",
};

/**
 * Whether the server ran nothing for this JSON-RPC error. Errors that come
 * before dispatch (headers, capability, version, method, params) are known;
 * any other code may follow a partial run.
 */
function jsonRpcRanNothing(code: number): boolean {
  return code in JSONRPC_KINDS || code === -32600 || code === -32700;
}

// ============================================================================
// Server selection and the envelope
// ============================================================================

export interface McpRawExtensions {
  tasks: boolean;
  /** Declares `io.modelcontextprotocol/files: {upload: {}}`. */
  filesUpload: boolean;
}

/** The client capabilities of the envelope (`_meta["io.modelcontextprotocol/clientCapabilities"]`). */
export function mcpRawClientCapabilities(extensions: McpRawExtensions): Record<string, unknown> {
  const declared: Record<string, unknown> = {};
  if (extensions.tasks) declared[MCP_TASKS_EXTENSION] = {};
  if (extensions.filesUpload) declared[MCP_FILES_EXTENSION] = { upload: {} };
  return {
    elicitation: { form: {}, url: {} },
    ...(Object.keys(declared).length > 0 ? { extensions: declared } : {}),
  };
}

/** The value of `Mcp-Name` for a request, or null when the method carries none. */
export function mcpRawNameHeader(method: string, params: Record<string, unknown>): string | null {
  if (method === "tools/call" || method === "prompts/get") return typeof params.name === "string" ? params.name : "";
  if (method === "resources/read") return typeof params.uri === "string" ? params.uri : "";
  if (method.startsWith("tasks/")) return typeof params.taskId === "string" ? params.taskId : "";
  return null;
}

// ============================================================================
// Result shapes
// ============================================================================

export type McpRawTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
const TASK_STATUSES = new Set<string>(["working", "input_required", "completed", "failed", "cancelled"]);
export const MCP_TERMINAL_TASK_STATUSES: ReadonlySet<McpRawTaskStatus> = new Set(["completed", "failed", "cancelled"]);

export interface McpRawTask {
  taskId: string;
  status: McpRawTaskStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  /** Milliseconds from creation; null means the server sets no limit; absent when not sent. */
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** `completed`: the tool result (its own `resultType` is `complete`). */
  result?: Record<string, unknown>;
  /** `failed`: the JSON-RPC error the task ended with (code and a safe message). */
  error?: { code: number | null; message: string };
  /** `input_required`: the embedded requests, by key. */
  inputRequests?: Record<string, unknown>;
}

export type McpRawToolResult =
  | { resultType: "complete"; result: Record<string, unknown> }
  | { resultType: "input_required"; inputRequests: Record<string, unknown>; requestState?: string }
  | { resultType: "task"; task: McpRawTask }
  | { resultType: "upload_required"; uploads: unknown[]; requestState: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function invalidResult(message: string, outcomeUnknown = true): McpRawDispatchError {
  return new McpRawDispatchError({ kind: "invalid_response", message, outcomeUnknown });
}

/** A task (a `task` result, or a `tasks/get` answer). Throws `invalid_response` on a shape it cannot use. */
export function parseMcpRawTask(raw: unknown, secrets: readonly string[] = []): McpRawTask {
  const record = asRecord(raw);
  if (!record) throw invalidResult("The MCP server answered a task that is not an object.");
  const taskId = record.taskId;
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > TASK_ID_MAX || !HEADER_VALUE.test(taskId)) {
    throw invalidResult("The MCP server answered a task without a usable task id.");
  }
  const status = record.status;
  if (typeof status !== "string" || !TASK_STATUSES.has(status)) {
    throw invalidResult("The MCP server answered a task with an unknown status.");
  }
  const task: McpRawTask = { taskId, status: status as McpRawTaskStatus };
  if (typeof record.statusMessage === "string") {
    task.statusMessage = safeMcpErrorText(record.statusMessage, secrets);
  }
  if (typeof record.createdAt === "string") task.createdAt = record.createdAt.slice(0, 64);
  if (typeof record.lastUpdatedAt === "string") task.lastUpdatedAt = record.lastUpdatedAt.slice(0, 64);
  if (record.ttlMs === null) task.ttlMs = null;
  else if (typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs >= 0) {
    task.ttlMs = Math.trunc(record.ttlMs);
  }
  if (
    typeof record.pollIntervalMs === "number" &&
    Number.isFinite(record.pollIntervalMs) &&
    record.pollIntervalMs > 0
  ) {
    task.pollIntervalMs = Math.trunc(record.pollIntervalMs);
  }
  if (task.status === "completed") {
    const result = asRecord(record.result);
    if (!result) throw invalidResult("The MCP server answered a completed task without its result.");
    if (result.resultType !== undefined && result.resultType !== "complete") {
      throw invalidResult("The MCP server answered a completed task whose result is not complete.");
    }
    task.result = result;
  }
  if (task.status === "failed") {
    const error = asRecord(record.error);
    task.error = {
      code: typeof error?.code === "number" && Number.isInteger(error.code) ? error.code : null,
      message: safeMcpErrorText(typeof error?.message === "string" ? error.message : "the task failed", secrets),
    };
  }
  if (task.status === "input_required") {
    const inputRequests = asRecord(record.inputRequests);
    if (inputRequests) task.inputRequests = inputRequests;
  }
  return task;
}

/** The result of one `tools/call`. Throws `invalid_response` (outcome unknown) on a type it does not know. */
export function parseMcpRawToolResult(raw: unknown, secrets: readonly string[] = []): McpRawToolResult {
  const record = asRecord(raw);
  if (!record) throw invalidResult("The MCP server answered a tool call with a result that is not an object.");
  const type = record.resultType ?? "complete";
  switch (type) {
    case "complete":
      return { resultType: "complete", result: record };
    case "input_required": {
      const inputRequests = asRecord(record.inputRequests);
      if (!inputRequests) throw invalidResult("The MCP server asked for input without saying what.", false);
      return {
        resultType: "input_required",
        inputRequests,
        ...(typeof record.requestState === "string" ? { requestState: record.requestState } : {}),
      };
    }
    case "task":
      return { resultType: "task", task: parseMcpRawTask(record, secrets) };
    case "upload_required": {
      if (!Array.isArray(record.uploads) || typeof record.requestState !== "string") {
        throw invalidResult("The MCP server asked for an upload without targets or request state.");
      }
      return { resultType: "upload_required", uploads: record.uploads, requestState: record.requestState };
    }
    default:
      throw invalidResult("The MCP server answered a tool call with a result type Ravi does not know.");
  }
}

// ============================================================================
// Answer reading
// ============================================================================

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {
        // no-cause: the oversized answer is refused below either way.
      });
      throw invalidResult("The MCP server's answer is larger than Ravi reads.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function matchesId(message: unknown, id: number): Record<string, unknown> | null {
  const record = asRecord(message);
  if (!record || record.id !== id) return null;
  return "result" in record || "error" in record ? record : null;
}

/** The JSON-RPC answer to `id` in a JSON body (an object, or a batch). */
function answerFromJson(text: string, id: number): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // no-cause: a body that is not JSON holds no answer; the caller reports it without its text.
    return null;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = matchesId(item, id);
      if (found) return found;
    }
    return null;
  }
  return matchesId(parsed, id);
}

/**
 * The JSON-RPC answer to `id` in an SSE stream: events are read as they come,
 * notifications and other ids are skipped, and the stream is closed as soon
 * as the answer is in.
 */
async function answerFromSse(
  response: Response,
  id: number,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let data: string[] = [];
  const dispatch = (): Record<string, unknown> | null => {
    if (data.length === 0) return null;
    const payload = data.join("\n");
    data = [];
    return answerFromJson(payload, id);
  };
  const line = (raw: string): Record<string, unknown> | null => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return dispatch();
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw invalidResult("The MCP server's answer is larger than Ravi reads.");
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const found = line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (found) return found;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const found = line(buffer);
      if (found) return found;
    }
    return dispatch();
  } finally {
    await reader.cancel().catch(() => {
      // no-cause: the stream is done with; a failed cancel leaves nothing to clean up.
    });
  }
}

function safeDataCode(data: Record<string, unknown> | null): string | null {
  const value = data?.reason ?? data?.error;
  return typeof value === "string" && SAFE_CODE.test(value) ? value : null;
}

function requiredExtensions(data: Record<string, unknown> | null): string[] {
  const capabilities = asRecord(data?.requiredCapabilities);
  const extensions = asRecord(capabilities?.extensions);
  const names = extensions ? Object.keys(extensions).filter((key) => SAFE_EXTENSION_KEY.test(key)) : [];
  if (capabilities?.elicitation) names.push("elicitation");
  return names.sort();
}

// ============================================================================
// Dispatcher
// ============================================================================

export interface McpRawTarget {
  /** The row's name (for error texts). */
  server: string;
  /** The full URL (from the credentials store; never shown). */
  url: URL;
  /** The row's stored login, or null for an `auth none` row. */
  auth: AuthProvider | null;
  /** Values removed from every error text (the full URL, tokens). */
  secrets?: readonly string[];
}

export interface McpRawDispatcherOptions {
  extensions: McpRawExtensions;
  fetch?: typeof fetch;
  now?: () => number;
  maxResponseBytes?: number;
}

interface SentRequest {
  response: Response;
  id: number;
  /** The request's own signal (the caller's, joined with its timeout). */
  signal: AbortSignal;
}

export interface McpRawRequestOptions {
  signal?: AbortSignal;
  /** Default 60 s. */
  timeoutMs?: number;
}

/**
 * One server's raw dispatch, with the capabilities of one logical call fixed
 * at construction. Requests are independent (no session); ids count up per
 * dispatcher.
 */
export class McpRawDispatcher {
  readonly server: string;
  readonly capabilities: Record<string, unknown>;
  private readonly url: URL;
  private readonly auth: AuthProvider | null;
  private readonly secrets: string[];
  private readonly options: McpRawDispatcherOptions;
  private nextId = 1;

  constructor(target: McpRawTarget, options: McpRawDispatcherOptions) {
    this.server = target.server;
    this.url = target.url;
    this.auth = target.auth;
    this.secrets = [target.url.toString(), ...(target.secrets ?? [])].filter((value) => value.length >= 4);
    this.options = options;
    this.capabilities = mcpRawClientCapabilities(options.extensions);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private safe(text: unknown): string {
    return safeMcpErrorText(text, this.secrets);
  }

  /**
   * Send one request and return its `result` object. Throws
   * `McpRawDispatchError` for every failure, and `McpLoginRequired` never: a
   * login problem is the `needs_login` kind.
   */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: McpRawRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (REFUSED_METHODS.has(method)) {
      throw new McpRawDispatchError({
        kind: "invalid_request",
        message: `${method} does not exist on the 2026-07-28 protocol; Ravi does not send it to MCP server ${this.server}.`,
        outcomeUnknown: false,
      });
    }
    const name = mcpRawNameHeader(method, params);
    if (name !== null && (!HEADER_VALUE.test(name) || name.length > 512)) {
      throw new McpRawDispatchError({
        kind: "invalid_request",
        message: `The ${method} request to MCP server ${this.server} has no name Ravi can send as a header.`,
        outcomeUnknown: false,
      });
    }
    // One budget for the request, a resend after a 401 included (real time: the abort timer runs on it).
    const until = Date.now() + Math.max(1, Math.trunc(options.timeoutMs ?? MCP_RAW_DEFAULT_TIMEOUT_MS));
    let token = await this.token();
    for (let attempt = 0; ; attempt++) {
      const sent = await this.post(method, params, name, token, {
        ...options,
        timeoutMs: Math.max(1, until - Date.now()),
      });
      const response = sent.response;
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {
          // no-cause: the 401's body is not read; the status decides.
        });
        if (attempt > 0 || !this.auth) {
          throw new McpRawDispatchError({
            kind: "needs_login",
            message: `MCP server ${this.server} refused the stored login (HTTP 401).`,
            outcomeUnknown: false,
            httpStatus: 401,
          });
        }
        // The server ran nothing. Refresh once (OAuth; a bearer row has nothing to refresh) and send again.
        token = await this.refreshAfterUnauthorized(response);
        continue;
      }
      return this.readAnswer(sent, method);
    }
  }

  private async token(): Promise<string | undefined> {
    if (!this.auth) return undefined;
    try {
      return await this.auth.token();
    } catch (error) {
      throw this.loginFailure(error);
    }
  }

  private async refreshAfterUnauthorized(response: Response): Promise<string | undefined> {
    try {
      // A bearer row's handler throws McpLoginRequired (nothing to refresh); an OAuth row refreshes under its lock.
      await this.auth?.onUnauthorized?.({
        response,
        serverUrl: this.url,
        fetchFn: (this.options.fetch ?? fetch) as FetchLike,
      });
      return await this.auth?.token();
    } catch (error) {
      throw this.loginFailure(error);
    }
  }

  private loginFailure(error: unknown): McpRawDispatchError {
    if (error instanceof McpLoginRequired || (error instanceof McpConnectionError && error.code === "needs_login")) {
      return new McpRawDispatchError({
        kind: "needs_login",
        message: `MCP server ${this.server} needs a login: run ${mcpLoginCommand(this.server)}`,
        outcomeUnknown: false,
      });
    }
    return new McpRawDispatchError({
      kind: "transport",
      message: `The login of MCP server ${this.server} could not be used: ${this.safe(error)}`,
      // Nothing was sent: the token is read before the request leaves.
      outcomeUnknown: false,
    });
  }

  private async post(
    method: string,
    params: Record<string, unknown>,
    name: string | null,
    token: string | undefined,
    options: McpRawRequestOptions,
  ): Promise<SentRequest> {
    const id = this.nextId++;
    const meta = asRecord(params._meta) ?? {};
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...meta,
          [PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { ...MCP_CLIENT_INFO },
          [CLIENT_CAPABILITIES_META_KEY]: this.capabilities,
        },
      },
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_MODERN_PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (name !== null) headers["mcp-name"] = name;
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.signal?.aborted) {
      throw new McpRawDispatchError({
        kind: "cancelled",
        message: `The request to MCP server ${this.server} was cancelled before it was sent.`,
        outcomeUnknown: false,
      });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.trunc(options.timeoutMs ?? MCP_RAW_DEFAULT_TIMEOUT_MS)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await (this.options.fetch ?? fetch)(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      });
      return { response, id, signal };
    } catch (error) {
      throw this.transportFailure(error, options, timeout);
    }
  }

  private transportFailure(error: unknown, options: McpRawRequestOptions, timeout: AbortSignal): McpRawDispatchError {
    if (error instanceof McpRawDispatchError) return error;
    if (options.signal?.aborted) {
      return new McpRawDispatchError({
        kind: "cancelled",
        message: `The request to MCP server ${this.server} was cancelled; its outcome on the server is unknown.`,
        outcomeUnknown: true,
      });
    }
    if (timeout.aborted) {
      return new McpRawDispatchError({
        kind: "timeout",
        message: `MCP server ${this.server} did not answer in time; the outcome on the server is unknown.`,
        outcomeUnknown: true,
      });
    }
    return new McpRawDispatchError({
      kind: "transport",
      message: `The request to MCP server ${this.server} failed: ${this.safe(error)}`,
      outcomeUnknown: true,
    });
  }

  private async readAnswer(sent: SentRequest, method: string): Promise<Record<string, unknown>> {
    const { response, id, signal } = sent;
    const maxBytes = this.options.maxResponseBytes ?? MCP_RAW_MAX_RESPONSE_BYTES;
    const status = response.status;

    if (status === 429) {
      await response.body?.cancel().catch(() => {
        // no-cause: the 429 body is not JSON-RPC; only Retry-After matters.
      });
      const retryAfterMs = parseMcpRetryAfter(response.headers.get("retry-after"), this.now());
      throw new McpRawDispatchError({
        kind: "rate_limited",
        message: `MCP server ${this.server} asks Ravi to slow down (HTTP 429).`,
        outcomeUnknown: false,
        httpStatus: 429,
        retryAfterMs: retryAfterMs ?? MCP_DEFAULT_RETRY_AFTER_MS,
      });
    }
    if (status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      await response.body?.cancel().catch(() => {
        // no-cause: the 403 body is not read; the challenge decides.
      });
      const insufficient = /error\s*=\s*"?insufficient_scope"?/i.test(challenge);
      throw new McpRawDispatchError({
        kind: insufficient ? "insufficient_scope" : "forbidden",
        message: insufficient
          ? `MCP server ${this.server} refused the request: the stored login lacks a scope it needs (insufficient_scope).`
          : `MCP server ${this.server} refused the request (HTTP 403).`,
        outcomeUnknown: false,
        httpStatus: 403,
        ...(insufficient ? { requiredScopes: mcpChallengeScopes(challenge) } : {}),
      });
    }
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {
        // no-cause: a redirect is never followed or read.
      });
      throw new McpRawDispatchError({
        kind: "http",
        message: `MCP server ${this.server} answered with a redirect (HTTP ${status}); Ravi does not follow it.`,
        outcomeUnknown: false,
        httpStatus: status,
      });
    }

    let answer: Record<string, unknown> | null;
    try {
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      answer = contentType.includes("text/event-stream")
        ? await answerFromSse(response, id, maxBytes)
        : answerFromJson(await readCapped(response, maxBytes), id);
    } catch (error) {
      // no-cause: the read error can quote the URL or a token, so only its redacted text leaves this process.
      if (error instanceof McpRawDispatchError) throw error;
      if (signal.aborted) {
        throw new McpRawDispatchError({
          kind:
            signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled",
          message: `The answer of MCP server ${this.server} did not arrive in full; the outcome on the server is unknown.`,
          outcomeUnknown: true,
        });
      }
      throw new McpRawDispatchError({
        kind: "transport",
        message: `The answer of MCP server ${this.server} could not be read: ${this.safe(error)}`,
        outcomeUnknown: true,
      });
    }

    if (answer && "error" in answer) {
      const error = asRecord(answer.error);
      const code = typeof error?.code === "number" && Number.isInteger(error.code) ? error.code : null;
      const data = asRecord(error?.data);
      const kind = code !== null ? (JSONRPC_KINDS[code] ?? "protocol") : "protocol";
      throw new McpRawDispatchError({
        kind,
        message: `MCP server ${this.server} refused ${method}${code !== null ? ` (${code})` : ""}: ${this.safe(error?.message ?? "no message")}`,
        outcomeUnknown: code === null || !jsonRpcRanNothing(code),
        httpStatus: status,
        code,
        dataCode: safeDataCode(data),
        requiredExtensions: code === -32021 ? requiredExtensions(data) : [],
      });
    }
    if (status < 200 || status >= 300) {
      throw new McpRawDispatchError({
        kind: "http",
        message: `MCP server ${this.server} answered HTTP ${status}.`,
        outcomeUnknown: status >= 500,
        httpStatus: status,
      });
    }
    if (!answer) {
      throw invalidResult(
        `MCP server ${this.server} sent no answer to ${method}; the outcome on the server is unknown.`,
      );
    }
    const result = asRecord(answer.result);
    if (!result)
      throw invalidResult(`MCP server ${this.server} answered ${method} with a result that is not an object.`);
    return result;
  }

  /** One `tools/call`, sent once. `input_required` is returned, not answered (see `callMcpToolRaw`). */
  async callTool(
    params: { name: string; arguments: Record<string, unknown>; inputResponses?: unknown; requestState?: string },
    options: McpRawRequestOptions = {},
  ): Promise<McpRawToolResult> {
    const result = await this.request("tools/call", { ...params }, options);
    return parseMcpRawToolResult(result, this.secrets);
  }

  private assertTaskId(taskId: string): void {
    if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX || !HEADER_VALUE.test(taskId)) {
      throw new McpRawDispatchError({
        kind: "invalid_request",
        message: `The task id for MCP server ${this.server} is not one Ravi can send.`,
        outcomeUnknown: false,
      });
    }
  }

  /** `tasks/get`: the task's current state. */
  async getTask(taskId: string, options: McpRawRequestOptions = {}): Promise<McpRawTask> {
    this.assertTaskId(taskId);
    const task = parseMcpRawTask(await this.request("tasks/get", { taskId }, options), this.secrets);
    if (task.taskId !== taskId) throw invalidResult(`MCP server ${this.server} answered tasks/get for another task.`);
    return task;
  }

  /** `tasks/update`: answers to a task's `inputRequests`. An empty acknowledgement. */
  async updateTask(
    taskId: string,
    inputResponses: Record<string, ElicitResult>,
    options: McpRawRequestOptions = {},
  ): Promise<void> {
    this.assertTaskId(taskId);
    await this.request("tasks/update", { taskId, inputResponses }, options);
  }

  /**
   * `tasks/cancel`: an acknowledgement only. The task may still complete (a
   * server that already committed the work finishes it), so the caller reads
   * the task once more with `getTask` and records what it says.
   */
  async cancelTask(taskId: string, options: McpRawRequestOptions = {}): Promise<void> {
    this.assertTaskId(taskId);
    await this.request("tasks/cancel", { taskId }, options);
  }
}

// ============================================================================
// Building a dispatcher for a registered row
// ============================================================================

export interface CreateMcpRawDispatcherOptions {
  /** The attachment has uploads on: declare `files.upload` when the server advertises it. */
  uploads?: boolean;
  /**
   * False for a call that cannot leave its turn: the tasks extension is not
   * declared on any request of it, so a compliant server answers inline
   * (default: declared when the server advertises tasks).
   */
  tasks?: boolean;
  readSecret?: (server: string) => Promise<McpServerSecret | null>;
  /** The row's stored login (default: `createMcpAuthProvider`, the gateway's own). */
  authProvider?: (server: McpServerRecord) => Promise<AuthProvider | null>;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * A dispatcher for a registered row that `mcpUsesRawDispatch` selects. The
 * full URL comes from the credentials store and must match the row's display
 * form; a bearer or OAuth row needs its stored login (else `McpLoginRequired`).
 */
export async function createMcpRawDispatcher(
  server: McpServerRecord,
  options: CreateMcpRawDispatcherOptions = {},
): Promise<McpRawDispatcher> {
  if (!mcpUsesRawDispatch(server)) {
    throw new McpConnectionError(
      "connect_failed",
      `MCP server ${server.name} is not a modern HTTP server that declares tasks or file uploads.`,
    );
  }
  const secret = await (options.readSecret ?? readMcpServerSecret)(server.name);
  if (!secret?.url) {
    throw new McpConnectionError(
      "secret_missing",
      `The full URL of MCP server ${server.name} is missing from the credentials store; register the server again.`,
    );
  }
  let url: URL;
  try {
    url = parseMcpServerUrl(secret.url);
  } catch {
    // no-cause: the parser error is about a URL that may carry a token.
    throw new McpConnectionError("url_mismatch", `The stored URL of MCP server ${server.name} is not valid.`);
  }
  if (mcpDisplayUrl(url) !== server.urlDisplay) {
    throw new McpConnectionError(
      "url_mismatch",
      `The stored URL of MCP server ${server.name} does not match its registration; register the server again.`,
    );
  }
  let auth: AuthProvider | null = null;
  if (server.authKind !== "none") {
    auth = await (
      options.authProvider ??
      ((row: McpServerRecord) =>
        createMcpAuthProvider(row, {
          ...(options.readSecret ? { readSecret: options.readSecret } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.now ? { now: options.now } : {}),
        }))
    )(server);
    if (!auth) throw new McpLoginRequired(server.name);
  }
  return new McpRawDispatcher(
    { server: server.name, url, auth, secrets: [secret.url, ...(secret.bearer ? [secret.bearer] : [])] },
    {
      extensions: {
        tasks: options.tasks !== false && mcpServerDeclaresTasks(server),
        filesUpload: options.uploads === true && mcpServerDeclaresFileUpload(server),
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  );
}

// ============================================================================
// One tool call with its input rounds
// ============================================================================

export interface McpRawCallInput {
  tool: string;
  arguments: Record<string, unknown>;
  /** Answers each embedded request (the gateway's `inputAnswerer`). */
  answer: McpInputAnswer;
  /** When the call's budget ends (epoch ms). */
  deadline: number;
  signal?: AbortSignal;
  now?: () => number;
  maxRounds?: number;
  onRound?: (rounds: number) => void;
}

/**
 * One tool call on the raw dispatch, through the shared `input_required` loop.
 * Returns the first result that does not ask for input: `complete`, `task` or
 * `upload_required`. Every request of the call uses the dispatcher's one set
 * of capabilities.
 */
export async function callMcpToolRaw(
  dispatcher: McpRawDispatcher,
  input: McpRawCallInput,
): Promise<Exclude<McpRawToolResult, { resultType: "input_required" }>> {
  let last: McpRawToolResult | null = null;
  await runMcpInputRequiredLoop({
    server: dispatcher.server,
    deadline: input.deadline,
    answer: input.answer,
    ...(input.now ? { now: input.now } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    ...(input.onRound ? { onRound: input.onRound } : {}),
    send: async (retry, remainingMs) => {
      last = await dispatcher.callTool(
        { name: input.tool, arguments: input.arguments, ...(retry ?? {}) },
        { timeoutMs: remainingMs, ...(input.signal ? { signal: input.signal } : {}) },
      );
      if (last.resultType === "input_required") {
        return {
          resultType: "input_required",
          inputRequests: last.inputRequests,
          ...(last.requestState !== undefined ? { requestState: last.requestState } : {}),
        };
      }
      return { resultType: last.resultType };
    },
  });
  const final = last as McpRawToolResult | null;
  if (!final || final.resultType === "input_required") {
    throw invalidResult(`MCP server ${dispatcher.server} ended the call without a result.`);
  }
  return final;
}
