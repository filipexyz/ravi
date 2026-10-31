import { describe, expect, it } from "bun:test";
import type { ContextRecord } from "../../../router/router-db.js";
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
