import { describe, expect, it, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { createKimiCodeTurnRequest } from "./kimi-code-turn.js";
import type { RuntimeStartRequest } from "./types.js";
import {
  buildKimiCodeRequest,
  createKimiCodeHttpTransport,
  KimiCodeHttpError,
  type KimiCodeTransportRequest,
} from "./kimi-code-transport.js";

const sessionId = "2df23f10-7811-4e4c-9348-5d61d83f4da2";

function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: (async function* () {})(),
    model: "k3",
    cwd: "C:/synthetic",
    abortController: new AbortController(),
    systemPromptAppend: "Ravi policy.",
    env: { KIMI_API_KEY: "synthetic-key" },
    ...overrides,
  };
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function response(chunks: string[], status = 200): Response {
  return new Response(stream(...chunks), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function syntheticFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

async function collect(transportRequest: KimiCodeTransportRequest, chunks: string[]): Promise<unknown[]> {
  const transport = createKimiCodeHttpTransport({ fetch: syntheticFetch(async () => response(chunks)) });
  const events: unknown[] = [];
  for await (const event of transport.stream(transportRequest)) events.push(event);
  return events;
}

describe("buildKimiCodeRequest", () => {
  test("sends the exact membership endpoint, honest headers, stable cache key, and stream body", () => {
    const built = buildKimiCodeRequest(request({ effort: "minimal" }), [{ role: "user", content: "hello" }], sessionId);

    expect(built.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(built.headers).toEqual({
      Authorization: "Bearer synthetic-key",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": `ravi/${packageJson.version}`,
    });
    expect(built.body).toEqual({
      model: "k3",
      messages: [
        { role: "system", content: "Ravi policy." },
        { role: "user", content: "hello" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: sessionId,
      thinking: { type: "enabled", effort: "low" },
    });
  });

  test("uses one supplied session uuid unchanged across requests", () => {
    const input = request();
    expect(buildKimiCodeRequest(input, [{ role: "user", content: "one" }], sessionId).body.prompt_cache_key).toBe(
      sessionId,
    );
    expect(buildKimiCodeRequest(input, [{ role: "user", content: "two" }], sessionId).body.prompt_cache_key).toBe(
      sessionId,
    );
  });

  test("maps K3 effort and omits thinking for fixed-thinking models", () => {
    expect(
      buildKimiCodeRequest(request({ effort: "ultra" }), [{ role: "user", content: "x" }], sessionId).body.thinking,
    ).toEqual({
      type: "enabled",
      effort: "max",
    });
    expect(
      buildKimiCodeRequest(
        request({ model: "kimi-for-coding", effort: "none" }),
        [{ role: "user", content: "x" }],
        sessionId,
      ).body.thinking,
    ).toBeUndefined();
  });

  test("fails preflight for an unsupported model or missing KIMI_API_KEY", () => {
    expect(() =>
      buildKimiCodeRequest(request({ model: "not-kimi" }), [{ role: "user", content: "x" }], sessionId),
    ).toThrow("Unknown Kimi Code model 'not-kimi'");
    expect(() => buildKimiCodeRequest(request({ env: {} }), [{ role: "user", content: "x" }], sessionId)).toThrow(
      "KIMI_API_KEY is required",
    );
  });

  test("enforces the 2 MiB UTF-8 limit for each input message", () => {
    expect(() =>
      buildKimiCodeRequest(request(), [{ role: "user", content: "a".repeat(2 * 1024 * 1024 - 1024) }], sessionId),
    ).not.toThrow();
    expect(() => buildKimiCodeRequest(request(), [{ role: "user", content: "😀".repeat(524_289) }], sessionId)).toThrow(
      "2 MiB",
    );
  });

  it("places system policy before the transcript on first and tool-continuation requests", () => {
    const firstRequest = buildKimiCodeRequest(request(), [{ role: "user", content: "first prompt" }], sessionId);
    const continuationRequest = buildKimiCodeRequest(
      request(),
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "I'll use a tool." },
        { role: "tool", content: "tool result" },
      ] as never,
      sessionId,
    );

    expect(firstRequest.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(continuationRequest.body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("rejects a serialized native body larger than 2 MiB even when each message is smaller", () => {
    const error = expect(() =>
      buildKimiCodeRequest(
        request(),
        [
          { role: "user", content: "a".repeat(Math.floor(1.1 * 1024 * 1024)) },
          { role: "user", content: "b".repeat(Math.floor(1.1 * 1024 * 1024)) },
        ],
        sessionId,
      ),
    );

    error.toThrow("request_too_large");
  });

  it("returns typed non-recoverable preflight failures for key model effort and size", () => {
    const cases: Array<[string, () => unknown, string]> = [
      ["key", () => buildKimiCodeRequest(request({ env: {} }), [], sessionId), "missing_api_key"],
      ["model", () => buildKimiCodeRequest(request({ model: "other" }), [], sessionId), "unknown_model"],
      [
        "effort",
        () => buildKimiCodeRequest(request({ effort: "none" }), [{ role: "user", content: "x" }], sessionId),
        "unsupported_effort",
      ],
      [
        "size",
        () => buildKimiCodeRequest(request(), [{ role: "user", content: "😀".repeat(524_289) }], sessionId),
        "message_too_large",
      ],
    ];

    for (const [_caseName, invoke, code] of cases) {
      try {
        invoke();
        throw new Error("expected preflight failure");
      } catch (error) {
        expect(error).toMatchObject({ name: "KimiCodePreflightError", code, recoverable: false });
      }
    }
  });
});

describe("createKimiCodeHttpTransport", () => {
  const transportRequest: KimiCodeTransportRequest = {
    url: "https://api.kimi.com/coding/v1/chat/completions",
    headers: { Authorization: "Bearer synthetic-key" },
    body: {
      model: "k3",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: sessionId,
    },
  };

  test("parses LF, CRLF, comments, and multiline data events", async () => {
    await expect(
      collect(transportRequest, [": keepalive\r\n", 'data: {"part":\r\ndata: "hello"}\r\n\r\n']),
    ).resolves.toEqual([{ type: "message", data: { part: "hello" } }, { type: "eof" }]);
  });

  test("emits done and ignores data after [DONE]", async () => {
    await expect(collect(transportRequest, ['data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n'])).resolves.toEqual([
      { type: "message", data: { n: 1 } },
      { type: "done" },
    ]);
  });

  test("decodes UTF-8 when an event spans byte chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"😀"}\n\n');
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes.slice(0, 18));
                controller.enqueue(bytes.slice(18));
                controller.close();
              },
            }),
          ),
      ),
    });
    const events = [];
    for await (const event of transport.stream(transportRequest)) events.push(event);
    expect(events).toEqual([{ type: "message", data: { text: "😀" } }, { type: "eof" }]);
  });

  test("fails malformed JSON and oversized retained input without exposing body or authorization", async () => {
    await expect(collect(transportRequest, ["data: {bad}\n\n"])).rejects.toThrow(
      "Kimi Code protocol error: malformed JSON event",
    );
    await expect(collect(transportRequest, ["x".repeat(1024 * 1024 + 1)])).rejects.toThrow("buffer limit");
  });

  test("rejects one complete SSE event that exceeds the event bound", async () => {
    const oversized = `data: ${JSON.stringify({ text: "x".repeat(1024 * 1024) })}\n\n`;

    await expect(collect(transportRequest, [oversized])).rejects.toThrow("event limit");
  });

  test("accepts a large fetch chunk when it contains only complete small SSE events", async () => {
    const eventCount = 70_000;
    const events = await collect(transportRequest, ['data: {"n":1}\n\n'.repeat(eventCount)]);

    expect(events).toHaveLength(eventCount + 1);
    expect(events[0]).toEqual({ type: "message", data: { n: 1 } });
    expect(events.at(-1)).toEqual({ type: "eof" });
  });

  test("reports a redacted non-2xx failure", async () => {
    const sentinel = "PRIVATE_RESPONSE_BODY_MUST_NOT_ESCAPE";
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "usage_limit",
                type: "membership_error",
                message:
                  "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
              },
              sentinel,
            }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
                "retry-after": "120",
                "x-request-id": "req-synthetic",
                authorization: "Bearer secret-must-not-escape",
              },
            },
          ),
      ),
    });
    let caught: unknown;
    try {
      for await (const _event of transport.stream(transportRequest)) {
        /* consume */
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KimiCodeHttpError);
    if (!(caught instanceof KimiCodeHttpError)) throw new Error("missing structured Kimi failure");
    expect(caught.message).toBe(
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle.",
    );
    expect(caught.rawEvent).toEqual({
      status: 403,
      code: "usage_limit",
      type: "membership_error",
      headers: { "retry-after": "120", "x-request-id": "req-synthetic" },
      requestId: "req-synthetic",
    });
    expect(JSON.stringify(caught)).not.toContain(sentinel);
    expect(JSON.stringify(caught)).not.toContain("secret-must-not-escape");
  });

  test("canonicalizes generalized Kimi membership quota windows", async () => {
    for (const message of [
      "You've reached your weekly usage limit.",
      "Your 5-hour usage limit has been reached.",
      "The monthly usage limit has been reached.",
    ]) {
      const transport = createKimiCodeHttpTransport({
        fetch: syntheticFetch(async () => response([JSON.stringify({ error: { message } })], 429)),
      });
      let caught: unknown;
      try {
        for await (const _event of transport.stream(transportRequest)) {
          /* consume */
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KimiCodeHttpError);
      expect((caught as KimiCodeHttpError).message).toBe("Kimi Code membership quota is exhausted.");
    }
  });

  test("redacts a fetch failure instead of propagating external transport text", async () => {
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async () => {
        throw new Error("synthetic-key and private prompt must not escape");
      }),
    });
    await expect(
      (async () => {
        for await (const _event of transport.stream(transportRequest)) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("Kimi Code request could not be completed");
  });

  test("redacts a stream-read failure instead of propagating credential-like or prompt text", async () => {
    const sentinel = "synthetic-key-PRIVATE-PROMPT";
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(sentinel));
              },
            }),
          ),
      ),
    });

    const consume = (async () => {
      for await (const _event of transport.stream(transportRequest)) {
        /* consume */
      }
    })();
    await expect(consume).rejects.toThrow("Kimi Code stream could not be read");
    await expect(consume).rejects.not.toThrow(sentinel);
  });

  test("emits EOF and stops silently on an aborted request; close is idempotent", async () => {
    await expect(collect(transportRequest, ['data: {"n":1}\n\n'])).resolves.toEqual([
      { type: "message", data: { n: 1 } },
      { type: "eof" },
    ]);
    const abortController = new AbortController();
    abortController.abort();
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async () => response(['data: {"n":1}\n\n'])),
    });
    const events = [];
    for await (const event of transport.stream({ ...transportRequest, signal: abortController.signal }))
      events.push(event);
    await transport.close();
    await transport.close();
    expect(events).toEqual([]);
  });

  it("never attaches authorization to a non-Kimi production origin", async () => {
    const built = buildKimiCodeRequest(request(), [{ role: "user", content: "hello" }], sessionId);
    const received: { url?: string; headers?: unknown } = {};
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async (url, init) => {
        received.url = String(url);
        received.headers = init?.headers;
        return response(["data: [DONE]\n\n"]);
      }),
      baseUrl: "https://not-kimi.invalid/coding/v1",
    } as never);

    for await (const _event of transport.stream(built)) {
      /* consume */
    }

    expect(received.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(new Headers(received.headers as never).get("authorization")).toBe("Bearer synthetic-key");
  });

  it("rejects an oversized final body after dynamic tools are attached before HTTP handoff", async () => {
    const turnRequest = createKimiCodeTurnRequest(
      request({
        dynamicTools: [
          {
            name: "large_schema_tool",
            description: "x".repeat(2 * 1024 * 1024),
            inputSchema: { type: "object" },
          },
        ],
      }),
      [{ role: "user", content: "short transcript" }],
      sessionId,
    );
    let fetchCalls = 0;
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async () => {
        fetchCalls += 1;
        return response(["data: [DONE]\n\n"]);
      }),
    });

    expect(new TextEncoder().encode(JSON.stringify(turnRequest.body.messages)).byteLength).toBeLessThan(
      2 * 1024 * 1024,
    );
    await expect(consume(transport, turnRequest)).rejects.toMatchObject({
      name: "KimiCodePreflightError",
      code: "request_too_large",
      recoverable: false,
    });
    expect(fetchCalls).toBe(0);
  });

  it("hands off the one final serialized representation after dynamic tools are attached", async () => {
    let serializations = 0;
    const turnRequest = createKimiCodeTurnRequest(
      request({
        dynamicTools: [
          {
            name: "serialization_probe",
            description: "probe",
            inputSchema: {
              toJSON() {
                serializations += 1;
                return { serialization: serializations };
              },
            },
          },
        ],
      }),
      [{ role: "user", content: "short transcript" }],
      sessionId,
    );
    let handedOffBody: unknown;
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async (_url, init) => {
        handedOffBody = init?.body;
        return response(["data: [DONE]\n\n"]);
      }),
    });

    await consume(transport, turnRequest);

    expect(serializations).toBe(1);
    expect(handedOffBody).toContain('"serialization":1');
  });

  it("classifies a fetch rejection before acceptance as request_not_sent", async () => {
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async () => {
        throw new Error("network unavailable");
      }),
    });

    await expect(consume(transport, transportRequest)).rejects.toMatchObject({
      name: "KimiCodeTransportError",
      phase: "request_not_sent",
    });
  });

  it("classifies an unowned AbortError before acceptance as request_not_sent", async () => {
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(async () => {
        throw new DOMException("remote cancellation", "AbortError");
      }),
    });

    await expect(consume(transport, transportRequest)).rejects.toMatchObject({
      name: "KimiCodeTransportError",
      phase: "request_not_sent",
    });
  });

  it("classifies failure after response acceptance as acceptance_ambiguous", async () => {
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection lost after acceptance"));
              },
            }),
          ),
      ),
    });

    await expect(consume(transport, transportRequest)).rejects.toMatchObject({
      name: "KimiCodeTransportError",
      phase: "acceptance_ambiguous",
    });
  });

  it("classifies an unowned AbortError after acceptance as acceptance_ambiguous", async () => {
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException("remote cancellation", "AbortError"));
              },
            }),
          ),
      ),
    });

    await expect(consume(transport, transportRequest)).rejects.toMatchObject({
      name: "KimiCodeTransportError",
      phase: "acceptance_ambiguous",
    });
  });

  it("classifies malformed accepted SSE as provider_protocol", async () => {
    const transport = createKimiCodeHttpTransport({ fetch: syntheticFetch(async () => response(["data: {bad}\n\n"])) });

    await expect(consume(transport, transportRequest)).rejects.toMatchObject({
      name: "KimiCodeProtocolError",
      phase: "provider_protocol",
    });
  });

  it("removes combined abort listeners after every stream round", async () => {
    const requestAbort = new AbortController();
    const signal = requestAbort.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    Object.defineProperty(signal, "addEventListener", {
      configurable: true,
      value: ((...args: Parameters<AbortSignal["addEventListener"]>) => {
        const [type] = args;
        if (type === "abort") added += 1;
        return originalAdd(...args);
      }) as AbortSignal["addEventListener"],
    });
    Object.defineProperty(signal, "removeEventListener", {
      configurable: true,
      value: ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
        const [type] = args;
        if (type === "abort") removed += 1;
        return originalRemove(...args);
      }) as AbortSignal["removeEventListener"],
    });
    const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    try {
      const transport = createKimiCodeHttpTransport({
        fetch: syntheticFetch(async () => response(["data: [DONE]\n\n"])),
      });
      await consume(transport, { ...transportRequest, signal });
      const rejectedTransport = createKimiCodeHttpTransport({
        fetch: syntheticFetch(async () => {
          throw new Error("connection refused");
        }),
      });
      await expect(consume(rejectedTransport, { ...transportRequest, signal })).rejects.toThrow(
        "Kimi Code request could not be completed",
      );
    } finally {
      if (nativeAny) Object.defineProperty(AbortSignal, "any", nativeAny);
      else Reflect.deleteProperty(AbortSignal, "any");
      Reflect.deleteProperty(signal, "addEventListener");
      Reflect.deleteProperty(signal, "removeEventListener");
    }

    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });

  it("ends an aborted pending reader without converting it to eof", async () => {
    let readStarted!: () => void;
    const readerStarted = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const abortController = new AbortController();
    const transport = createKimiCodeHttpTransport({
      fetch: syntheticFetch(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                readStarted();
              },
            }),
          ),
      ),
    });
    const iterator = transport.stream({ ...transportRequest, signal: abortController.signal })[Symbol.asyncIterator]();
    const next = iterator.next();
    await readerStarted;
    abortController.abort();

    await expect(
      Promise.race([
        next,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("reader remained pending after abort")), 100);
        }),
      ]),
    ).resolves.toEqual({ value: undefined, done: true });
  });
});

async function consume(
  transport: ReturnType<typeof createKimiCodeHttpTransport>,
  transportRequest: KimiCodeTransportRequest,
) {
  for await (const _event of transport.stream(transportRequest)) {
    /* consume */
  }
}
