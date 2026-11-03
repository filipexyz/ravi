import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { replaceConsentDepsForTests, type ConsentRequestOwner } from "@/server/connectors/consent";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as revoke } from "./[id]/revoke/route";
import { POST as decide } from "./decide/route";
import { POST as list } from "./list/route";
import { POST as resolve } from "./resolve/route";

const ORIGIN = "https://console.example.test";
const TOKEN = "consent-token-abcdefghijklmnop";
const GRANT = "88888888-8888-4888-8888-888888888888";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const REQUEST_ORG = "44444444-4444-4444-8444-444444444444";
const ME = "33333333-3333-4333-8333-333333333333";
const SOMEONE = "66666666-6666-4666-8666-666666666666";

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-request-id": "req-test", ...headers },
    method: "POST",
  });
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const params = { params: Promise.resolve({ id: GRANT }) };
type Route = [path: string, run: (request: NextRequest) => Promise<Response>, body: unknown];
const routes: Route[] = [
  ["/api/internal/connectors/consent/resolve", (request) => resolve(request), { token: TOKEN }],
  ["/api/internal/connectors/consent/decide", (request) => decide(request), { decision: "approve", token: TOKEN }],
  ["/api/internal/connectors/consent/list", (request) => list(request), {}],
  [`/api/internal/connectors/consent/${GRANT}/revoke`, (request) => revoke(request, params), {}],
];

describe("consent routes without a session", () => {
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
      expect(await anonymous.json()).toEqual({ code: "unauthorized", status: "error" });
    }
  });
});

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;

function workspaceFor(organizationId: string) {
  return {
    membership: { role: "developer", status: "active" },
    mode: "workos",
    organization: { id: organizationId, name: organizationId === REQUEST_ORG ? "Acme" : "Selected" },
    user: { id: ME },
  } as unknown as ConsoleWorkspace;
}

const PENDING_VIEW = {
  agentDisplayName: "Support bot",
  agentId: "support",
  connections: [
    { email: "me@example.test", id: CONNECTION, isDefault: true },
    { email: "other@example.test", id: GRANT, isDefault: false },
  ],
  expiresAt: "2099-01-01T00:00:00.000Z",
  installationName: "ana-mbp",
  operatorEmail: "ana@example.test",
  operatorName: "Ana",
  provider: "google",
  state: "pending",
};

describe("consent routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  /** Replies for one Worker path; any other path gets `reply`. */
  let replies: Record<string, { status: number; body: unknown }> = {};
  let session: ConsoleAuthState = auth;
  let request: ConsentRequestOwner | null = null;
  let memberOfRequestOrg = true;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
    replies = {};
    session = auth;
    request = { consoleUserId: ME, organizationId: REQUEST_ORG };
    memberOfRequestOrg = true;
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
    env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace("https://link.example.test", "");
      calls.push({ body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}, path });
      const answer = replies[path] ?? reply;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch;
    restores.push(
      replaceConnectorGateDepsForTests({
        authState: async () => session,
        featureError: async () => null,
        selectedWorkspace: async () => workspaceFor(ORG),
      }),
      replaceConsentDepsForTests({
        currentUserId: async () => ME,
        featureDenial: async () => null,
        findRequest: async () => request,
        selectedWorkspace: async () => workspaceFor(ORG),
        workspaceIn: async (_auth, organizationId) =>
          organizationId === REQUEST_ORG && !memberOfRequestOrg ? null : workspaceFor(organizationId),
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    while (restores.length) restores.pop()?.();
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
    delete env.RAVI_CONNECTORS_LINK_URL;
  });

  test("resolve asks for the request's own organization and says it isn't the one selected", async () => {
    replies = { "/ui/consent/resolve": { status: 200, body: PENDING_VIEW } };
    const response = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      agentId: "support",
      connections: [
        { id: CONNECTION, isDefault: true },
        { id: GRANT },
      ],
      organization: { id: REQUEST_ORG, name: "Acme", selected: false },
      state: "pending",
      status: "ok",
    });
    expect(calls).toEqual([{ body: { organizationId: REQUEST_ORG, token: TOKEN, userId: ME }, path: "/ui/consent/resolve" }]);
  });

  test("a request made for someone else says so; the Worker records it but its answer isn't shown", async () => {
    request = { consoleUserId: SOMEONE, organizationId: REQUEST_ORG };
    reply = { status: 200, body: PENDING_VIEW };
    const response = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(await response.json()).toEqual({ state: "user_mismatch", status: "ok" });
    expect(calls).toEqual([{ body: { organizationId: REQUEST_ORG, token: TOKEN, userId: ME }, path: "/ui/consent/resolve" }]);

    // Outside the request's organization nothing is forwarded at all.
    calls = [];
    memberOfRequestOrg = false;
    const outsider = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(await outsider.json()).toEqual({ state: "user_mismatch", status: "ok" });
    expect(calls).toHaveLength(0);

    // Deciding someone else's request never reaches the Worker.
    memberOfRequestOrg = true;
    const decided = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "approve", token: TOKEN }));
    expect(decided.status).toBe(403);
    expect(await decided.json()).toEqual({ code: "user_mismatch", status: "error" });
    expect(calls).toHaveLength(0);
  });

  test("the person isn't an active member of the request's organization", async () => {
    memberOfRequestOrg = false;
    const response = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "not_member", status: "error" });
    const decided = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "deny", token: TOKEN }));
    expect(decided.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("an unknown token is answered by the Worker in the selected organization; a malformed one asks nothing", async () => {
    request = null;
    reply = { status: 200, body: { state: "invalid" } };
    const unknown = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(await unknown.json()).toEqual({ state: "invalid", status: "ok" });
    expect(calls).toEqual([{ body: { organizationId: ORG, token: TOKEN, userId: ME }, path: "/ui/consent/resolve" }]);

    calls = [];
    const malformed = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: "short" }));
    expect(await malformed.json()).toEqual({ state: "invalid", status: "ok" });
    const badDecide = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "deny", token: "x/y" }));
    expect(badDecide.status).toBe(404);
    expect(await badDecide.json()).toEqual({ code: "consent_invalid", status: "error" });
    expect(calls).toHaveLength(0);
  });

  test("an impersonation session sees nothing and decides nothing", async () => {
    session = impersonated;
    const resolved = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(resolved.status).toBe(403);
    expect(await resolved.json()).toEqual({ code: "impersonation", status: "error" });
    for (const [path, run, body] of routes.slice(1).filter(([path]) => !path.endsWith("/list"))) {
      const response = await run(post(path, sameOrigin, body));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("approve without an account leaves it to the person's default", async () => {
    reply = { status: 200, body: { grantId: GRANT, status: "approved" } };
    const approved = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "approve", token: TOKEN }));
    expect(await approved.json()).toEqual({ consentStatus: "approved", grantId: GRANT, status: "ok" });
    expect(calls).toEqual([
      { body: { decision: "approve", organizationId: REQUEST_ORG, token: TOKEN, userId: ME }, path: "/ui/consent/decide" },
    ]);
  });

  test("approve sends the chosen account; deny never does", async () => {
    reply = { status: 200, body: { grantId: GRANT, status: "approved" } };
    const approved = await decide(
      post("/api/internal/connectors/consent/decide", sameOrigin, { connectionId: CONNECTION, decision: "approve", token: TOKEN }),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ consentStatus: "approved", grantId: GRANT, status: "ok" });

    reply = { status: 200, body: { status: "denied" } };
    const denied = await decide(
      post("/api/internal/connectors/consent/decide", sameOrigin, { connectionId: CONNECTION, decision: "deny", token: TOKEN }),
    );
    expect(await denied.json()).toEqual({ consentStatus: "denied", grantId: null, status: "ok" });
    expect(calls).toEqual([
      {
        body: { connectionId: CONNECTION, decision: "approve", organizationId: REQUEST_ORG, token: TOKEN, userId: ME },
        path: "/ui/consent/decide",
      },
      { body: { decision: "deny", organizationId: REQUEST_ORG, token: TOKEN, userId: ME }, path: "/ui/consent/decide" },
    ]);
  });

  test("decide refuses a bad body and maps Worker failures", async () => {
    for (const body of [
      { decision: "maybe", token: TOKEN },
      { decision: "approve" },
      { connectionId: "not-a-uuid", decision: "approve", token: TOKEN },
    ]) {
      const response = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "payload_invalid", status: "error" });
    }
    expect(calls).toHaveLength(0);

    reply = { status: 409, body: { error: "connector_connection_required" } };
    const needsAccount = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "approve", token: TOKEN }));
    expect(needsAccount.status).toBe(409);
    expect(await needsAccount.json()).toEqual({ code: "connector_connection_required", status: "error" });

    reply = { status: 500, body: { error: "internal_error" } };
    expect((await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "deny", token: TOKEN }))).status).toBe(502);

    reply = { status: 401, body: { error: "connector_unauthorized" } };
    const unsigned = await decide(post("/api/internal/connectors/consent/decide", sameOrigin, { decision: "deny", token: TOKEN }));
    expect(unsigned.status).toBe(502);
    expect(await unsigned.json()).toEqual({ code: "connector_service_unavailable", status: "error" });

    // A Worker outage on resolve is a bad gateway too, never an "invalid link".
    reply = { status: 503, body: { error: "internal_error" } };
    const down = await resolve(post("/api/internal/connectors/consent/resolve", sameOrigin, { token: TOKEN }));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ code: "connector_service_unavailable", status: "error" });
  });

  test("list and revoke use the selected organization; the list may be read while impersonating", async () => {
    session = impersonated;
    reply = {
      status: 200,
      body: { grants: [{ agentId: "support", id: GRANT, installationId: "i", mode: "person_asking", operator: { email: "ana@example.test", userId: SOMEONE } }] },
    };
    const listed = await list(post("/api/internal/connectors/consent/list", sameOrigin));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ grants: [{ id: GRANT, operator: { email: "ana@example.test", userId: SOMEONE } }], status: "ok" });

    session = auth;
    reply = { status: 200, body: { ok: true } };
    const revoked = await revoke(post(`/api/internal/connectors/consent/${GRANT}/revoke`, sameOrigin), params);
    expect(await revoked.json()).toEqual({ revoked: true, status: "ok" });
    expect(calls).toEqual([
      { body: { organizationId: ORG, userId: ME }, path: "/ui/consent/list" },
      { body: { organizationId: ORG, userId: ME }, path: `/ui/consent/revoke/${GRANT}` },
    ]);

    calls = [];
    const bad = await revoke(post("/api/internal/connectors/consent/x/revoke", sameOrigin), { params: Promise.resolve({ id: "../x" }) });
    expect(bad.status).toBe(400);
    reply = { status: 404, body: { error: "connector_unavailable" } };
    const gone = await revoke(post(`/api/internal/connectors/consent/${GRANT}/revoke`, sameOrigin), params);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ code: "connector_unavailable", status: "error" });
  });
});
