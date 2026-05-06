import { describe, expect, it } from "bun:test";

import { parseSse, RaviStreamClient } from "../streaming.js";

describe("parseSse", () => {
  it("parses event, id, and JSON data frames", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': connected\n\nid: 7\nevent: message\ndata: {"ok":true}\n\n'));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSse<{ ok: boolean }>(stream)) {
      events.push(event);
    }

    expect(events).toEqual([{ id: "7", event: "message", data: { ok: true } }]);
  });

  it("cancels the stream when iteration stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"ok":true}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const events = [];
    for await (const event of parseSse<{ ok: boolean }>(stream)) {
      events.push(event);
      break;
    }

    expect(events).toEqual([{ event: "message", data: { ok: true } }]);
    expect(cancelled).toBe(true);
  });
});

describe("RaviStreamClient", () => {
  it("opens streams with bearer auth and SSE accept header", async () => {
    const seen: { url: string; auth: string | null; accept: string | null }[] = [];
    const client = new RaviStreamClient({
      baseUrl: "http://ravi.test/",
      contextKey: "rctx_test",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: String(input),
          auth: headers.get("authorization"),
          accept: headers.get("accept"),
        });
        return new Response('event: end\ndata: {"type":"stream.end"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const events = [];
    for await (const event of client.events({ subject: "ravi.session.>", noClaude: true })) {
      events.push(event);
    }

    expect(seen[0]?.url).toBe("http://ravi.test/api/v1/_stream/events?subject=ravi.session.%3E&noClaude=1");
    expect(seen[0]?.auth).toBe("Bearer rctx_test");
    expect(seen[0]?.accept).toBe("text/event-stream");
    expect(events[0]?.event).toBe("end");
  });
});
