import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildRegistry } from "../../../cli/registry-snapshot.js";
import type { ContextRecord } from "../../../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext } from "../../../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../../test/ravi-state.js";
import type { GatewayContractErrorBody } from "../errors.js";
import { createGatewayHandlerContext, handleGatewayRequest } from "../server.js";
import { handleStreamingRequest } from "./handler.js";
import type { StreamAuditEvent, StreamChannel, StreamEvent } from "./types.js";

function liveContext(): ContextRecord {
  return {
    contextId: "ctx_stream_live",
    contextKey: "rctx_stream_live",
    kind: "turn-runtime",
    agentId: "stream-agent",
    capabilities: [{ permission: "view", objectType: "system", objectId: "events" }],
    createdAt: Date.now(),
  };
}

/** A channel whose events the test pushes one at a time. */
function pushChannel() {
  const queue: StreamEvent[] = [];
  let wake: (() => void) | null = null;
  const channel: StreamChannel = {
    name: "events",
    meta: {
      methodName: "events",
      pathPattern: "events",
      optionsTypeName: "EventsStreamOptions",
      payloadTypeName: "GatewayTopicEvent",
      optionsSchema: { type: "object", additionalProperties: false, properties: {} },
      payloadSchema: { type: "object", properties: {} },
    },
    match: (segments) =>
      segments[0] === "events"
        ? { channelPath: "events", scope: { permission: "view", objectType: "system", objectId: "events" } }
        : null,
    async *subscribe(ctx) {
      while (!ctx.signal.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
  return {
    channel,
    push(data: string) {
      queue.push({ event: "message", data: { data } });
      wake?.();
    },
  };
}

async function openStream(record: { current: ContextRecord | null }, authRecheckMs = 60_000) {
  const audits: StreamAuditEvent[] = [];
  const feed = pushChannel();
  const response = await handleStreamingRequest(
    new Request("http://gateway.test/api/v1/_stream/events", {
      headers: { authorization: "Bearer rctx_stream_live" },
    }),
    new URL("http://gateway.test/api/v1/_stream/events"),
    {
      auth: { resolveContext: () => record.current },
      authFailureMessage: () => "unauthorized",
      streaming: { channels: [feed.channel], authRecheckMs, emitAudit: (event) => void audits.push(event) },
    },
  );
  if (!response?.body) throw new Error("stream did not open");
  return { reader: response.body.getReader(), feed, audits };
}

async function readAll(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe("SSE admission uses the gateway context error contract", () => {
  let stateDir: string | null = null;
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-stream-auth-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function request(token: string) {
    const audits: StreamAuditEvent[] = [];
    let subscriptions = 0;
    const channel: StreamChannel = {
      ...pushChannel().channel,
      async *subscribe() {
        subscriptions += 1;
        yield { event: "message", data: { value: "authorized" } };
      },
    };
    const ctx = createGatewayHandlerContext({
      registry: buildRegistry([]),
      streaming: { channels: [channel], emitAudit: (event) => void audits.push(event) },
    });
    const response = await handleGatewayRequest(
      new Request("http://gateway.test/api/v1/_stream/events", {
        headers: { authorization: `Bearer ${token}` },
      }),
      ctx,
    );
    if (!response) throw new Error("stream route was not handled");
    const text = await response.text();
    expect(text).not.toContain(token);
    return { response, text, audits, subscriptions };
  }

  it.each(["expired", "revoked", "revoked-expired", "unknown"] as const)(
    "rejects %s credentials before subscribing",
    async (state) => {
      const context = createRuntimeContext({
        capabilities: liveContext().capabilities,
        ...(state.includes("expired") ? { expiresAt: Date.now() - 1 } : {}),
      });
      if (state.startsWith("revoked")) revokeRuntimeContext(context.contextId);
      const { response, text, audits, subscriptions } = await request(
        state === "unknown" ? "rctx_unknown_stream_fixture" : context.contextKey,
      );
      const body = JSON.parse(text) as GatewayContractErrorBody;
      expect(response.status).toBe(401);
      expect(body.error.code).toBe(state === "expired" ? "CONTEXT_EXPIRED" : "AUTH_REQUIRED");
      expect(body.error.cause).toContain(state === "revoked-expired" ? "revoked" : state);
      expect(subscriptions).toBe(0);
      expect(audits).toEqual([]);
    },
  );

  it("names the required capability when a live context has no grant", async () => {
    const context = createRuntimeContext({ capabilities: [] });
    const { response, text, audits, subscriptions } = await request(context.contextKey);
    const body = JSON.parse(text) as GatewayContractErrorBody;
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(body.error.cause).toBe("Permission denied: requires view on system:events");
    expect(subscriptions).toBe(0);
    expect(audits.map((event) => event.type)).toEqual(["sdk.gateway.stream.denied"]);
  });

  it("opens and delivers events with a live authorized context", async () => {
    const context = createRuntimeContext({ capabilities: liveContext().capabilities });
    const { response, text, audits, subscriptions } = await request(context.contextKey);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('data: {"value":"authorized"}');
    expect(subscriptions).toBe(1);
    expect(audits.map((event) => event.type)).toEqual(["sdk.gateway.stream.opened", "sdk.gateway.stream.closed"]);
  });
});

describe("open SSE streams follow their context", () => {
  it("stops delivering once the context is revoked", async () => {
    const record = { current: liveContext() as ContextRecord | null };
    const { reader, feed, audits } = await openStream(record);
    feed.push("before");
    await new Promise((resolve) => setTimeout(resolve, 10));
    record.current = { ...record.current!, revokedAt: Date.now() - 1 };
    feed.push("after");

    const body = await readAll(reader);
    expect(body).toContain("before");
    expect(body).not.toContain("after");
    expect(audits.find((event) => event.type === "sdk.gateway.stream.closed")?.reason).toBe("revoked");
  });

  it("closes an idle stream when the grant is removed", async () => {
    const record = { current: liveContext() as ContextRecord | null };
    const { reader, audits } = await openStream(record, 10);
    record.current = { ...record.current!, capabilities: [] };

    await readAll(reader);
    expect(audits.find((event) => event.type === "sdk.gateway.stream.closed")?.reason).toBe("permission_revoked");
  });
});
