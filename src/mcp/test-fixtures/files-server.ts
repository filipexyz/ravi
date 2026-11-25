/**
 * A 2026-07-28 MCP server with the files extension, shaped like the Ravi
 * Console as built (draft shape, hand-written answers), for the file upload
 * tests.
 *
 * - `tools/list` declares `publish`. Its plain variant takes `title` and
 *   inline `paths` (text by path); a client that declares
 *   `io.modelcontextprotocol/files` also sees `files`, a list whose items
 *   carry the `x-mcp-file` marker. `paths` stays visible in both.
 * - `tools/call publish`: a preview first (`input_required` with a form
 *   confirmation and a `rmc2.` request state), then, once confirmed,
 *   `upload_required` with one target per file that has bytes (a size-0 file
 *   needs none) and a new request state. The retry carries the same
 *   arguments and that state only; it completes, or answers a task when the
 *   client declared tasks. A state is single use: a second retry with it is
 *   -32602 `invalid_request_state`.
 * - `files` in the arguments without the extension declared is -32021 with
 *   `data.requiredCapabilities`. A size-0 item, or one with inline `data`,
 *   needs no upload.
 * - `task`, `upload_required` and `input_required` results carry no `content`.
 *
 * Discovery and everything else go to the SDK server. Test-only: no product
 * code imports this module.
 */

import { serve } from "bun";

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const TASKS = "io.modelcontextprotocol/tasks";
const FILES = "io.modelcontextprotocol/files";

export interface FilesSeenRequest {
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface FilesFixtureUpload {
  fileId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: string;
  expiresAt?: string;
  [key: string]: unknown;
}

export interface FilesFixtureOptions {
  /** Advertise `files.upload` (default true). */
  files?: boolean;
  /** Advertise tasks (default true); the retry answers a task when the client declared them. */
  tasks?: boolean;
  /** Reshape each upload target before it is sent (tests of refused targets). */
  target?: (upload: FilesFixtureUpload) => FilesFixtureUpload;
  /** Answer the retry with this JSON-RPC error instead of running it (`retryAfter` sets the Retry-After header). */
  retryError?: { status: number; code: number; message: string; retryAfter?: string } | null;
  /** Close the connection on the retry without answering (the outcome is unknown). */
  dropRetry?: boolean;
}

export interface FilesFixture {
  url: string;
  requests: FilesSeenRequest[];
  /** The retries the server ran: the arguments it received with them. */
  published: Array<Record<string, unknown>>;
  setOptions(options: Partial<FilesFixtureOptions>): void;
  close(): Promise<void>;
}

/** The marker as the Console puts it on each item of `files`. */
export const FILES_FIXTURE_ITEM_SCHEMA = {
  type: "object",
  "x-mcp-file": { maxSize: 52_428_800 },
  required: ["id", "mimeType", "size", "digest"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    name: { type: "string" },
    digest: {
      type: "object",
      required: ["algorithm", "value"],
      properties: { algorithm: { const: "sha-256" }, value: { pattern: "^[A-Za-z0-9_-]{43}$" } },
    },
    data: { type: "string" },
  },
} as const;

interface FixtureTask {
  taskId: string;
  status: "working" | "completed";
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: Record<string, unknown>;
}

export function startFilesFixture(initial: FilesFixtureOptions = {}): FilesFixture {
  let options: FilesFixtureOptions = { files: true, tasks: true, retryError: null, ...initial };
  const requests: FilesSeenRequest[] = [];
  const published: Array<Record<string, unknown>> = [];
  const states = new Map<string, { phase: "confirm" | "upload"; arguments: Record<string, unknown>; used: boolean }>();
  const tasks = new Map<string, FixtureTask>();
  let counter = 0;

  const make = (): McpServer => {
    const mcp = new McpServer(
      { name: "ravi-files-fixture", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
          extensions: {
            ...(options.tasks !== false ? { [TASKS]: {} } : {}),
            ...(options.files !== false ? { [FILES]: { upload: {} } } : {}),
          },
        },
      },
    );
    mcp.registerTool(
      "publish",
      {
        description: "Publish a site",
        inputSchema: z.object({ title: z.string(), paths: z.record(z.string(), z.string()).optional() }),
      },
      async () => ({ content: [{ type: "text", text: "unreachable: the fixture answers publish itself" }] }),
    );
    mcp.registerTool(
      "echo",
      { description: "Echo", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
    );
    return mcp;
  };
  const handler = createMcpHandler(() => make(), { onerror: () => {} });

  const rpc = (id: unknown, result: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id, result });
  const rpcError = (id: unknown, status: number, code: number, message: string, data?: unknown) =>
    Response.json(
      { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
      { status },
    );

  const iso = () => new Date().toISOString();

  const publish = (
    id: unknown,
    params: Record<string, unknown>,
    extensions: Record<string, unknown>,
  ): Response | "drop" => {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
    if (files.length > 0 && !(FILES in extensions)) {
      return rpcError(id, 400, -32021, "Missing required client capability: this call needs file uploads", {
        requiredCapabilities: { extensions: { [FILES]: { upload: {} } } },
      });
    }
    const stateKey = typeof params.requestState === "string" ? params.requestState : null;
    if (stateKey === null) {
      const key = `rmc2.confirm.${++counter}`;
      states.set(key, { phase: "confirm", arguments: args, used: false });
      return rpc(id, {
        resultType: "input_required",
        inputRequests: {
          confirm: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: `Publish ${String(args.title)} with ${files.length} file(s)?`,
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
              },
            },
          },
        },
        requestState: key,
      });
    }
    const state = states.get(stateKey);
    if (!state || state.used || JSON.stringify(state.arguments) !== JSON.stringify(args)) {
      return rpcError(id, 200, -32602, "Invalid or expired requestState", { reason: "invalid_request_state" });
    }
    state.used = true;
    if (state.phase === "confirm") {
      const responses = (params.inputResponses ?? {}) as Record<
        string,
        { action?: string; content?: { confirm?: boolean } }
      >;
      if (responses.confirm?.action !== "accept" || responses.confirm.content?.confirm !== true) {
        return rpc(id, { content: [{ type: "text", text: "Nothing published: not confirmed." }], isError: false });
      }
      const needs = files.filter((file) => Number(file.size) > 0 && typeof file.data !== "string");
      if (needs.length === 0) return finish(id, args, extensions);
      const key = `rmc2.upload.${++counter}`;
      states.set(key, { phase: "upload", arguments: args, used: false });
      const uploads = needs.map((file) => {
        const upload: FilesFixtureUpload = {
          fileId: String(file.id),
          url: `https://uploads.storage.test/r/${counter}/${String(file.id)}?sig=fixture-signature`,
          method: "PUT",
          headers: {
            "content-type": String(file.mimeType),
            "x-amz-meta-digest": String((file.digest as { value?: string })?.value ?? ""),
          },
          credentials: "omit",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
        return options.target ? options.target(upload) : upload;
      });
      return rpc(id, { resultType: "upload_required", uploads, requestState: key });
    }
    // The retry after the upload.
    if (options.dropRetry) return "drop";
    if (options.retryError) {
      const { status, code, message, retryAfter } = options.retryError;
      const refused = rpcError(
        id,
        status,
        code,
        message,
        code === -32602 ? { reason: "invalid_request_state" } : undefined,
      );
      if (retryAfter !== undefined) refused.headers.set("retry-after", retryAfter);
      return refused;
    }
    return finish(id, args, extensions);
  };

  const finish = (id: unknown, args: Record<string, unknown>, extensions: Record<string, unknown>): Response => {
    published.push(args);
    const files = Array.isArray(args.files) ? args.files.length : 0;
    const result = {
      content: [{ type: "text", text: `published ${String(args.title)} with ${files} file(s)` }],
      structuredContent: { published: true, files },
      isError: false,
      resultType: "complete",
    };
    if (options.tasks !== false && TASKS in extensions) {
      const task: FixtureTask = {
        taskId: `mct_${crypto.randomUUID().replace(/-/g, "")}`,
        status: "working",
        createdAt: iso(),
        lastUpdatedAt: iso(),
        ttlMs: 86_400_000,
        pollIntervalMs: 1_000,
        result,
      };
      tasks.set(task.taskId, task);
      const { result: _result, ...wire } = task;
      return rpc(id, { resultType: "task", ...wire });
    }
    return rpc(id, result);
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
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ method: String(body?.method ?? request.headers.get("mcp-method") ?? ""), headers, body });
      const params = (body?.params ?? {}) as Record<string, unknown>;
      const envelope = (params._meta ?? {}) as Record<string, unknown>;
      const capabilities = (envelope["io.modelcontextprotocol/clientCapabilities"] ?? {}) as Record<string, unknown>;
      const extensions = (capabilities.extensions ?? {}) as Record<string, unknown>;

      if (body?.method === "tools/call" && params.name === "publish") {
        const answer = publish(body.id, params, extensions);
        if (answer === "drop") {
          // Run it, then cut the answer short: the client cannot know whether it ran.
          published.push((params.arguments ?? {}) as Record<string, unknown>);
          return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"res`, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return answer;
      }
      if (body?.method === "tasks/get") {
        const task = tasks.get(String(params.taskId));
        if (!task) return rpcError(body.id, 200, -32602, "Task not found or expired");
        task.status = "completed";
        task.lastUpdatedAt = iso();
        return rpc(body.id, { ...task, resultType: "complete" });
      }
      const response = await handler.fetch(request);
      if (body?.method !== "tools/list") return response;
      // The files variant: `files` appears only for a client that declared the extension.
      const text = await response.text();
      const out = new Headers(response.headers);
      out.delete("content-length");
      const rewrite = (message: Record<string, unknown>) => {
        const result = message.result as { tools?: Array<Record<string, unknown>> } | undefined;
        for (const tool of result?.tools ?? []) {
          if (tool.name !== "publish" || !(FILES in extensions) || options.files === false) continue;
          const schema = tool.inputSchema as { properties: Record<string, unknown> };
          schema.properties.files = { type: "array", minItems: 1, maxItems: 10, items: FILES_FIXTURE_ITEM_SCHEMA };
        }
        return message;
      };
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const lines = text.split("\n").map((line) => {
          if (!line.startsWith("data:")) return line;
          return `data: ${JSON.stringify(rewrite(JSON.parse(line.slice(5).trim())))}`;
        });
        return new Response(lines.join("\n"), { status: response.status, headers: out });
      }
      return new Response(JSON.stringify(rewrite(JSON.parse(text))), { status: response.status, headers: out });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    requests,
    published,
    setOptions(next) {
      options = { ...options, ...next };
    },
    async close() {
      await handler.close();
      server.stop(true);
    },
  };
}
