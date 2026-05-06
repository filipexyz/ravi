import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-tool-bridge-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;
const originalFetch = globalThis.fetch;

import {
  createCallRequest,
  createCallRun,
  listCallEvents,
  listCallToolRuns,
  resetCallsSchemaFlag,
  seedDefaultProfiles,
  seedDefaultCallTools,
  seedCallToolBindingsForProfile,
  upsertCallToolPolicy,
  updateCallRunStatus,
  getCallToolRun,
  upsertCallTool,
  upsertCallToolBinding,
} from "./calls-db.js";
import { handleToolBridgeCall, handleToolBridgeRequest, listEffectiveTools } from "./tool-bridge.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCallsSchemaFlag();
  process.env.RAVI_CALLS_DISABLE_ENV_FILE = "1";
  delete process.env.AGORA_APP_ID;
  delete process.env.AGORA_APP_CERTIFICATE;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.RAVI_AGORA_TOOL_SECRET;
  delete process.env.RAVI_TOOL_BRIDGE_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setupAgoraEnv() {
  process.env.AGORA_APP_ID = "0".repeat(32);
  process.env.AGORA_APP_CERTIFICATE = "1".repeat(32);
  process.env.AGORA_CUSTOMER_ID = "customer-id";
  process.env.AGORA_CUSTOMER_SECRET = "customer-secret";
  process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";
}

function createTestCallWithRun() {
  seedDefaultProfiles();
  const request = createCallRequest({
    profile_id: "checkin",
    target_person_id: "person_bridge_test",
    target_phone: "+5511999999999",
    reason: "Tool bridge test",
  });
  const run = createCallRun({
    request_id: request.id,
    attempt_number: 1,
    provider: "agora_sip",
  });
  updateCallRunStatus(run.id, "in_progress", {
    provider_call_id: "agent_bridge_test",
  });
  return { request, run };
}

describe("tool-bridge: handleToolBridgeRequest auth", () => {
  it("returns 503 when tool secret is not configured", async () => {
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer something",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "tool_secret_not_configured" });
  });

  it("returns 401 when authorization is missing", async () => {
    process.env.RAVI_AGORA_TOOL_SECRET = "secret";
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: null,
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: "invalid_token" });
  });

  it("returns 401 when bearer token is wrong", async () => {
    process.env.RAVI_AGORA_TOOL_SECRET = "secret";
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer wrong-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: "invalid_token" });
  });

  it("accepts RAVI_TOOL_BRIDGE_SECRET for auth", async () => {
    process.env.RAVI_TOOL_BRIDGE_SECRET = "bridge-secret";
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer bridge-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(200);
  });
});

describe("tool-bridge: handleToolBridgeRequest protocol", () => {
  beforeEach(() => {
    process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";
  });

  it("returns 400 for missing request_id", async () => {
    const result = await handleToolBridgeRequest({
      requestId: null,
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "missing_request_id" });
  });

  it("handles initialize", async () => {
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: { serverInfo: { name: "ravi-prox-calls" } },
    });
  });

  it("handles ping", async () => {
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ result: {} });
  });

  it("handles notifications with 202", async () => {
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", method: "notifications/progress" },
    });
    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
  });

  it("returns method not found for unknown methods", async () => {
    const result = await handleToolBridgeRequest({
      requestId: "cr_test",
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "unknown/method" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      error: { code: -32601 },
    });
  });
});

describe("tool-bridge: unknown tool", () => {
  it("returns error for unknown provider tool name", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "nonexistent_tool",
      arguments: {},
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toContain("Unknown tool");
    expect(result.status).toBe("failed");

    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "tool.failed" && e.status === "unknown_tool")).toBe(true);
  });
});

describe("tool-bridge: invalid input schema", () => {
  it("rejects tool call with invalid input type", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: 42 },
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toContain("must be a string");
    expect(result.status).toBe("failed");
    expect(result.toolRunId).toBeTruthy();

    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "tool.failed" && e.status === "validation_failed")).toBe(true);
  });

  it("rejects tool call with unknown fields when additionalProperties is false", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "ok", extra_field: "nope" },
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toContain("Unknown field");
    expect(result.status).toBe("failed");
  });
});

describe("tool-bridge: policy blocked tool", () => {
  it("blocks tool when policy disallows it", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: false,
    });

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "test" },
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toContain("blocked by policy");
    expect(result.status).toBe("blocked");
    expect(result.toolRunId).toBeTruthy();

    const toolRun = getCallToolRun(result.toolRunId!);
    expect(toolRun?.status).toBe("blocked");

    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "tool.blocked")).toBe(true);
  });

  it("blocks when max_calls_per_run is exceeded", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
      max_calls_per_run: 1,
    });

    // Mock fetch for the first call
    const agoraCalls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      agoraCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const first = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "first" },
    });
    expect(first.normalized.ok).toBe(true);

    // Second call should be blocked by max_calls_per_run
    const second = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "second" },
    });
    expect(second.normalized.ok).toBe(false);
    expect(second.normalized.message).toContain("Max calls per run");
    expect(second.status).toBe("blocked");
  });
});

describe("tool-bridge: successful native call.end", () => {
  it("ends call through Agora provider and creates durable state", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    const agoraCalls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      agoraCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth:
          init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : ((init?.headers as Record<string, string>)?.authorization ?? null),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "test complete" },
    });

    expect(result.normalized.ok).toBe(true);
    expect(result.normalized.message).toBe("Call hangup requested.");
    expect(result.status).toBe("completed");
    expect(result.toolRunId).toBeTruthy();

    // Verify Agora API call
    expect(agoraCalls).toHaveLength(1);
    expect(agoraCalls[0]?.url).toContain("/calls/agent_bridge_test/hangup");
    expect(agoraCalls[0]?.auth).toMatch(/^Basic /);
    expect(agoraCalls[0]?.body).toEqual({ reason: "test complete" });

    // Verify durable state
    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "tool.started")).toBe(true);
    expect(events.some((e) => e.event_type === "tool.completed")).toBe(true);
    expect(events.some((e) => e.status === "hangup_requested")).toBe(true);

    const toolRuns = listCallToolRuns(request.id);
    expect(toolRuns).toHaveLength(1);
    expect(toolRuns[0]?.status).toBe("completed");
    expect(toolRuns[0]?.tool_id).toBe("call.end");
    expect(toolRuns[0]?.provider_tool_name).toBe("end_call");
  });
});

describe("tool-bridge: canonical route via handleToolBridgeRequest", () => {
  it("handles tools/call through the canonical bridge", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await handleToolBridgeRequest({
      requestId: request.id,
      authorization: "Bearer tool-secret",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "end_call", arguments: { reason: "canonical test" } },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: {
        content: [{ type: "text", text: "Call hangup requested." }],
        isError: false,
      },
    });
  });

  it("returns tools/list from resolved bindings", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    const result = await handleToolBridgeRequest({
      requestId: request.id,
      authorization: "Bearer tool-secret",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    expect(result.status).toBe(200);
    const tools = (result.body as Record<string, unknown>).result as Record<string, unknown>;
    expect(tools.tools).toBeArrayOfSize(1);
    expect((tools.tools as Array<Record<string, unknown>>)[0]?.name).toBe("end_call");
  });
});

describe("tool-bridge: idempotent duplicate call.end", () => {
  it("does not call provider hangup twice", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    // Reset policy to default (no max_calls_per_run) in case a previous test modified it
    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });

    const agoraCalls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      agoraCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const first = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "first" },
    });
    expect(first.normalized.ok).toBe(true);
    expect(agoraCalls).toHaveLength(1);

    const second = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "duplicate" },
    });
    expect(second.normalized.ok).toBe(true);
    expect(second.normalized.message).toBe("Call hangup was already requested.");
    // No additional Agora API call
    expect(agoraCalls).toHaveLength(1);
  });
});

describe("tool-bridge: timeout/failure mapping", () => {
  it("creates durable call_tool_run and call_event on provider failure", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();

    // Reset policy to default in case a previous test modified it
    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });

    globalThis.fetch = (async () => {
      return new Response("Agora error", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "failure test" },
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toBe("Failed to end the call. Please try again.");
    expect(result.status).toBe("failed");
    expect(result.toolRunId).toBeTruthy();

    const toolRun = getCallToolRun(result.toolRunId!);
    expect(toolRun?.status).toBe("failed");
    expect(toolRun?.error_message).toBeTruthy();

    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "tool.failed")).toBe(true);
    // Detailed provider error is persisted in durable state but NOT exposed to provider
    const providerError = events.find((e) => e.event_type === "provider.error");
    expect(providerError).toBeTruthy();
    expect(providerError?.message).toContain("Agora error");
  });
});

describe("tool-bridge: listEffectiveTools", () => {
  it("returns tools for valid request", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_list_test",
      reason: "list test",
    });

    const tools = listEffectiveTools(request.id);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("end_call");
    expect(tools[0]?.inputSchema).toBeDefined();
  });

  it("returns empty for unknown request", () => {
    const tools = listEffectiveTools("nonexistent");
    expect(tools).toHaveLength(0);
  });
});

describe("tool-bridge: disabled tool", () => {
  it("blocks when tool is disabled", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    // Create a disabled tool and binding
    upsertCallTool({
      id: "test.disabled",
      name: "disabled_tool",
      description: "A disabled tool",
      input_schema_json: { type: "object", properties: {} },
      executor_type: "native",
      side_effect: "read_only",
      timeout_ms: 5000,
    });
    // Manually disable it
    const { getDb } = await import("../../router/router-db.js");
    getDb().prepare("UPDATE call_tools SET enabled = 0 WHERE id = ?").run("test.disabled");

    upsertCallToolBinding({
      id: "bind-checkin-disabled",
      tool_id: "test.disabled",
      scope_type: "profile",
      scope_id: "checkin",
      provider_tool_name: "disabled_tool",
    });

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "disabled_tool",
      arguments: {},
    });

    // Tool is disabled so binding won't find enabled tool
    expect(result.normalized.ok).toBe(false);
  });
});

describe("tool-bridge: seedDefaultCallTools with pre-existing unrelated tool", () => {
  it("ensures call.end and its policy exist even when other tools are present", async () => {
    // Insert an unrelated tool first (simulates partially populated DB)
    upsertCallTool({
      id: "test.fixture",
      name: "fixture_tool",
      description: "An unrelated fixture tool",
      input_schema_json: { type: "object", properties: {} },
      executor_type: "native",
      side_effect: "read_only",
      timeout_ms: 1000,
    });

    // Seed should still ensure call.end exists despite other tools being present
    seedDefaultCallTools();

    const { getCallTool, getCallToolPolicy } = await import("./calls-db.js");
    const callEnd = getCallTool("call.end");
    expect(callEnd).toBeTruthy();
    expect(callEnd?.name).toBe("end_call");
    expect(callEnd?.executor_type).toBe("native");

    const policy = getCallToolPolicy("call.end", "global", "*");
    expect(policy).toBeTruthy();
    expect(policy?.allowed).toBe(true);
  });
});

describe("tool-bridge: timeout status", () => {
  it("persists explicit timeout status when execution times out", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    // Reset policy in case a prior test set max_calls_per_run
    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });

    // Override call.end tool with a very short timeout (1ms)
    upsertCallTool({
      id: "call.end",
      name: "end_call",
      description: "End call (timeout test)",
      input_schema_json: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "call.end" },
      side_effect: "external_call",
      timeout_ms: 1,
    });

    // Mock fetch that delays longer than the timeout
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "timeout test" },
    });

    expect(result.normalized.ok).toBe(false);
    expect(result.normalized.message).toContain("timed out");
    expect(result.status).toBe("timeout");

    const toolRun = getCallToolRun(result.toolRunId!);
    expect(toolRun?.status).toBe("timeout");

    const events = listCallEvents(request.id);
    expect(events.some((e) => e.status === "timeout")).toBe(true);
  });

  it("aborts provider fetch when timeout fires", async () => {
    setupAgoraEnv();
    const { request } = createTestCallWithRun();
    seedDefaultCallTools();
    seedCallToolBindingsForProfile("checkin");

    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });

    // Override with 1ms timeout
    upsertCallTool({
      id: "call.end",
      name: "end_call",
      description: "End call (abort test)",
      input_schema_json: {
        type: "object",
        properties: { reason: { type: "string" } },
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "call.end" },
      side_effect: "external_call",
      timeout_ms: 1,
    });

    // Track whether abort signal was received
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      // Delay so timeout fires first
      await new Promise((r) => setTimeout(r, 200));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await handleToolBridgeCall({
      requestId: request.id,
      providerToolName: "end_call",
      arguments: { reason: "abort test" },
    });

    expect(result.status).toBe("timeout");
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });
});

describe("tool-bridge: legacy Agora handler delegation", () => {
  it("handleAgoraMcpToolRequest delegates to handleToolBridgeRequest", async () => {
    setupAgoraEnv();

    const { handleAgoraMcpToolRequest } = await import("./agora.js");

    // Test that initialize works through the legacy handler
    const initResult = await handleAgoraMcpToolRequest({
      requestId: "any-request-id",
      authorization: `Bearer ${process.env.RAVI_AGORA_TOOL_SECRET}`,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });

    expect(initResult.status).toBe(200);
    const body = initResult.body as Record<string, unknown>;
    const resultObj = body.result as Record<string, unknown>;
    const serverInfo = resultObj.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("ravi-prox-calls");

    // Test that auth is enforced through the legacy handler
    const authResult = await handleAgoraMcpToolRequest({
      requestId: "any-request-id",
      authorization: "Bearer wrong-token",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });

    expect(authResult.status).toBe(401);
  });
});
