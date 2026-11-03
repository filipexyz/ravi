import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as setOwner } from "./connections/[id]/owner/route";
import { POST as listConnections } from "./connections/route";
import { POST as listInstallations } from "./installations/route";
import { POST as revokeShared } from "./shared/[id]/revoke/route";
import { POST as listShared } from "./shared/list/route";
import { POST as grantShared } from "./shared/route";

const ORIGIN = "https://console.example.test";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const INSTALLATION = "66666666-6666-4666-8666-666666666666";
const GRANT = "88888888-8888-4888-8888-888888888888";

function post(path: string, headers: Record<string, string>, body: unknown = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-request-id": "req-test", ...headers },
    method: "POST",
  });
}

const sameOrigin = { "sec-fetch-site": "same-origin" };
const connectionParams = { params: Promise.resolve({ id: CONNECTION }) };
const grantParams = { params: Promise.resolve({ id: GRANT }) };
const GRANT_BODY = { agentId: "support", connectionId: CONNECTION, conversations: ["dm", "group"], installationId: INSTALLATION };

type Route = [path: string, run: (request: NextRequest) => Promise<Response>, body: unknown];
const reads: Route[] = [
  ["/api/internal/connectors/org/connections", (request) => listConnections(request), {}],
  ["/api/internal/connectors/org/shared/list", (request) => listShared(request), {}],
];
const writes: Route[] = [
  [
    `/api/internal/connectors/org/connections/${CONNECTION}/owner`,
    (request) => setOwner(request, connectionParams),
    { managedByUserId: MANAGER },
  ],
  ["/api/internal/connectors/org/shared", (request) => grantShared(request), GRANT_BODY],
  [`/api/internal/connectors/org/shared/${GRANT}/revoke`, (request) => revokeShared(request, grantParams), {}],
];
// The installations list is Console-owned: for owners and admins it never
// calls the Worker; for anyone else it asks which accounts they manage.
const consoleOnly: Route[] = [["/api/internal/connectors/org/installations", (request) => listInstallations(request), {}]];
const routes = [...reads, ...writes, ...consoleOnly];

describe("organization account routes without a session", () => {
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

describe("organization account routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let session: ConsoleAuthState = auth;
  let workspace = workspaceAs("admin");
  let restore: (() => void) | null = null;

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
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

  test("Change owner still refuses a member who isn't an owner or admin, and the Worker hears nothing", async () => {
    for (const role of ["developer", "viewer", "billing"]) {
      workspace = workspaceAs(role);
      const response = await setOwner(
        post(`/api/internal/connectors/org/connections/${CONNECTION}/owner`, sameOrigin, { managedByUserId: MANAGER }),
        connectionParams,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "connector_forbidden", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("a membership that isn't active reaches none of them, even an owner's", async () => {
    for (const role of ["owner", "developer"]) {
      workspace = workspaceAs(role, "suspended");
      for (const [path, run, body] of routes) {
        const response = await run(post(path, sameOrigin, body));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "connector_forbidden", status: "error" });
      }
    }
    expect(calls).toHaveLength(0);
  });

  test("a member's list, shares and revokes reach the Worker with their role: it decides what they manage", async () => {
    for (const role of ["developer", "viewer"]) {
      calls = [];
      workspace = workspaceAs(role);
      reply = {
        status: 200,
        body: {
          connections: [
            {
              email: "support@acme.test",
              id: CONNECTION,
              managedBy: { email: "me@example.test", userId: ME },
              provider: "google",
              scopeKind: "organization",
              status: "active",
            },
          ],
        },
      };
      const listed = await listConnections(post("/api/internal/connectors/org/connections", sameOrigin));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ connections: [{ id: CONNECTION, managedBy: { userId: ME } }], status: "ok" });

      reply = { status: 201, body: { grantId: GRANT } };
      const granted = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, GRANT_BODY));
      expect(granted.status).toBe(201);

      reply = { status: 200, body: { grants: [] } };
      const shared = await listShared(post("/api/internal/connectors/org/shared/list", sameOrigin, { connectionId: CONNECTION }));
      expect(await shared.json()).toEqual({ grants: [], status: "ok" });

      reply = { status: 200, body: { ok: true } };
      const revoked = await revokeShared(post(`/api/internal/connectors/org/shared/${GRANT}/revoke`, sameOrigin), grantParams);
      expect(await revoked.json()).toEqual({ revoked: true, status: "ok" });

      const actor = { organizationId: ORG, role, userId: ME };
      expect(calls).toEqual([
        { body: actor, path: "/ui/org/connections/list" },
        {
          body: { ...actor, agentId: "support", connectionId: CONNECTION, conversations: ["dm", "group"], installationId: INSTALLATION },
          path: "/ui/org/shared/grant",
        },
        { body: { ...actor, connectionId: CONNECTION }, path: "/ui/org/shared/list" },
        { body: actor, path: `/ui/org/shared/revoke/${GRANT}` },
      ]);
    }
  });

  test("the Worker's refusal of someone who doesn't manage the account reaches the screen, with why when it tells", async () => {
    workspace = workspaceAs("developer");
    reply = { status: 403, body: { error: "connector_forbidden", requestId: "w" } };
    const refused = await revokeShared(post(`/api/internal/connectors/org/shared/${GRANT}/revoke`, sameOrigin), grantParams);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "connector_forbidden", status: "error" });

    // An agent on another organization account its manager can't change.
    reply = { status: 403, body: { error: "connector_forbidden", reason: "agent_uses_other_account", requestId: "w" } };
    const elsewhere = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, GRANT_BODY));
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ code: "connector_forbidden", reason: "agent_uses_other_account", status: "error" });
  });

  test("computers for a member: refused unless the Worker lists an account they manage", async () => {
    workspace = workspaceAs("developer");
    reply = { status: 200, body: { connections: [] } };
    const none = await listInstallations(post("/api/internal/connectors/org/installations", sameOrigin));
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ code: "connector_forbidden", status: "error" });
    expect(calls).toEqual([{ body: { organizationId: ORG, role: "developer", userId: ME }, path: "/ui/org/connections/list" }]);

    reply = { status: 500, body: { error: "internal_error" } };
    expect((await listInstallations(post("/api/internal/connectors/org/installations", sameOrigin))).status).toBe(502);
  });

  test("an impersonation session can read but can't write, even as an owner", async () => {
    session = impersonated;
    for (const role of ["owner", "developer"]) {
      workspace = workspaceAs(role);
      for (const [path, run, body] of writes) {
        const response = await run(post(path, sameOrigin, body));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
      }
    }
    expect(calls).toHaveLength(0);
    workspace = workspaceAs("owner");
    reply = { status: 200, body: { connections: [] } };
    expect((await listConnections(post("/api/internal/connectors/org/connections", sameOrigin))).status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual(["/ui/org/connections/list"]);
  });

  test("owners and admins reach the Worker with their role", async () => {
    for (const role of ["owner", "admin"]) {
      calls = [];
      workspace = workspaceAs(role);
      reply = {
        status: 200,
        body: {
          connections: [
            {
              email: "support@acme.test",
              id: CONNECTION,
              managedBy: { email: "m@acme.test", userId: MANAGER },
              provider: "google",
              scopeKind: "organization",
              status: "active",
            },
            // GitHub rows are project installations and never listed.
            { id: GRANT, provider: "github", scopeKind: "project" },
          ],
        },
      };
      const listed = await listConnections(post("/api/internal/connectors/org/connections", sameOrigin));
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { connections: Array<{ id: string; managedBy: unknown; scopeKind: string }> };
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0]).toMatchObject({
        id: CONNECTION,
        managedBy: { email: "m@acme.test", userId: MANAGER },
        scopeKind: "organization",
      });

      reply = { status: 200, body: { ok: true } };
      const owner = await setOwner(
        post(`/api/internal/connectors/org/connections/${CONNECTION}/owner`, sameOrigin, { managedByUserId: MANAGER }),
        connectionParams,
      );
      expect(await owner.json()).toEqual({ ok: true, status: "ok" });

      reply = { status: 201, body: { grantId: GRANT } };
      const granted = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, { ...GRANT_BODY, conversations: ["dm", "dm"] }));
      expect(granted.status).toBe(201);
      expect(await granted.json()).toEqual({ grantId: GRANT, status: "ok" });

      reply = { status: 200, body: { grants: [{ agentId: "support", connectionId: CONNECTION, conversations: ["dm"], id: GRANT, mode: "shared" }] } };
      const shared = await listShared(post("/api/internal/connectors/org/shared/list", sameOrigin, { connectionId: CONNECTION }));
      expect(await shared.json()).toMatchObject({ grants: [{ conversations: ["dm"], id: GRANT, mode: "shared" }], status: "ok" });

      reply = { status: 200, body: { ok: true } };
      const revoked = await revokeShared(post(`/api/internal/connectors/org/shared/${GRANT}/revoke`, sameOrigin), grantParams);
      expect(await revoked.json()).toEqual({ revoked: true, status: "ok" });

      const actor = { organizationId: ORG, role, userId: ME };
      expect(calls).toEqual([
        { body: actor, path: "/ui/org/connections/list" },
        { body: { ...actor, managedByUserId: MANAGER }, path: `/ui/org/connections/owner/${CONNECTION}` },
        {
          body: { ...actor, agentId: "support", connectionId: CONNECTION, conversations: ["dm"], installationId: INSTALLATION },
          path: "/ui/org/shared/grant",
        },
        { body: { ...actor, connectionId: CONNECTION }, path: "/ui/org/shared/list" },
        { body: actor, path: `/ui/org/shared/revoke/${GRANT}` },
      ]);
    }
  });

  test("bad bodies and ids are refused before the Worker hears of them", async () => {
    const badGrants = [
      { ...GRANT_BODY, conversations: [] },
      { ...GRANT_BODY, conversations: ["dm", "terminal"] },
      { ...GRANT_BODY, agentId: "" },
      { ...GRANT_BODY, agentId: "../main" },
      { ...GRANT_BODY, agentId: "a b" },
      { ...GRANT_BODY, installationId: "computer" },
      { ...GRANT_BODY, connectionId: undefined },
    ];
    for (const body of badGrants) {
      const response = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "payload_invalid", status: "error" });
    }
    for (const body of [{}, { managedByUserId: "someone" }]) {
      const response = await setOwner(post(`/api/internal/connectors/org/connections/${CONNECTION}/owner`, sameOrigin, body), connectionParams);
      expect(response.status).toBe(400);
    }
    const badId = await setOwner(
      post("/api/internal/connectors/org/connections/x/owner", sameOrigin, { managedByUserId: MANAGER }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(badId.status).toBe(400);
    const badGrant = await revokeShared(post("/api/internal/connectors/org/shared/x/revoke", sameOrigin), {
      params: Promise.resolve({ id: "../admin" }),
    });
    expect(badGrant.status).toBe(400);
    const badFilter = await listShared(post("/api/internal/connectors/org/shared/list", sameOrigin, { connectionId: "x" }));
    expect(badFilter.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("Worker failures: refusals keep their code, an outage or a refused signature is a bad gateway", async () => {
    reply = { status: 403, body: { error: "connector_forbidden" } };
    const refused = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, GRANT_BODY));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "connector_forbidden", status: "error" });

    reply = { status: 409, body: { error: "connector_shared_not_allowed" } };
    const notAllowed = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, GRANT_BODY));
    expect(notAllowed.status).toBe(409);
    expect(await notAllowed.json()).toEqual({ code: "connector_shared_not_allowed", status: "error" });

    reply = { status: 404, body: { error: "connector_unavailable" } };
    const gone = await setOwner(
      post(`/api/internal/connectors/org/connections/${CONNECTION}/owner`, sameOrigin, { managedByUserId: MANAGER }),
      connectionParams,
    );
    expect(gone.status).toBe(404);

    reply = { status: 500, body: { error: "internal_error" } };
    expect((await listConnections(post("/api/internal/connectors/org/connections", sameOrigin))).status).toBe(502);

    reply = { status: 401, body: { error: "connector_unauthorized" } };
    const unsigned = await listShared(post("/api/internal/connectors/org/shared/list", sameOrigin));
    expect(unsigned.status).toBe(502);
    expect(await unsigned.json()).toEqual({ code: "connector_service_unavailable", status: "error" });

    // A grant answer without an id isn't treated as success.
    reply = { status: 201, body: {} };
    const empty = await grantShared(post("/api/internal/connectors/org/shared", sameOrigin, GRANT_BODY));
    expect(empty.status).toBe(502);
  });
});
