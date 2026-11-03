import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as revoke } from "./connections/[id]/revoke/route";
import { POST as listConnections } from "./connections/route";
import { POST as getPolicy } from "./policy/route";
import { POST as setPolicy } from "./policy/set/route";

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

type Route = [path: string, run: (request: NextRequest) => Promise<Response>, body: unknown];
const reads: Route[] = [
  ["/api/internal/connectors/admin/policy", (request) => getPolicy(request), { provider: "google" }],
  ["/api/internal/connectors/admin/connections", (request) => listConnections(request), {}],
];
const writes: Route[] = [
  ["/api/internal/connectors/admin/policy/set", (request) => setPolicy(request), { enabled: false, provider: "google" }],
  [
    "/api/internal/connectors/admin/policy/set",
    (request) => setPolicy(request),
    { provider: "google", toolCeiling: { capability: "gmail.message.send", ceiling: "blocked" } },
  ],
  [`/api/internal/connectors/admin/connections/${ID}/revoke`, (request) => revoke(request, params), {}],
];
const routes = [...reads, ...writes];

describe("admin connector routes without a session", () => {
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

  test("every post refuses a cross-site request, then a missing session", async () => {
    for (const [path, run, body] of routes) {
      const crossSite = await run(post(path, { "sec-fetch-site": "cross-site" }, body));
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toEqual({ code: "forbidden", status: "error" });
      const anonymous = await run(post(path, sameOrigin, body));
      expect(anonymous.status).toBe(401);
    }
  });
});

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;

function workspaceAs(role: string, status = "active") {
  return {
    membership: { role, status },
    mode: "workos",
    organization: { id: ORG },
    user: { id: ME },
  } as unknown as ConsoleWorkspace;
}

describe("admin connector routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  /** Answers for the next calls, in order; `reply` after that. */
  let queue: Array<{ status: number; body: unknown }> = [];
  let session: ConsoleAuthState = auth;
  let workspace = workspaceAs("admin");
  let restore: (() => void) | null = null;

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
    queue = [];
    session = auth;
    workspace = workspaceAs("admin");
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
    env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        path: String(input).replace("https://link.example.test", ""),
      });
      const answer = queue.shift() ?? reply;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
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

  test("a member who isn't an owner or admin can't reach any admin route, and the Worker hears nothing", async () => {
    for (const role of ["developer", "viewer", "billing"]) {
      workspace = workspaceAs(role);
      for (const [path, run, body] of routes) {
        const response = await run(post(path, sameOrigin, body));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "connector_forbidden", status: "error" });
      }
    }
    workspace = workspaceAs("admin", "suspended");
    for (const [path, run, body] of writes) {
      expect((await run(post(path, sameOrigin, body))).status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test("an impersonation session can't write, even as an owner", async () => {
    workspace = workspaceAs("owner");
    session = impersonated;
    for (const [path, run, body] of writes) {
      const response = await run(post(path, sameOrigin, body));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("owners and admins reach the Worker with their role", async () => {
    for (const role of ["owner", "admin"]) {
      calls = [];
      workspace = workspaceAs(role);
      reply = { status: 200, body: { enabled: true, provider: "google", tools: [], toolCeilings: {}, writesAllowed: true } };
      const policy = await getPolicy(post("/api/internal/connectors/admin/policy", sameOrigin, { provider: "google" }));
      expect(policy.status).toBe(200);
      expect(await policy.json()).toMatchObject({ policy: { enabled: true, provider: "google" }, status: "ok" });

      reply = { status: 200, body: { enabled: false, provider: "google" } };
      const set = await setPolicy(
        post("/api/internal/connectors/admin/policy/set", sameOrigin, {
          enabled: false,
          provider: "google",
          sharedAllowed: true,
          writesAllowed: true,
        }),
      );
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ policy: { enabled: false }, status: "ok" });

      reply = { status: 200, body: { connections: [{ id: ID, member: { email: "m@example.test" }, provider: "google" }] } };
      const listed = await listConnections(post("/api/internal/connectors/admin/connections", sameOrigin, {}));
      expect(await listed.json()).toMatchObject({ connections: [{ id: ID }], status: "ok" });

      reply = { status: 200, body: { revoked: true } };
      const revoked = await revoke(post(`/api/internal/connectors/admin/connections/${ID}/revoke`, sameOrigin), params);
      expect(await revoked.json()).toEqual({ revoked: true, status: "ok" });

      const actor = { organizationId: ORG, role, userId: ME };
      expect(calls).toEqual([
        { body: { ...actor, provider: "google" }, path: "/ui/admin/policy/get" },
        {
          body: { ...actor, enabled: false, provider: "google", sharedAllowed: true, writesAllowed: true },
          path: "/ui/admin/policy/set",
        },
        { body: actor, path: "/ui/admin/connections/list" },
        { body: actor, path: `/ui/admin/connections/revoke/${ID}` },
      ]);
    }
  });

  test("a ceiling change applies to the policy as the Worker has it now, so an older page can't undo another admin's", async () => {
    const tools = [
      { capability: "gmail.message.send", class: "write", label: "Send email" },
      { capability: "gcal.event.list", class: "read", label: "Read your calendar" },
    ];
    // Another admin blocked sending after this page loaded; a capability left the catalog.
    queue = [
      {
        status: 200,
        body: {
          enabled: true,
          provider: "google",
          toolCeilings: { "gmail.message.retired": "needs_approval", "gmail.message.send": "blocked" },
          tools,
          writesAllowed: true,
        },
      },
      {
        status: 200,
        body: {
          enabled: true,
          provider: "google",
          toolCeilings: { "gcal.event.list": "needs_approval", "gmail.message.send": "blocked" },
          tools,
          writesAllowed: true,
        },
      },
    ];
    const response = await setPolicy(
      post("/api/internal/connectors/admin/policy/set", sameOrigin, {
        provider: "google",
        toolCeiling: { capability: "gcal.event.list", ceiling: "needs_approval" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      policy: { toolCeilings: { "gcal.event.list": "needs_approval", "gmail.message.send": "blocked" } },
      status: "ok",
    });
    const actor = { organizationId: ORG, role: "admin", userId: ME };
    expect(calls).toEqual([
      { body: { ...actor, provider: "google" }, path: "/ui/admin/policy/get" },
      {
        body: { ...actor, provider: "google", toolCeilings: { "gcal.event.list": "needs_approval", "gmail.message.send": "blocked" } },
        path: "/ui/admin/policy/set",
      },
    ]);

    // No limit removes only that tool.
    calls = [];
    queue = [{ status: 200, body: { provider: "google", toolCeilings: { "gcal.event.list": "needs_approval", "gmail.message.send": "blocked" }, tools } }];
    reply = { status: 200, body: { provider: "google" } };
    await setPolicy(
      post("/api/internal/connectors/admin/policy/set", sameOrigin, {
        provider: "google",
        toolCeiling: { capability: "gcal.event.list", ceiling: null },
      }),
    );
    expect(calls[1]).toEqual({
      body: { ...actor, provider: "google", toolCeilings: { "gmail.message.send": "blocked" } },
      path: "/ui/admin/policy/set",
    });
  });

  test("Allow shared accounts goes to the Worker on its own", async () => {
    reply = { status: 200, body: { enabled: true, provider: "google", sharedAllowed: true } };
    const response = await setPolicy(
      post("/api/internal/connectors/admin/policy/set", sameOrigin, { provider: "google", sharedAllowed: true }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ policy: { sharedAllowed: true }, status: "ok" });
    expect(calls).toEqual([
      {
        body: { organizationId: ORG, provider: "google", role: "admin", sharedAllowed: true, userId: ME },
        path: "/ui/admin/policy/set",
      },
    ]);
  });

  test("a ceiling for a tool the policy doesn't list is refused before anything is written", async () => {
    reply = { status: 200, body: { provider: "google", toolCeilings: {}, tools: [{ capability: "gmail.message.send", class: "write" }] } };
    const response = await setPolicy(
      post("/api/internal/connectors/admin/policy/set", sameOrigin, {
        provider: "google",
        toolCeiling: { capability: "slack.post", ceiling: "blocked" },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "payload_invalid", status: "error" });
    expect(calls.map((call) => call.path)).toEqual(["/ui/admin/policy/get"]);
  });

  test("a Worker refusal while reading the policy for a ceiling change writes nothing", async () => {
    reply = { status: 403, body: { error: "connector_forbidden" } };
    const response = await setPolicy(
      post("/api/internal/connectors/admin/policy/set", sameOrigin, {
        provider: "google",
        toolCeiling: { capability: "gmail.message.send", ceiling: "blocked" },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "connector_forbidden", status: "error" });
    expect(calls.map((call) => call.path)).toEqual(["/ui/admin/policy/get"]);
  });

  test("policy set refuses an empty change, a whole ceilings map, a bad ceiling and a bad capability", async () => {
    for (const body of [
      { provider: "google" },
      // A page's copy of the whole map could erase another admin's ceiling.
      { provider: "google", toolCeilings: { "gmail.message.send": "blocked" } },
      { provider: "google", toolCeiling: { capability: "gmail.message.send", ceiling: "always_allow" } },
      { provider: "google", toolCeiling: { capability: "gmail.message.send", ceiling: "sometimes" } },
      { provider: "google", toolCeiling: { capability: "gmail.message.send" } },
      { provider: "google", toolCeiling: { capability: "../x", ceiling: "blocked" } },
      { enabled: "no", provider: "google" },
      { provider: "google", sharedAllowed: "yes" },
    ]) {
      const response = await setPolicy(post("/api/internal/connectors/admin/policy/set", sameOrigin, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "payload_invalid", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("Worker failures: its own refusal and provider errors keep their code, an outage is a bad gateway", async () => {
    reply = { status: 403, body: { error: "connector_forbidden" } };
    const refused = await getPolicy(post("/api/internal/connectors/admin/policy", sameOrigin, { provider: "google" }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "connector_forbidden", status: "error" });

    reply = { status: 502, body: { error: "connector_provider_error" } };
    const provider = await revoke(post(`/api/internal/connectors/admin/connections/${ID}/revoke`, sameOrigin), params);
    expect(provider.status).toBe(502);
    expect(await provider.json()).toEqual({ code: "connector_provider_error", status: "error" });

    reply = { status: 500, body: { error: "internal_error" } };
    const down = await listConnections(post("/api/internal/connectors/admin/connections", sameOrigin, {}));
    expect(down.status).toBe(502);
  });
});
