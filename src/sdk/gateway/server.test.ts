import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { Arg, Command, CommandAccess, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { startGateway, type GatewayHandle } from "./server.js";
import type { ContextRecord } from "../../router/router-db.js";
import type { StreamAuditEvent, StreamChannel } from "./streaming/types.js";

@Group({ name: "demo", description: "Server demo", scope: "open" })
class ServerDemoCommands {
  @Command({ name: "echo", description: "Echo" })
  @CommandAccess({ kind: "read", resource: "demo", action: "echo", risk: "low", input: ["name"] })
  @Returns(z.object({ ok: z.literal(true), name: z.string() }))
  echo(@Arg("name") name: string, @Option({ flags: "--shout" }) shout?: boolean) {
    void shout;
    return { ok: true as const, name };
  }
}

@Group({ name: "tasks", description: "Server task reads", scope: "open" })
class ServerTasksCommands {
  @Command({ name: "list", description: "List tasks" })
  @CommandAccess({ kind: "read", resource: "tasks", action: "list", risk: "low" })
  list() {
    return { ok: true };
  }
}

const registry = buildRegistry([ServerDemoCommands, ServerTasksCommands]);

let handle: GatewayHandle;
const streamAudits: StreamAuditEvent[] = [];

const allowedContext: ContextRecord = {
  contextId: "ctx_stream_allowed",
  contextKey: "rctx_stream_allowed",
  kind: "turn-runtime",
  agentId: "stream-agent",
  capabilities: [
    { permission: "view", objectType: "system", objectId: "events" },
    { permission: "execute", objectType: "group", objectId: "demo" },
    { permission: "execute", objectType: "group", objectId: "tasks" },
  ],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};

const deniedContext: ContextRecord = {
  ...allowedContext,
  contextId: "ctx_stream_denied",
  contextKey: "rctx_stream_denied",
  capabilities: [],
};

const testStreamChannels: StreamChannel[] = [
  {
    name: "events",
    meta: {
      methodName: "events",
      pathPattern: "events",
      optionsTypeName: "EventsStreamOptions",
      payloadTypeName: "GatewayTopicEvent",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      payloadSchema: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string" } },
      },
    },
    match(segments) {
      return segments.length === 1 && segments[0] === "events"
        ? {
            channelPath: "events",
            scope: {
              permission: "view",
              objectType: "system",
              objectId: "events",
            },
          }
        : null;
    },
    async *subscribe() {
      yield {
        event: "message",
        data: { type: "event", topic: "ravi.test", data: { ok: true } },
      };
      yield { event: "end", data: { type: "stream.end", reason: "test" } };
    },
  },
];

beforeAll(() => {
  handle = startGateway({
    host: "127.0.0.1",
    port: 0,
    registry,
    auth: {
      resolveContext(token) {
        if (token === allowedContext.contextKey) return { ...allowedContext };
        if (token === deniedContext.contextKey) return { ...deniedContext };
        return null;
      },
    },
    streaming: {
      channels: testStreamChannels,
      keepaliveMs: 10_000,
      emitAudit(event) {
        streamAudits.push(event);
      },
    },
  });
});

afterAll(async () => {
  if (handle) await handle.stop();
});

describe("gateway server — meta + health", () => {
  it("/health returns 200", async () => {
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("/api/v1/_meta/version returns gateway+registryHash", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway: string;
      registryHash: string;
    };
    expect(typeof body.gateway).toBe("string");
    expect(body.registryHash).toBe(handle.registryHash);
  });

  it("/api/v1/_meta/registry mirrors the registry command count", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commandCount: number;
      commands: { fullName: string }[];
    };
    expect(body.commandCount).toBe(registry.commands.length);
    expect(body.commands.find((c) => c.fullName === "demo.echo")).toBeDefined();
  });

  it("/api/v1/_meta/registry rejects POST", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/registry`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });
});

describe("gateway server — dispatch over HTTP", () => {
  it("POST to a real command returns 200 with the handler payload (flat body)", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowedContext.contextKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "luis" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body).toEqual({ ok: true, name: "luis" });
  });

  it("POST to a command without runtime context fails closed", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "luis" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("PermissionDenied");
    expect(body.reason).toContain("runtime principal");
  });

  it("does not enforce runtime skill gates for API routes", async () => {
    const res = await fetch(`${handle.url}/api/v1/tasks/list`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowedContext.contextKey}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST with empty body returns 400 ValidationError with structured issues", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: { path: string[] }[];
    };
    expect(body.error).toBe("ValidationError");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((i) => i.path[0] === "name")).toBe(true);
  });

  it("POST with malformed JSON returns 400 BadRequest", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("BadRequest");
  });

  it("POST to a missing command returns 404", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/does_not_exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NotFound");
  });

  it("GET on a command path returns 405", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MethodNotAllowed");
  });

  it("unknown root path returns 404", async () => {
    const res = await fetch(`${handle.url}/no-such-thing`);
    expect(res.status).toBe(404);
  });
});

describe("gateway server — SSE streaming namespace", () => {
  it("streams registered channels under /api/v1/_stream", async () => {
    streamAudits.length = 0;
    const res = await fetch(`${handle.url}/api/v1/_stream/events`, {
      headers: {
        authorization: `Bearer ${allowedContext.contextKey}`,
        accept: "text/event-stream",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: message");
    expect(body).toContain('data: {"type":"event","topic":"ravi.test","data":{"ok":true}}');
    expect(body).toContain("event: end");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(streamAudits.some((event) => event.type === "sdk.gateway.stream.opened")).toBe(true);
    expect(streamAudits.some((event) => event.type === "sdk.gateway.stream.closed")).toBe(true);
  });

  it("requires bearer auth for streams", async () => {
    const res = await fetch(`${handle.url}/api/v1/_stream/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.reason).toContain("Authorization");
  });

  it("denies streams when context lacks the channel scope", async () => {
    streamAudits.length = 0;
    const res = await fetch(`${handle.url}/api/v1/_stream/events`, {
      headers: {
        authorization: `Bearer ${deniedContext.contextKey}`,
        accept: "text/event-stream",
      },
    });
    expect(res.status).toBe(403);
    expect(streamAudits.some((event) => event.type === "sdk.gateway.stream.denied")).toBe(true);
  });
});
