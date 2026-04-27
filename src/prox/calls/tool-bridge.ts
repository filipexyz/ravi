/**
 * prox.city Calls — Provider-Neutral Tool Bridge
 *
 * Canonical executor for all voice-agent tool calls. Provider adapters MUST
 * route tool invocations through this bridge. The bridge owns resolution,
 * validation, policy, execution, audit, and result normalization.
 */

import { timingSafeEqual } from "node:crypto";
import { getDb } from "../../router/router-db.js";
import {
  createCallEvent,
  createCallToolRun,
  countCallToolRunsForRun,
  getCallProfile,
  getCallRequest,
  getCallTool,
  getEffectiveCallToolPolicy,
  listCallToolBindings,
  resolveCallToolBindingByProviderName,
  seedCallToolBindingsForProfile,
  seedDefaultCallTools,
  updateCallToolRunStatus,
} from "./calls-db.js";
import type {
  CallRun,
  CallRunStatus,
  CallTool,
  CallToolExecutionContext,
  CallToolNormalizedResult,
  CallToolRunStatus,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Call request / run resolution
// ---------------------------------------------------------------------------

function findLatestEligibleRun(requestId: string): CallRun | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM call_runs
       WHERE request_id = ?
       ORDER BY COALESCE(answered_at, started_at, 0) DESC, attempt_number DESC
       LIMIT 1`,
    )
    .get(requestId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    request_id: row.request_id as string,
    status: row.status as CallRunStatus,
    attempt_number: row.attempt_number as number,
    provider: row.provider as string,
    provider_call_id: (row.provider_call_id as string) ?? null,
    twilio_call_sid: (row.twilio_call_sid as string) ?? null,
    started_at: (row.started_at as number) ?? null,
    answered_at: (row.answered_at as number) ?? null,
    ended_at: (row.ended_at as number) ?? null,
    failure_reason: (row.failure_reason as string) ?? null,
    metadata_json: row.metadata_json ? (JSON.parse(row.metadata_json as string) as JsonRecord) : null,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateInputSchema(tool: CallTool, input: JsonRecord): string | null {
  const schema = tool.input_schema_json;
  if (!schema || !isRecord(schema)) return null;

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  for (const field of required) {
    if (!(field in input)) return `Missing required field: ${field}`;
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) return `Unknown field: ${key}`;
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const propSchema = isRecord(properties[key]) ? (properties[key] as JsonRecord) : null;
    if (!propSchema) continue;
    const expectedType = propSchema.type;
    if (expectedType === "string" && typeof value !== "string") {
      return `Field ${key} must be a string`;
    }
    if (expectedType === "number" && typeof value !== "number") {
      return `Field ${key} must be a number`;
    }
    if (expectedType === "boolean" && typeof value !== "boolean") {
      return `Field ${key} must be a boolean`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

interface PolicyVerdict {
  allowed: boolean;
  reason: string;
}

function evaluateToolPolicy(context: CallToolExecutionContext): PolicyVerdict {
  const { tool, run } = context;

  if (!tool.enabled) {
    return { allowed: false, reason: "Tool is disabled." };
  }

  if (!context.binding.enabled) {
    return { allowed: false, reason: "Tool binding is disabled." };
  }

  const policy = getEffectiveCallToolPolicy(tool.id);

  if (policy && !policy.allowed) {
    return { allowed: false, reason: "Tool is blocked by policy." };
  }

  const unsafeSideEffects = new Set(["external_message", "external_irreversible"]);
  if (unsafeSideEffects.has(tool.side_effect)) {
    if (!policy || !policy.allowed) {
      return { allowed: false, reason: `Side-effect class '${tool.side_effect}' requires explicit policy allowance.` };
    }
  }

  if (policy?.max_calls_per_run != null && run) {
    const count = countCallToolRunsForRun(run.id, tool.id);
    if (count >= policy.max_calls_per_run) {
      return { allowed: false, reason: `Max calls per run (${policy.max_calls_per_run}) exceeded.` };
    }
  }

  return { allowed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Native executors
// ---------------------------------------------------------------------------

async function executeNativeCallEnd(context: CallToolExecutionContext): Promise<CallToolNormalizedResult> {
  const { request, run } = context;
  const reason = stringValue(context.input.reason) ?? null;

  if (!run) {
    return { ok: false, message: "No active call run found for this request." };
  }

  const terminalStatuses = new Set<string>(["completed", "no_answer", "busy", "voicemail", "failed", "canceled"]);

  if (terminalStatuses.has(run.status)) {
    return { ok: true, message: "Call has already ended." };
  }

  // Check for prior hangup request (idempotency)
  const { listCallEvents } = await import("./calls-db.js");
  const events = listCallEvents(request.id);
  const alreadyRequested = events.some(
    (e) => e.run_id === run.id && e.event_type === "run.progress" && e.status === "hangup_requested",
  );
  if (alreadyRequested) {
    return { ok: true, message: "Call hangup was already requested." };
  }

  // Dispatch to provider-specific hangup
  if (run.provider === "agora_sip") {
    const { resolveAgoraSipConfig, hangupAgoraSipCall } = await import("./agora.js");
    const config = resolveAgoraSipConfig();
    if (!config) return { ok: false, message: "Agora credentials are not configured." };
    if (!config.customerId || !config.customerSecret) {
      return { ok: false, message: "AGORA_CUSTOMER_ID and AGORA_CUSTOMER_SECRET are required for API hangup." };
    }
    if (!run.provider_call_id) {
      return { ok: false, message: "No provider call ID available for hangup." };
    }

    const result = await hangupAgoraSipCall(config, run.provider_call_id, reason);
    if (!result.ok) {
      createCallEvent({
        request_id: request.id,
        run_id: run.id,
        event_type: "provider.error",
        status: "hangup_failed",
        message: result.message,
        payload_json: { provider: "agora", agent_id: run.provider_call_id },
        source: "prox.calls.tool-bridge",
      });
      return result;
    }

    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "run.progress",
      status: "hangup_requested",
      message: reason || "Hangup requested by end_call tool.",
      payload_json: { provider: "agora", agent_id: run.provider_call_id },
      source: "prox.calls.tool-bridge",
    });

    return { ok: true, message: "Call hangup requested." };
  }

  return { ok: false, message: `Provider '${run.provider}' does not support call.end yet.` };
}

async function executeNativeTool(context: CallToolExecutionContext): Promise<CallToolNormalizedResult> {
  switch (context.tool.id) {
    case "call.end":
      return executeNativeCallEnd(context);
    default:
      return { ok: false, message: `Unknown native tool: ${context.tool.id}` };
  }
}

// ---------------------------------------------------------------------------
// Execution with timeout
// ---------------------------------------------------------------------------

async function executeWithTimeout(context: CallToolExecutionContext): Promise<CallToolNormalizedResult> {
  const timeoutMs = context.tool.timeout_ms || 5000;

  const executionPromise = (async (): Promise<CallToolNormalizedResult> => {
    switch (context.tool.executor_type) {
      case "native":
        return executeNativeTool(context);
      default:
        return { ok: false, message: `Executor type '${context.tool.executor_type}' is not implemented.` };
    }
  })();

  const timeoutPromise = new Promise<CallToolNormalizedResult>((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, message: `Tool execution timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
  });

  return Promise.race([executionPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Bridge: full tool call handler
// ---------------------------------------------------------------------------

export interface ToolBridgeCallInput {
  requestId: string;
  providerToolName: string;
  arguments: JsonRecord;
}

export interface ToolBridgeCallResult {
  normalized: CallToolNormalizedResult;
  toolRunId: string | null;
  status: CallToolRunStatus;
}

export async function handleToolBridgeCall(input: ToolBridgeCallInput): Promise<ToolBridgeCallResult> {
  const { requestId, providerToolName, arguments: args } = input;

  // 1. Resolve call_request
  const request = getCallRequest(requestId);
  if (!request) {
    return {
      normalized: { ok: false, message: `Call request '${requestId}' not found.` },
      toolRunId: null,
      status: "failed",
    };
  }

  // 2. Resolve latest eligible call_run
  const run = findLatestEligibleRun(requestId);

  // 3. Resolve call_profile
  const profile = getCallProfile(request.profile_id);
  if (!profile) {
    return {
      normalized: { ok: false, message: `Call profile '${request.profile_id}' not found.` },
      toolRunId: null,
      status: "failed",
    };
  }

  // 4. Ensure default tools and bindings exist
  seedDefaultCallTools();
  seedCallToolBindingsForProfile(profile.id);

  // 5. Resolve call_tool_binding by provider tool name
  // Try profile scope first, then voice_agent scope (future).
  // NOTE: voice_agent-scoped bindings are not yet populated because
  // call_voice_agent storage is not part of this MVP. The executor API
  // leaves room for it — once voice-agent records exist, bindings with
  // scope_type='voice_agent' will be checked before profile bindings.
  const binding = resolveCallToolBindingByProviderName(providerToolName, "profile", profile.id);
  if (!binding) {
    // Audit the unknown tool attempt
    if (request) {
      createCallEvent({
        request_id: request.id,
        run_id: run?.id ?? null,
        event_type: "tool.failed",
        status: "unknown_tool",
        message: `Provider tool '${providerToolName}' has no binding for profile '${profile.id}'.`,
        source: "prox.calls.tool-bridge",
      });
    }
    return {
      normalized: { ok: false, message: `Unknown tool: ${providerToolName}` },
      toolRunId: null,
      status: "failed",
    };
  }

  // 6. Resolve call_tool
  const tool = getCallTool(binding.tool_id);
  if (!tool) {
    return {
      normalized: { ok: false, message: `Tool definition '${binding.tool_id}' not found.` },
      toolRunId: null,
      status: "failed",
    };
  }

  // 7. Validate input against schema
  const validationError = validateInputSchema(tool, args);
  if (validationError) {
    const toolRun = createCallToolRun({
      request_id: request.id,
      run_id: run?.id ?? null,
      tool_id: tool.id,
      binding_id: binding.id,
      provider_tool_name: providerToolName,
      input_json: args,
      status: "failed",
    });
    updateCallToolRunStatus(toolRun.id, "failed", {
      error_message: validationError,
    });
    createCallEvent({
      request_id: request.id,
      run_id: run?.id ?? null,
      event_type: "tool.failed",
      status: "validation_failed",
      message: validationError,
      payload_json: { tool_id: tool.id, provider_tool_name: providerToolName },
      source: "prox.calls.tool-bridge",
    });
    return {
      normalized: { ok: false, message: validationError },
      toolRunId: toolRun.id,
      status: "failed",
    };
  }

  // 8. Build execution context
  const context: CallToolExecutionContext = {
    tool,
    binding,
    request,
    run,
    profile,
    input: args,
  };

  // 9. Evaluate policy
  const verdict = evaluateToolPolicy(context);
  if (!verdict.allowed) {
    const toolRun = createCallToolRun({
      request_id: request.id,
      run_id: run?.id ?? null,
      tool_id: tool.id,
      binding_id: binding.id,
      provider_tool_name: providerToolName,
      input_json: args,
      status: "blocked",
    });
    updateCallToolRunStatus(toolRun.id, "blocked", {
      error_message: verdict.reason,
    });
    createCallEvent({
      request_id: request.id,
      run_id: run?.id ?? null,
      event_type: "tool.blocked",
      status: "blocked",
      message: verdict.reason,
      payload_json: { tool_id: tool.id, provider_tool_name: providerToolName },
      source: "prox.calls.tool-bridge",
    });
    return {
      normalized: { ok: false, message: verdict.reason },
      toolRunId: toolRun.id,
      status: "blocked",
    };
  }

  // 10. Create tool run and execute
  const toolRun = createCallToolRun({
    request_id: request.id,
    run_id: run?.id ?? null,
    tool_id: tool.id,
    binding_id: binding.id,
    provider_tool_name: providerToolName,
    input_json: args,
    status: "running",
  });

  createCallEvent({
    request_id: request.id,
    run_id: run?.id ?? null,
    event_type: "tool.started",
    status: "running",
    message: `Executing tool '${tool.id}' via provider name '${providerToolName}'.`,
    payload_json: { tool_id: tool.id, tool_run_id: toolRun.id },
    source: "prox.calls.tool-bridge",
  });

  try {
    const result = await executeWithTimeout(context);
    const status: CallToolRunStatus = result.ok ? "completed" : "failed";

    updateCallToolRunStatus(toolRun.id, status, {
      output_json: { ok: result.ok, message: result.message, data: result.data },
      error_message: result.ok ? null : result.message,
    });

    createCallEvent({
      request_id: request.id,
      run_id: run?.id ?? null,
      event_type: result.ok ? "tool.completed" : "tool.failed",
      status: result.ok ? "completed" : "failed",
      message: result.message,
      payload_json: { tool_id: tool.id, tool_run_id: toolRun.id },
      source: "prox.calls.tool-bridge",
    });

    return { normalized: result, toolRunId: toolRun.id, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes("timed out");

    updateCallToolRunStatus(toolRun.id, isTimeout ? "timeout" : "failed", {
      error_message: message,
    });

    createCallEvent({
      request_id: request.id,
      run_id: run?.id ?? null,
      event_type: "tool.failed",
      status: isTimeout ? "timeout" : "failed",
      message,
      payload_json: { tool_id: tool.id, tool_run_id: toolRun.id },
      source: "prox.calls.tool-bridge",
    });

    return {
      normalized: { ok: false, message },
      toolRunId: toolRun.id,
      status: isTimeout ? "timeout" : "failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Bridge: list effective tools for a request
// ---------------------------------------------------------------------------

export interface ToolBridgeListItem {
  name: string;
  description: string;
  inputSchema: JsonRecord;
}

export function listEffectiveTools(requestId: string): ToolBridgeListItem[] {
  const request = getCallRequest(requestId);
  if (!request) return [];
  const profile = getCallProfile(request.profile_id);
  if (!profile) return [];

  seedDefaultCallTools();
  seedCallToolBindingsForProfile(profile.id);

  const bindings = listCallToolBindings("profile", profile.id);
  const tools: ToolBridgeListItem[] = [];

  for (const binding of bindings) {
    const tool = getCallTool(binding.tool_id);
    if (!tool || !tool.enabled) continue;
    tools.push({
      name: binding.provider_tool_name,
      description: binding.tool_prompt || tool.description,
      inputSchema: tool.input_schema_json,
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Bridge: MCP JSON-RPC handler (shared by canonical and alias routes)
// ---------------------------------------------------------------------------

function jsonRpcResult(id: unknown, result: JsonRecord): JsonRecord {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value.method === "string";
}

function extractBearerToken(authorization: string | null | undefined): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeCompareString(expectedValue: string, actualValue: string): boolean {
  if (!expectedValue || !actualValue) return false;
  const expected = Buffer.from(expectedValue);
  const actual = Buffer.from(actualValue);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function resolveToolBearerSecret(): string | null {
  return (
    process.env.RAVI_TOOL_BRIDGE_SECRET?.trim() ||
    process.env.RAVI_AGORA_TOOL_SECRET?.trim() ||
    process.env.AGORA_MCP_TOOL_SECRET?.trim() ||
    null
  );
}

export async function handleToolBridgeRequest(input: {
  requestId: string | null;
  authorization: string | null;
  payload: unknown;
}): Promise<{ status: number; body: JsonRecord | null }> {
  const expectedSecret = resolveToolBearerSecret();
  if (!expectedSecret) return { status: 503, body: { ok: false, error: "tool_secret_not_configured" } };

  const actualSecret = extractBearerToken(input.authorization);
  if (!actualSecret || !safeCompareString(expectedSecret, actualSecret)) {
    return { status: 401, body: { ok: false, error: "invalid_token" } };
  }

  if (!input.requestId) return { status: 400, body: { ok: false, error: "missing_request_id" } };
  if (Array.isArray(input.payload)) {
    return { status: 400, body: { ok: false, error: "batch_not_supported" } };
  }
  if (!isJsonRpcRequest(input.payload)) {
    return { status: 400, body: { ok: false, error: "invalid_json_rpc" } };
  }

  const rpc = input.payload;
  const method = String(rpc.method);
  if (!("id" in rpc) && method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }

  switch (method) {
    case "initialize":
      return {
        status: 200,
        body: jsonRpcResult(rpc.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ravi-prox-calls", version: "0.2.0" },
        }),
      };
    case "ping":
      return { status: 200, body: jsonRpcResult(rpc.id, {}) };
    case "tools/list": {
      const tools = listEffectiveTools(input.requestId);
      return {
        status: 200,
        body: jsonRpcResult(rpc.id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }),
      };
    }
    case "tools/call": {
      const params = isRecord(rpc.params) ? rpc.params : {};
      const toolName = stringValue(params.name);
      if (!toolName) {
        return { status: 200, body: jsonRpcError(rpc.id, -32602, "Missing tool name") };
      }
      const args = isRecord(params.arguments) ? params.arguments : {};

      const result = await handleToolBridgeCall({
        requestId: input.requestId,
        providerToolName: toolName,
        arguments: args,
      });

      return {
        status: 200,
        body: jsonRpcResult(rpc.id, {
          content: [{ type: "text", text: result.normalized.message }],
          isError: !result.normalized.ok,
        }),
      };
    }
    default:
      return { status: 200, body: jsonRpcError(rpc.id, -32601, `Method not found: ${method}`) };
  }
}
