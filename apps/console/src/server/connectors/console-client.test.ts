import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ConsoleConnectorClientError,
  continueConnect,
  decideApproval,
  decideConsent,
  grantSharedUse,
  listConsentGrants,
  listOrgConnections,
  listSharedGrants,
  normalizeConsentView,
  normalizeGrantRow,
  resolveConsent,
  revokeConsentGrant,
  revokeSharedGrant,
  setOrgConnectionOwner,
  finishConnect,
  getApproval,
  getConnectionDetail,
  getOrgPolicy,
  listAdminConnections,
  listApprovals,
  listConnectors,
  makeDefaultConnector,
  normalizeApprovalDetail,
  normalizeConnectionDetail,
  normalizeConnectionSummary,
  normalizeOrgPolicy,
  renameConnector,
  resolveConnect,
  revokeAdminConnection,
  revokeConnector,
  setOrgPolicy,
  setToolPolicy,
  startConnect,
  withToolCeiling,
} from "./console-client";

const actor = { organizationId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };

type Captured = { url: string; method: string; body: Record<string, unknown>; headers: Headers };

const env = process.env;
const originalFetch = globalThis.fetch;
let captured: Captured[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  captured = [];
  reply = { status: 200, body: {} };
  env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
  env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
  env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url: String(input),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
  delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
  delete env.RAVI_CONNECTORS_LINK_URL;
});

describe("connect flow calls", () => {
  test("start sends the person, never a project, and signs the request", async () => {
    reply = { status: 201, body: { authorizationUrl: "https://accounts.example/x", expiresAt: "t", pendingGrantId: "p" } };
    const result = await startConnect(actor, { accessMode: "read_only", continueNow: true, provider: "google" });
    expect(result.authorizationUrl).toBe("https://accounts.example/x");
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://link.example.test/ui/connect/start");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ ...actor, accessMode: "read_only", continueNow: true, origin: "ui", provider: "google" });
    expect(call.body).not.toHaveProperty("projectId");
    expect(call.headers.get("x-ravi-hmac-key-id")).toBe("test-key");
    expect(call.headers.get("x-ravi-hmac-signature")).toBeTruthy();
  });

  test("CLI starts carry the session and installation", async () => {
    reply = { status: 201, body: { connectUrl: "https://console.example/connect/t", expiresAt: "t", pendingGrantId: "p" } };
    await startConnect(actor, {
      cliSessionId: "33333333-3333-4333-8333-333333333333",
      localInstallationId: "44444444-4444-4444-8444-444444444444",
      origin: "cli",
      provider: "google",
      reconnectConnectionId: "55555555-5555-4555-8555-555555555555",
    });
    expect(captured[0]!.body).toEqual({
      ...actor,
      cliSessionId: "33333333-3333-4333-8333-333333333333",
      localInstallationId: "44444444-4444-4444-8444-444444444444",
      origin: "cli",
      provider: "google",
      reconnectConnectionId: "55555555-5555-4555-8555-555555555555",
    });
  });

  test("resolve, continue and finish post to their Worker routes", async () => {
    reply = { status: 200, body: { state: "expired" } };
    expect(await resolveConnect(actor, "tok")).toEqual({ state: "expired" });
    reply = { status: 200, body: { authorizationUrl: "https://accounts.example/y" } };
    expect(await continueConnect(actor, "tok")).toEqual({ authorizationUrl: "https://accounts.example/y" });
    reply = { status: 200, body: { reason: "provider_denied", state: "rejected" } };
    expect(await finishConnect(actor, { pendingId: "p", resultToken: "r" })).toEqual({
      reason: "provider_denied",
      state: "rejected",
    });
    expect(captured.map((call) => [call.url.replace("https://link.example.test", ""), call.body])).toEqual([
      ["/ui/connect/resolve", { ...actor, connectToken: "tok" }],
      ["/ui/connect/continue", { ...actor, connectToken: "tok" }],
      ["/ui/connect/finish", { ...actor, pendingId: "p", resultToken: "r" }],
    ]);
  });
});

describe("connection calls", () => {
  test("list asks for history and normalizes rows", async () => {
    reply = {
      status: 200,
      body: {
        connections: [
          {
            createdAt: "2026-10-01T00:00:00.000Z",
            displayName: "google",
            externalAccountLogin: "ana@example.test",
            grantedAt: "2026-10-01T00:00:00.000Z",
            id: "a",
            projectId: "legacy-project",
            provider: "google",
            requiresReauth: false,
            scopes: ["openid"],
            status: "active",
          },
          { id: "b", provider: "github", status: "active" },
        ],
      },
    };
    const rows = await listConnectors(actor, { includeHistory: true });
    expect(captured[0]!.body).toEqual({ ...actor, includeHistory: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      accessMode: "full",
      createdAt: "2026-10-01T00:00:00.000Z",
      displayName: "google",
      email: "ana@example.test",
      grantedAt: "2026-10-01T00:00:00.000Z",
      id: "a",
      isDefault: false,
      lastUsedAt: null,
      provider: "google",
      requiresReauth: false,
      revokedAt: null,
      scopeKind: "user",
      scopes: ["openid"],
      status: "active",
      usedBy: [],
    });
    expect(rows[0]).not.toHaveProperty("projectId");
  });

  test("rename, default and revoke post to the row's Worker route", async () => {
    reply = { status: 200, body: { ok: true } };
    await renameConnector(actor, "c/1", "Work");
    await makeDefaultConnector(actor, "c1");
    await revokeConnector(actor, "c1");
    expect(captured.map((call) => [call.url.replace("https://link.example.test", ""), call.body])).toEqual([
      ["/ui/connect/rename/c%2F1", { ...actor, displayName: "Work" }],
      ["/ui/connect/default/c1", actor],
      ["/ui/connect/revoke/c1", actor],
    ]);
  });

  test("Worker errors keep status and code", async () => {
    reply = { status: 403, body: { error: "connector_disabled_by_org", requestId: "w1" } };
    const error = await startConnect(actor, { provider: "google" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsoleConnectorClientError);
    expect(error).toMatchObject({ code: "connector_disabled_by_org", reason: null, status: 403 });

    // The Worker's reason detail rides along; anything that isn't a plain code doesn't.
    reply = { status: 403, body: { error: "connector_disabled_by_org", reason: "shared_not_allowed", requestId: "w2" } };
    const shared = await startConnect(actor, { provider: "google", scopeKind: "organization" }).catch((caught: unknown) => caught);
    expect(shared).toMatchObject({ code: "connector_disabled_by_org", reason: "shared_not_allowed", status: 403 });
    reply = { status: 403, body: { error: "connector_disabled_by_org", reason: "Shared <b>off</b>" } };
    const odd = await startConnect(actor, { provider: "google" }).catch((caught: unknown) => caught);
    expect(odd).toMatchObject({ reason: null });
  });

  test("missing HMAC keys answer server_not_configured without calling the Worker", async () => {
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
    const error = await listConnectors(actor).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "server_not_configured", status: 503 });
    expect(captured).toHaveLength(0);
  });
});

describe("normalizeConnectionSummary", () => {
  test("keeps the new fields and rejects rows without an id", () => {
    expect(normalizeConnectionSummary(null)).toBeNull();
    expect(normalizeConnectionSummary({ provider: "google" })).toBeNull();
    const row = normalizeConnectionSummary({
      accessMode: "read_only",
      email: "ana@example.test",
      id: "a",
      isDefault: true,
      lastUsedAt: "2026-10-09T00:00:00.000Z",
      provider: "google",
      scopeKind: "user",
      scopes: ["x", 3],
      status: "revoke_pending",
    });
    expect(row).toMatchObject({
      accessMode: "read_only",
      email: "ana@example.test",
      isDefault: true,
      lastUsedAt: "2026-10-09T00:00:00.000Z",
      scopes: ["x"],
      status: "revoke_pending",
    });
  });
});

const worker = (call: Captured) => [call.url.replace("https://link.example.test", ""), call.body] as const;

describe("detail and tool calls", () => {
  test("detail posts the person and fills a detail the Worker left partial", async () => {
    reply = {
      status: 200,
      body: {
        activity: [
          { action: "connector.action.executed", at: "2026-10-10T09:00:00.000Z", capability: "gmail.message.send" },
          { at: "x" },
          {
            action: "connector.action.denied",
            at: "2026-10-10T08:30:00.000Z",
            capability: "gmail.message.send",
            code: "connector_approval_required",
            outcome: "denied",
          },
        ],
        id: "c1",
        provider: "google",
        tools: [
          { capability: "gmail.message.send", class: "write", label: "Send email", policy: "needs_approval" },
          { label: "no capability" },
        ],
        usedBy: [{ agentId: "main", installationName: "ana-mbp", lastUsedAt: "2026-10-10T08:00:00.000Z" }],
      },
    };
    const detail = await getConnectionDetail(actor, "c/1");
    expect(worker(captured[0]!)).toEqual(["/ui/connect/detail/c%2F1", actor]);
    expect(detail.tools).toEqual([
      {
        available: true,
        capability: "gmail.message.send",
        ceiling: null,
        class: "write",
        label: "Send email",
        policy: "needs_approval",
        userPolicy: null,
      },
    ]);
    expect(detail.activity).toEqual([
      {
        action: "connector.action.executed",
        agentId: null,
        at: "2026-10-10T09:00:00.000Z",
        capability: "gmail.message.send",
        code: null,
        conversation: null,
        outcome: "ok",
      },
      {
        action: "connector.action.denied",
        agentId: null,
        at: "2026-10-10T08:30:00.000Z",
        capability: "gmail.message.send",
        code: "connector_approval_required",
        conversation: null,
        outcome: "denied",
      },
    ]);
    // No `usage` from the Worker: the summary's usedBy stands in.
    expect(detail.usage).toEqual([
      {
        agentId: "main",
        conversation: "terminal",
        installationId: null,
        installationName: "ana-mbp",
        lastUsedAt: "2026-10-10T08:00:00.000Z",
        legacyCli: false,
        mode: "owner",
        routineKey: null,
        useCount: 0,
      },
    ]);
    expect(detail.grants).toEqual([]);
  });

  test("a detail without an id is a bad gateway, never a blank drawer", async () => {
    reply = { status: 200, body: { tools: [] } };
    const error = await getConnectionDetail(actor, "c1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "connector_service_unavailable", status: 502 });
    expect(normalizeConnectionDetail({ id: "g", provider: "github" })).toBeNull();
  });

  test("a tool rule posts the capability and policy; a rule above the ceiling keeps its code", async () => {
    reply = { status: 200, body: { ok: true } };
    await setToolPolicy(actor, "c1", { capability: "gmail.message.send", policy: "blocked" });
    expect(worker(captured[0]!)).toEqual([
      "/ui/connect/tools/c1",
      { ...actor, capability: "gmail.message.send", policy: "blocked" },
    ]);
    reply = { status: 409, body: { error: "connector_policy_above_ceiling" } };
    const error = await setToolPolicy(actor, "c1", { capability: "gmail.message.send", policy: "always_allow" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "connector_policy_above_ceiling", status: 409 });
  });
});

describe("approval calls", () => {
  test("list, get and decide post to their Worker routes", async () => {
    reply = {
      status: 200,
      body: { approvals: [{ capability: "gmail.message.send", expiresAt: "t", id: "a1", label: "Send email" }, { id: "x" }] },
    };
    const approvals = await listApprovals(actor);
    expect(approvals.map((approval) => [approval.id, approval.reason, approval.label])).toEqual([["a1", "policy", "Send email"]]);

    reply = {
      status: 200,
      body: {
        capability: "gmail.message.send",
        id: "a1",
        preview: { subject: "Hi", to: ["b@example.test"] },
        reason: "write_after_read",
        routine: { kind: "cron", id: "daily" },
        status: "pending",
      },
    };
    const approval = await getApproval(actor, "a1");
    expect(approval).toMatchObject({
      preview: { subject: "Hi", to: ["b@example.test"] },
      reason: "write_after_read",
      routine: { id: "daily", kind: "cron" },
      status: "pending",
    });

    reply = { status: 200, body: { status: "denied" } };
    expect(await decideApproval(actor, "a1", "deny")).toEqual({ status: "denied" });

    expect(captured.map(worker)).toEqual([
      ["/ui/approvals/list", actor],
      ["/ui/approvals/get/a1", actor],
      ["/ui/approvals/decide/a1", { ...actor, decision: "deny" }],
    ]);
  });

  test("a preview that isn't an object is dropped", () => {
    expect(normalizeApprovalDetail({ capability: "c", id: "a", preview: ["x"] })?.preview).toBeNull();
    expect(normalizeApprovalDetail({ capability: "c", id: "a", preview: "x" })?.preview).toBeNull();
  });
});

describe("admin calls", () => {
  const admin = { ...actor, role: "admin" };

  test("every admin call carries the member's role", async () => {
    reply = { status: 200, body: { enabled: false, provider: "google", toolCeilings: { "gmail.message.send": "blocked", x: "nope" } } };
    const policy = await getOrgPolicy(admin, "google");
    expect(policy).toEqual({
      enabled: false,
      provider: "google",
      sharedAllowed: false,
      toolCeilings: { "gmail.message.send": "blocked" },
      tools: [],
      writesAllowed: true,
    });
    await setOrgPolicy(admin, { provider: "google", toolCeilings: {}, writesAllowed: false });
    reply = { status: 200, body: { connections: [{ id: "c1", member: { email: "m@example.test" }, provider: "google" }, { id: "g", provider: "github" }] } };
    const rows = await listAdminConnections(admin, { provider: "google" });
    expect(rows).toEqual([
      {
        createdAt: "",
        email: null,
        id: "c1",
        lastUsedAt: null,
        member: { email: "m@example.test", name: null, userId: null },
        provider: "google",
        requiresReauth: false,
        scopeKind: "user",
        status: "active",
      },
    ]);
    reply = { status: 200, body: { revoked: true } };
    await revokeAdminConnection(admin, "c1");

    expect(captured.map(worker)).toEqual([
      ["/ui/admin/policy/get", { ...admin, provider: "google" }],
      ["/ui/admin/policy/set", { ...admin, provider: "google", toolCeilings: {}, writesAllowed: false }],
      ["/ui/admin/connections/list", { ...admin, provider: "google" }],
      ["/ui/admin/connections/revoke/c1", admin],
    ]);
  });

  test("no policy row reads as the defaults", () => {
    expect(normalizeOrgPolicy({}, "google")).toEqual({
      enabled: true,
      provider: "google",
      sharedAllowed: false,
      toolCeilings: {},
      tools: [],
      writesAllowed: true,
    });
  });

  test("one tool's ceiling change keeps every other ceiling and drops tools the catalog no longer lists", () => {
    const tools = [
      { capability: "gmail.message.send", class: "write", label: "Send email" },
      { capability: "gcal.event.list", class: "read", label: "Read your calendar" },
    ];
    const toolCeilings = {
      "gmail.message.retired": "blocked" as const,
      "gmail.message.send": "blocked" as const,
    };
    expect(withToolCeiling({ toolCeilings, tools }, { capability: "gcal.event.list", ceiling: "needs_approval" })).toEqual({
      "gcal.event.list": "needs_approval",
      "gmail.message.send": "blocked",
    });
    expect(withToolCeiling({ toolCeilings, tools }, { capability: "gmail.message.send", ceiling: null })).toEqual({});
    expect(
      withToolCeiling({ toolCeilings: { "gcal.event.list": "always_allow" }, tools }, { capability: "gmail.message.send", ceiling: "blocked" }),
    ).toEqual({ "gmail.message.send": "blocked" });
    expect(withToolCeiling({ toolCeilings, tools }, { capability: "slack.post", ceiling: "blocked" })).toBeNull();
  });

  test("a non-admin refused by the Worker keeps the code", async () => {
    reply = { status: 403, body: { error: "connector_forbidden" } };
    const error = await getOrgPolicy({ ...actor, role: "developer" }, "google").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "connector_forbidden", status: 403 });
    expect(captured[0]!.body).toMatchObject({ role: "developer" });
  });
});

describe("consent calls", () => {
  test("resolve, decide, list and revoke post the person to their Worker routes", async () => {
    reply = {
      status: 200,
      body: {
        agentId: "support",
        connections: [{ email: "me@example.test", id: "c1", isDefault: true }, { id: "c2" }, { email: "no-id@example.test" }],
        expiresAt: "2026-10-11T10:00:00.000Z",
        provider: "google",
        state: "pending",
      },
    };
    expect(await resolveConsent(actor, "tok")).toEqual({
      agentDisplayName: null,
      agentId: "support",
      connections: [
        { email: "me@example.test", id: "c1", isDefault: true },
        { email: null, id: "c2", isDefault: false },
      ],
      expiresAt: "2026-10-11T10:00:00.000Z",
      installationName: null,
      operatorEmail: null,
      operatorName: null,
      provider: "google",
      state: "pending",
    });

    reply = { status: 200, body: { grantId: "g1", status: "approved" } };
    expect(await decideConsent(actor, { connectionId: "c1", decision: "approve", token: "tok" })).toEqual({
      grantId: "g1",
      status: "approved",
    });
    reply = { status: 200, body: {} };
    expect(await decideConsent(actor, { decision: "deny", token: "tok" })).toEqual({ grantId: null, status: "denied" });

    reply = { status: 200, body: { grants: [{ agentId: "support", id: "g1", mode: "person_asking" }, { agentId: "x" }] } };
    const grants = await listConsentGrants(actor);
    expect(grants.map((grant) => grant.id)).toEqual(["g1"]);

    reply = { status: 200, body: { ok: true } };
    await revokeConsentGrant(actor, "g1");

    expect(captured.map((call) => [call.url.replace("https://link.example.test", ""), call.body])).toEqual([
      ["/ui/consent/resolve", { ...actor, token: "tok" }],
      ["/ui/consent/decide", { ...actor, connectionId: "c1", decision: "approve", token: "tok" }],
      ["/ui/consent/decide", { ...actor, decision: "deny", token: "tok" }],
      ["/ui/consent/list", actor],
      ["/ui/consent/revoke/g1", actor],
    ]);
  });

  test("a consent view the Worker didn't fill reads invalid; end states pass", () => {
    expect(normalizeConsentView(null)).toEqual({ state: "invalid" });
    expect(normalizeConsentView({ state: "pending", provider: "google" })).toEqual({ state: "invalid" });
    expect(normalizeConsentView({ state: "approved" })).toEqual({ state: "invalid" });
    for (const state of ["expired", "used", "user_mismatch", "invalid"] as const) {
      expect(normalizeConsentView({ agentId: "leak", state })).toEqual({ state });
    }
  });

  test("a grant's operator is a person or nobody, never whatever the Worker sent", () => {
    expect(normalizeGrantRow({ id: "g", operator: { email: "a@example.test", userId: "u" } })?.operator).toEqual({
      email: "a@example.test",
      userId: "u",
    });
    expect(normalizeGrantRow({ id: "g", operator: { email: "a@example.test" } })?.operator).toBeNull();
    expect(normalizeGrantRow({ id: "g", operator: "someone" })?.operator).toBeNull();
    expect(normalizeGrantRow({ id: "g", conversations: ["dm", 3, "group"], mode: "shared" })).toMatchObject({
      conversations: ["dm", "group"],
      mode: "shared",
    });
    expect(normalizeGrantRow(null)).toBeNull();
  });
});

describe("organization account calls", () => {
  const admin = { ...actor, role: "owner" };

  test("every call carries the member's role", async () => {
    reply = {
      status: 200,
      body: {
        connections: [
          { email: "support@acme.test", id: "c1", managedBy: { email: "m@acme.test", userId: "m" }, provider: "google" },
          { email: "orphan@acme.test", id: "c2", provider: "google" },
          { id: "g", provider: "github" },
        ],
      },
    };
    const rows = await listOrgConnections(admin);
    expect(rows.map((row) => [row.id, row.scopeKind, row.managedBy])).toEqual([
      ["c1", "organization", { email: "m@acme.test", userId: "m" }],
      ["c2", "organization", null],
    ]);

    reply = { status: 200, body: { ok: true } };
    await setOrgConnectionOwner(admin, "c1", "m2");
    reply = { status: 201, body: { grantId: "g1" } };
    expect(
      await grantSharedUse(admin, { agentId: "support", connectionId: "c1", conversations: ["dm"], installationId: "i1" }),
    ).toEqual({ grantId: "g1" });
    reply = { status: 200, body: { grants: [{ agentId: "support", connectionId: "c1", id: "g1", mode: "shared" }] } };
    expect((await listSharedGrants(admin, { connectionId: "c1" })).map((grant) => grant.id)).toEqual(["g1"]);
    reply = { status: 200, body: { ok: true } };
    await revokeSharedGrant(admin, "g1");

    expect(captured.map((call) => [call.url.replace("https://link.example.test", ""), call.body])).toEqual([
      ["/ui/org/connections/list", admin],
      ["/ui/org/connections/owner/c1", { ...admin, managedByUserId: "m2" }],
      ["/ui/org/shared/grant", { ...admin, agentId: "support", connectionId: "c1", conversations: ["dm"], installationId: "i1" }],
      ["/ui/org/shared/list", { ...admin, connectionId: "c1" }],
      ["/ui/org/shared/revoke/g1", admin],
    ]);
  });

  test("a member who isn't an owner or admin asks with their own role; the Worker answers what they manage", async () => {
    const member = { ...actor, role: "developer" };
    reply = { status: 200, body: { connections: [{ email: "support@acme.test", id: "c1", managedBy: { email: null, userId: "u" }, provider: "google" }] } };
    expect((await listOrgConnections(member)).map((row) => row.id)).toEqual(["c1"]);
    reply = { status: 200, body: { grants: [] } };
    expect(await listSharedGrants(member)).toEqual([]);
    expect(captured.map((call) => [call.url.replace("https://link.example.test", ""), call.body])).toEqual([
      ["/ui/org/connections/list", member],
      ["/ui/org/shared/list", member],
    ]);
  });

  test("a grant answer without an id is a bad gateway", async () => {
    reply = { status: 201, body: {} };
    const error = await grantSharedUse(admin, { agentId: "a", connectionId: "c", conversations: ["dm"], installationId: "i" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConsoleConnectorClientError);
    expect(error).toMatchObject({ code: "connector_service_unavailable", status: 502 });
  });

  test("an organization start sends the scope and the role; Allow shared accounts goes with the policy", async () => {
    reply = { status: 201, body: { authorizationUrl: "https://accounts.example/x", expiresAt: "t", pendingGrantId: "p" } };
    await startConnect(actor, { continueNow: true, provider: "google", role: "admin", scopeKind: "organization" });
    expect(captured[0]!.body).toEqual({
      ...actor,
      continueNow: true,
      origin: "ui",
      provider: "google",
      role: "admin",
      scopeKind: "organization",
    });
    reply = { status: 200, body: { provider: "google", sharedAllowed: true } };
    expect((await setOrgPolicy(admin, { provider: "google", sharedAllowed: true })).sharedAllowed).toBe(true);
    expect(captured[1]!.body).toEqual({ ...admin, provider: "google", sharedAllowed: true });
  });
});
