import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { connectBrowserCookieName, replaceConnectGrantDepsForTests } from "@/server/connectors/connect-grants";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as finish } from "../finish/route";
import { POST as continueConnect } from "../continue/route";
import { POST as resolve } from "../resolve/route";
import { POST as start } from "./route";
import { POST as rename } from "../../[id]/rename/route";
import { POST as makeDefault } from "../../[id]/default/route";
import { POST as revokeInstallation } from "../../installations/[id]/revoke/route";
import { POST as listInstallations } from "../../installations/route";
import * as listRoute from "../../list/route";
import { POST as revoke } from "../../revoke/[id]/route";

const ORIGIN = "https://console.example.test";
const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const PENDING = "55555555-5555-4555-8555-555555555555";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-request-id": "req-test", ...headers },
    method: "POST",
  });
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const params = { params: Promise.resolve({ id: ID }) };

const routes: Array<[string, (request: NextRequest) => Promise<Response>]> = [
  ["/api/internal/connectors/connect/start", (request) => start(request)],
  ["/api/internal/connectors/connect/resolve", (request) => resolve(request)],
  ["/api/internal/connectors/connect/continue", (request) => continueConnect(request)],
  ["/api/internal/connectors/connect/finish", (request) => finish(request)],
  ["/api/internal/connectors/list", (request) => listRoute.POST(request)],
  [`/api/internal/connectors/${ID}/rename`, (request) => rename(request, params)],
  [`/api/internal/connectors/${ID}/default`, (request) => makeDefault(request, params)],
  [`/api/internal/connectors/revoke/${ID}`, (request) => revoke(request, params)],
  ["/api/internal/connectors/installations", (request) => listInstallations(request)],
  [`/api/internal/connectors/installations/${ID}/revoke`, (request) => revokeInstallation(request, params)],
];

/** Routes that change something, with a body each would otherwise accept. */
const writes: Array<[string, (request: NextRequest) => Promise<Response>, unknown]> = [
  ["/api/internal/connectors/connect/start", (request) => start(request), { provider: "google" }],
  ["/api/internal/connectors/connect/continue", (request) => continueConnect(request), { token: TOKEN }],
  [
    "/api/internal/connectors/connect/finish",
    (request) => finish(request),
    { pendingId: PENDING, resultToken: "result-token" },
  ],
  [`/api/internal/connectors/${ID}/rename`, (request) => rename(request, params), { displayName: "Work" }],
  [`/api/internal/connectors/${ID}/default`, (request) => makeDefault(request, params), {}],
  [`/api/internal/connectors/revoke/${ID}`, (request) => revoke(request, params), {}],
  [`/api/internal/connectors/installations/${ID}/revoke`, (request) => revokeInstallation(request, params), {}],
];

describe("internal connector routes without a session", () => {
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

  test("every post refuses a cross-site request before reading the session", async () => {
    for (const [path, run] of routes) {
      const response = await run(post(path, { "sec-fetch-site": "cross-site" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "forbidden", status: "error" });
      expect(response.headers.get("x-request-id")).toBe("req-test");
    }
  });

  test("a same-origin post without a Console session is unauthorized", async () => {
    for (const [path, run] of routes) {
      const response = await run(post(path, sameOrigin, { provider: "google", token: "t" }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "unauthorized", status: "error" });
    }
  });

  test("the list has no GET: the screens post", () => {
    expect("GET" in listRoute).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// With a session: the gate and the connect-grant lookups are stubbed, the
// Worker is a fetch stub.
// ---------------------------------------------------------------------------

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

describe("internal connector routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let session: ConsoleAuthState = auth;
  const restores: Array<() => void> = [];

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
    restores.push(
      replaceConnectorGateDepsForTests({
        authState: async () => session,
        featureError: async () => null,
        selectedWorkspace: async () => workspace,
      }),
      replaceConnectGrantDepsForTests({
        currentUserId: async () => ME,
        featureDenial: async () => null,
        findOwner: async () => ({ id: PENDING, organizationId: ORG, userId: ME }),
        selectedWorkspace: async () => workspace,
        workspaceIn: async () => workspace,
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

  test("connect/start continues at once as the Console and drops project and scopes", async () => {
    reply = {
      status: 201,
      body: {
        authorizationUrl: "https://accounts.example/auth?state=s",
        expiresAt: "2026-10-10T10:10:00.000Z",
        pendingGrantId: PENDING,
      },
    };
    const response = await start(
      post("/api/internal/connectors/connect/start", sameOrigin, {
        accessMode: "read_only",
        projectId: "p",
        projectRef: "p",
        provider: "google",
        scopes: ["https://mail.google.com/"],
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      authorizationUrl: "https://accounts.example/auth?state=s",
      expiresAt: "2026-10-10T10:10:00.000Z",
      pendingGrantId: PENDING,
      status: "ok",
    });
    expect(response.headers.get("set-cookie")).toContain(`${connectBrowserCookieName(PENDING)}=1`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/ui/connect/start");
    expect(calls[0]?.body).toMatchObject({
      accessMode: "read_only",
      continueNow: true,
      organizationId: ORG,
      origin: "ui",
      provider: "google",
      userId: ME,
    });
    for (const dropped of ["projectId", "projectRef", "scopes"]) expect(calls[0]?.body).not.toHaveProperty(dropped);
  });

  test("connect/start for an organization account: owners and admins only, with their role", async () => {
    const organizationStart = () =>
      start(post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google", scopeKind: "organization" }));
    // The default workspace is a developer's.
    const refused = await organizationStart();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "connector_forbidden", status: "error" });
    expect(calls).toHaveLength(0);

    for (const role of ["owner", "admin"]) {
      calls = [];
      restores.push(
        replaceConnectorGateDepsForTests({
          selectedWorkspace: async () =>
            ({ ...workspace, membership: { role, status: "active" } }) as unknown as ConsoleWorkspace,
        }),
      );
      reply = {
        status: 201,
        body: { authorizationUrl: "https://accounts.example/auth?state=o", expiresAt: "2026-10-10T10:10:00.000Z", pendingGrantId: PENDING },
      };
      const response = await organizationStart();
      expect(response.status).toBe(201);
      expect(calls).toEqual([
        {
          body: {
            continueNow: true,
            organizationId: ORG,
            origin: "ui",
            provider: "google",
            role,
            scopeKind: "organization",
            userId: ME,
          },
          path: "/ui/connect/start",
        },
      ]);
    }

    // A suspended admin is refused too, and a personal start never carries a role.
    calls = [];
    restores.push(
      replaceConnectorGateDepsForTests({
        selectedWorkspace: async () =>
          ({ ...workspace, membership: { role: "admin", status: "suspended" } }) as unknown as ConsoleWorkspace,
      }),
    );
    expect((await organizationStart()).status).toBe(403);
    expect(calls).toHaveLength(0);
    reply = { status: 201, body: { authorizationUrl: "https://accounts.example/auth", expiresAt: "x", pendingGrantId: PENDING } };
    await start(post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google", scopeKind: "user" }));
    expect(calls[0]?.body).not.toHaveProperty("role");
    expect(calls[0]?.body).not.toHaveProperty("scopeKind");
  });

  test("a member's reconnect of an organization account goes to the Worker with their role; a new one doesn't", async () => {
    const reconnectBody = { provider: "google", reconnectConnectionId: ID, scopeKind: "organization" };
    reply = {
      status: 201,
      body: { authorizationUrl: "https://accounts.example/auth?state=r", expiresAt: "2026-10-10T10:10:00.000Z", pendingGrantId: PENDING },
    };
    // The default workspace is a developer's: the Worker decides whether they manage the account.
    const response = await start(post("/api/internal/connectors/connect/start", sameOrigin, reconnectBody));
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      {
        body: {
          continueNow: true,
          organizationId: ORG,
          origin: "ui",
          provider: "google",
          reconnectConnectionId: ID,
          role: "developer",
          scopeKind: "organization",
          userId: ME,
        },
        path: "/ui/connect/start",
      },
    ]);

    // When they don't manage it, the Worker's refusal comes back as it is.
    calls = [];
    reply = { status: 403, body: { error: "connector_forbidden" } };
    const refused = await start(post("/api/internal/connectors/connect/start", sameOrigin, reconnectBody));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "connector_forbidden", status: "error" });
    expect(calls).toHaveLength(1);

    // A new organization account still needs an owner or admin, and so does any start from a suspended member.
    calls = [];
    const fresh = await start(
      post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google", scopeKind: "organization" }),
    );
    expect(fresh.status).toBe(403);
    expect(await fresh.json()).toEqual({ code: "connector_forbidden", status: "error" });
    restores.push(
      replaceConnectorGateDepsForTests({
        selectedWorkspace: async () =>
          ({ ...workspace, membership: { role: "developer", status: "suspended" } }) as unknown as ConsoleWorkspace,
      }),
    );
    expect((await start(post("/api/internal/connectors/connect/start", sameOrigin, reconnectBody))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("connect/start without the provider's sign-in URL is a bad gateway, not a redirect to a Console page", async () => {
    reply = {
      status: 201,
      body: { connectUrl: "https://console.example.test/connect/x", expiresAt: "x", pendingGrantId: PENDING },
    };
    const response = await start(post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "connector_service_unavailable", status: "error" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("Worker failures: 4xx codes pass, 5xx and a refused signature are a bad gateway", async () => {
    const startGoogle = () => start(post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google" }));
    reply = { status: 403, body: { error: "connector_disabled_by_org" } };
    let response = await startGoogle();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "connector_disabled_by_org", status: "error" });

    // Shared accounts off is told apart from the connector off; other details stay on the server.
    restores.push(
      replaceConnectorGateDepsForTests({
        selectedWorkspace: async () => ({ ...workspace, membership: { role: "admin", status: "active" } }) as unknown as ConsoleWorkspace,
      }),
    );
    reply = { status: 403, body: { error: "connector_disabled_by_org", reason: "shared_not_allowed", requestId: "w" } };
    response = await start(post("/api/internal/connectors/connect/start", sameOrigin, { provider: "google", scopeKind: "organization" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "connector_disabled_by_org", reason: "shared_not_allowed", status: "error" });
    reply = { status: 403, body: { error: "connector_disabled_by_org", reason: "something_internal" } };
    response = await startGoogle();
    expect(await response.json()).toEqual({ code: "connector_disabled_by_org", status: "error" });

    reply = { status: 500, body: { error: "internal_error", reason: "shared_not_allowed" } };
    response = await startGoogle();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "internal_error", status: "error" });

    reply = { status: 401, body: { error: "connector_unauthorized" } };
    response = await startGoogle();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "connector_service_unavailable", status: "error" });
  });

  test("an impersonation session can't change anything, and nothing reaches the Worker", async () => {
    session = impersonated;
    for (const [path, run, body] of writes) {
      const response = await run(post(path, sameOrigin, body));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("an impersonation session can still read the list; the connect page shows it blocked", async () => {
    session = impersonated;
    reply = { status: 200, body: { connections: [] } };
    const listed = await listRoute.POST(post("/api/internal/connectors/list", sameOrigin, { includeHistory: true }));
    expect(listed.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual(["/ui/connect/list"]);
    expect(calls[0]?.body).toMatchObject({ includeHistory: true, organizationId: ORG, userId: ME });

    const resolved = await resolve(post("/api/internal/connectors/connect/resolve", sameOrigin, { token: TOKEN }));
    expect(await resolved.json()).toEqual({ reason: "impersonation", state: "denied", status: "ok" });
    expect(calls).toHaveLength(1);
  });

  test("rename takes 1 to 120 characters, like the Worker", async () => {
    const tooLong = await rename(
      post(`/api/internal/connectors/${ID}/rename`, sameOrigin, { displayName: "x".repeat(121) }),
      params,
    );
    expect(tooLong.status).toBe(400);
    expect(calls).toHaveLength(0);

    reply = { status: 200, body: { ok: true } };
    const fits = await rename(
      post(`/api/internal/connectors/${ID}/rename`, sameOrigin, { displayName: ` ${"x".repeat(120)} ` }),
      params,
    );
    expect(fits.status).toBe(200);
    expect(calls[0]).toMatchObject({ body: { displayName: "x".repeat(120) }, path: `/ui/connect/rename/${ID}` });
  });

  test("continue marks the browser; finish refuses a browser that isn't marked", async () => {
    reply = { status: 200, body: { authorizationUrl: "https://accounts.example/auth?state=s" } };
    const continued = await continueConnect(post("/api/internal/connectors/connect/continue", sameOrigin, { token: TOKEN }));
    expect(continued.status).toBe(200);
    expect(await continued.json()).toEqual({ authorizationUrl: "https://accounts.example/auth?state=s", status: "ok" });
    expect(continued.headers.get("set-cookie")).toContain(`${connectBrowserCookieName(PENDING)}=1`);

    calls = [];
    const elsewhere = await finish(
      post("/api/internal/connectors/connect/finish", sameOrigin, { pendingId: PENDING, resultToken: "result-token" }),
    );
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ code: "connect_other_browser", status: "error" });
    expect(calls).toHaveLength(0);

    reply = { status: 200, body: { connectionId: ID, provider: "google", scopeKind: "organization", state: "connected" } };
    const here = await finish(
      post(
        "/api/internal/connectors/connect/finish",
        { ...sameOrigin, cookie: `${connectBrowserCookieName(PENDING)}=1` },
        { pendingId: PENDING, resultToken: "result-token" },
      ),
    );
    expect(here.status).toBe(200);
    // The finish page tells an organization account from the person's own by its scope.
    expect(await here.json()).toMatchObject({ connectionId: ID, scopeKind: "organization", state: "connected", status: "ok" });
    expect(calls[0]).toMatchObject({
      body: { organizationId: ORG, pendingId: PENDING, resultToken: "result-token", userId: ME },
      path: "/ui/connect/finish",
    });
  });
});
