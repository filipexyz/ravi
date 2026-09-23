import { afterEach, describe, expect, it } from "bun:test";

import { resolveFetch } from "../fetch.js";
import { RaviStreamClient } from "../streaming.js";
import { createHttpTransport } from "../transport/http.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveFetch", () => {
  it("throws the caller message when no fetch is available", () => {
    globalThis.fetch = undefined as unknown as typeof fetch;

    expect(() => resolveFetch(undefined, "missing fetch")).toThrow("missing fetch");
  });

  it("returns a custom fetch without rebinding it", async () => {
    const owner = {
      token: "custom",
      async fetch(this: { token: string }, _input: RequestInfo | URL) {
        if (this?.token !== "custom") {
          throw new Error("custom fetch lost its receiver");
        }
        return jsonResponse({ source: "custom" });
      },
    };
    const custom = owner.fetch.bind(owner) as typeof fetch;

    expect(resolveFetch(custom, "missing fetch")).toBe(custom);
    const response = await resolveFetch(custom, "missing fetch")("https://ravi.test/custom");
    expect(await response.json()).toEqual({ source: "custom" });
  });

  it("binds the global fallback so Window-like fetch can be invoked unbound", async () => {
    installWindowLikeFetch(async () => jsonResponse({ source: "global" }));

    const extracted = globalThis.fetch;
    expect(() => extracted("https://ravi.test/unbound")).toThrow(/Illegal invocation/);

    const bound = resolveFetch(undefined, "missing fetch");
    const response = await bound("https://ravi.test/bound");
    expect(await response.json()).toEqual({ source: "global" });
  });
});

describe("createHttpTransport fetch binding", () => {
  it("uses the default global fetch when config.fetch is omitted", async () => {
    installWindowLikeFetch(async () => jsonResponse({ ok: true }));

    const transport = createHttpTransport({
      baseUrl: "https://gateway.example",
      contextKey: "rctx_test",
    });

    await expect(
      transport.call({ groupSegments: ["context"], command: "whoami", body: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it("honors a custom config.fetch and does not call global fetch", async () => {
    let globalCalls = 0;
    installWindowLikeFetch(async () => {
      globalCalls += 1;
      return jsonResponse({ source: "global" });
    });

    const transport = createHttpTransport({
      baseUrl: "https://gateway.example",
      contextKey: "rctx_test",
      fetch: (async () => jsonResponse({ source: "custom" })) as typeof fetch,
    });

    await expect(
      transport.call({ groupSegments: ["context"], command: "whoami", body: {} }),
    ).resolves.toEqual({ source: "custom" });
    expect(globalCalls).toBe(0);
  });
});

describe("RaviStreamClient fetch binding", () => {
  it("uses the default global fetch when config.fetch is omitted", async () => {
    installWindowLikeFetch(async () => sseResponse());

    const client = new RaviStreamClient({
      baseUrl: "http://ravi.test/",
      contextKey: "rctx_test",
    });

    const events = [];
    for await (const event of client.events()) {
      events.push(event);
    }

    expect(events).toEqual([{ event: "end", data: { type: "stream.end" } }]);
  });

  it("honors a custom config.fetch and does not call global fetch", async () => {
    let globalCalls = 0;
    installWindowLikeFetch(async () => {
      globalCalls += 1;
      return sseResponse();
    });

    const client = new RaviStreamClient({
      baseUrl: "http://ravi.test/",
      contextKey: "rctx_test",
      fetch: (async () => sseResponse({ source: "custom" })) as typeof fetch,
    });

    const events = [];
    for await (const event of client.events()) {
      events.push(event);
    }

    expect(events[0]?.data).toEqual({ source: "custom" });
    expect(globalCalls).toBe(0);
  });
});

function installWindowLikeFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  function windowLikeFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return impl(input, init);
  }
  globalThis.fetch = windowLikeFetch as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(data: unknown = { type: "stream.end" }): Response {
  return new Response(`event: end\ndata: ${JSON.stringify(data)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
