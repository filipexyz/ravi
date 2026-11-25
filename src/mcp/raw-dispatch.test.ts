import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AuthProvider, ElicitResult } from "@modelcontextprotocol/client";

import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import type { ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { McpConnectionError, McpLoginRequired } from "./connections.js";
import { McpGateway, type McpElicitationRequest } from "./gateway.js";
import { answerMcpInputRequests, McpInputError } from "./input-loop.js";
import { createMcpAuthProvider } from "./oauth-provider.js";
import {
  callMcpToolRaw,
  classifyMcpRawFailure,
  createMcpRawDispatcher,
  MCP_FILES_EXTENSION,
  MCP_RAW_DEFAULT_RETRY_AFTER_MS,
  MCP_TASKS_EXTENSION,
  McpRawDispatcher,
  McpRawDispatchError,
  type McpRawExtensions,
  mcpRawClientCapabilities,
  mcpRawNameHeader,
  mcpUsesRawDispatch,
  parseMcpRawTask,
  parseMcpRawToolResult,
  parseMcpRetryAfter,
} from "./raw-dispatch.js";
import {
  createMcpServer,
  getMcpServer,
  type McpServerRecord,
  recordMcpServerProbe,
  setMcpConfigChangedEmitterForTests,
} from "./registry-db.js";
import { writeMcpServerSecret } from "./secrets.js";
import { type SeenRequest, startTaskFixture, type TaskFixture } from "./test-fixtures/task-server.js";

const BRIDGE_TOKEN = "bridgetoken0123456789abcdefXYZ";
const BEARER = "bearer-secret-value-9a8b7c6d5e";
const TASKS_ONLY: McpRawExtensions = { tasks: true, filesUpload: false };

let fixture: TaskFixture | null = null;

afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

function fixtureUrl(): URL {
  if (!fixture) throw new Error("no fixture");
  return new URL(`${fixture.url.replace(/\/mcp$/, "")}/${BRIDGE_TOKEN}/console/mcp`);
}

function dispatcher(
  options: { extensions?: McpRawExtensions; auth?: AuthProvider | null; fetch?: typeof fetch } = {},
): McpRawDispatcher {
  return new McpRawDispatcher(
    { server: "console", url: fixtureUrl(), auth: options.auth ?? null, secrets: [BEARER] },
    { extensions: options.extensions ?? TASKS_ONLY, ...(options.fetch ? { fetch: options.fetch } : {}) },
  );
}

async function caught(promise: Promise<unknown>): Promise<McpRawDispatchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpRawDispatchError) return error;
    throw error;
  }
  throw new Error("expected a raw dispatch error");
}

function envelopeOf(request: SeenRequest): Record<string, unknown> {
  const params = (request.body?.params ?? {}) as Record<string, unknown>;
  return (params._meta ?? {}) as Record<string, unknown>;
}

function expectNoSecret(text: string): void {
  expect(text).not.toContain(BRIDGE_TOKEN);
  expect(text).not.toContain(BEARER);
}

describe("raw dispatch: wire", () => {
  it("sends the modern headers and the envelope from the SDK constants, and reads a complete result", async () => {
    fixture = startTaskFixture();
    const result = await dispatcher().callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.resultType).toBe("complete");
    if (result.resultType !== "complete") throw new Error("unreachable");
    expect(result.result.structuredContent).toEqual({ echoed: "hi" });

    const seen = fixture.requests.at(-1)!;
    expect(seen.method).toBe("tools/call");
    expect(seen.name).toBe("echo");
    expect(seen.protocolVersion).toBe("2026-07-28");
    const meta = envelopeOf(seen);
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect((meta["io.modelcontextprotocol/clientInfo"] as { name: string }).name).toBe("ravi");
    expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
      elicitation: { form: {}, url: {} },
      extensions: { [MCP_TASKS_EXTENSION]: {} },
    });
  });

  it("frames the files extension as {upload: {}} and only when asked", () => {
    expect(mcpRawClientCapabilities({ tasks: true, filesUpload: true })).toEqual({
      elicitation: { form: {}, url: {} },
      extensions: { [MCP_TASKS_EXTENSION]: {}, [MCP_FILES_EXTENSION]: { upload: {} } },
    });
    expect(mcpRawClientCapabilities({ tasks: false, filesUpload: false })).toEqual({
      elicitation: { form: {}, url: {} },
    });
  });

  it("names the request in Mcp-Name by method", () => {
    expect(mcpRawNameHeader("tools/call", { name: "echo" })).toBe("echo");
    expect(mcpRawNameHeader("resources/read", { uri: "skill://a/SKILL.md" })).toBe("skill://a/SKILL.md");
    expect(mcpRawNameHeader("tasks/get", { taskId: "mct_1" })).toBe("mct_1");
    expect(mcpRawNameHeader("tools/list", {})).toBeNull();
  });

  it("maps an Mcp-Name that disagrees with the body to -32020 (nothing ran)", async () => {
    fixture = startTaskFixture();
    const rewrite: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("mcp-name", "other");
      return fetch(input, { ...init, headers });
    }) as typeof fetch;
    const error = await caught(dispatcher({ fetch: rewrite }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("header_mismatch");
    expect(error.code).toBe(-32020);
    expect(error.httpStatus).toBe(400);
    expect(error.outcomeUnknown).toBe(false);
  });

  it("maps a missing tasks capability to -32021 with the extension it names", async () => {
    fixture = startTaskFixture();
    const error = await caught(
      dispatcher({ extensions: { tasks: false, filesUpload: false } }).callTool({ name: "long", arguments: { n: 1 } }),
    );
    expect(error.kind).toBe("missing_capability");
    expect(error.code).toBe(-32021);
    expect(error.requiredExtensions).toEqual([MCP_TASKS_EXTENSION]);
    expect(error.outcomeUnknown).toBe(false);
    expect(fixture.tasks.size).toBe(0);
  });

  it("maps an envelope revision the server does not speak to -32022", async () => {
    fixture = startTaskFixture();
    const rewrite: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      body.params._meta["io.modelcontextprotocol/protocolVersion"] = "2027-01-01";
      const headers = new Headers(init?.headers);
      headers.set("mcp-protocol-version", "2027-01-01");
      return fetch(input, { ...init, headers, body: JSON.stringify(body) });
    }) as typeof fetch;
    const error = await caught(dispatcher({ fetch: rewrite }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("unsupported_version");
    expect(error.outcomeUnknown).toBe(false);
    expect(classifyMcpRawFailure(error, { authKind: "oauth" })).toBe("unsupported_version");
  });

  it("refuses ping and initialize locally: nothing is sent to a modern row", async () => {
    fixture = startTaskFixture();
    for (const method of ["ping", "initialize"]) {
      const error = await caught(dispatcher().request(method));
      expect(error.kind).toBe("invalid_request");
      expect(error.outcomeUnknown).toBe(false);
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuses a name that cannot be a header before sending", async () => {
    fixture = startTaskFixture();
    const error = await caught(dispatcher().callTool({ name: "bad\r\nx-evil: 1", arguments: {} }));
    expect(error.kind).toBe("invalid_request");
    expect(fixture.requests).toHaveLength(0);
    const task = await caught(dispatcher().getTask("a b\n"));
    expect(task.kind).toBe("invalid_request");
  });
});

describe("raw dispatch: tasks", () => {
  it("parses a task result without content (the Console's shape) and with an empty one", async () => {
    fixture = startTaskFixture();
    const bare = await dispatcher().callTool({ name: "long", arguments: { n: 21 } });
    expect(bare.resultType).toBe("task");
    if (bare.resultType !== "task") throw new Error("unreachable");
    expect(bare.task.status).toBe("working");
    expect(bare.task.taskId).toMatch(/^mct_/);
    expect(bare.task.ttlMs).toBe(86_400_000);
    expect(bare.task.pollIntervalMs).toBe(10_000);

    fixture.setOptions({ keepEmptyContent: true });
    const withContent = await dispatcher().callTool({ name: "long", arguments: { n: 2 } });
    expect(withContent.resultType).toBe("task");
  });

  it("polls tasks/get until completed and reads the inner result", async () => {
    fixture = startTaskFixture({ pollsToComplete: 2 });
    const raw = dispatcher();
    const created = await raw.callTool({ name: "long", arguments: { n: 21 } });
    if (created.resultType !== "task") throw new Error("expected a task");
    const statuses: string[] = [];
    let task = await raw.getTask(created.task.taskId);
    statuses.push(task.status);
    while (task.status === "working") {
      task = await raw.getTask(created.task.taskId);
      statuses.push(task.status);
    }
    expect(statuses).toEqual(["working", "working", "completed"]);
    expect(task.result?.content).toEqual([{ type: "text", text: "done 42" }]);
    const names = fixture.requests.filter((r) => r.method === "tasks/get").map((r) => r.name);
    expect(new Set(names)).toEqual(new Set([created.task.taskId]));
  });

  it("reads a tool error as completed with isError, and a failed task with its error", async () => {
    fixture = startTaskFixture({ pollsToComplete: 0 });
    const raw = dispatcher();
    const failing = await raw.callTool({ name: "fail_long", arguments: {} });
    if (failing.resultType !== "task") throw new Error("expected a task");
    const done = await raw.getTask(failing.task.taskId);
    expect(done.status).toBe("completed");
    expect(done.result?.isError).toBe(true);

    const broken = await raw.callTool({ name: "broken_long", arguments: {} });
    if (broken.resultType !== "task") throw new Error("expected a task");
    const failed = await raw.getTask(broken.task.taskId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: -32603, message: "the worker crashed" });
  });

  it("answers a task's late input through tasks/update with the shared answer step", async () => {
    fixture = startTaskFixture();
    const raw = dispatcher();
    const created = await raw.callTool({ name: "asks_long", arguments: {} });
    if (created.resultType !== "task") throw new Error("expected a task");
    const asking = await raw.getTask(created.task.taskId);
    expect(asking.status).toBe("input_required");
    const asked: string[] = [];
    const responses = await answerMcpInputRequests("console", asking.inputRequests, async (key) => {
      asked.push(key);
      return { action: "accept", content: { size: "M" } };
    });
    await raw.updateTask(created.task.taskId, responses);
    const done = await raw.getTask(created.task.taskId);
    expect(asked).toEqual(["pick"]);
    expect(done.status).toBe("completed");
    expect(done.result?.content).toEqual([{ type: "text", text: "size M" }]);
    expect(fixture.requests.find((r) => r.method === "tasks/update")?.name).toBe(created.task.taskId);
  });

  it("acknowledges a cancel, and the next tasks/get says what really happened", async () => {
    fixture = startTaskFixture({ pollsToComplete: 5 });
    const raw = dispatcher();
    const first = await raw.callTool({ name: "long", arguments: { n: 1 } });
    if (first.resultType !== "task") throw new Error("expected a task");
    await raw.cancelTask(first.task.taskId);
    expect((await raw.getTask(first.task.taskId)).status).toBe("cancelled");

    // A cancel that arrives after the server committed the work: acknowledged, and the task completes.
    fixture.setOptions({ cancelCompletes: true });
    const second = await raw.callTool({ name: "long", arguments: { n: 3 } });
    if (second.resultType !== "task") throw new Error("expected a task");
    await raw.cancelTask(second.task.taskId);
    const after = await raw.getTask(second.task.taskId);
    expect(after.status).toBe("completed");
    expect(after.result?.content).toEqual([{ type: "text", text: "done 6" }]);
  });

  it("maps an unknown task to -32602 (nothing ran)", async () => {
    fixture = startTaskFixture();
    const error = await caught(dispatcher().getTask("mct_unknown"));
    expect(error.kind).toBe("invalid_params");
    expect(error.code).toBe(-32602);
    expect(error.outcomeUnknown).toBe(false);
  });

  it("reads upload_required without content, and refuses a result type it does not know", async () => {
    fixture = startTaskFixture();
    const upload = await dispatcher().callTool({ name: "upload", arguments: {} });
    expect(upload.resultType).toBe("upload_required");
    if (upload.resultType !== "upload_required") throw new Error("unreachable");
    expect(upload.requestState).toBe("rmc2.upload-state");
    expect(upload.uploads).toHaveLength(1);

    const error = await caught(dispatcher().callTool({ name: "mystery", arguments: {} }));
    expect(error.kind).toBe("invalid_response");
    expect(error.outcomeUnknown).toBe(true);
  });
});

describe("raw dispatch: SSE framing", () => {
  it("reads the answer from an event stream, skipping comments and notifications", async () => {
    fixture = startTaskFixture({ responseMode: "sse", pollsToComplete: 0 });
    const raw = dispatcher();
    const echoed = await raw.callTool({ name: "echo", arguments: { text: "sse" } });
    expect(echoed.resultType).toBe("complete");
    const created = await raw.callTool({ name: "long", arguments: { n: 5 } });
    if (created.resultType !== "task") throw new Error("expected a task");
    const done = await raw.getTask(created.task.taskId);
    expect(done.status).toBe("completed");
    expect(done.result?.content).toEqual([{ type: "text", text: "done 10" }]);
  });

  it("reads an answer split across chunks with CRLF line ends", async () => {
    fixture = startTaskFixture();
    const chunked: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).id;
      const text = `: hi\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":${id},\r\ndata: "result":{"content":[{"type":"text","text":"ok"}],"resultType":"complete"}}\r\n\r\n`;
      const bytes = new TextEncoder().encode(text);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const result = await dispatcher({ fetch: chunked }).callTool({ name: "echo", arguments: { text: "x" } });
    expect(result).toEqual({
      resultType: "complete",
      result: { content: [{ type: "text", text: "ok" }], resultType: "complete" },
    });
  });

  it("reports a stream that ends without the answer as outcome unknown", async () => {
    fixture = startTaskFixture();
    const empty: typeof fetch = (async () =>
      new Response('data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const error = await caught(dispatcher({ fetch: empty }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("invalid_response");
    expect(error.outcomeUnknown).toBe(true);
  });
});

describe("raw dispatch: auth and HTTP answers", () => {
  it("refreshes once after a 401 and sends again", async () => {
    fixture = startTaskFixture({ bearer: "fresh-token" });
    let current = "stale-token";
    let refreshes = 0;
    const auth: AuthProvider = {
      token: async () => current,
      onUnauthorized: async () => {
        refreshes++;
        current = "fresh-token";
      },
    };
    const result = await dispatcher({ auth }).callTool({ name: "echo", arguments: { text: "x" } });
    expect(result.resultType).toBe("complete");
    expect(refreshes).toBe(1);
    expect(fixture.requests.map((r) => r.authorization)).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
  });

  it("gives needs_login after a second 401, never a third send", async () => {
    fixture = startTaskFixture({ bearer: "never" });
    const auth: AuthProvider = { token: async () => "wrong", onUnauthorized: async () => {} };
    const error = await caught(dispatcher({ auth }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("needs_login");
    expect(error.outcomeUnknown).toBe(false);
    expect(fixture.requests).toHaveLength(2);
    expect(classifyMcpRawFailure(error, { authKind: "oauth" })).toBe("needs_login");
    expect(classifyMcpRawFailure(error, { authKind: "none" })).toBe("refused");
  });

  it("gives needs_login at once for a bearer row (nothing to refresh)", async () => {
    fixture = startTaskFixture({ bearer: "other" });
    const auth: AuthProvider = {
      token: async () => BEARER,
      onUnauthorized: async () => {
        throw new McpLoginRequired("console");
      },
    };
    const error = await caught(dispatcher({ auth }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("needs_login");
    expect(fixture.requests).toHaveLength(1);
    expectNoSecret(error.message);
  });

  it("treats 429 as a back-off with Retry-After, sent once", async () => {
    fixture = startTaskFixture();
    fixture.force({ status: 429, headers: { "retry-after": "7" }, body: '{"error":"mcp_rate_limited"}' });
    const error = await caught(dispatcher().callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(7_000);
    expect(error.outcomeUnknown).toBe(false);
    expect(fixture.requests).toHaveLength(1);

    fixture.force({ status: 429, body: '{"error":"mcp_rate_limited"}' });
    const bare = await caught(dispatcher().getTask("mct_x"));
    expect(bare.retryAfterMs).toBe(MCP_RAW_DEFAULT_RETRY_AFTER_MS);
  });

  it("separates insufficient_scope from a plain 403", async () => {
    fixture = startTaskFixture();
    fixture.force(
      {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="mcp.console.skills.read"' },
        body: '{"error":"insufficient_scope"}',
      },
      { status: 403, body: "no" },
    );
    const scope = await caught(dispatcher().request("skills/get", { uri: "skill://x/SKILL.md" }));
    expect(scope.kind).toBe("insufficient_scope");
    expect(classifyMcpRawFailure(scope, { authKind: "oauth" })).toBe("needs_login");
    const plain = await caught(dispatcher().request("skills/get", { uri: "skill://x/SKILL.md" }));
    expect(plain.kind).toBe("forbidden");
    expect(classifyMcpRawFailure(plain, { authKind: "oauth" })).toBe("refused");
  });

  it("keeps 5xx and -32603 as outcome unknown, with the data code only when it is an identifier", async () => {
    fixture = startTaskFixture();
    fixture.force(
      { status: 502, body: "bad gateway" },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32603, message: "The Ravi Console could not answer", data: { error: "console_unreachable" } },
        }),
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          error: { code: -32602, message: "Invalid or expired requestState", data: { reason: "has spaces <script>" } },
        }),
      },
    );
    const raw = dispatcher();
    const gateway = await caught(raw.callTool({ name: "echo", arguments: { text: "x" } }));
    expect(gateway.kind).toBe("http");
    expect(gateway.outcomeUnknown).toBe(true);
    const unreachable = await caught(raw.callTool({ name: "echo", arguments: { text: "x" } }));
    expect(unreachable.kind).toBe("protocol");
    expect(unreachable.dataCode).toBe("console_unreachable");
    expect(unreachable.outcomeUnknown).toBe(true);
    const invalid = await caught(raw.callTool({ name: "echo", arguments: { text: "x" } }));
    expect(invalid.kind).toBe("invalid_params");
    expect(invalid.dataCode).toBeNull();
    expect(invalid.outcomeUnknown).toBe(false);
  });

  it("never follows a redirect", async () => {
    fixture = startTaskFixture();
    fixture.force({ status: 302, headers: { location: "https://elsewhere.example.com/" } });
    const error = await caught(dispatcher().callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("http");
    expect(error.httpStatus).toBe(302);
    expect(fixture.requests).toHaveLength(1);
  });

  it("refuses an answer larger than the cap as outcome unknown", async () => {
    fixture = startTaskFixture();
    const raw = new McpRawDispatcher(
      { server: "console", url: fixtureUrl(), auth: null },
      { extensions: TASKS_ONLY, maxResponseBytes: 64 },
    );
    const error = await caught(raw.callTool({ name: "echo", arguments: { text: "x".repeat(200) } }));
    expect(error.kind).toBe("invalid_response");
    expect(error.outcomeUnknown).toBe(true);
  });

  it("reports a timeout and a cancel as outcome unknown, with no URL or secret in the text", async () => {
    fixture = startTaskFixture();
    const hang: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${fixtureUrl().toString()}`)));
      })) as typeof fetch;
    const timedOut = await caught(
      dispatcher({ fetch: hang }).callTool({ name: "echo", arguments: { text: "x" } }, { timeoutMs: 50 }),
    );
    expect(timedOut.kind).toBe("timeout");
    expect(timedOut.outcomeUnknown).toBe(true);

    const controller = new AbortController();
    let sent = 0;
    const counting: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
      sent++;
      setTimeout(() => controller.abort(), 10);
      return hang(input, init);
    }) as typeof fetch;
    const cancelled = await caught(
      dispatcher({ fetch: counting }).callTool(
        { name: "echo", arguments: { text: "x" } },
        { signal: controller.signal },
      ),
    );
    expect(cancelled.kind).toBe("cancelled");
    expect(cancelled.outcomeUnknown).toBe(true);
    expect(sent).toBe(1);

    // Cancelled before it left: nothing was sent, so the outcome is known.
    const early = await caught(
      dispatcher({ fetch: counting }).callTool(
        { name: "echo", arguments: { text: "x" } },
        { signal: controller.signal },
      ),
    );
    expect(early.kind).toBe("cancelled");
    expect(early.outcomeUnknown).toBe(false);
    expect(sent).toBe(1);

    const failing: typeof fetch = (async () => {
      throw new Error(`connect failed to ${fixtureUrl().toString()} with ${BEARER}`);
    }) as unknown as typeof fetch;
    const transport = await caught(dispatcher({ fetch: failing }).callTool({ name: "echo", arguments: { text: "x" } }));
    expect(transport.kind).toBe("transport");
    expect(transport.outcomeUnknown).toBe(true);
    expectNoSecret(transport.message);
    expectNoSecret(timedOut.message);
  });
});

describe("raw dispatch: the shared input_required loop", () => {
  it("asks through the answer step, retries with the byte-exact requestState, and ends in a task", async () => {
    fixture = startTaskFixture();
    const asked: { key: string; mode: unknown }[] = [];
    const result = await callMcpToolRaw(dispatcher(), {
      tool: "confirm_long",
      arguments: { n: 7 },
      deadline: Date.now() + 10_000,
      answer: async (key, params) => {
        asked.push({ key, mode: (params as { mode?: unknown }).mode });
        return { action: "accept", content: { confirm: true } };
      },
    });
    expect(asked).toEqual([{ key: "confirm", mode: "form" }]);
    expect(result.resultType).toBe("task");

    const calls = fixture.requests.filter((r) => r.method === "tools/call");
    expect(calls).toHaveLength(2);
    const firstState = calls[0]!.body?.params as Record<string, unknown>;
    const retry = calls[1]!.body?.params as Record<string, unknown>;
    expect(firstState.requestState).toBeUndefined();
    expect(typeof retry.requestState).toBe("string");
    expect(retry.inputResponses).toEqual({ confirm: { action: "accept", content: { confirm: true } } });
    // Every request of one logical call declares the same capabilities.
    const caps = calls.map((call) => envelopeOf(call)["io.modelcontextprotocol/clientCapabilities"]);
    expect(caps[0]).toEqual(caps[1]);
  });

  it("passes a decline to the server, which changes nothing", async () => {
    fixture = startTaskFixture();
    const result = await callMcpToolRaw(dispatcher(), {
      tool: "confirm_long",
      arguments: { n: 1 },
      deadline: Date.now() + 10_000,
      answer: async () => ({ action: "decline" }),
    });
    expect(result.resultType).toBe("complete");
    if (result.resultType !== "complete") throw new Error("unreachable");
    expect(result.result.content).toEqual([{ type: "text", text: "Nothing changed: the person did not confirm." }]);
    expect(fixture.tasks.size).toBe(0);
  });

  it("uses the gateway's own answer step (the elicitation handler with the call scope)", async () => {
    fixture = startTaskFixture();
    const seen: McpElicitationRequest[] = [];
    const gateway = new McpGateway({
      subscribe: false,
      refreshTickMs: 0,
      elicit: async (request) => {
        seen.push(request);
        return { action: "accept", content: { confirm: true } } satisfies ElicitResult;
      },
    });
    const context = { contextId: "ctx", agentId: "main" } as unknown as ContextRecord;
    const deadline = Date.now() + 10_000;
    try {
      const result = await callMcpToolRaw(dispatcher(), {
        tool: "confirm_long",
        arguments: { n: 2 },
        deadline,
        answer: gateway.inputAnswerer(
          { context, agentId: "main" },
          { server: "console", tool: "confirm_long" },
          "modern",
          deadline,
        ),
      });
      expect(result.resultType).toBe("task");
    } finally {
      await gateway.stop();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ server: "console", tool: "confirm_long", era: "modern", key: "confirm", deadline });
    expect(seen[0]!.scope.agentId).toBe("main");
  });

  it("stops after the round limit before asking anyone", async () => {
    fixture = startTaskFixture();
    let answers = 0;
    await expect(
      callMcpToolRaw(dispatcher(), {
        tool: "confirm_long",
        arguments: { n: 1 },
        deadline: Date.now() + 10_000,
        maxRounds: 0,
        answer: async () => {
          answers++;
          return { action: "accept", content: { confirm: true } };
        },
      }),
    ).rejects.toBeInstanceOf(McpInputError);
    expect(answers).toBe(0);
  });
});

describe("raw dispatch: shapes and selection", () => {
  it("selects only modern HTTP rows whose server declares tasks or file uploads", () => {
    const base = { transport: "http", era: "modern", protocol: "auto" } as const;
    expect(mcpUsesRawDispatch({ ...base, extensions: { [MCP_TASKS_EXTENSION]: {} } })).toBe(true);
    expect(mcpUsesRawDispatch({ ...base, extensions: { [MCP_FILES_EXTENSION]: { upload: {} } } })).toBe(true);
    expect(mcpUsesRawDispatch({ ...base, extensions: { [MCP_FILES_EXTENSION]: {} } })).toBe(false);
    expect(mcpUsesRawDispatch({ ...base, extensions: { "io.modelcontextprotocol/skills": {} } })).toBe(false);
    expect(mcpUsesRawDispatch({ ...base, extensions: null })).toBe(false);
    expect(mcpUsesRawDispatch({ ...base, era: "legacy", extensions: { [MCP_TASKS_EXTENSION]: {} } })).toBe(false);
    expect(mcpUsesRawDispatch({ ...base, transport: "stdio", extensions: { [MCP_TASKS_EXTENSION]: {} } })).toBe(false);
    expect(mcpUsesRawDispatch({ ...base, protocol: "legacy", extensions: { [MCP_TASKS_EXTENSION]: {} } })).toBe(false);
  });

  it("parses Retry-After as seconds or a date, clamped to one second .. one hour", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(parseMcpRetryAfter("7", now)).toBe(7_000);
    expect(parseMcpRetryAfter("0", now)).toBe(1_000);
    expect(parseMcpRetryAfter("999999", now)).toBe(3_600_000);
    expect(parseMcpRetryAfter("Wed, 25 Nov 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseMcpRetryAfter("soon", now)).toBeNull();
    expect(parseMcpRetryAfter(null, now)).toBeNull();
  });

  it("reads task fields defensively", () => {
    expect(() => parseMcpRawTask({ taskId: "", status: "working" })).toThrow(McpRawDispatchError);
    expect(() => parseMcpRawTask({ taskId: "t", status: "paused" })).toThrow(McpRawDispatchError);
    expect(() => parseMcpRawTask({ taskId: "t", status: "completed" })).toThrow(McpRawDispatchError);
    expect(() =>
      parseMcpRawTask({ taskId: "t", status: "completed", result: { resultType: "task", content: [] } }),
    ).toThrow(McpRawDispatchError);
    const task = parseMcpRawTask({
      taskId: "t",
      status: "working",
      ttlMs: null,
      pollIntervalMs: -5,
      statusMessage: `see https://x.example.com/${BRIDGE_TOKEN}`,
    });
    expect(task.ttlMs).toBeNull();
    expect(task.pollIntervalMs).toBeUndefined();
    expectNoSecret(task.statusMessage ?? "");
    expect(parseMcpRawToolResult({ content: [] })).toEqual({ resultType: "complete", result: { content: [] } });
  });
});

describe("createMcpRawDispatcher", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = (await createIsolatedRaviState("ravi-mcp-raw-")) as string;
    setMcpConfigChangedEmitterForTests(() => {});
    setPermissionAuditPublisherForTest(() => {});
  });

  afterEach(async () => {
    setPermissionAuditPublisherForTest();
    setMcpConfigChangedEmitterForTests(null);
    await cleanupIsolatedRaviState(stateDir);
  });

  async function register(
    authKind: "none" | "bearer",
    extensions: Record<string, unknown> | null,
    era: "modern" | "legacy" = "modern",
  ): Promise<McpServerRecord> {
    fixture ??= startTaskFixture({ bearer: authKind === "bearer" ? BEARER : null });
    const url = fixtureUrl().toString();
    createMcpServer({ name: "console", transport: "http", url, authKind });
    await writeMcpServerSecret("console", { url, ...(authKind === "bearer" ? { bearer: BEARER } : {}) });
    recordMcpServerProbe("console", { status: "ok", era, extensions, checkedAt: Date.now() });
    return getMcpServer("console")!;
  }

  it("builds from the stored URL and login, and declares files only for an uploads attachment", async () => {
    const row = await register("bearer", { [MCP_TASKS_EXTENSION]: {}, [MCP_FILES_EXTENSION]: { upload: {} } });
    expect(row.urlDisplay).not.toContain(BRIDGE_TOKEN);
    const plain = await createMcpRawDispatcher(row);
    expect(plain.capabilities).toEqual({
      elicitation: { form: {}, url: {} },
      extensions: { [MCP_TASKS_EXTENSION]: {} },
    });
    const result = await plain.callTool({ name: "echo", arguments: { text: "x" } });
    expect(result.resultType).toBe("complete");
    expect(fixture!.requests.at(-1)?.authorization).toBe(`Bearer ${BEARER}`);

    const uploads = await createMcpRawDispatcher(row, { uploads: true });
    expect((uploads.capabilities.extensions as Record<string, unknown>)[MCP_FILES_EXTENSION]).toEqual({ upload: {} });
  });

  it("uses the gateway's bearer provider, whose 401 asks for a login", async () => {
    const row = await register("bearer", { [MCP_TASKS_EXTENSION]: {} });
    fixture!.setOptions({ bearer: "rotated-elsewhere" });
    const raw = await createMcpRawDispatcher(row, { authProvider: (server) => createMcpAuthProvider(server) });
    const error = await caught(raw.callTool({ name: "echo", arguments: { text: "x" } }));
    expect(error.kind).toBe("needs_login");
    expectNoSecret(error.message);
  });

  it("refuses rows the raw dispatch does not serve, a mismatched URL and a missing login", async () => {
    const legacy = await register("none", { [MCP_TASKS_EXTENSION]: {} }, "legacy");
    await expect(createMcpRawDispatcher(legacy)).rejects.toBeInstanceOf(McpConnectionError);
    recordMcpServerProbe("console", { status: "ok", era: "modern", extensions: {} });
    await expect(createMcpRawDispatcher(getMcpServer("console")!)).rejects.toBeInstanceOf(McpConnectionError);

    recordMcpServerProbe("console", { status: "ok", era: "modern", extensions: { [MCP_TASKS_EXTENSION]: {} } });
    await writeMcpServerSecret("console", { url: "https://other.example.com/mcp" });
    const mismatch = await createMcpRawDispatcher(getMcpServer("console")!).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(McpConnectionError);
    expect((mismatch as McpConnectionError).code).toBe("url_mismatch");

    const row = getMcpServer("console")!;
    const noLogin = await createMcpRawDispatcher(
      { ...row, authKind: "bearer" },
      { readSecret: async () => ({ url: fixtureUrl().toString() }) },
    ).catch((error: unknown) => error);
    expect(noLogin).toBeInstanceOf(McpLoginRequired);
  });
});
