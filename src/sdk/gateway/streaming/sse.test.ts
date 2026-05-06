import { describe, expect, it } from "bun:test";

import { createSseReadableStream, encodeSseEvent } from "./sse.js";

describe("SSE encoder", () => {
  it("emits id, event, and single-line JSON data", () => {
    const encoded = encodeSseEvent({
      id: "1\n2",
      event: "message\nbad",
      data: { ok: true, text: "hello\nworld" },
    });

    expect(encoded).toBe('id: 1 2\nevent: message bad\ndata: {"ok":true,"text":"hello\\nworld"}\n\n');
  });
});

describe("SSE readable stream", () => {
  it("assigns monotonic ids after Last-Event-ID", async () => {
    async function* source() {
      yield { event: "message", data: { first: true } };
      yield { event: "end", data: { done: true } };
    }

    const stream = createSseReadableStream(source(), { keepaliveMs: 10_000, lastEventId: "41" });
    const text = await new Response(stream).text();

    expect(text).toContain("id: 42\nevent: message");
    expect(text).toContain("id: 43\nevent: end");
  });

  it("closes the stream when the external signal aborts", async () => {
    async function* source() {
      yield { event: "message", data: { first: true } };
      await new Promise(() => undefined);
    }

    const controller = new AbortController();
    let closeReason: string | undefined;
    const stream = createSseReadableStream(source(), {
      signal: controller.signal,
      keepaliveMs: 10_000,
      onClose(reason) {
        closeReason = reason;
      },
    });

    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    const done = await reader.read();

    expect(done.done).toBe(true);
    expect(closeReason).toBe("aborted");
  });
});
