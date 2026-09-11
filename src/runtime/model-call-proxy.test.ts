import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync, serve, sleep } from "bun";
import { createModelCallFence } from "./model-call-fence.js";
import type { ModelCallFence, ModelCallInvalidation } from "./model-call-fence.js";
import { startModelCallProxy } from "./model-call-proxy.js";
import type { ModelCallProxySingleEndpointOptions } from "./model-call-proxy.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function startUpstream(handler: (request: Request) => Response | Promise<Response>): string {
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanup.push(() => server.stop(true));
  return new URL("/v1/responses", server.url).toString();
}

function openFence(): ModelCallFence {
  return createModelCallFence({
    binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
    assertCurrent() {},
    notifyInvalidated() {},
  });
}

function startProxy(upstreamUrl: string, overrides: Partial<ModelCallProxySingleEndpointOptions> = {}) {
  const proxy = startModelCallProxy({
    fence: openFence(),
    requestPath: "/responses",
    upstream: { url: upstreamUrl },
    ...overrides,
  });
  cleanup.push(() => proxy.close());
  return proxy;
}

function post(url: string, body = "model-input") {
  return fetch(url, { method: "POST", body });
}

describe("model call proxy", () => {
  test("inspects a defensive body copy without altering the original bytes sent upstream", async () => {
    const received: number[][] = [];
    const inspected: Array<{ method: string; path: string; bytes: number[] }> = [];
    const upstream = startUpstream(async (request) => {
      received.push([...new Uint8Array(await request.arrayBuffer())]);
      return new Response("ok");
    });
    const proxy = startProxy(upstream, {
      beforeDispatch(inspection) {
        inspected.push({ method: inspection.method, path: inspection.path, bytes: [...inspection.body] });
        inspection.body.fill(7);
        expect(Object.isFrozen(inspection)).toBe(true);
      },
    });

    const response = await fetch(proxy.url, { method: "POST", body: new Uint8Array([0, 255, 4, 10, 13]) });

    expect(await response.text()).toBe("ok");
    expect(inspected).toEqual([{ method: "POST", path: "/responses", bytes: [0, 255, 4, 10, 13] }]);
    expect(received).toEqual([[0, 255, 4, 10, 13]]);
  });

  test("an inspector exception invalidates the binding without sending a body or revealing the exception", async () => {
    let received = 0;
    let rejectInspection = true;
    const notifications: ModelCallInvalidation[] = [];
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, {
      fence: createModelCallFence({
        binding: {
          snapshotId: "snapshot-1",
          scope: { agentId: "test", executionId: "run-1", contextKey: "rctx_private_inspection_fixture" },
        },
        assertCurrent() {},
        notifyInvalidated: (event) => {
          notifications.push(event);
        },
      }),
      beforeDispatch() {
        if (rejectInspection) throw new Error("fixture-private-inspector-content");
      },
    });

    const rejected = await post(proxy.url, "private-draft");
    rejectInspection = false;
    const retry = await post(proxy.url, "retry-draft");

    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toBe('{"error":{"code":"RAVI_SKILL_POLICY_STALE"}}');
    expect(retry.status).toBe(409);
    expect(received).toBe(0);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toContain("rctx_private_inspection_fixture");
    expect(JSON.stringify(notifications)).not.toContain("fixture-private-inspector-content");
  });

  test.each(["resolved", "rejected"])(
    "rejects a %s Promise from an inspector before upstream dispatch",
    async (outcome) => {
      let received = 0;
      const upstream = startUpstream(() => {
        received += 1;
        return new Response("unexpected");
      });
      const proxy = startProxy(upstream, {
        async beforeDispatch() {
          if (outcome === "rejected") throw new Error("fixture-private-async-inspector");
        },
      });

      const response = await post(proxy.url);

      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain("fixture-private");
      expect(received).toBe(0);
    },
  );

  test("checks current policy after inspection rather than admitting a request before its inspection changes state", async () => {
    let revision = 1;
    let received = 0;
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, {
      fence: createModelCallFence({
        binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
        assertCurrent() {
          if (revision !== 1) throw new Error("Policy changed");
        },
        notifyInvalidated() {},
      }),
      beforeDispatch() {
        revision = 2;
      },
    });

    const response = await post(proxy.url);

    expect(response.status).toBe(409);
    expect(received).toBe(0);
  });

  test("guards explicit GET discovery and POST inference routes under the same immutable binding", async () => {
    const received: string[] = [];
    const upstream = startUpstream((request) => {
      const target = new URL(request.url);
      received.push(`${request.method} ${target.pathname}${target.search}`);
      return new Response("ok");
    });
    const fence = openFence();
    const proxy = startModelCallProxy({
      fence,
      routes: [
        {
          method: "GET",
          path: "/models",
          upstream: { url: new URL("/models?fixed=host", upstream).toString() },
          queryKeys: ["client_version"],
        },
        { method: "POST", path: "/responses", upstream: { url: new URL("/responses", upstream).toString() } },
        {
          method: "POST",
          path: "/responses/compact",
          upstream: { url: new URL("/responses/compact", upstream).toString() },
        },
      ],
    });
    cleanup.push(() => proxy.close());

    expect(await (await fetch(`${proxy.baseUrl}/models?client_version=test-version`)).text()).toBe("ok");
    expect(await (await post(`${proxy.baseUrl}/responses`)).text()).toBe("ok");
    expect(await (await post(`${proxy.baseUrl}/responses/compact`)).text()).toBe("ok");
    await fence.invalidate("policy-changed");
    expect((await post(`${proxy.baseUrl}/responses`)).status).toBe(409);
    expect((await fetch(`${proxy.baseUrl}/models?client_version=test-version`)).status).toBe(409);

    expect(received).toEqual([
      "GET /models?fixed=host&client_version=test-version",
      "POST /responses",
      "POST /responses/compact",
    ]);
  });

  test("multiple routes reject undeclared paths, methods, duplicate queries and unapproved query keys", async () => {
    let received = 0;
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startModelCallProxy({
      fence: openFence(),
      routes: [{ method: "GET", path: "/models", upstream: { url: upstream }, queryKeys: ["client_version"] }],
    });
    cleanup.push(() => proxy.close());

    const attempts = [
      fetch(`${proxy.baseUrl}/models?client_version=one&client_version=two`),
      fetch(`${proxy.baseUrl}/models?target=http://127.0.0.1/private`),
      fetch(`${proxy.baseUrl}/models?fixed=override`),
      fetch(`${proxy.baseUrl}/unknown`),
      post(`${proxy.baseUrl}/models`),
      fetch(`${proxy.baseUrl}/models`, { headers: { upgrade: "websocket", connection: "upgrade" } }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.arrayBuffer();
    }

    expect(received).toBe(0);
  });

  test("one turn's second model call and its retries never reach upstream after revocation", async () => {
    const received: string[] = [];
    const notifications: ModelCallInvalidation[] = [];
    let revision = 1;
    const upstream = startUpstream(async (request) => {
      received.push(await request.text());
      return new Response("tool-completed");
    });
    const proxy = startProxy(upstream, {
      fence: createModelCallFence({
        binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
        assertCurrent() {
          if (revision !== 1) throw new Error("fixture-private-revision-error");
        },
        notifyInvalidated: (event) => {
          notifications.push(event);
        },
      }),
    });

    expect(await (await post(proxy.url, "before-tool")).text()).toBe("tool-completed");
    revision = 2;
    const second = await post(proxy.url, "after-tool");
    revision = 1;
    const retry = await post(proxy.url, "retry-after-tool");

    expect(second.status).toBe(409);
    expect(await second.text()).not.toContain("fixture-private");
    expect(retry.status).toBe(409);
    expect(received).toEqual(["before-tool"]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("skill_policy_stale");
  });

  test("forwards exact body and native headers but fixed host auth cannot be overridden", async () => {
    const received: Array<{
      body: string;
      auth: string | null;
      nativeKey: string | null;
      binding: string | null;
      hop: string | null;
    }> = [];
    const upstream = startUpstream(async (request) => {
      received.push({
        body: await request.text(),
        auth: request.headers.get("authorization"),
        nativeKey: request.headers.get("x-api-key"),
        binding: request.headers.get("x-ravi-binding"),
        hop: request.headers.get("x-hop-secret"),
      });
      return new Response("model-output", { headers: { "x-request-id": "request-1" } });
    });
    const proxy = startProxy(upstream, {
      upstream: { url: upstream, headers: { authorization: "Bearer host-fixture", "x-ravi-binding": "host-binding" } },
    });

    const response = await fetch(proxy.url, {
      method: "POST",
      body: '{"input":"unchanged\\nbytes"}',
      headers: {
        authorization: "Bearer client-fixture",
        "x-api-key": "native-fixture",
        "x-ravi-binding": "client-binding",
        connection: "x-hop-secret",
        "x-hop-secret": "must-not-forward",
      },
    });

    expect(received).toEqual([
      {
        body: '{"input":"unchanged\\nbytes"}',
        auth: "Bearer host-fixture",
        nativeKey: "native-fixture",
        binding: "host-binding",
        hop: null,
      },
    ]);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(await response.text()).toBe("model-output");
  });

  test("rejects alternate methods, paths, query destinations and host authorities before checking policy", async () => {
    let received = 0;
    let checks = 0;
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, {
      fence: createModelCallFence({
        binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
        assertCurrent() {
          checks += 1;
        },
        notifyInvalidated() {},
      }),
    });

    const attempts = [
      fetch(proxy.url),
      fetch(proxy.url, { method: "OPTIONS" }),
      post(`${proxy.url}/other`),
      post(`${proxy.url}?url=http://127.0.0.1/private`),
      fetch(proxy.url, { method: "POST", headers: { host: "untrusted.example" } }),
      fetch(proxy.url, { method: "POST", headers: { origin: "https://untrusted.example" } }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.arrayBuffer();
    }

    expect(received).toBe(0);
    expect(checks).toBe(0);
  });

  test("does not follow upstream redirects or expose a Location that lets the client bypass the fence", async () => {
    let escaped = 0;
    const escape = startUpstream(() => {
      escaped += 1;
      return new Response("escaped");
    });
    const upstream = startUpstream(() => new Response(null, { status: 307, headers: { location: escape } }));
    const proxy = startProxy(upstream);

    const response = await post(proxy.url);

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain(escape);
    expect(escaped).toBe(0);
  });

  test("rejects oversized bodies before any policy check or upstream send", async () => {
    let received = 0;
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, { maxRequestBytes: 4 });

    const response = await post(proxy.url, "12345");

    expect(response.status).toBe(413);
    expect(received).toBe(0);
  });

  test("a revoked binding does not contaminate a concurrent binding", async () => {
    const received: string[] = [];
    const upstream = startUpstream(async (request) => {
      received.push(await request.text());
      return new Response("ok");
    });
    const fence = openFence();
    const restricted = startProxy(upstream, { fence });
    const independent = startProxy(upstream);
    await fence.invalidate("policy-changed");

    const [denied, accepted] = await Promise.all([
      post(restricted.url, "restricted"),
      post(independent.url, "independent"),
    ]);

    expect(denied.status).toBe(409);
    expect(await accepted.text()).toBe("ok");
    expect(received).toEqual(["independent"]);
  });

  test("streams the first SSE event immediately and cancels the upstream when the client aborts", async () => {
    const upstreamCancelled = Promise.withResolvers<void>();
    const upstream = startUpstream((request) => {
      request.signal.addEventListener("abort", () => upstreamCancelled.resolve(), { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
          cancel() {
            upstreamCancelled.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const proxy = startProxy(upstream);
    const abort = new AbortController();
    const response = await fetch(proxy.url, { method: "POST", body: "stream", signal: abort.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");

    const first = await reader.read();
    abort.abort();
    await upstreamCancelled.promise;

    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    expect(first.done).toBe(false);
  });

  test("closing during a pending guard prevents a later successful check from sending upstream", async () => {
    let received = 0;
    const checking = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, {
      fence: createModelCallFence({
        binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
        async assertCurrent() {
          checking.resolve();
          await resume.promise;
        },
        assertCurrentAtDispatch() {},
        notifyInvalidated() {},
      }),
    });
    const response = post(proxy.url).catch(() => null);
    await checking.promise;

    await proxy.close();
    resume.resolve();
    await response;
    await sleep(0);

    expect(received).toBe(0);
  });

  test("closing during SSE aborts upstream without waiting for an infinite response", async () => {
    const cancelled = Promise.withResolvers<void>();
    const upstream = startUpstream((request) => {
      request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
          },
          cancel() {
            cancelled.resolve();
          },
        }),
      );
    });
    const proxy = startProxy(upstream);
    const response = await post(proxy.url);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected a streaming body");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

    await proxy.close();
    await cancelled.promise;
  });

  test("preserves compressed upstream response bytes without decompressing them twice", async () => {
    const compressed = gzipSync("compressed-model-response");
    const upstream = startUpstream(() => new Response(compressed, { headers: { "content-encoding": "gzip" } }));
    const proxy = startProxy(upstream);

    const response = await post(proxy.url);

    expect(await response.text()).toBe("compressed-model-response");
  });

  test("a timed-out pending check cannot send upstream when it eventually resolves", async () => {
    const checking = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let received = 0;
    const upstream = startUpstream(() => {
      received += 1;
      return new Response("unexpected");
    });
    const proxy = startProxy(upstream, {
      requestTimeoutMs: 20,
      fence: createModelCallFence({
        binding: { snapshotId: "snapshot-1", scope: { agentId: "test", executionId: "run-1", contextKey: "ctx-1" } },
        async assertCurrent() {
          checking.resolve();
          await resume.promise;
        },
        assertCurrentAtDispatch() {},
        notifyInvalidated() {},
      }),
    });
    const pending = post(proxy.url);
    await checking.promise;

    const response = await pending;
    resume.resolve();
    await sleep(0);

    expect(response.status).toBe(504);
    expect(received).toBe(0);
  });

  test("redacts malformed private routing headers from startup errors", () => {
    try {
      const proxy = startProxy("http://127.0.0.1:1/responses", {
        upstream: {
          url: "http://127.0.0.1:1/responses",
          headers: { "x-private-route": "fixture-private-header\nbad" },
        },
      });
      cleanup.push(() => proxy.close());
      throw new Error("Unexpected proxy startup");
    } catch (error) {
      expect(String(error)).not.toContain("fixture-private-header");
      expect(String(error)).not.toContain("Unexpected proxy startup");
    }
  });

  test.each([
    "file:///private",
    "ftp://127.0.0.1/responses",
    "http://untrusted.example/responses",
    "https://user:fixture-private-value@example.test/responses",
  ])("rejects unsafe fixed upstream configuration: %j", (url) => {
    try {
      startProxy(url);
      throw new Error("Unexpected proxy startup");
    } catch (error) {
      expect(String(error)).not.toContain("Unexpected proxy startup");
      expect(String(error)).not.toContain("fixture-private-value");
    }
  });
});
