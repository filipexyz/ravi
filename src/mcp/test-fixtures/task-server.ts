/**
 * A 2026-07-28 MCP server with the tasks and files extensions, for the raw
 * dispatch tests. Tasks are hand-written, as in SDK probe b4: SDK 2.4.0 has
 * no tasks runtime, so the tool handlers return `resultType: 'task'` results
 * and `tasks/get`, `tasks/update` and `tasks/cancel` are registered with the
 * three-argument `setRequestHandler`. The SDK's HTTP ladder checks
 * `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` (-32020) and the
 * envelope version (-32022); the tasks capability gate (-32021) is written
 * here, as the SDK leaves it to the server.
 *
 * By default it answers like the Ravi Console as built: `task` and
 * `upload_required` results carry no `content` (the SDK adds an empty one,
 * which the fixture removes), and `tasks/cancel` may be acknowledged for a
 * task that still completes.
 *
 * Test-only: no product code imports this module.
 */

import { serve } from "bun";

import {
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const TASKS = "io.modelcontextprotocol/tasks";
const FILES = "io.modelcontextprotocol/files";
/** Tools whose confirmed call creates a task. */
const TASK_TOOLS = new Set(["long", "confirm_long", "fail_long", "broken_long", "asks_long"]);

const codec = createRequestStateCodec<{ n: number }>({
  key: "task-fixture-request-state-key-0123456789",
  ttlSeconds: 600,
});

interface FixtureTask {
  taskId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  inputRequests?: Record<string, unknown>;
  /** Polls left before the task finishes. */
  pollsLeft: number;
  finish: () => void;
}

export interface SeenRequest {
  method: string;
  /** `Mcp-Name` as sent (null when absent). */
  name: string | null;
  protocolVersion: string | null;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

export interface ForcedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface TaskFixtureOptions {
  /** `sse` frames every answer as an event stream (with a notification and a comment before the answer). */
  responseMode?: "json" | "sse";
  /** The bearer the server accepts; null accepts any request (default). */
  bearer?: string | null;
  /** Polls of `tasks/get` before a task finishes (default 2). */
  pollsToComplete?: number;
  /** A cancel is acknowledged but the task completes anyway (the Console's committed-publish case). */
  cancelCompletes?: boolean;
  /** Keep the SDK's `content: []` on task and upload results (default false: removed, as the Console sends them). */
  keepEmptyContent?: boolean;
  /** Advertise the files extension with `upload` (default true). */
  files?: boolean;
}

export interface TaskFixture {
  url: string;
  requests: SeenRequest[];
  tasks: Map<string, FixtureTask>;
  /** Answer the next requests with these, in order, before the server sees them. */
  force(...responses: ForcedResponse[]): void;
  setOptions(options: Partial<TaskFixtureOptions>): void;
  close(): Promise<void>;
}

function iso(): string {
  return new Date().toISOString();
}

function wireTask(task: FixtureTask): Record<string, unknown> {
  const { pollsLeft: _polls, finish: _finish, ...wire } = task;
  return wire;
}

export function startTaskFixture(initial: TaskFixtureOptions = {}): TaskFixture {
  let options: TaskFixtureOptions = { responseMode: "json", bearer: null, pollsToComplete: 2, files: true, ...initial };
  const tasks = new Map<string, FixtureTask>();
  const requests: SeenRequest[] = [];
  const forced: ForcedResponse[] = [];

  const newTask = (finish: (task: FixtureTask) => void, overrides: Partial<FixtureTask> = {}): FixtureTask => {
    const task: FixtureTask = {
      taskId: `mct_${crypto.randomUUID().replace(/-/g, "")}`,
      status: "working",
      createdAt: iso(),
      lastUpdatedAt: iso(),
      ttlMs: 86_400_000,
      pollIntervalMs: 10_000,
      pollsLeft: options.pollsToComplete ?? 2,
      finish: () => {
        finish(task);
        task.lastUpdatedAt = iso();
      },
      ...overrides,
    };
    tasks.set(task.taskId, task);
    return task;
  };

  const taskResult = (task: FixtureTask) => ({ resultType: "task", content: [], ...wireTask(task) }) as never;

  const make = (): McpServer => {
    const mcp = new McpServer(
      { name: "ravi-task-fixture", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
          extensions: { [TASKS]: {}, ...(options.files !== false ? { [FILES]: { upload: {} } } : {}) },
        },
        requestState: { verify: codec.verify },
      },
    );

    mcp.registerTool(
      "echo",
      { description: "Echo", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({
        content: [{ type: "text", text: `echo: ${text}` }],
        structuredContent: { echoed: text },
      }),
    );

    mcp.registerTool("long", { description: "A task", inputSchema: z.object({ n: z.number() }) }, async ({ n }) => {
      const task = newTask((t) => {
        t.status = "completed";
        t.result = { content: [{ type: "text", text: `done ${n * 2}` }], isError: false, resultType: "complete" };
      });
      return taskResult(task);
    });

    const Confirm = z.object({ confirm: z.boolean() });
    mcp.registerTool(
      "confirm_long",
      { description: "Confirm, then a task", inputSchema: z.object({ n: z.number() }) },
      async ({ n }, ctx) => {
        const got = acceptedContent(ctx.mcpReq.inputResponses, "confirm", Confirm);
        if (got?.confirm === true) {
          const state = ctx.mcpReq.requestState<{ n: number }>();
          const task = newTask((t) => {
            t.status = "completed";
            t.result = {
              content: [{ type: "text", text: `confirmed ${state?.n ?? n}` }],
              isError: false,
              resultType: "complete",
            };
          });
          return taskResult(task);
        }
        const view = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (view.kind === "elicit") {
          return { content: [{ type: "text", text: "Nothing changed: the person did not confirm." }] };
        }
        return inputRequired({
          inputRequests: { confirm: inputRequired.elicit({ message: `Start ${n}?`, requestedSchema: Confirm }) },
          requestState: await codec.mint({ n }),
        });
      },
    );

    mcp.registerTool("fail_long", { description: "A task whose tool fails" }, async () => {
      const task = newTask((t) => {
        t.status = "completed";
        t.result = {
          content: [{ type: "text", text: '{"run":{"status":"failed"}}' }],
          structuredContent: { run: { status: "failed" } },
          isError: true,
          resultType: "complete",
        };
      });
      return taskResult(task);
    });

    mcp.registerTool("broken_long", { description: "A task that fails" }, async () => {
      const task = newTask((t) => {
        t.status = "failed";
        t.error = { code: -32603, message: "the worker crashed" };
      });
      return taskResult(task);
    });

    mcp.registerTool("asks_long", { description: "A task that asks for input" }, async () => {
      const task = newTask(
        (t) => {
          t.status = "input_required";
          t.inputRequests = {
            pick: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Pick a size",
                requestedSchema: { type: "object", properties: { size: { type: "string" } }, required: ["size"] },
              },
            },
          };
        },
        { pollsLeft: 0 },
      );
      return taskResult(task);
    });

    mcp.registerTool(
      "upload",
      { description: "Asks for an upload" },
      async () =>
        ({
          content: [],
          resultType: "upload_required",
          uploads: [
            {
              fileId: "f1",
              url: "https://storage.example.com/up?sig=abc",
              method: "PUT",
              headers: { "content-type": "text/html" },
            },
          ],
          requestState: "rmc2.upload-state",
        }) as never,
    );

    mcp.registerTool(
      "mystery",
      { description: "An unknown result type" },
      async () =>
        ({
          content: [],
          resultType: "mystery",
          requestState: "x",
        }) as never,
    );

    const P = z.object({ taskId: z.string() }).passthrough();
    const find = (taskId: string): FixtureTask => {
      const task = tasks.get(taskId);
      if (!task) throw new ProtocolError(-32602, "Task not found or expired");
      return task;
    };
    mcp.server.setRequestHandler("tasks/get", { params: P }, async (params) => {
      const task = find(params.taskId);
      if (task.status === "working") {
        if (task.pollsLeft <= 0) task.finish();
        else task.pollsLeft--;
      }
      return { ...wireTask(task), resultType: "complete" } as never;
    });
    mcp.server.setRequestHandler(
      "tasks/update",
      { params: P.extend({ inputResponses: z.record(z.string(), z.unknown()).optional() }) },
      async (params, ctx) => {
        const task = find(params.taskId);
        // The SDK lifts `inputResponses` out of the params into the request context.
        const responses = (params.inputResponses ?? ctx.mcpReq.inputResponses) as Record<string, unknown> | undefined;
        const answer = responses?.pick as { action?: string; content?: { size?: string } } | undefined;
        if (task.status === "input_required" && answer) {
          task.inputRequests = undefined;
          task.status = "completed";
          task.result = {
            content: [{ type: "text", text: answer.action === "accept" ? `size ${answer.content?.size}` : "no size" }],
            isError: false,
            resultType: "complete",
          };
          task.lastUpdatedAt = iso();
        }
        return { resultType: "complete" } as never;
      },
    );
    mcp.server.setRequestHandler("tasks/cancel", { params: P }, async (params) => {
      const task = find(params.taskId);
      if (task.status === "working" || task.status === "input_required") {
        if (options.cancelCompletes) task.finish();
        else {
          task.status = "cancelled";
          task.statusMessage = "Cancelled before it finished.";
          task.lastUpdatedAt = iso();
        }
      }
      return { resultType: "complete" } as never;
    });
    return mcp;
  };

  const jsonHandler = createMcpHandler(() => make(), { onerror: () => {} });
  const sseHandler = createMcpHandler(() => make(), { onerror: () => {}, responseMode: "sse" });

  const consoleShape = (message: unknown): unknown => {
    if (options.keepEmptyContent) return message;
    const result = (message as { result?: Record<string, unknown> })?.result;
    if (result && (result.resultType === "task" || result.resultType === "upload_required")) {
      const { content: _content, ...rest } = result;
      return { ...(message as Record<string, unknown>), result: rest };
    }
    return message;
  };

  const reshape = async (response: Response): Promise<Response> => {
    const type = response.headers.get("content-type") ?? "";
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const text = await response.text();
    if (type.includes("text/event-stream")) {
      const lines = text.split("\n").map((line) => {
        if (!line.startsWith("data:")) return line;
        try {
          return `data: ${JSON.stringify(consoleShape(JSON.parse(line.slice(5).trim())))}`;
        } catch {
          // no-cause: a data line that is not JSON is passed on as it is.
          return line;
        }
      });
      const preface = `: keep-alive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`;
      return new Response(preface + lines.join("\n"), { status: response.status, headers });
    }
    if (!text) return new Response(null, { status: response.status, headers });
    try {
      return new Response(JSON.stringify(consoleShape(JSON.parse(text))), { status: response.status, headers });
    } catch {
      // no-cause: a body that is not JSON is passed on as it is.
      return new Response(text, { status: response.status, headers });
    }
  };

  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(request) {
      let body: Record<string, unknown> | null = null;
      try {
        body = (await request.clone().json()) as Record<string, unknown>;
      } catch {
        // no-cause: a body that is not JSON is recorded as null.
        body = null;
      }
      requests.push({
        method: request.headers.get("mcp-method") ?? String(body?.method ?? ""),
        name: request.headers.get("mcp-name"),
        protocolVersion: request.headers.get("mcp-protocol-version"),
        authorization: request.headers.get("authorization"),
        body,
      });
      const next = forced.shift();
      if (next) return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? {} });
      if (options.bearer && request.headers.get("authorization") !== `Bearer ${options.bearer}`) {
        return Response.json(
          { error: "mcp_unauthorized" },
          { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/prm"' } },
        );
      }
      const params = (body?.params ?? {}) as Record<string, unknown>;
      const envelope = (params._meta ?? {}) as Record<string, unknown>;
      const capabilities = (envelope["io.modelcontextprotocol/clientCapabilities"] ?? {}) as Record<string, unknown>;
      const extensions = (capabilities.extensions ?? {}) as Record<string, unknown>;
      if (body?.method === "tools/call" && TASK_TOOLS.has(String(params.name)) && !(TASKS in extensions)) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: -32021,
              message: "Missing required client capability: this call runs as a task",
              data: { requiredCapabilities: { extensions: { [TASKS]: {} } } },
            },
          },
          { status: 400 },
        );
      }
      const handler = options.responseMode === "sse" ? sseHandler : jsonHandler;
      return reshape(await handler.fetch(request));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    tasks,
    force(...responses) {
      forced.push(...responses);
    },
    setOptions(next) {
      options = { ...options, ...next };
    },
    async close() {
      await jsonHandler.close();
      await sseHandler.close();
      server.stop(true);
    },
  };
}
