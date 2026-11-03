import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ManagedProviderBroker,
  type ManagedProviderBrokerConfig,
} from "./managed-provider-broker";

const roots: string[] = [];
const GUEST_IP = "172.30.0.2";
const PROVIDER_KEY = "sk-test-provider-key-that-must-never-reach-the-guest";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Managed Ravi host provider broker", () => {
  test("forwards only Responses API calls and replaces caller authorization", async () => {
    const fixture = await brokerFixture();
    const response = await fixture.broker.handle(
      new Request("http://broker.test/v1/responses", {
        body: JSON.stringify({ input: "secret prompt", model: "gpt-5" }),
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer guest-controlled-token",
          cookie: "guest-cookie=must-not-leave-host",
          "content-type": "application/json",
          session_id: "codex-session-1",
          "x-codex-turn-state": "sticky-state-1",
        },
        method: "POST",
      }),
      GUEST_IP,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      authorization: `Bearer ${PROVIDER_KEY}`,
      method: "POST",
      sessionId: "codex-session-1",
      turnState: "sticky-state-1",
      url: "https://api.openai.com/v1/responses",
    });
    expect(fixture.calls[0]?.authorization).not.toContain("guest-controlled-token");
    expect(fixture.calls[0]?.cookie).toBeNull();
    expect(response.headers.get("x-codex-turn-state")).toBe("upstream-sticky-state");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(fixture.logs)).not.toContain("secret prompt");
    expect(JSON.stringify(fixture.logs)).not.toContain("guest-controlled-token");
    expect(JSON.stringify(fixture.logs)).not.toContain(PROVIDER_KEY);
  });

  test("fails closed for unknown or revoked VM sources", async () => {
    const fixture = await brokerFixture();
    const unknown = await fixture.broker.handle(request(), "172.30.0.6");
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({
      code: "provider_broker_source_denied",
      ok: false,
    });
    expect(fixture.calls).toHaveLength(0);

    await fixture.writeRegistry("revoked");
    const revoked = await fixture.broker.handle(request(), GUEST_IP);
    expect(revoked.status).toBe(403);
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects every route, method, query, and oversized body outside the contract", async () => {
    const fixture = await brokerFixture({ maxBodyBytes: 64 });
    const cases = [
      new Request("http://broker.test/v1/chat/completions", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      new Request("http://broker.test/v1/responses?debug=1", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      new Request("http://broker.test/v1/responses", { method: "GET" }),
    ];
    for (const candidate of cases) {
      const response = await fixture.broker.handle(candidate, GUEST_IP);
      expect(response.status).toBe(403);
    }

    const oversized = await fixture.broker.handle(
      new Request("http://broker.test/v1/responses", {
        body: JSON.stringify({ input: "x".repeat(100) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      GUEST_IP,
    );
    expect(oversized.status).toBe(413);
    expect(fixture.calls).toHaveLength(0);
  });

  test("health is source-bound and caches a successful upstream credential probe", async () => {
    const fixture = await brokerFixture();
    const first = await fixture.broker.handle(
      new Request("http://broker.test/health"),
      GUEST_IP,
    );
    const second = await fixture.broker.handle(
      new Request("http://broker.test/health"),
      GUEST_IP,
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, ready: true });
    expect(second.status).toBe(200);
    expect(fixture.calls).toEqual([
      expect.objectContaining({
        authorization: `Bearer ${PROVIDER_KEY}`,
        method: "GET",
        url: "https://api.openai.com/v1/models",
      }),
    ]);
  });

  test("allows host-only loopback health without opening provider calls", async () => {
    const fixture = await brokerFixture();
    const health = await fixture.broker.handle(
      new Request("http://broker.test/health"),
      "127.0.0.1",
    );
    const providerCall = await fixture.broker.handle(request(), "127.0.0.1");

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, ready: true });
    expect(providerCall.status).toBe(403);
    expect(fixture.calls).toHaveLength(1);
  });
});

function request() {
  return new Request("http://broker.test/v1/responses", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function brokerFixture(overrides: Partial<ManagedProviderBrokerConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-provider-broker-"));
  roots.push(root);
  const registryPath = path.join(root, "instances.json");
  await mkdir(root, { recursive: true });
  const writeRegistry = async (status: "active" | "revoked") => {
    await writeFile(
      registryPath,
      JSON.stringify({
        entries: [
          {
            guestIp: GUEST_IP,
            instanceId: "10000000-0000-4000-8000-000000000001",
            status,
            updatedAt: "2026-07-15T18:00:00Z",
            vmId: "mvm_test0000000000000000000000000001",
          },
        ],
        schemaVersion: "ravi.managed-provider-broker.registry/v1",
        updatedAt: "2026-07-15T18:00:00Z",
      }),
    );
  };
  await writeRegistry("active");
  const calls: Array<{
    authorization: string;
    cookie: string | null;
    method: string;
    sessionId: string | null;
    turnState: string | null;
    url: string;
  }> = [];
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization") ?? "",
      cookie: headers.get("cookie"),
      method: init?.method ?? "GET",
      sessionId: headers.get("session_id"),
      turnState: headers.get("x-codex-turn-state"),
      url,
    });
    if (url.endsWith("/v1/models")) return Response.json({ data: [] });
    return new Response("data: ok\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "upstream-cookie=must-not-leave-host",
        "x-codex-turn-state": "upstream-sticky-state",
      },
    });
  }) as typeof fetch;
  const config: ManagedProviderBrokerConfig = {
    credentialPath: path.join(root, "openai-api-key"),
    hostname: "127.0.0.1",
    maxBodyBytes: 4 * 1024 * 1024,
    maxConcurrentGlobal: 32,
    maxConcurrentPerSource: 4,
    port: 7443,
    probeTtlMs: 60_000,
    registryPath,
    upstreamResponsesUrl: "https://api.openai.com/v1/responses",
    ...overrides,
  };
  const broker = await ManagedProviderBroker.create(config, {
    fetchImpl,
    logger: (event, payload) => logs.push({ event, payload }),
    now: () => new Date("2026-07-15T18:00:00Z"),
    providerApiKey: PROVIDER_KEY,
  });
  return { broker, calls, logs, writeRegistry };
}
