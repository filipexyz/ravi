import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import postgres from "postgres";

import { createGoogleAdapter, type GoogleCapabilityHandler } from "./adapters/google";
import type { ConnectorAdapter } from "./adapters/adapter";
import { buildGoogleCalendarHandlers } from "./capabilities/google/calendar";
import { shredAfterGivingUp } from "./connection-lifecycle";
import { importRootWrapKey } from "./crypto";
import { findProviderConnectionById, openConnectorsDb, type ConnectorsDb } from "./db";
import type { ConnectorsWorkerEnv, HyperdriveBinding } from "./env";
import { signHmacRequest } from "./hmac";
import { createConnectorsWorker } from "./router";
import { runScheduledMaintenance } from "./scheduled";
import { storeConnectionTokens } from "./vault";

// Exec policy, approvals, usage, tool settings, organization admin and the
// revocation outbox against a migrated Console database, with a fake
// Google. Runs only with CONNECTORS_TEST_DATABASE_URL; creates and deletes
// its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const DB_TEST_TIMEOUT_MS = 60_000;

type J = any;

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const HMAC_KEY = "exec-policy-test-hmac-key";
const HMAC_KEY_ID = "k_exec_policy";
const CLI_SECRET = "exec-policy-test-cli-secret-0123456789";
const CONSOLE = "https://console.test";
const LINK = "https://link.test";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const owner = { id: randomUUID(), email: `ep-${suffix}-owner@example.test` };
const member = { id: randomUUID(), email: `ep-${suffix}-member@example.test` };
const admin = { id: randomUUID(), email: `ep-${suffix}-admin@example.test` };
const installation = randomUUID();
const session = { id: randomUUID(), jti: randomUUID() };
const memberInstallation = randomUUID();
const memberSession = { id: randomUUID(), jti: randomUUID() };
const ownerActor = { userId: owner.id, organizationId: orgId };
const memberActor = { userId: member.id, organizationId: orgId };
const adminActor = { userId: admin.id, organizationId: orgId, role: "admin" };

const env = {
  RAVI_CONSOLE_DB: { connectionString: url ?? "" } as HyperdriveBinding,
  RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64: ROOT_KEY,
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT: HMAC_KEY,
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID: HMAC_KEY_ID,
  RAVI_CONNECTORS_CLI_ACCESS_TOKEN_SECRET: CLI_SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  WORKOS_API_KEY: "workos",
  RAVI_CONSOLE_BASE_URL: CONSOLE,
  RAVI_CONNECTORS_BASE_URL: LINK,
  RAVI_CONNECTORS_KEY_VERSION: "1",
  RAVI_CONNECTORS_PENDING_GRANT_TTL_SECONDS: "600",
  RAVI_CONNECTORS_STEPUP_TTL_SECONDS: "300",
  RAVI_CONNECTORS_REAUTH_AFTER_DAYS: "90",
  RAVI_CONNECTORS_SUSPEND_AFTER_DAYS: "120",
} as unknown as ConnectorsWorkerEnv;

// ---------------------------------------------------------------------------
// Fake Google
// ---------------------------------------------------------------------------

const fakeGoogle = {
  sent: [] as { accessToken: string; subject: string }[],
  reads: 0,
  revoked: [] as string[],
  revokeFails: false,
  refreshFails: false,
  freeBusyBodies: [] as J[],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (target === GOOGLE_TOKEN_URL) {
    if (fakeGoogle.refreshFails) return json({ error: "invalid_grant" }, 400);
    return json({ access_token: `at-refreshed-${randomUUID()}`, expires_in: 3600 });
  }
  if (target === GOOGLE_REVOKE_URL) {
    if (fakeGoogle.revokeFails) return json({ error: "backend" }, 503);
    fakeGoogle.revoked.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
    return json({});
  }
  if (target === FREEBUSY_URL && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as J;
    fakeGoogle.freeBusyBodies.push(body);
    return json({
      kind: "calendar#freeBusy",
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars: {
        primary: {
          busy: [
            { start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" },
            { start: "2026-10-12T16:30:00Z", end: "2026-10-12T17:00:00Z" },
          ],
        },
        "team@example.test": { busy: [], errors: [{ domain: "calendar", reason: "notFound" }] },
      },
    });
  }
  throw new Error(`unexpected fetch ${target}`);
}) as typeof fetch;

const handlers = new Map<string, GoogleCapabilityHandler>([
  [
    "gmail.message.list",
    {
      async execute() {
        fakeGoogle.reads += 1;
        return { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 };
      },
    },
  ],
  [
    "gmail.message.read",
    {
      async execute(input) {
        fakeGoogle.reads += 1;
        return { id: (input.parameters as { id: string }).id, threadId: "t1", headers: {}, body: { text: "secret" } };
      },
    },
  ],
  [
    "gmail.message.send",
    {
      async execute(input) {
        fakeGoogle.sent.push({ accessToken: input.accessToken, subject: (input.parameters as { subject: string }).subject });
        return { messageId: `sent-${fakeGoogle.sent.length}`, threadId: "t-sent" };
      },
    },
  ],
  ["gcal.freebusy.query", buildGoogleCalendarHandlers(fakeFetch).get("gcal.freebusy.query")!],
]);

const adapters = new Map<string, ConnectorAdapter>([
  [
    "google",
    createGoogleAdapter({
      config: { clientId: "client", clientSecret: "secret", fetchImpl: fakeFetch },
      capabilities: handlers,
    }),
  ],
]);

const worker = createConnectorsWorker({ adapters: () => adapters, sleep: async () => {} });

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const requestIds: string[] = [];

async function call(request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
  });
  await Promise.all(pending);
  const requestId = response.headers.get("x-ravi-request-id");
  if (requestId) requestIds.push(requestId);
  return response;
}

async function ui(path: string, body: Record<string, unknown>): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const headers = await signHmacRequest({ method: "POST", path, bodyText, key: HMAC_KEY, keyId: HMAC_KEY_ID });
  return call(
    new Request(`${LINK}${path}`, {
      method: "POST",
      body: bodyText,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

async function uiJson(path: string, body: Record<string, unknown>): Promise<J> {
  return (await ui(path, body)).json();
}

async function bearerFor(
  cliSession: { id: string; jti: string },
  installationId: string,
  userId: string,
): Promise<string> {
  return new SignJWT({ sid: cliSession.id, li: installationId, org: orgId, scopes: [] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("ravi-console")
    .setAudience("ravi-cli")
    .setSubject(userId)
    .setJti(cliSession.jti)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(CLI_SECRET));
}

interface ExecContext {
  v?: unknown;
  agentId?: string;
  sessionName?: string;
  routine?: { kind: string; id?: string };
  speaker?: { kind: string; contactId?: string; consoleUserId?: string };
  conversation?: string;
  turnKey?: string;
  [key: string]: unknown;
}

function encodeContext(context: ExecContext): string {
  return Buffer.from(
    JSON.stringify({ v: 1, speaker: { kind: "terminal" }, conversation: "terminal", ...context }),
    "utf8",
  ).toString("base64url");
}

async function exec(
  connectionId: string,
  capability: string,
  parameters: unknown,
  options: { context?: ExecContext | null; rawContext?: string; approval?: string; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.bearer ?? bearer}`,
    "content-type": "application/json",
  };
  if (options.rawContext !== undefined) headers["x-ravi-exec-context"] = options.rawContext;
  else if (options.context !== null) headers["x-ravi-exec-context"] = encodeContext(options.context ?? {});
  if (options.approval) headers["x-ravi-approval"] = options.approval;
  return call(
    new Request(`${LINK}/cli/exec/${connectionId}`, {
      method: "POST",
      body: JSON.stringify({ capability, parameters }),
      headers,
    }),
  );
}

async function cliGet(path: string, token: string = bearer): Promise<Response> {
  return call(new Request(`${LINK}${path}`, { headers: { authorization: `Bearer ${token}` } }));
}

const sendParams = (subject = "Hello") => ({
  to: ["friend@example.test"],
  cc: ["boss@example.test"],
  subject,
  body: `Hi there. ${"x".repeat(5000)}`,
});

function turnKey(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sql: postgres.Sql;
let vaultDb: ConnectorsDb;
let rootWrapKey: CryptoKey;
let bearer: string;
let memberBearer: string;

async function insertConnection(input: {
  userId?: string | null;
  scopeKind?: "user" | "organization";
  status?: string;
  sub?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
} = {}): Promise<string> {
  const userId = input.userId === undefined ? owner.id : input.userId;
  const sub = input.sub ?? `sub-${randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`
    insert into provider_connections (
      organization_id, user_id, managed_by_user_id, provider, scope_kind,
      external_account_id, external_account_login, display_name, status, scopes_json, metadata_json
    ) values (
      ${orgId},
      ${input.scopeKind === "organization" ? null : userId},
      ${input.scopeKind === "organization" ? userId : null},
      'google',
      ${input.scopeKind ?? "user"},
      ${input.scopeKind === "organization" ? null : sub},
      ${`${sub}@gmail.test`},
      'google',
      ${input.status ?? "active"},
      ${sql.json(input.scopes ?? SCOPES)},
      ${sql.json({ googleSub: sub, ...(input.metadata ?? {}) } as never)}
    )
    returning id
  `;
  await storeConnectionTokens(vaultDb, {
    rootWrapKey,
    dekKeyVersion: 1,
    connection: { id: row!.id, organizationId: orgId, userId: input.scopeKind === "organization" ? null : userId },
    tokens: { accessToken: `at-${row!.id}`, refreshToken: `rt-${row!.id}`, expiresInSeconds: 3600, scopes: [] },
    existing: [],
  });
  return row!.id;
}

/** The JSON body with `status` set to the HTTP status (a body detail named `status` is dropped). */
async function errorOf(response: Response): Promise<J> {
  return { ...((await response.json()) as J), status: response.status };
}

async function deniedAudits(connectionId: string): Promise<J[]> {
  return [
    ...(await sql`
      select metadata_json from audit_events
      where target_id = ${connectionId} and action = 'connector.action.denied'
      order by created_at asc
    `),
  ].map((row) => row.metadata_json);
}

async function approvalRow(id: string): Promise<J> {
  const [row] = await sql`select * from connector_action_approvals where id = ${id}`;
  return row;
}

async function resetOrgPolicy(): Promise<void> {
  await sql`delete from connector_org_policies where organization_id = ${orgId}`;
}

describeDb("connectors Worker: exec policy, approvals, usage and admin (DB)", () => {
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, fetch_types: false, onnotice: () => {} });
    vaultDb = openConnectorsDb({ connectionString: url! } as HyperdriveBinding);
    rootWrapKey = await importRootWrapKey(ROOT_KEY);

    await sql`insert into organizations (id, slug, name) values (${orgId}, ${`ep-${suffix}`}, 'Exec policy test')`;
    await sql`
      insert into users (id, primary_email, display_name) values
        (${owner.id}, ${owner.email}, 'Ana Owner'),
        (${member.id}, ${member.email}, 'Bo Member'),
        (${admin.id}, ${admin.email}, 'Cy Admin')
    `;
    await sql`
      insert into organization_memberships (organization_id, user_id, role) values
        (${orgId}, ${owner.id}, 'developer'),
        (${orgId}, ${member.id}, 'developer'),
        (${orgId}, ${admin.id}, 'admin')
    `;
    await sql`
      insert into local_installations (id, organization_id, user_id, name, status) values
        (${installation}, ${orgId}, ${owner.id}, 'ana-laptop', 'active'),
        (${memberInstallation}, ${orgId}, ${member.id}, 'bo-laptop', 'active')
    `;
    await sql`
      insert into cli_sessions (
        id, local_installation_id, organization_id, user_id,
        refresh_token_hash, access_token_jti, expires_at
      ) values
        (${session.id}, ${installation}, ${orgId}, ${owner.id}, ${`rh-${randomUUID()}`}, ${session.jti}, now() + interval '1 day'),
        (${memberSession.id}, ${memberInstallation}, ${orgId}, ${member.id}, ${`rh-${randomUUID()}`}, ${memberSession.jti}, now() + interval '1 day')
    `;
    bearer = await bearerFor(session, installation, owner.id);
    memberBearer = await bearerFor(memberSession, memberInstallation, member.id);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!sql) return;
    if (requestIds.length > 0) {
      await sql`delete from audit_events where request_id in ${sql(requestIds)}`;
    }
    const userIds = [owner.id, member.id, admin.id];
    await sql`delete from audit_events where organization_id = ${orgId} or actor_id in ${sql(userIds)}`;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id in ${sql(userIds)}`;
    await vaultDb.close();
    await sql.end({ timeout: 5 });
  }, DB_TEST_TIMEOUT_MS);

  test("terminal, owner DM and the owner's routines read; reads stay always allowed", async () => {
    const id = await insertConnection();
    expect((await exec(id, "gmail.message.list", {})).status).toBe(200);
    expect((await exec(id, "gmail.message.list", {}, { context: null })).status).toBe(200);
    const ownerDm = { agentId: "main", speaker: { kind: "owner" }, conversation: "dm" };
    expect((await exec(id, "gmail.message.list", {}, { context: ownerDm })).status).toBe(200);
    const linkedContact = { speaker: { kind: "contact", contactId: "c_ana", consoleUserId: owner.id }, conversation: "dm" };
    expect((await exec(id, "gmail.message.list", {}, { context: linkedContact })).status).toBe(200);
    for (const kind of ["cron", "heartbeat"]) {
      const routine = { speaker: { kind: "automation" }, conversation: "automation", routine: { kind, id: "job1" } };
      expect((await exec(id, "gmail.message.list", {}, { context: routine })).status).toBe(200);
    }
  }, DB_TEST_TIMEOUT_MS);

  test("a malformed, oversized or unknown exec context fails closed", async () => {
    const id = await insertConnection();
    const reads = fakeGoogle.reads;
    for (const rawContext of [
      "not base64!",
      Buffer.from("{nope").toString("base64url"),
      encodeContext({ v: 2 }),
      encodeContext({ unknownField: true }),
      encodeContext({ sessionName: "s".repeat(1700) }),
    ]) {
      const response = await exec(id, "gmail.message.list", {}, { rawContext });
      expect(await errorOf(response)).toMatchObject({ status: 400, error: "connector_exec_context_invalid" });
    }
    expect(fakeGoogle.reads).toBe(reads);
  }, DB_TEST_TIMEOUT_MS);

  test("groups, other agents, other automations and other people are refused and audited", async () => {
    const id = await insertConnection();
    const reads = fakeGoogle.reads;
    const cases: [ExecContext, string][] = [
      [{ speaker: { kind: "owner" }, conversation: "group" }, "connector_group_blocked"],
      [{ speaker: { kind: "agent" }, conversation: "dm" }, "connector_speaker_not_owner"],
      [{ speaker: { kind: "automation" }, conversation: "automation", routine: { kind: "trigger", id: "t1" } }, "connector_speaker_not_owner"],
      [{ speaker: { kind: "contact", contactId: "c_bo", consoleUserId: member.id }, conversation: "dm" }, "connector_speaker_not_owner"],
      [{ speaker: { kind: "contact", contactId: "c_x" }, conversation: "dm" }, "connector_speaker_not_owner"],
      // A context that contradicts itself fails closed.
      [{ speaker: { kind: "owner", consoleUserId: member.id }, conversation: "dm" }, "connector_speaker_not_owner"],
      [{ speaker: { kind: "terminal" }, conversation: "terminal", routine: { kind: "trigger", id: "t2" } }, "connector_speaker_not_owner"],
    ];
    for (const [context, code] of cases) {
      const response = await exec(id, "gmail.message.list", {}, { context: { agentId: "main", ...context } });
      expect(await errorOf(response)).toMatchObject({ status: 403, error: code });
    }
    expect(fakeGoogle.reads).toBe(reads);
    const audits = await deniedAudits(id);
    expect(audits.map((entry) => entry.code)).toEqual(cases.map(([, code]) => code));
    expect(audits[0]).toMatchObject({
      capability: "gmail.message.list",
      agentId: "main",
      conversation: "group",
      speakerKind: "owner",
      installationId: installation,
    });
  }, DB_TEST_TIMEOUT_MS);

  test("someone else's connection, an organization connection and a revoked installation are refused", async () => {
    const id = await insertConnection();
    expect(await errorOf(await exec(id, "gmail.message.list", {}, { bearer: memberBearer }))).toMatchObject({
      status: 503,
      error: "connector_unavailable",
    });
    const orgRow = await insertConnection({ scopeKind: "organization" });
    expect(await errorOf(await exec(orgRow, "gmail.message.list", {}))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
    });

    const laptop = randomUUID();
    const laptopSession = { id: randomUUID(), jti: randomUUID() };
    await sql`
      insert into local_installations (id, organization_id, user_id, name, status)
      values (${laptop}, ${orgId}, ${owner.id}, 'spare-laptop', 'active')
    `;
    await sql`
      insert into cli_sessions (id, local_installation_id, organization_id, user_id, refresh_token_hash, access_token_jti, expires_at)
      values (${laptopSession.id}, ${laptop}, ${orgId}, ${owner.id}, ${`rh-${randomUUID()}`}, ${laptopSession.jti}, now() + interval '1 day')
    `;
    const laptopBearer = await bearerFor(laptopSession, laptop, owner.id);
    expect((await exec(id, "gmail.message.list", {}, { bearer: laptopBearer })).status).toBe(200);
    await sql`update local_installations set status = 'revoked', revoked_at = now() where id = ${laptop}`;
    expect(await errorOf(await exec(id, "gmail.message.list", {}, { bearer: laptopBearer }))).toMatchObject({
      status: 401,
      error: "connector_unauthorized",
    });
  }, DB_TEST_TIMEOUT_MS);

  test("an organization that disabled Google refuses exec", async () => {
    const id = await insertConnection();
    try {
      const set = await ui("/ui/admin/policy/set", { ...adminActor, provider: "google", enabled: false });
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({ provider: "google", enabled: false, writesAllowed: true });
      expect(await errorOf(await exec(id, "gmail.message.list", {}))).toMatchObject({
        status: 403,
        error: "connector_disabled_by_org",
      });
    } finally {
      await resetOrgPolicy();
    }
    expect((await exec(id, "gmail.message.list", {})).status).toBe(200);
  }, DB_TEST_TIMEOUT_MS);

  test("tools blocked by the owner, by an organization ceiling, or with writes not allowed", async () => {
    const id = await insertConnection();
    const setTool = (capability: string, policy: string) =>
      ui(`/ui/connect/tools/${id}`, { ...ownerActor, capability, policy });

    expect((await setTool("gmail.message.list", "blocked")).status).toBe(200);
    expect(await errorOf(await exec(id, "gmail.message.list", {}))).toMatchObject({
      status: 403,
      error: "connector_tool_blocked",
    });
    expect((await setTool("gmail.message.list", "always_allow")).status).toBe(200);
    expect((await exec(id, "gmail.message.list", {})).status).toBe(200);

    expect(await errorOf(await setTool("gmail.message.list", "sometimes"))).toMatchObject({ status: 400 });
    expect(await errorOf(await setTool("gcal.unknown", "blocked"))).toMatchObject({ status: 400 });
    expect((await ui(`/ui/connect/tools/${id}`, { ...memberActor, capability: "gmail.message.list", policy: "blocked" })).status).toBe(404);

    try {
      const set = await uiJson("/ui/admin/policy/set", {
        ...adminActor,
        provider: "google",
        toolCeilings: { "gmail.message.read": "blocked", "gmail.message.send": "needs_approval" },
      });
      expect(set.toolCeilings).toEqual({ "gmail.message.read": "blocked", "gmail.message.send": "needs_approval" });
      expect(await errorOf(await exec(id, "gmail.message.read", { id: "m1" }))).toMatchObject({
        status: 403,
        error: "connector_tool_blocked",
      });
      expect(await errorOf(await setTool("gmail.message.read", "always_allow"))).toMatchObject({
        status: 409,
        error: "connector_policy_above_ceiling",
        ceiling: "blocked",
      });
      expect((await setTool("gmail.message.read", "blocked")).status).toBe(200);
      expect(await errorOf(await setTool("gmail.message.send", "always_allow"))).toMatchObject({
        status: 409,
        error: "connector_policy_above_ceiling",
        ceiling: "needs_approval",
      });

      await ui("/ui/admin/policy/set", { ...adminActor, provider: "google", toolCeilings: {}, writesAllowed: false });
      expect(await errorOf(await setTool("gmail.message.send", "needs_approval"))).toMatchObject({
        status: 409,
        error: "connector_policy_above_ceiling",
      });
      expect(await errorOf(await exec(id, "gmail.message.send", sendParams()))).toMatchObject({
        status: 403,
        error: "connector_tool_blocked",
      });

      const detail = await uiJson(`/ui/connect/detail/${id}`, ownerActor);
      const send = detail.tools.find((tool: J) => tool.capability === "gmail.message.send");
      expect(send).toMatchObject({ label: "Send email", class: "destructive", policy: "blocked", ceiling: "blocked", userPolicy: null });
    } finally {
      await resetOrgPolicy();
    }
    const detail = await uiJson(`/ui/connect/detail/${id}`, ownerActor);
    expect(detail.tools.find((tool: J) => tool.capability === "gmail.message.read")).toMatchObject({
      policy: "blocked",
      userPolicy: "blocked",
      ceiling: null,
    });
  }, DB_TEST_TIMEOUT_MS);

  test("a write needs approval: 409, approve in the Console, the retry runs once", async () => {
    const id = await insertConnection();
    const params = sendParams("Quarterly numbers");
    const context = { agentId: "main", sessionName: "main-dm", speaker: { kind: "owner" }, conversation: "dm" };

    const first = await errorOf(await exec(id, "gmail.message.send", params, { context }));
    expect(first).toMatchObject({ status: 409, error: "connector_approval_required", reason: "policy" });
    const approvalId = first.approvalId as string;
    expect(first.approvalUrl).toBe(`${CONSOLE}/connectors/approvals/${approvalId}`);
    expect(new Date(first.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);

    // A retry without the approval asks for the same one.
    const again = await errorOf(await exec(id, "gmail.message.send", params, { context }));
    expect(again.approvalId).toBe(approvalId);

    const stored = await approvalRow(approvalId);
    expect(stored).toMatchObject({
      status: "pending",
      owner_user_id: owner.id,
      requested_by_user_id: owner.id,
      local_installation_id: installation,
      cli_session_id: session.id,
      capability: "gmail.message.send",
      capability_class: "destructive",
      reason: "policy",
    });
    expect(stored.params_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.preview_encrypted.split(".")).toHaveLength(4);
    expect(stored.preview_encrypted).not.toContain("Quarterly");
    expect(stored.exec_context_json).toEqual({ v: 1, agentId: "main", sessionName: "main-dm", speaker: { kind: "owner" }, conversation: "dm" });

    const pending = await errorOf(await exec(id, "gmail.message.send", params, { context, approval: approvalId }));
    expect(pending).toMatchObject({ status: 409, error: "connector_approval_pending", approvalId });
    expect(await (await cliGet(`/cli/approvals/${approvalId}`)).json()).toMatchObject({
      status: "pending",
      capability: "gmail.message.send",
    });
    expect((await cliGet(`/cli/approvals/${approvalId}`, memberBearer)).status).toBe(404);

    const waiting = await uiJson("/ui/approvals/list", ownerActor);
    expect(waiting.approvals.find((entry: J) => entry.id === approvalId)).toMatchObject({
      connectionId: id,
      capability: "gmail.message.send",
      label: "Send email",
      reason: "policy",
      installationName: "ana-laptop",
      agentId: "main",
      conversation: "dm",
    });
    expect((await uiJson("/ui/approvals/list", memberActor)).approvals).toEqual([]);
    expect((await ui(`/ui/approvals/get/${approvalId}`, memberActor)).status).toBe(404);
    expect((await ui(`/ui/approvals/decide/${approvalId}`, { ...memberActor, decision: "approve" })).status).toBe(404);

    const detail = await uiJson(`/ui/approvals/get/${approvalId}`, ownerActor);
    expect(detail).toMatchObject({
      id: approvalId,
      status: "pending",
      sessionName: "main-dm",
      speakerKind: "owner",
      routine: null,
      preview: {
        to: ["friend@example.test"],
        cc: ["boss@example.test"],
        bcc: [],
        subject: "Quarterly numbers",
        bodyTruncated: true,
      },
    });
    expect(detail.preview.body).toHaveLength(4000);

    const decided = await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" });
    expect(decided).toEqual({ status: "approved" });
    expect(await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" })).toEqual({
      status: "approved",
    });
    expect(await errorOf(await ui(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "deny" }))).toMatchObject({
      status: 400,
      error: "connector_approval_invalid",
    });
    const approved = await approvalRow(approvalId);
    expect(approved.decided_by_user_id).toBe(owner.id);
    expect(new Date(approved.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
    expect(await (await cliGet(`/cli/approvals/${approvalId}`)).json()).toMatchObject({ status: "approved" });

    const sentBefore = fakeGoogle.sent.length;
    const ran = await exec(id, "gmail.message.send", params, { context, approval: approvalId });
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({ capability: "gmail.message.send", result: { messageId: expect.any(String) } });
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
    expect((await approvalRow(approvalId)).status).toBe("consumed");

    const replay = await errorOf(await exec(id, "gmail.message.send", params, { context, approval: approvalId }));
    expect(replay).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);

    const [executed] = await sql`
      select metadata_json from audit_events
      where target_id = ${id} and action = 'connector.action.executed'
    `;
    expect(executed!.metadata_json).toMatchObject({
      capability: "gmail.message.send",
      approvalId,
      agentId: "main",
      conversation: "dm",
      speakerKind: "owner",
      installationId: installation,
    });
    expect(JSON.stringify(executed!.metadata_json)).not.toContain("Quarterly");
    const lifecycle = await sql`
      select action from audit_events
      where target_type = 'provider_connection' and target_id = ${id}
        and metadata_json->>'approvalId' = ${approvalId}
        and action like 'connector.approval.%'
      order by created_at asc
    `;
    expect(lifecycle.map((row) => row.action)).toEqual([
      "connector.approval.created",
      "connector.approval.approved",
      "connector.approval.consumed",
    ]);

    // Recent activity: asked, approved, ran; the replay is the only refusal.
    // Waiting for the owner (409s) is never shown as refused.
    const activity = (await uiJson(`/ui/connect/detail/${id}`, ownerActor)).activity as J[];
    expect(activity.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["connector.action.denied", "denied"],
      ["connector.action.executed", "ok"],
      ["connector.approval.approved", "ok"],
      ["connector.approval.created", "ok"],
    ]);
    expect(activity[3]).toMatchObject({ capability: "gmail.message.send", agentId: "main", conversation: "dm" });
    expect((await deniedAudits(id)).map((entry) => entry.code)).toEqual(["connector_approval_invalid"]);
  }, DB_TEST_TIMEOUT_MS);

  test("an older CLI's write that needs approval is refused before any approval or preview exists", async () => {
    const id = await insertConnection();
    const sentBefore = fakeGoogle.sent.length;
    // No exec context: a CLI from before approvals, which can neither wait
    // for one nor send it back.
    const refused = await errorOf(await exec(id, "gmail.message.send", sendParams("Legacy"), { context: null }));
    expect(refused).toMatchObject({ status: 403, error: "connector_permission_required", reason: "cli_upgrade_required" });
    expect(refused.approvalId).toBeUndefined();
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from connector_action_approvals where provider_connection_id = ${id}
    `;
    expect(counted!.count).toBe(0);
    expect((await uiJson("/ui/approvals/list", ownerActor)).approvals.map((entry: J) => entry.connectionId)).not.toContain(id);
    expect(fakeGoogle.sent.length).toBe(sentBefore);
    expect(await deniedAudits(id)).toEqual([
      expect.objectContaining({ code: "connector_permission_required", reason: "cli_upgrade_required", legacyCli: true }),
    ]);
    // Reads need no approval and still run for it.
    expect((await exec(id, "gmail.message.list", {}, { context: null })).status).toBe(200);
  }, DB_TEST_TIMEOUT_MS);

  test("an approval covers only the parameters approved", async () => {
    const id = await insertConnection();
    const params = sendParams("Original");
    const { approvalId } = await errorOf(await exec(id, "gmail.message.send", params));
    await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" });

    const sentBefore = fakeGoogle.sent.length;
    const changed = await errorOf(await exec(id, "gmail.message.send", sendParams("Changed"), { approval: approvalId }));
    expect(changed).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    const otherConnection = await insertConnection();
    expect(
      await errorOf(await exec(otherConnection, "gmail.message.send", params, { approval: approvalId })),
    ).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    expect(
      await errorOf(await exec(id, "gmail.message.send", params, { approval: "not-an-id" })),
    ).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    expect(fakeGoogle.sent.length).toBe(sentBefore);
    expect((await approvalRow(approvalId)).status).toBe("approved");

    // Key order does not change the action.
    const reordered = { body: params.body, subject: params.subject, cc: params.cc, to: params.to };
    expect((await exec(id, "gmail.message.send", reordered, { approval: approvalId })).status).toBe(200);
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
  }, DB_TEST_TIMEOUT_MS);

  test("a denied approval is refused; an expired one is invalid and expires on schedule", async () => {
    const id = await insertConnection();
    const denied = await errorOf(await exec(id, "gmail.message.send", sendParams("Deny me")));
    expect(await uiJson(`/ui/approvals/decide/${denied.approvalId}`, { ...ownerActor, decision: "deny" })).toEqual({
      status: "denied",
    });
    expect(
      await errorOf(await exec(id, "gmail.message.send", sendParams("Deny me"), { approval: denied.approvalId })),
    ).toMatchObject({ status: 403, error: "connector_approval_denied" });

    const late = await errorOf(await exec(id, "gmail.message.send", sendParams("Too late")));
    await uiJson(`/ui/approvals/decide/${late.approvalId}`, { ...ownerActor, decision: "approve" });
    await sql`update connector_action_approvals set expires_at = now() - interval '1 second' where id = ${late.approvalId}`;
    expect(
      await errorOf(await exec(id, "gmail.message.send", sendParams("Too late"), { approval: late.approvalId })),
    ).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    expect(await (await cliGet(`/cli/approvals/${late.approvalId}`)).json()).toMatchObject({ status: "expired" });

    const stale = await errorOf(await exec(id, "gmail.message.send", sendParams("Never decided")));
    await sql`update connector_action_approvals set expires_at = now() - interval '1 second' where id = ${stale.approvalId}`;
    expect(await errorOf(await ui(`/ui/approvals/decide/${stale.approvalId}`, { ...ownerActor, decision: "approve" }))).toMatchObject({
      status: 400,
      error: "connector_approval_invalid",
    });
    expect((await uiJson("/ui/approvals/list", ownerActor)).approvals.map((entry: J) => entry.id)).not.toContain(
      stale.approvalId,
    );

    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    expect(report.expired.approvals).toBeGreaterThanOrEqual(2);
    expect((await approvalRow(late.approvalId)).status).toBe("expired");
    expect((await approvalRow(stale.approvalId)).status).toBe("expired");
    expect((await approvalRow(denied.approvalId)).status).toBe("denied");
  }, DB_TEST_TIMEOUT_MS);

  test("an approval is used once, even by concurrent retries, and only for its own capability", async () => {
    const id = await insertConnection();
    const params = sendParams("Once only");
    const { approvalId } = await errorOf(await exec(id, "gmail.message.send", params));
    await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" });

    // Another capability of the same connection, needing approval too.
    expect((await ui(`/ui/connect/tools/${id}`, { ...ownerActor, capability: "gmail.message.list", policy: "needs_approval" })).status).toBe(200);
    expect(await errorOf(await exec(id, "gmail.message.list", {}, { approval: approvalId }))).toMatchObject({
      status: 400,
      error: "connector_approval_invalid",
    });
    expect((await approvalRow(approvalId)).status).toBe("approved");

    const sentBefore = fakeGoogle.sent.length;
    const [a, b] = await Promise.all([
      exec(id, "gmail.message.send", params, { approval: approvalId }),
      exec(id, "gmail.message.send", params, { approval: approvalId }),
    ]);
    const outcomes = [await errorOf(a), await errorOf(b)].map((body) => [body.status, body.error ?? null]).sort();
    expect(outcomes).toEqual([
      [200, null],
      [400, "connector_approval_invalid"],
    ]);
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
    expect((await approvalRow(approvalId)).status).toBe("consumed");
  }, DB_TEST_TIMEOUT_MS);

  test("an approval header on an always-allowed tool is ignored and the approval kept", async () => {
    const id = await insertConnection();
    const params = sendParams("Kept");
    const { approvalId } = await errorOf(await exec(id, "gmail.message.send", params));
    await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" });
    expect((await ui(`/ui/connect/tools/${id}`, { ...ownerActor, capability: "gmail.message.send", policy: "always_allow" })).status).toBe(200);
    const sentBefore = fakeGoogle.sent.length;
    expect((await exec(id, "gmail.message.send", params, { approval: approvalId })).status).toBe(200);
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
    expect((await approvalRow(approvalId)).status).toBe("approved");
  }, DB_TEST_TIMEOUT_MS);

  test("an approval survives a refusal before Google is called", async () => {
    const id = await insertConnection();
    const params = sendParams("Survives");
    const { approvalId } = await errorOf(await exec(id, "gmail.message.send", params));
    await uiJson(`/ui/approvals/decide/${approvalId}`, { ...ownerActor, decision: "approve" });
    const sentBefore = fakeGoogle.sent.length;

    // No access token stored.
    await sql`delete from connector_credentials where provider_connection_id = ${id} and payload_kind = 'access_token'`;
    expect(await errorOf(await exec(id, "gmail.message.send", params, { approval: approvalId }))).toMatchObject({
      status: 503,
      error: "connector_reauth_required",
    });
    expect((await approvalRow(approvalId)).status).toBe("approved");

    // Google refuses the refresh token: the row needs reconnecting.
    await sql`delete from connector_credentials where provider_connection_id = ${id}`;
    await storeConnectionTokens(vaultDb, {
      rootWrapKey,
      dekKeyVersion: 1,
      connection: { id, organizationId: orgId, userId: owner.id },
      tokens: { accessToken: `at-${id}`, refreshToken: `rt-${id}`, expiresInSeconds: 1, scopes: [] },
      existing: [],
    });
    fakeGoogle.refreshFails = true;
    try {
      expect(await errorOf(await exec(id, "gmail.message.send", params, { approval: approvalId }))).toMatchObject({
        status: 503,
        error: "connector_reauth_required",
      });
    } finally {
      fakeGoogle.refreshFails = false;
    }
    expect((await sql`select requires_reauth from provider_connections where id = ${id}`)[0]!.requires_reauth).toBe(true);
    expect((await approvalRow(approvalId)).status).toBe("approved");
    expect(fakeGoogle.sent.length).toBe(sentBefore);

    // While it needs reconnecting nothing runs, and nothing new is asked.
    const approvalsBefore = (await sql`select count(*)::int as count from connector_action_approvals where provider_connection_id = ${id}`)[0]!.count;
    expect(await errorOf(await exec(id, "gmail.message.send", sendParams("Another")))).toMatchObject({
      status: 503,
      error: "connector_reauth_required",
    });
    expect((await sql`select count(*)::int as count from connector_action_approvals where provider_connection_id = ${id}`)[0]!.count).toBe(approvalsBefore);
    expect((await deniedAudits(id)).at(-1)).toMatchObject({ code: "connector_reauth_required", reason: "connector_requires_reauth" });

    // Reconnected: the same approval runs the send, once.
    await sql`update provider_connections set requires_reauth = false, last_reauth_at = now() where id = ${id}`;
    await sql`update connector_credentials set expires_at = now() + interval '1 hour' where provider_connection_id = ${id} and payload_kind = 'access_token'`;
    expect((await exec(id, "gmail.message.send", params, { approval: approvalId })).status).toBe(200);
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
    expect((await approvalRow(approvalId)).status).toBe("consumed");
  }, DB_TEST_TIMEOUT_MS);

  test("an approval whose preview cannot be read can only be denied", async () => {
    const id = await insertConnection();
    const unreadable = await errorOf(await exec(id, "gmail.message.send", sendParams("Unreadable")));
    await sql`update connector_action_approvals set preview_encrypted = 'not.a.real.bundle' where id = ${unreadable.approvalId}`;
    expect((await uiJson(`/ui/approvals/get/${unreadable.approvalId}`, ownerActor)).preview).toBeNull();
    expect(
      await errorOf(await ui(`/ui/approvals/decide/${unreadable.approvalId}`, { ...ownerActor, decision: "approve" })),
    ).toMatchObject({ status: 400, error: "connector_approval_invalid" });
    expect((await approvalRow(unreadable.approvalId)).status).toBe("pending");
    expect(await uiJson(`/ui/approvals/decide/${unreadable.approvalId}`, { ...ownerActor, decision: "deny" })).toEqual({
      status: "denied",
    });

    const missing = await errorOf(await exec(id, "gmail.message.send", sendParams("Missing")));
    await sql`update connector_action_approvals set preview_encrypted = null where id = ${missing.approvalId}`;
    expect(
      await errorOf(await ui(`/ui/approvals/decide/${missing.approvalId}`, { ...ownerActor, decision: "approve" })),
    ).toMatchObject({ status: 400, error: "connector_approval_invalid" });
  }, DB_TEST_TIMEOUT_MS);

  test("someone else's attempt never reaches the owner's activity nor tells their connection's state", async () => {
    const id = await insertConnection();
    const spoofed = { agentId: "Ravi security: reconnect at https://evil.example", speaker: { kind: "owner" }, conversation: "dm" };
    expect(await errorOf(await exec(id, "gmail.message.list", {}, { bearer: memberBearer, context: spoofed }))).toMatchObject({
      status: 503,
      error: "connector_unavailable",
    });
    const unknown = await errorOf(await exec(randomUUID(), "gmail.message.list", {}, { bearer: memberBearer }));
    await sql`update provider_connections set requires_reauth = true where id = ${id}`;
    const needsReauth = await errorOf(await exec(id, "gmail.message.list", {}, { bearer: memberBearer }));
    await sql`update provider_connections set requires_reauth = false, status = 'suspended' where id = ${id}`;
    const suspended = await errorOf(await exec(id, "gmail.message.list", {}, { bearer: memberBearer }));
    for (const answer of [needsReauth, suspended]) {
      expect({ status: answer.status, error: answer.error }).toEqual({ status: unknown.status, error: unknown.error });
    }

    const detail = await uiJson(`/ui/connect/detail/${id}`, ownerActor);
    expect(detail.activity).toEqual([]);
    expect(await deniedAudits(id)).toEqual([]);
    const [onMember] = await sql`
      select target_type, target_id, metadata_json from audit_events
      where actor_id = ${member.id} and action = 'connector.action.denied'
        and metadata_json->>'providerConnectionId' = ${id}
      order by created_at asc limit 1
    `;
    expect(onMember).toMatchObject({
      target_type: "user",
      target_id: member.id,
      metadata_json: { reason: "actor_user_mismatch", code: "connector_unavailable" },
    });

    // The owner's own refusal on the same row is theirs to see.
    expect(await errorOf(await exec(id, "gmail.message.list", {}))).toMatchObject({ status: 503, error: "connector_unavailable" });
    expect((await uiJson(`/ui/connect/detail/${id}`, ownerActor)).activity.map((entry: J) => entry.outcome)).toEqual(["denied"]);
  }, DB_TEST_TIMEOUT_MS);

  test("a write after a read in the same turn needs approval even when always allowed", async () => {
    const id = await insertConnection();
    expect((await ui(`/ui/connect/tools/${id}`, { ...ownerActor, capability: "gmail.message.send", policy: "always_allow" })).status).toBe(200);
    const sentBefore = fakeGoogle.sent.length;
    const turn = turnKey();
    const dm = { agentId: "main", speaker: { kind: "owner" }, conversation: "dm" };

    expect((await exec(id, "gmail.message.send", sendParams("Before reading"), { context: { ...dm, turnKey: turn } })).status).toBe(200);
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);

    expect((await exec(id, "gmail.message.read", { id: "m1" }, { context: { ...dm, turnKey: turn } })).status).toBe(200);
    const [read] = await sql`
      select expires_at - read_at as ttl from connector_turn_reads
      where local_installation_id = ${installation}
        and turn_key_hash = ${createHash("sha256").update(turn).digest("hex")}
    `;
    expect(read).toBeTruthy();

    const blocked = await errorOf(await exec(id, "gmail.message.send", sendParams("After reading"), { context: { ...dm, turnKey: turn } }));
    expect(blocked).toMatchObject({ status: 409, error: "connector_approval_required", reason: "write_after_read" });
    expect((await approvalRow(blocked.approvalId)).reason).toBe("write_after_read");
    expect(fakeGoogle.sent.length).toBe(sentBefore + 1);

    // Another turn, or a read on another connection of a turn, decides on its own.
    expect((await exec(id, "gmail.message.send", sendParams("Other turn"), { context: { ...dm, turnKey: turnKey() } })).status).toBe(200);
    const other = await insertConnection();
    const crossTurn = turnKey();
    expect((await exec(other, "gmail.message.list", {}, { context: { ...dm, turnKey: crossTurn } })).status).toBe(200);
    expect(
      await errorOf(await exec(id, "gmail.message.send", sendParams("Cross"), { context: { ...dm, turnKey: crossTurn } })),
    ).toMatchObject({ status: 409, reason: "write_after_read" });

    await uiJson(`/ui/approvals/decide/${blocked.approvalId}`, { ...ownerActor, decision: "approve" });
    expect(
      (await exec(id, "gmail.message.send", sendParams("After reading"), { context: { ...dm, turnKey: turn }, approval: blocked.approvalId })).status,
    ).toBe(200);
  }, DB_TEST_TIMEOUT_MS);

  test("usage rows, last used, used by and recent activity", async () => {
    const id = await insertConnection();
    const cron = { agentId: "main", speaker: { kind: "automation" }, conversation: "automation", routine: { kind: "cron", id: "daily" } };
    expect((await exec(id, "gmail.message.list", {}, { context: cron })).status).toBe(200);
    expect((await exec(id, "gcal.event.list", {}, { context: cron })).status).toBe(502);
    expect((await exec(id, "gmail.message.list", {}, { context: cron })).status).toBe(200);
    expect((await exec(id, "gmail.message.list", {}, { context: null })).status).toBe(200);
    expect((await exec(id, "gmail.message.list", {}, { context: { speaker: { kind: "owner" }, conversation: "group" } })).status).toBe(403);

    const rows = await sql`
      select agent_id, routine_key, mode, conversation, use_count, last_capability, local_installation_id
      from connector_usage where provider_connection_id = ${id}
      order by agent_id desc
    `;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      {
        agent_id: "main",
        routine_key: "cron:daily",
        mode: "owner",
        conversation: "automation",
        use_count: 2,
        last_capability: "gmail.message.list",
        local_installation_id: installation,
      },
      {
        agent_id: "",
        routine_key: "",
        mode: "owner",
        conversation: "legacy_cli",
        use_count: 1,
        last_capability: "gmail.message.list",
        local_installation_id: installation,
      },
    ]);
    const [connection] = await sql`select last_used_at from provider_connections where id = ${id}`;
    expect(connection!.last_used_at).not.toBeNull();

    const listed = (await uiJson("/ui/connect/list", ownerActor)).connections.find((entry: J) => entry.id === id);
    expect(listed.lastUsedAt).not.toBeNull();
    expect(listed.usedBy).toHaveLength(2);
    expect(listed.usedBy[0]).toMatchObject({ installationName: "ana-laptop", legacyCli: true, conversation: "legacy_cli", agentId: null });
    expect(listed.usedBy[1]).toMatchObject({ installationId: installation, agentId: "main", routineKey: "cron:daily", useCount: 2, mode: "owner" });

    const cliListed = ((await (await cliGet("/cli/connect/list")).json()) as J).connections.find((entry: J) => entry.id === id);
    expect(cliListed.usedBy).toHaveLength(2);
    const shown = ((await (await cliGet(`/cli/connect/show/${id}`)).json()) as J).connection;
    expect(shown.usedBy).toHaveLength(2);
    expect(shown.lastUsedAt).not.toBeNull();

    const detail = await uiJson(`/ui/connect/detail/${id}`, ownerActor);
    expect(detail).toMatchObject({ id, email: listed.email, grants: [] });
    expect(detail.usage).toHaveLength(2);
    expect(detail.tools.map((tool: J) => tool.capability)).toEqual([
      "gmail.message.send",
      "gmail.message.list",
      "gmail.message.read",
      "gcal.event.list",
      "gcal.freebusy.query",
    ]);
    expect(detail.tools.find((tool: J) => tool.capability === "gcal.freebusy.query")).toEqual({
      capability: "gcal.freebusy.query",
      label: "See when you're free or busy",
      class: "read",
      policy: "always_allow",
      userPolicy: null,
      ceiling: null,
      available: true,
    });
    expect(detail.tools.find((tool: J) => tool.capability === "gmail.message.send")).toMatchObject({
      policy: "needs_approval",
      available: true,
    });
    expect(detail.activity.map((entry: J) => entry.outcome)).toEqual(["denied", "ok", "ok", "failed", "ok"]);
    expect(detail.activity[0]).toMatchObject({
      action: "connector.action.denied",
      capability: "gmail.message.list",
      conversation: "group",
    });
    expect(detail.activity[4]).toMatchObject({ action: "connector.action.executed", agentId: "main", conversation: "automation" });
    expect(JSON.stringify(detail)).not.toContain("at-");

    expect((await ui(`/ui/connect/detail/${id}`, memberActor)).status).toBe(404);
  }, DB_TEST_TIMEOUT_MS);

  test("free/busy reads busy intervals per calendar", async () => {
    const id = await insertConnection();
    const response = await exec(id, "gcal.freebusy.query", {
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00Z",
      calendarIds: ["primary", "team@example.test"],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as J).result).toEqual({
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00Z",
      calendars: [
        {
          id: "primary",
          busy: [
            { start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" },
            { start: "2026-10-12T16:30:00Z", end: "2026-10-12T17:00:00Z" },
          ],
        },
        { id: "team@example.test", busy: [], errors: [{ reason: "notFound" }] },
      ],
    });
    const defaulted = await exec(id, "gcal.freebusy.query", {
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00Z",
    });
    expect(defaulted.status).toBe(200);
    expect(fakeGoogle.freeBusyBodies.at(-1)).toEqual({
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00Z",
      items: [{ id: "primary" }],
    });
    expect(await errorOf(await exec(id, "gcal.freebusy.query", { timeMin: "tomorrow" }))).toMatchObject({
      status: 400,
      error: "payload_invalid",
    });
    const noCalendar = await insertConnection({ scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"] });
    expect(
      await errorOf(await exec(noCalendar, "gcal.freebusy.query", { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z" })),
    ).toMatchObject({ status: 403, error: "connector_permission_required" });
  }, DB_TEST_TIMEOUT_MS);

  test("admin endpoints are for organization owners and admins only", async () => {
    for (const actor of [
      { ...memberActor, role: "developer" },
      { ...memberActor, role: "admin" },
      { ...memberActor },
      { ...adminActor, role: "viewer" },
    ]) {
      for (const path of ["/ui/admin/policy/get", "/ui/admin/policy/set", "/ui/admin/connections/list"]) {
        expect(await errorOf(await ui(path, { ...actor, provider: "google", enabled: false }))).toMatchObject({
          status: 403,
          error: "connector_forbidden",
        });
      }
    }
    expect((await sql`select count(*)::int as count from connector_org_policies where organization_id = ${orgId}`)[0]!.count).toBe(0);

    const policy = await uiJson("/ui/admin/policy/get", { ...adminActor, provider: "google" });
    expect(policy).toEqual({
      provider: "google",
      enabled: true,
      writesAllowed: true,
      sharedAllowed: false,
      toolCeilings: {},
      tools: [
        { capability: "gmail.message.send", label: "Send email", class: "destructive" },
        { capability: "gmail.message.list", label: "Search your email", class: "read" },
        { capability: "gmail.message.read", label: "Read your email", class: "read" },
        { capability: "gcal.event.list", label: "Read your calendar", class: "read" },
        { capability: "gcal.freebusy.query", label: "See when you're free or busy", class: "read" },
      ],
    });
    expect(await errorOf(await ui("/ui/admin/policy/get", { ...adminActor, provider: "github" }))).toMatchObject({ status: 400 });
    expect(
      await errorOf(await ui("/ui/admin/policy/set", { ...adminActor, provider: "google", toolCeilings: { "drive.file.list": "blocked" } })),
    ).toMatchObject({ status: 400, error: "payload_invalid" });
    expect(
      await errorOf(await ui("/ui/admin/policy/set", { ...adminActor, provider: "google", toolCeilings: { "gmail.message.send": "maybe" } })),
    ).toMatchObject({ status: 400, error: "payload_invalid" });
    expect(await errorOf(await ui("/ui/admin/policy/set", { ...adminActor, provider: "google", enabled: "no" }))).toMatchObject({
      status: 400,
    });
    try {
      const set = await uiJson("/ui/admin/policy/set", { ...adminActor, provider: "google", sharedAllowed: true });
      expect(set).toMatchObject({ enabled: true, writesAllowed: true, sharedAllowed: true });
      const [audit] = await sql`
        select actor_id, metadata_json from audit_events
        where organization_id = ${orgId} and action = 'connector.org_policy.updated'
        order by created_at desc limit 1
      `;
      expect(audit).toMatchObject({ actor_id: admin.id, metadata_json: { provider: "google", sharedAllowed: true } });
    } finally {
      await resetOrgPolicy();
    }
  }, DB_TEST_TIMEOUT_MS);

  test("admins list every member's connection and disconnect one as the operator", async () => {
    const memberRow = await insertConnection({ userId: member.id });
    const ownerRow = await insertConnection();
    const github = await sql<{ id: string }[]>`
      insert into projects (id, organization_id, slug, name) values (${randomUUID()}, ${orgId}, ${`ep-${suffix}`}, 'P')
      returning id
    `;
    await sql`
      insert into provider_connections (organization_id, project_id, provider, scope_kind, display_name, scopes_json)
      values (${orgId}, ${github[0]!.id}, 'github', 'project', 'gh', ${sql.json([])})
    `;
    const listed = (await uiJson("/ui/admin/connections/list", { ...adminActor })).connections as J[];
    expect(listed.every((row) => row.provider === "google")).toBe(true);
    expect(listed.find((row) => row.id === memberRow)).toMatchObject({
      scopeKind: "user",
      status: "active",
      member: { userId: member.id, email: member.email, name: "Bo Member" },
    });
    expect(listed.findIndex((row) => row.id === ownerRow)).toBeLessThan(listed.findIndex((row) => row.id === memberRow));
    expect(JSON.stringify(listed)).not.toContain("at-");

    expect((await ui(`/ui/admin/connections/revoke/${memberRow}`, { ...memberActor, role: "developer" })).status).toBe(403);
    const revokedBefore = fakeGoogle.revoked.length;
    const revoked = await ui(`/ui/admin/connections/revoke/${memberRow}`, adminActor);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(revokedBefore + 1);
    const [row] = await sql`select status, revoked_at from provider_connections where id = ${memberRow}`;
    expect(row).toMatchObject({ status: "revoked_by_operator" });
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${memberRow}`)[0]!.count).toBe(0);
    expect((await ui(`/ui/admin/connections/revoke/${randomUUID()}`, adminActor)).status).toBe(404);
  }, DB_TEST_TIMEOUT_MS);

  test("the revocation outbox revokes, backs off on failure and gives up after 5 attempts", async () => {
    // Revoked at Google, shredded, closed as the operator.
    const removed = await insertConnection({ userId: member.id, status: "suspended" });
    const [okRow] = await sql<{ id: string }[]>`
      insert into connector_revocation_outbox (organization_id, provider_connection_id, reason)
      values (${orgId}, ${removed}, 'member_removed') returning id
    `;
    const revokedBefore = fakeGoogle.revoked.length;
    let report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    expect(report.outbox).toMatchObject({ processed: 1, done: 1 });
    expect(fakeGoogle.revoked).toEqual([...fakeGoogle.revoked.slice(0, revokedBefore), `rt-${removed}`]);
    expect((await sql`select status from connector_revocation_outbox where id = ${okRow!.id}`)[0]!.status).toBe("done");
    expect((await sql`select status from provider_connections where id = ${removed}`)[0]!.status).toBe("revoked_by_operator");
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${removed}`)[0]!.count).toBe(0);

    // The same account still connected elsewhere: shredded here, Google grant kept.
    const sharedSub = `sub-shared-${suffix}`;
    const keeper = await insertConnection({ sub: sharedSub });
    const sharedRow = await insertConnection({ userId: member.id, status: "suspended", sub: `${sharedSub}-dup`, metadata: { googleSub: sharedSub } });
    await sql`update provider_connections set external_account_id = null where id = ${sharedRow}`;
    await sql`
      insert into connector_revocation_outbox (organization_id, provider_connection_id, reason)
      values (${orgId}, ${sharedRow}, 'member_removed')
    `;
    const beforeShared = fakeGoogle.revoked.length;
    report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.outbox).toMatchObject({ processed: 1, done: 1 });
    expect(fakeGoogle.revoked.length).toBe(beforeShared);
    expect((await sql`select status from provider_connections where id = ${sharedRow}`)[0]!.status).toBe("revoked_by_operator");
    expect((await sql`select status from provider_connections where id = ${keeper}`)[0]!.status).toBe("active");

    // Google keeps failing: backoff 5 min × attempts, then shred anyway.
    const failing = await insertConnection({ userId: member.id, status: "suspended" });
    const [failRow] = await sql<{ id: string }[]>`
      insert into connector_revocation_outbox (organization_id, provider_connection_id, reason)
      values (${orgId}, ${failing}, 'member_removed') returning id
    `;
    const outbox = async () =>
      (await sql`
        select status, attempts, last_error_code, extract(epoch from (next_attempt_at - now()))::int as wait
        from connector_revocation_outbox where id = ${failRow!.id}
      `)[0]!;
    fakeGoogle.revokeFails = true;
    try {
      report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
      expect(report.outbox).toMatchObject({ processed: 1, retry: 1 });
      let state = await outbox();
      expect(state).toMatchObject({ status: "pending", attempts: 1, last_error_code: "provider_http_503" });
      expect(state.wait).toBeGreaterThan(4 * 60);
      expect(state.wait).toBeLessThanOrEqual(5 * 60);
      expect((await sql`select status from provider_connections where id = ${failing}`)[0]!.status).toBe("suspended");
      expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${failing}`)[0]!.count).toBe(2);

      // Not due yet: untouched.
      report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
      expect(report.outbox.processed).toBe(0);
      expect((await outbox()).attempts).toBe(1);

      for (let attempt = 2; attempt <= 4; attempt += 1) {
        await sql`update connector_revocation_outbox set next_attempt_at = now() - interval '1 second' where id = ${failRow!.id}`;
        report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
        state = await outbox();
        expect(state).toMatchObject({ status: "pending", attempts: attempt });
        expect(state.wait).toBeGreaterThan(attempt * 5 * 60 - 60);
        expect(state.wait).toBeLessThanOrEqual(attempt * 5 * 60);
      }
      await sql`update connector_revocation_outbox set next_attempt_at = now() - interval '1 second' where id = ${failRow!.id}`;
      report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
      expect(report.outbox).toMatchObject({ processed: 1, failed: 1 });
      expect(await outbox()).toMatchObject({ status: "failed", attempts: 5, last_error_code: "provider_http_503" });
    } finally {
      fakeGoogle.revokeFails = false;
    }
    expect((await sql`select status from provider_connections where id = ${failing}`)[0]!.status).toBe("revoked_by_operator");
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${failing}`)[0]!.count).toBe(0);
    const [gaveUp] = await sql`
      select count(*)::int as count from audit_events
      where target_id = ${failing} and action = 'connector.revoke.provider_gave_up'
    `;
    expect(gaveUp!.count).toBe(1);

    // A connection already disconnected: nothing to do.
    const gone = await insertConnection({ userId: member.id, status: "revoked_by_user" });
    const [goneRow] = await sql<{ id: string }[]>`
      insert into connector_revocation_outbox (organization_id, provider_connection_id, reason)
      values (${orgId}, ${gone}, 'installation_revoked') returning id
    `;
    const beforeGone = fakeGoogle.revoked.length;
    await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect((await sql`select status from connector_revocation_outbox where id = ${goneRow!.id}`)[0]!.status).toBe("done");
    expect(fakeGoogle.revoked.length).toBe(beforeGone);
  }, DB_TEST_TIMEOUT_MS);

  test("the outbox leaves alone a connection its owner reconnected since it was queued", async () => {
    // Removed (suspended and queued), added back, reconnected before the run.
    const revived = await insertConnection({ userId: member.id, status: "suspended" });
    const [row] = await sql<{ id: string }[]>`
      insert into connector_revocation_outbox (organization_id, provider_connection_id, reason)
      values (${orgId}, ${revived}, 'member_removed') returning id
    `;
    await sql`update provider_connections set status = 'active', last_reauth_at = now() where id = ${revived}`;
    const revokedBefore = fakeGoogle.revoked.length;
    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.outbox).toMatchObject({ processed: 1, done: 1 });
    expect(fakeGoogle.revoked.length).toBe(revokedBefore);
    expect((await sql`select status from connector_revocation_outbox where id = ${row!.id}`)[0]!.status).toBe("done");
    expect((await sql`select status from provider_connections where id = ${revived}`)[0]!.status).toBe("active");
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${revived}`)[0]!.count).toBe(2);

    // Giving up re-checks the locked row: one reconnected meanwhile keeps its credentials.
    const failing = await insertConnection({ userId: member.id, status: "suspended" });
    const stale = (await findProviderConnectionById(vaultDb, failing, orgId))!;
    await sql`update provider_connections set status = 'active', last_reauth_at = now() where id = ${failing}`;
    const notActive = (connection: { status: string }) => connection.status !== "active";
    expect(await shredAfterGivingUp({ db: vaultDb }, stale, { origin: "operator", onlyIf: notActive })).toBe(false);
    expect((await sql`select status from provider_connections where id = ${failing}`)[0]!.status).toBe("active");
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${failing}`)[0]!.count).toBe(2);
    await sql`update provider_connections set status = 'suspended' where id = ${failing}`;
    expect(await shredAfterGivingUp({ db: vaultDb }, stale, { origin: "operator", onlyIf: notActive })).toBe(true);
    expect((await sql`select status from provider_connections where id = ${failing}`)[0]!.status).toBe("revoked_by_operator");
    expect((await sql`select count(*)::int as count from connector_credentials where provider_connection_id = ${failing}`)[0]!.count).toBe(0);
  }, DB_TEST_TIMEOUT_MS);
});
