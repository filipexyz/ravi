import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { replaceApprovalDepsForTests } from "@/server/connectors/approvals";
import { replaceConnectorGateDepsForTests } from "@/server/connectors/internal-api";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import { POST as decide } from "./[id]/decide/route";
import { POST as getOne } from "./[id]/route";
import { POST as list } from "./list/route";

const ORIGIN = "https://console.example.test";
const APPROVAL = "77777777-7777-4777-8777-777777777777";
const ORG = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ORG = "44444444-4444-4444-8444-444444444444";
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
const params = { params: Promise.resolve({ id: APPROVAL }) };
const routes: Array<[string, (request: NextRequest) => Promise<Response>]> = [
  ["/api/internal/connectors/approvals/list", (request) => list(request)],
  [`/api/internal/connectors/approvals/${APPROVAL}`, (request) => getOne(request, params)],
  [`/api/internal/connectors/approvals/${APPROVAL}/decide`, (request) => decide(request, params)],
];

describe("approval routes without a session", () => {
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
      const response = await run(post(path, { "sec-fetch-site": "cross-site" }, { decision: "approve" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "forbidden", status: "error" });
    }
  });

  test("a same-origin post without a Console session is unauthorized", async () => {
    for (const [path, run] of routes) {
      const response = await run(post(path, sameOrigin, { decision: "approve" }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: "unauthorized", status: "error" });
    }
  });
});

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;

function workspaceFor(organizationId: string, role = "developer") {
  return {
    membership: { role, status: "active" },
    mode: "workos",
    organization: { id: organizationId },
    user: { id: ME },
  } as unknown as ConsoleWorkspace;
}

describe("approval routes with a session", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let session: ConsoleAuthState = auth;
  let owner = ME;
  let unmanaged = false;
  let role = "developer";
  const restores: Array<() => void> = [];

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
    session = auth;
    owner = ME;
    unmanaged = false;
    role = "developer";
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
        selectedWorkspace: async () => workspaceFor(ORG),
      }),
      replaceApprovalDepsForTests({
        currentUserId: async () => ME,
        featureDenial: async () => null,
        findOwner: async (id) => ({ id, organizationId: APPROVAL_ORG, ownerUserId: owner, unmanaged }),
        workspaceIn: async (_auth, organizationId) => workspaceFor(organizationId, role),
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

  test("the list asks for the selected organization; an impersonation session may look at summaries", async () => {
    session = impersonated;
    reply = {
      status: 200,
      body: { approvals: [{ capability: "gmail.message.send", expiresAt: "2026-10-10T10:15:00.000Z", id: APPROVAL, label: "Send email" }] },
    };
    const response = await list(post("/api/internal/connectors/approvals/list", sameOrigin));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { approvals: Array<{ id: string }> };
    expect(body.approvals.map((approval) => approval.id)).toEqual([APPROVAL]);
    expect(calls).toEqual([{ body: { organizationId: ORG, userId: ME }, path: "/ui/approvals/list" }]);
  });

  test("get answers the owner's approval from its own organization", async () => {
    reply = { status: 200, body: { capability: "gmail.message.send", id: APPROVAL, preview: { subject: "Hi" }, status: "pending" } };
    const response = await getOne(post(`/api/internal/connectors/approvals/${APPROVAL}`, sameOrigin), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ approval: { id: APPROVAL, preview: { subject: "Hi" } }, status: "ok" });
    expect(calls).toEqual([{ body: { organizationId: APPROVAL_ORG, userId: ME }, path: `/ui/approvals/get/${APPROVAL}` }]);
  });

  test("someone else's approval is not found and the Worker is never asked", async () => {
    owner = SOMEONE;
    const got = await getOne(post(`/api/internal/connectors/approvals/${APPROVAL}`, sameOrigin), params);
    expect(got.status).toBe(404);
    expect(await got.json()).toEqual({ code: "not_found", status: "error" });
    const decided = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "approve" }), params);
    expect(decided.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("an owner or admin opens and decides an approval on an organization account nobody manages; a member does not", async () => {
    owner = SOMEONE;
    unmanaged = true;
    const getPath = `/api/internal/connectors/approvals/${APPROVAL}`;
    const decidePath = `/api/internal/connectors/approvals/${APPROVAL}/decide`;

    const asMember = await getOne(post(getPath, sameOrigin), params);
    expect(asMember.status).toBe(404);
    expect((await decide(post(decidePath, sameOrigin, { decision: "approve" }), params)).status).toBe(404);
    expect(calls).toHaveLength(0);

    role = "admin";
    reply = { status: 200, body: { capability: "gmail.message.send", id: APPROVAL, preview: { subject: "Hi" }, status: "pending" } };
    const got = await getOne(post(getPath, sameOrigin), params);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ approval: { id: APPROVAL }, status: "ok" });
    role = "owner";
    reply = { status: 200, body: { status: "approved" } };
    const decided = await decide(post(decidePath, sameOrigin, { decision: "approve" }), params);
    expect(await decided.json()).toEqual({ approvalStatus: "approved", status: "ok" });
    expect(calls).toEqual([
      { body: { organizationId: APPROVAL_ORG, userId: ME }, path: `/ui/approvals/get/${APPROVAL}` },
      { body: { decision: "approve", organizationId: APPROVAL_ORG, userId: ME }, path: `/ui/approvals/decide/${APPROVAL}` },
    ]);

    // The Worker still decides: when it refuses, the route answers not found.
    reply = { status: 404, body: { error: "not_found" } };
    expect((await decide(post(decidePath, sameOrigin, { decision: "deny" }), params)).status).toBe(404);
  });

  test("an impersonation session can't see the preview or decide", async () => {
    session = impersonated;
    const got = await getOne(post(`/api/internal/connectors/approvals/${APPROVAL}`, sameOrigin), params);
    expect(got.status).toBe(403);
    expect(await got.json()).toEqual({ code: "impersonation", status: "error" });
    for (const decision of ["approve", "deny"]) {
      const response = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision }), params);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "impersonation", status: "error" });
    }
    expect(calls).toHaveLength(0);
  });

  test("decide forwards approve and deny and answers the approval's status", async () => {
    reply = { status: 200, body: { status: "approved" } };
    const approved = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "approve" }), params);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ approvalStatus: "approved", status: "ok" });
    reply = { status: 200, body: { status: "denied" } };
    const denied = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "deny" }), params);
    expect(await denied.json()).toEqual({ approvalStatus: "denied", status: "ok" });
    expect(calls).toEqual([
      { body: { decision: "approve", organizationId: APPROVAL_ORG, userId: ME }, path: `/ui/approvals/decide/${APPROVAL}` },
      { body: { decision: "deny", organizationId: APPROVAL_ORG, userId: ME }, path: `/ui/approvals/decide/${APPROVAL}` },
    ]);
  });

  test("decide refuses an unknown decision, and maps Worker failures", async () => {
    const bad = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "maybe" }), params);
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);

    reply = { status: 400, body: { error: "connector_approval_invalid" } };
    const invalid = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "approve" }), params);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "connector_approval_invalid", status: "error" });

    reply = { status: 502, body: { error: "internal_error" } };
    const down = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "approve" }), params);
    expect(down.status).toBe(502);

    reply = { status: 401, body: { error: "connector_unauthorized" } };
    const unsigned = await decide(post(`/api/internal/connectors/approvals/${APPROVAL}/decide`, sameOrigin, { decision: "approve" }), params);
    expect(unsigned.status).toBe(502);
    expect(await unsigned.json()).toEqual({ code: "connector_service_unavailable", status: "error" });
  });
});
