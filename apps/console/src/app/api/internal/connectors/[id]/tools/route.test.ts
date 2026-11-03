import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as detail } from "../detail/route";
import { POST as tools } from "./route";

const ORIGIN = "https://console.example.test";
const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-request-id": "req-test", ...headers },
    method: "POST",
  });
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const params = { params: Promise.resolve({ id: ID }) };
const runDetail = (request: NextRequest) => detail(request, params);
const runTools = (request: NextRequest) => tools(request, params);

describe("connection detail and tool routes without a session", () => {
  const saved = { anonymous: process.env.RAVI_CONSOLE_ANONYMOUS_MODE, workos: process.env.WORKOS_API_KEY };

  beforeEach(() => {
    delete process.env.RAVI_CONSOLE_ANONYMOUS_MODE;
    delete process.env.WORKOS_API_KEY;
  });

  afterEach(() => {
    if (saved.anonymous === undefined) delete process.env.RAVI_CONSOLE_ANONYMOUS_MODE;
    else process.env.RAVI_CONSOLE_ANONYMOUS_MODE = saved.anonymous;
    if (saved.workos === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = saved.workos;
  });

  test("a cross-site post is refused before the session is read; without a session it is unauthorized", async () => {
    for (const [path, run] of [
      [`/api/internal/connectors/${ID}/detail`, runDetail],
      [`/api/internal/connectors/${ID}/tools`, runTools],
    ] as const) {
      const crossSite = await run(post(path, { "sec-fetch-site": "cross-site" }));
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ code: "forbidden", status: "error" });
      const anonymous = await run(post(path, sameOrigin, { capability: "gmail.message.send", policy: "blocked" }));
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ code: "unauthorized", status: "error" });
    }
  });
});

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;
const workspace = {
  membership: { role: "developer", status: "active" },
  mode: "workos",
  organization: { id: ORG },
  user: { id: ME },
} as unknown as ConsoleWorkspace;

describe("connection detail and tool routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let session: ConsoleAuthState = auth;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
    session = auth;
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
    env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        path: String(input).replace("https://link.example.test", ""),
      });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    restore = replaceConnectorGateDepsForTests({
      authState: async () => session,
      featureError: async () => null,
      selectedWorkspace: async () => workspace,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restore?.();
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
    delete env.RAVI_CONNECTORS_LINK_URL;
  });

  test("detail forwards the person and answers the connection; an impersonation session may look", async () => {
    reply = { status: 200, body: { id: ID, provider: "google", tools: [{ capability: "gmail.message.send", class: "write" }] } };
    session = impersonated;
    const response = await runDetail(post(`/api/internal/connectors/${ID}/detail`, sameOrigin));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { status: string; connection: { id: string; tools: unknown[] } };
    expect(body.status).toBe("ok");
    expect(body.connection.id).toBe(ID);
    expect(body.connection.tools).toHaveLength(1);
    expect(calls).toEqual([{ body: { organizationId: ORG, userId: ME }, path: `/ui/connect/detail/${ID}` }]);
  });

  test("detail maps Worker failures: a 404 stays, a 5xx is a bad gateway", async () => {
    reply = { status: 404, body: { error: "not_found" } };
    let response = await runDetail(post(`/api/internal/connectors/${ID}/detail`, sameOrigin));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found", status: "error" });
    reply = { status: 503, body: { error: "internal_error" } };
    response = await runDetail(post(`/api/internal/connectors/${ID}/detail`, sameOrigin));
    expect(response.status).toBe(502);
  });

  test("tools posts the rule; a rule above the ceiling keeps its 409", async () => {
    reply = { status: 200, body: { ok: true } };
    const ok = await runTools(
      post(`/api/internal/connectors/${ID}/tools`, sameOrigin, { capability: "gmail.message.send", policy: "blocked" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, status: "ok" });
    expect(calls[0]).toEqual({
      body: { capability: "gmail.message.send", organizationId: ORG, policy: "blocked", userId: ME },
      path: `/ui/connect/tools/${ID}`,
    });

    reply = { status: 409, body: { error: "connector_policy_above_ceiling", requestId: "w" } };
    const above = await runTools(
      post(`/api/internal/connectors/${ID}/tools`, sameOrigin, { capability: "gmail.message.send", policy: "always_allow" }),
    );
    expect(above.status).toBe(409);
    expect(await above.json()).toEqual({ code: "connector_policy_above_ceiling", status: "error" });
  });

  test("tools refuses a bad body and an impersonation session before the Worker", async () => {
    for (const body of [{}, { capability: "gmail.message.send", policy: "sometimes" }, { capability: "Not A Capability", policy: "blocked" }]) {
      const response = await runTools(post(`/api/internal/connectors/${ID}/tools`, sameOrigin, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "payload_invalid", status: "error" });
    }
    session = impersonated;
    const response = await runTools(
      post(`/api/internal/connectors/${ID}/tools`, sameOrigin, { capability: "gmail.message.send", policy: "blocked" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
    expect(calls).toHaveLength(0);
  });
});
