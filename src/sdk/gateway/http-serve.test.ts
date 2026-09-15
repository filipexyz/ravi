import { describe, expect, it } from "bun:test";

import { raviHttpServeOptions } from "./http-serve.js";
import { createSseReadableStream, DEFAULT_HTTP_IDLE_TIMEOUT_SECONDS, DEFAULT_KEEPALIVE_MS } from "./streaming/sse.js";

interface ServeLike {
  port: number;
  stop(force?: boolean): void;
}

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    idleTimeout?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): ServeLike;
};

describe("raviHttpServeOptions", () => {
  it("sets Bun idleTimeout above the SSE ping interval", () => {
    const options = raviHttpServeOptions({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });

    expect(options.idleTimeout).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_SECONDS);
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_SECONDS).toBe(30);
    expect(DEFAULT_KEEPALIVE_MS).toBe(15_000);
    expect(options.idleTimeout * 1000).toBeGreaterThan(DEFAULT_KEEPALIVE_MS);
    expect(options.idleTimeout).toBeGreaterThan(10);
  });

  it("accepts an explicit idleTimeout override", () => {
    const options = raviHttpServeOptions({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 2,
      fetch: () => new Response("ok"),
    });
    expect(options.idleTimeout).toBe(2);
  });

  it("keeps an idle SSE connection open past idleTimeout when pings fire first", async () => {
    const idleTimeoutSeconds = 1;
    const keepaliveMs = 200;
    const server = Bun.serve(
      raviHttpServeOptions({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: idleTimeoutSeconds,
        fetch: () =>
          new Response(
            createSseReadableStream(
              (async function* () {
                await new Promise(() => undefined);
              })(),
              { keepaliveMs },
            ),
            {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                connection: "keep-alive",
              },
            },
          ),
      }),
    );

    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let lastPingAt = 0;
      const deadline = started + idleTimeoutSeconds * 1000 + 800;
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const next = await Promise.race([
          reader.read().then((chunk) => ({ kind: "read" as const, ...chunk })),
          new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), remaining)),
        ]);
        if (next.kind === "timeout") break;
        if (next.done) break;
        if (!next.value) continue;
        text += decoder.decode(next.value, { stream: true });
        if (text.includes(": ping")) lastPingAt = Date.now();
      }

      expect(text).toContain(": connected");
      expect(text).toContain(": ping");
      expect(lastPingAt - started).toBeGreaterThan(idleTimeoutSeconds * 1000);
    } finally {
      server.stop(true);
    }
  });
});
