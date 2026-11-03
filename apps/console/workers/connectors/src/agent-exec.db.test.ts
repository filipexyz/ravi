import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import postgres from "postgres";

import { createGoogleAdapter, type GoogleCapabilityHandler } from "./adapters/google";
import type { ConnectorAdapter } from "./adapters/adapter";
import { buildGoogleCalendarHandlers } from "./capabilities/google/calendar";
import { importRootWrapKey } from "./crypto";
import { findCredentialsByConnection, openConnectorsDb, type ConnectorsDb } from "./db";
import type { ConnectorsWorkerEnv, HyperdriveBinding } from "./env";
import { signHmacRequest } from "./hmac";
import { createConnectorsWorker } from "./router";
import { runScheduledMaintenance } from "./scheduled";
import { decryptStoredCredential, storeConnectionTokens } from "./vault";

// Agent exec for the person asking (consent, `ravi link` bindings) and for
// shared organization accounts (organization connect, Change owner, shared
// grants, revoke), against a migrated Console database with a fake Google.
// Runs only with CONNECTORS_TEST_DATABASE_URL; creates and deletes its own
// fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
const DB_TEST_TIMEOUT_MS = 60_000;

type J = any;

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const HMAC_KEY = "agent-exec-test-hmac-key";
const HMAC_KEY_ID = "k_agent_exec";
const CLI_SECRET = "agent-exec-test-cli-secret-0123456789";
const CONSOLE = "https://console.test";
const LINK = "https://link.test";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
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
const otherOrgId = randomUUID();

function person(label: string, name: string) {
  return { id: randomUUID(), email: `ae-${suffix}-${label}@example.test`, name };
}

const owner = person("owner", "Olga Owner");
const admin = person("admin", "Ada Admin");
const operator = person("operator", "Oscar Operator");
const asker = person("asker", "Paula Person");
const noAccount = person("noaccount", "Nico Noaccount");
const leaver = person("leaver", "Lea Leaver");
const member = person("member", "Max Member");
const people = [owner, admin, operator, asker, noAccount, leaver, member];

const actor = (user: { id: string }, role?: string) => ({
  userId: user.id,
  organizationId: orgId,
  ...(role ? { role } : {}),
});

const opInstallation = randomUUID();
const opSession = { id: randomUUID(), jti: randomUUID() };
const otherInstallation = randomUUID();
const foreignInstallation = randomUUID();

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

interface FakeAccount {
  sub: string;
  email: string;
  scopes?: string[];
  /** Signed in from a sign-in URL with the identity scopes taken out: Google's answer has no id_token. */
  withoutIdToken?: boolean;
}

const fakeGoogle = {
  codes: new Map<string, FakeAccount>(),
  seq: 0,
  sent: [] as { accessToken: string; subject: string }[],
  reads: [] as string[],
  freeBusyTokens: [] as string[],
  revoked: [] as string[],
};

function idTokenFor(account: { sub: string; email: string }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: account.sub, email: account.email, aud: "client" })}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (target === GOOGLE_TOKEN_URL) {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "authorization_code") {
      const account = fakeGoogle.codes.get(body.get("code") ?? "");
      if (!account || !body.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      fakeGoogle.seq += 1;
      return json({
        access_token: `at-code-${fakeGoogle.seq}`,
        refresh_token: `rt-code-${fakeGoogle.seq}`,
        ...(account.withoutIdToken ? {} : { id_token: idTokenFor(account) }),
        expires_in: 3600,
        scope: (account.scopes ?? []).join(" "),
        token_type: "Bearer",
      });
    }
    fakeGoogle.seq += 1;
    return json({ access_token: `at-refreshed-${fakeGoogle.seq}`, expires_in: 3600 });
  }
  if (target === GOOGLE_REVOKE_URL) {
    fakeGoogle.revoked.push(new URLSearchParams(String(init?.body ?? "")).get("token") ?? "");
    return json({});
  }
  if (target === FREEBUSY_URL && init?.method === "POST") {
    fakeGoogle.freeBusyTokens.push(new Headers(init.headers).get("authorization") ?? "");
    const body = JSON.parse(String(init.body)) as J;
    return json({
      kind: "calendar#freeBusy",
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars: { primary: { busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }] } },
    });
  }
  throw new Error(`unexpected fetch ${target}`);
}) as typeof fetch;

const handlers = new Map<string, GoogleCapabilityHandler>([
  [
    "gmail.message.list",
    {
      async execute(input) {
        fakeGoogle.reads.push(input.accessToken);
        return { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 };
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

/** The JSON body with `status` set to the HTTP status (a body detail named `status` is dropped). */
async function errorOf(response: Response): Promise<J> {
  return { ...((await response.json()) as J), status: response.status };
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
  agentId?: string;
  agentDisplayName?: string;
  sessionName?: string;
  routine?: { kind: string; id?: string };
  speaker?: { kind: string; contactId?: string; consoleUserId?: string };
  conversation?: string;
  turnKey?: string;
}

function encodeContext(context: ExecContext): string {
  return Buffer.from(
    JSON.stringify({ v: 1, speaker: { kind: "terminal" }, conversation: "terminal", ...context }),
    "utf8",
  ).toString("base64url");
}

const dmFrom = (contactId: string, extra: Partial<ExecContext> = {}): ExecContext => ({
  agentId: "main",
  agentDisplayName: "Main",
  speaker: { kind: "contact", contactId },
  conversation: "dm",
  ...extra,
});

async function agentExec(
  capability: string,
  parameters: unknown,
  options: {
    mode?: unknown;
    context?: ExecContext | null;
    approval?: string;
    bearer?: string;
    provider?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.bearer ?? opBearer}`,
    "content-type": "application/json",
  };
  if (options.context !== null) headers["x-ravi-exec-context"] = encodeContext(options.context ?? {});
  if (options.approval) headers["x-ravi-approval"] = options.approval;
  return call(
    new Request(`${LINK}/cli/agent-exec`, {
      method: "POST",
      body: JSON.stringify({
        provider: options.provider ?? "google",
        capability,
        parameters,
        mode: options.mode ?? "person_asking",
      }),
      headers,
    }),
  );
}

async function cliGet(path: string, token: string = opBearer): Promise<Response> {
  return call(new Request(`${LINK}${path}`, { headers: { authorization: `Bearer ${token}` } }));
}

const sendParams = (subject = "Hello") => ({
  to: ["friend@example.test"],
  subject,
  body: "Hi there.",
});

const freeBusyParams = { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z" };

function tokenOf(consentUrl: string): string {
  const prefix = `${CONSOLE}/connectors/consent/`;
  expect(consentUrl.startsWith(prefix)).toBe(true);
  return consentUrl.slice(prefix.length);
}

const base64Sha256 = (value: string) => createHash("sha256").update(value).digest("base64");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sql: postgres.Sql;
let vaultDb: ConnectorsDb;
let rootWrapKey: CryptoKey;
let opBearer: string;

async function insertConnection(input: {
  userId: string;
  sub?: string;
  isDefault?: boolean;
  createdAt?: string;
}): Promise<string> {
  const sub = input.sub ?? `sub-${randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`
    insert into provider_connections (
      organization_id, user_id, provider, scope_kind, external_account_id, external_account_login,
      display_name, status, scopes_json, metadata_json, is_default, created_at
    ) values (
      ${orgId}, ${input.userId}, 'google', 'user', ${sub}, ${`${sub}@gmail.test`},
      'google', 'active', ${sql.json(SCOPES)}, ${sql.json({ googleSub: sub })},
      ${input.isDefault ?? false}, ${input.createdAt ?? new Date().toISOString()}
    )
    returning id
  `;
  await storeConnectionTokens(vaultDb, {
    rootWrapKey,
    dekKeyVersion: 1,
    connection: { id: row!.id, organizationId: orgId, userId: input.userId },
    tokens: { accessToken: `at-${row!.id}`, refreshToken: `rt-${row!.id}`, expiresInSeconds: 3600, scopes: [] },
    existing: [],
  });
  return row!.id;
}

/** A computer of `user` with a signed-in CLI session: their own `/cli/exec` bearer. */
async function cliSessionFor(user: { id: string }, name: string): Promise<string> {
  const installationId = randomUUID();
  const session = { id: randomUUID(), jti: randomUUID() };
  await sql`
    insert into local_installations (id, organization_id, user_id, name, status)
    values (${installationId}, ${orgId}, ${user.id}, ${name}, 'active')
  `;
  await sql`
    insert into cli_sessions (
      id, local_installation_id, organization_id, user_id,
      refresh_token_hash, access_token_jti, expires_at
    ) values (
      ${session.id}, ${installationId}, ${orgId}, ${user.id},
      ${`rh-${randomUUID()}`}, ${session.jti}, now() + interval '1 day'
    )
  `;
  return bearerFor(session, installationId, user.id);
}

/** The owner's own exec of their connection, from the terminal. */
async function ownExec(bearer: string, connectionId: string, capability: string, parameters: unknown): Promise<Response> {
  return call(
    new Request(`${LINK}/cli/exec/${connectionId}`, {
      method: "POST",
      body: JSON.stringify({ capability, parameters }),
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-ravi-exec-context": encodeContext({}) },
    }),
  );
}

async function bind(installationId: string, contactId: string, userId: string): Promise<void> {
  await sql`
    insert into ravi_actor_bindings (installation_id, organization_id, console_user_id, contact_id, status, linked_by)
    values (${installationId}, ${orgId}, ${userId}, ${contactId}, 'active', ${userId})
  `;
}

async function setSharedAllowed(sharedAllowed: boolean): Promise<void> {
  const response = await ui("/ui/admin/policy/set", { ...actor(admin, "admin"), provider: "google", sharedAllowed });
  expect(response.status).toBe(200);
}

async function consentRows(userId: string, agentId: string): Promise<J[]> {
  return [
    ...(await sql`
      select * from connector_consent_requests
      where organization_id = ${orgId} and console_user_id = ${userId} and agent_id = ${agentId}
      order by created_at asc
    `),
  ];
}

async function usageRow(connectionId: string, mode: string): Promise<J> {
  const [row] = await sql`
    select * from connector_usage where provider_connection_id = ${connectionId} and mode = ${mode}
  `;
  return row;
}

async function approvalRow(id: string): Promise<J> {
  const [row] = await sql`select * from connector_action_approvals where id = ${id}`;
  return row;
}

/** Consent through the Console: the agent asks, the person approves. Returns the grant id. */
async function consentFor(
  user: { id: string },
  contactId: string,
  options: { agentId?: string; connectionId?: string } = {},
): Promise<string> {
  const context = dmFrom(contactId, { agentId: options.agentId ?? "main" });
  const asked = await errorOf(await agentExec("gmail.message.list", {}, { context }));
  expect(asked).toMatchObject({ status: 409, error: "connector_consent_required" });
  const decided = await uiJson("/ui/consent/decide", {
    ...actor(user),
    token: tokenOf(asked.consentUrl),
    decision: "approve",
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
  });
  expect(decided.status).toBe("approved");
  expect(typeof decided.grantId).toBe("string");
  return decided.grantId;
}

// ---------------------------------------------------------------------------
// Organization connect helpers
// ---------------------------------------------------------------------------

function newAccount(label: string): FakeAccount {
  const id = randomUUID().slice(0, 8);
  return { sub: `org-sub-${id}`, email: `${label}-${id}@corp.test` };
}

async function startOrgConnect(
  user: { id: string },
  role: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return ui("/ui/connect/start", { ...actor(user, role), provider: "google", scopeKind: "organization", ...extra });
}

/** start → resolve → continue → callback → finish, for an organization account. */
async function connectOrgAccount(
  user: { id: string },
  role: string,
  account: FakeAccount,
  extra: Record<string, unknown> = {},
): Promise<{ resolved: J; finish: J }> {
  const startResponse = await startOrgConnect(user, role, extra);
  expect(startResponse.status).toBe(201);
  const started = (await startResponse.json()) as J;
  const connectToken = new URL(started.connectUrl).pathname.split("/").pop()!;
  const resolved = await uiJson("/ui/connect/resolve", { ...actor(user), connectToken });
  const continued = await uiJson("/ui/connect/continue", { ...actor(user), connectToken });
  const authorizationUrl = new URL(continued.authorizationUrl);
  const code = `code-${randomUUID()}`;
  fakeGoogle.codes.set(code, { ...account, scopes: authorizationUrl.searchParams.get("scope")!.split(" ") });
  const callback = await call(
    new Request(
      `${LINK}/oauth/google/callback?code=${code}&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
    ),
  );
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get("location")!);
  const finish = await uiJson("/ui/connect/finish", {
    ...actor(user),
    pendingId: location.searchParams.get("p")!,
    resultToken: location.searchParams.get("r")!,
  });
  return { resolved, finish };
}

async function connectionRow(id: string): Promise<J> {
  const [row] = await sql`select * from provider_connections where id = ${id}`;
  return row;
}

async function grantRow(id: string): Promise<J> {
  const [row] = await sql`select * from agent_connector_grants where id = ${id}`;
  return row;
}

async function shareWith(
  connectionId: string,
  by: { id: string },
  options: { agentId?: string; conversations?: string[]; installationId?: string; role?: string } = {},
): Promise<Response> {
  return ui("/ui/org/shared/grant", {
    ...actor(by, options.role),
    connectionId,
    installationId: options.installationId ?? opInstallation,
    agentId: options.agentId ?? "support",
    conversations: options.conversations ?? ["dm"],
  });
}

const sharedDm: ExecContext = {
  agentId: "support",
  speaker: { kind: "contact", contactId: "c_customer" },
  conversation: "dm",
};

describeDb("connectors Worker: agent exec for the person asking and shared accounts (DB)", () => {
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, fetch_types: false, onnotice: () => {} });
    vaultDb = openConnectorsDb({ connectionString: url! } as HyperdriveBinding);
    rootWrapKey = await importRootWrapKey(ROOT_KEY);

    await sql`
      insert into organizations (id, slug, name) values
        (${orgId}, ${`ae-${suffix}`}, 'Agent exec test'),
        (${otherOrgId}, ${`ae-${suffix}-2`}, 'Agent exec test 2')
    `;
    for (const user of people) {
      await sql`insert into users (id, primary_email, display_name) values (${user.id}, ${user.email}, ${user.name})`;
    }
    // The owner joined first: approvals of an account nobody manages name them.
    await sql`
      insert into organization_memberships (organization_id, user_id, role, created_at) values
        (${orgId}, ${owner.id}, 'owner', now() - interval '2 days'),
        (${orgId}, ${admin.id}, 'admin', now() - interval '1 day'),
        (${orgId}, ${operator.id}, 'developer', now()),
        (${orgId}, ${asker.id}, 'developer', now()),
        (${orgId}, ${noAccount.id}, 'developer', now()),
        (${orgId}, ${leaver.id}, 'developer', now()),
        (${orgId}, ${member.id}, 'developer', now())
    `;
    await sql`
      insert into local_installations (id, organization_id, user_id, name, status) values
        (${opInstallation}, ${orgId}, ${operator.id}, 'op-laptop', 'active'),
        (${otherInstallation}, ${orgId}, ${member.id}, 'max-laptop', 'active'),
        (${foreignInstallation}, ${otherOrgId}, ${operator.id}, 'elsewhere', 'active')
    `;
    await sql`
      insert into cli_sessions (
        id, local_installation_id, organization_id, user_id,
        refresh_token_hash, access_token_jti, expires_at
      ) values (
        ${opSession.id}, ${opInstallation}, ${orgId}, ${operator.id},
        ${`rh-${randomUUID()}`}, ${opSession.jti}, now() + interval '1 day'
      )
    `;
    opBearer = await bearerFor(opSession, opInstallation, operator.id);

    await bind(opInstallation, "c_asker", asker.id);
    await bind(opInstallation, "c_noaccount", noAccount.id);
    await bind(opInstallation, "c_leaver", leaver.id);
    // The same person linked on another member's installation only.
    await bind(otherInstallation, "c_elsewhere", asker.id);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!sql) return;
    if (requestIds.length > 0) {
      await sql`delete from audit_events where request_id in ${sql(requestIds)}`;
    }
    const userIds = people.map((user) => user.id);
    await sql`
      delete from audit_events
      where organization_id in ${sql([orgId, otherOrgId])} or actor_id in ${sql(userIds)}
    `;
    await sql`delete from organizations where id in ${sql([orgId, otherOrgId])}`;
    await sql`delete from users where id in ${sql(userIds)}`;
    await vaultDb.close();
    await sql.end({ timeout: 5 });
  }, DB_TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // The person asking
  // -------------------------------------------------------------------------

  test("the request must say which agent, which contact and which mode", async () => {
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: null }))).toMatchObject({
      status: 400,
      error: "connector_exec_context_invalid",
      reason: "missing",
    });
    expect(
      await errorOf(await agentExec("gmail.message.list", {}, { context: { ...dmFrom("c_asker"), agentId: undefined } })),
    ).toMatchObject({ status: 400, error: "connector_exec_context_invalid", reason: "agent_required" });
    expect(
      await errorOf(
        await agentExec("gmail.message.list", {}, { context: { agentId: "main", speaker: { kind: "contact" }, conversation: "dm" } }),
      ),
    ).toMatchObject({ status: 400, error: "connector_exec_context_invalid", reason: "contact_required" });
    expect(await errorOf(await agentExec("gmail.message.list", {}, { mode: "owner", context: dmFrom("c_asker") }))).toMatchObject({
      status: 400,
      error: "payload_invalid",
    });
    expect(
      await errorOf(await agentExec("gmail.message.list", {}, { provider: "github", context: dmFrom("c_asker") })),
    ).toMatchObject({ status: 400, error: "connector_capability_unsupported" });
  }, DB_TEST_TIMEOUT_MS);

  test("who the speaker is comes only from this installation's binding, never from the header", async () => {
    await insertConnection({ userId: asker.id });
    // No binding for the contact.
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_nobody") }))).toMatchObject({
      status: 403,
      error: "connector_not_linked",
      reason: "contact_not_linked",
    });
    // The contact is linked, but on another installation.
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_elsewhere") }))).toMatchObject({
      status: 403,
      error: "connector_not_linked",
    });
    // The header naming a Console user changes nothing.
    const spoofed = dmFrom("c_nobody", { speaker: { kind: "contact", contactId: "c_nobody", consoleUserId: asker.id } });
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: spoofed }))).toMatchObject({
      status: 403,
      error: "connector_not_linked",
    });
    const misnamed = dmFrom("c_noaccount", {
      agentId: "spoof-check",
      speaker: { kind: "contact", contactId: "c_noaccount", consoleUserId: asker.id },
    });
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: misnamed }))).toMatchObject({
      status: 409,
      error: "connector_consent_required",
    });
    expect(await consentRows(asker.id, "spoof-check")).toEqual([]);
    expect((await consentRows(noAccount.id, "spoof-check")).map((row) => row.status)).toEqual(["pending"]);
    expect(fakeGoogle.reads).toEqual([]);

    const audits = await sql`
      select metadata_json from audit_events
      where organization_id = ${orgId} and action = 'connector.action.denied' and actor_id = ${operator.id}
        and metadata_json->>'mode' = 'person_asking'
    `;
    expect(audits.map((row) => row.metadata_json.code)).toContain("connector_not_linked");
  }, DB_TEST_TIMEOUT_MS);

  test("a group, another agent or a trigger never uses a person's account", async () => {
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { conversation: "group" }) }))).toMatchObject({
      status: 403,
      error: "connector_group_blocked",
    });
    expect(
      await errorOf(
        await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { speaker: { kind: "agent", contactId: "c_asker" } }) }),
      ),
    ).toMatchObject({ status: 403, error: "connector_speaker_not_owner" });
    expect(
      await errorOf(
        await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { routine: { kind: "trigger", id: "t1" } }) }),
      ),
    ).toMatchObject({ status: 403, error: "connector_speaker_not_owner" });
  }, DB_TEST_TIMEOUT_MS);

  test("consent: one pending request, a fresh token each time, decided once by that person", async () => {
    const askerConnection = await insertConnection({ userId: asker.id, isDefault: true });
    const context = dmFrom("c_asker", { agentId: "consent-agent", agentDisplayName: "Consent agent" });

    const first = await errorOf(await agentExec("gmail.message.list", {}, { context }));
    expect(first).toMatchObject({ status: 409, error: "connector_consent_required" });
    expect(typeof first.consentRequestId).toBe("string");
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const firstToken = tokenOf(first.consentUrl);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await consentRows(asker.id, "consent-agent");
    expect(stored).toMatchObject({
      id: first.consentRequestId,
      status: "pending",
      local_installation_id: opInstallation,
      contact_id: "c_asker",
      requested_by_user_id: operator.id,
      token_hash: base64Sha256(firstToken),
    });
    expect(JSON.stringify(stored)).not.toContain(firstToken);
    const ttl = new Date(stored.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(23 * 3600_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000 + 60_000);

    // Asked again: the same request with a new token; the first link stops working.
    const second = await errorOf(await agentExec("gmail.message.list", {}, { context }));
    expect(second.consentRequestId).toBe(first.consentRequestId);
    const token = tokenOf(second.consentUrl);
    expect(token).not.toBe(firstToken);
    expect(await consentRows(asker.id, "consent-agent")).toHaveLength(1);
    expect(await uiJson("/ui/consent/resolve", { ...actor(asker), token: firstToken })).toEqual({ state: "invalid" });
    expect(await uiJson("/ui/consent/resolve", { ...actor(asker), token: "short" })).toEqual({ state: "invalid" });

    // Only the person it was made for.
    expect(await uiJson("/ui/consent/resolve", { ...actor(operator), token })).toEqual({ state: "user_mismatch" });
    expect(await errorOf(await ui("/ui/consent/decide", { ...actor(operator), token, decision: "approve" }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
    });

    const view = await uiJson("/ui/consent/resolve", { ...actor(asker), token });
    expect(view).toMatchObject({
      state: "pending",
      provider: "google",
      agentId: "consent-agent",
      agentDisplayName: "Consent agent",
      operatorName: operator.name,
      operatorEmail: operator.email,
      installationName: "op-laptop",
      expiresAt: expect.any(String),
    });
    expect(view.connections[0]).toEqual({ id: askerConnection, email: expect.any(String), isDefault: true });
    expect(view.connections.every((row: J) => typeof row.id === "string")).toBe(true);

    // Someone else's account cannot be chosen.
    const operatorConnection = await insertConnection({ userId: operator.id });
    expect(
      await errorOf(await ui("/ui/consent/decide", { ...actor(asker), token, decision: "approve", connectionId: operatorConnection })),
    ).toMatchObject({ status: 400, error: "payload_invalid" });

    const decided = await uiJson("/ui/consent/decide", { ...actor(asker), token, decision: "approve" });
    expect(Object.keys(decided).sort()).toEqual(["grantId", "status"]);
    expect(decided.status).toBe("approved");
    expect(await grantRow(decided.grantId)).toMatchObject({
      mode: "person_asking",
      agent_id: "consent-agent",
      local_installation_id: opInstallation,
      granted_by_user_id: asker.id,
      provider_connection_id: null,
      status: "active",
      conversations_json: ["dm"],
    });
    // Once.
    expect(await errorOf(await ui("/ui/consent/decide", { ...actor(asker), token, decision: "deny" }))).toMatchObject({
      status: 409,
      error: "connector_connect_unavailable",
      state: "used",
    });
    expect(await uiJson("/ui/consent/resolve", { ...actor(asker), token })).toEqual({ state: "used" });
    expect((await consentRows(asker.id, "consent-agent"))[0]).toMatchObject({ status: "approved", grant_id: decided.grantId });

    const given = await uiJson("/ui/consent/list", actor(asker));
    expect(given.grants.find((row: J) => row.id === decided.grantId)).toEqual({
      id: decided.grantId,
      mode: "person_asking",
      provider: "google",
      agentId: "consent-agent",
      installationId: opInstallation,
      installationName: "op-laptop",
      operator: { userId: operator.id, email: operator.email },
      connectionId: null,
      email: null,
      conversations: ["dm"],
      createdAt: expect.any(String),
    });
    expect((await uiJson("/ui/consent/list", actor(operator))).grants).toEqual([]);

    const audits = await sql`
      select action from audit_events
      where target_id = ${first.consentRequestId} order by created_at asc
    `;
    expect(audits.map((row) => row.action)).toEqual([
      "connector.consent.requested",
      "connector.consent.reissued",
      "connector.consent.user_mismatch",
      "connector.consent.user_mismatch",
      "connector.consent.approved",
    ]);
  }, DB_TEST_TIMEOUT_MS);

  test("with consent the agent runs as the person: their account, their approvals", async () => {
    const askerDefault = (await sql<{ id: string }[]>`
      select id from provider_connections where user_id = ${asker.id} and is_default
    `)[0]!.id;
    const context = dmFrom("c_asker", { agentId: "consent-agent" });

    const read = await agentExec("gmail.message.list", {}, { context });
    expect(read.status).toBe(200);
    expect(fakeGoogle.reads.at(-1)).toBe(`at-${askerDefault}`);
    expect(await usageRow(askerDefault, "person_asking")).toMatchObject({
      local_installation_id: opInstallation,
      agent_id: "consent-agent",
      conversation: "dm",
      use_count: 1,
    });

    const asked = await errorOf(await agentExec("gmail.message.send", sendParams("For Paula"), { context }));
    expect(asked).toMatchObject({ status: 409, error: "connector_approval_required" });
    expect(await approvalRow(asked.approvalId)).toMatchObject({
      owner_user_id: asker.id,
      requested_by_user_id: operator.id,
      provider_connection_id: askerDefault,
      local_installation_id: opInstallation,
    });
    // The operator follows it from the CLI; only the person decides.
    expect(await (await cliGet(`/cli/approvals/${asked.approvalId}`)).json()).toMatchObject({ status: "pending" });
    expect((await uiJson("/ui/approvals/list", actor(operator))).approvals).toEqual([]);
    expect((await ui(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(operator), decision: "approve" })).status).toBe(404);
    const waiting = await uiJson("/ui/approvals/list", actor(asker));
    expect(waiting.approvals.map((entry: J) => entry.id)).toContain(asked.approvalId);
    const detail = await uiJson(`/ui/approvals/get/${asked.approvalId}`, actor(asker));
    expect(detail.preview).toMatchObject({ subject: "For Paula" });
    expect(await uiJson(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(asker), decision: "approve" })).toEqual({
      status: "approved",
    });

    const sent = await agentExec("gmail.message.send", sendParams("For Paula"), { context, approval: asked.approvalId });
    expect(sent.status).toBe(200);
    expect(fakeGoogle.sent.at(-1)).toEqual({ accessToken: `at-${askerDefault}`, subject: "For Paula" });
    expect((await approvalRow(asked.approvalId)).status).toBe("consumed");

    // Audited on the operator who asked (an agent, through their CLI
    // session), naming the person it acted for: never as the person.
    const grantId = (await sql<{ id: string }[]>`
      select id from agent_connector_grants
      where granted_by_user_id = ${asker.id} and agent_id = 'consent-agent' and status = 'active'
    `)[0]!.id;
    const audited = await sql`
      select action, actor_type, actor_id, metadata_json from audit_events
      where target_id = ${askerDefault}
        and action in ('connector.approval.created', 'connector.approval.consumed', 'connector.action.executed')
        and metadata_json->>'mode' = 'person_asking'
      order by created_at asc
    `;
    expect(audited.map((row) => row.action).sort()).toEqual([
      "connector.action.executed",
      "connector.action.executed",
      "connector.approval.consumed",
      "connector.approval.created",
    ]);
    for (const row of audited) {
      expect(row).toMatchObject({
        actor_type: "agent",
        actor_id: operator.id,
        metadata_json: { mode: "person_asking", actingForUserId: asker.id, grantId, cliSessionId: opSession.id },
      });
    }
    expect(audited.find((row) => row.action === "connector.approval.consumed")!.metadata_json).toMatchObject({
      approvalId: asked.approvalId,
      ownerUserId: asker.id,
      requestedByUserId: operator.id,
    });
    expect(JSON.stringify(audited.map((row) => row.metadata_json))).not.toContain("For Paula");

    // The person's drawer lists the agent (it uses the default account) and what it did for them.
    const drawer = await uiJson(`/ui/connect/detail/${askerDefault}`, actor(asker));
    expect(drawer.grants.map((row: J) => row.agentId)).toContain("consent-agent");
    expect(drawer.usage.find((row: J) => row.mode === "person_asking")).toMatchObject({ agentId: "consent-agent" });
    const activity = (drawer.activity as J[]).filter((row) => row.agentId === "consent-agent").map((row) => row.action);
    expect(activity).toEqual(expect.arrayContaining(["connector.action.executed", "connector.approval.created"]));

    // A group is still refused.
    expect(
      await errorOf(await agentExec("gmail.message.list", {}, { context: { ...context, conversation: "group" } })),
    ).toMatchObject({ status: 403, error: "connector_group_blocked" });
  }, DB_TEST_TIMEOUT_MS);

  test("for the person asking a write always waits for that person, even when they always allow it", async () => {
    const askerDefault = (await sql<{ id: string }[]>`
      select id from provider_connections where user_id = ${asker.id} and is_default
    `)[0]!.id;
    expect(
      await uiJson(`/ui/connect/tools/${askerDefault}`, { ...actor(asker), capability: "gmail.message.send", policy: "always_allow" }),
    ).toEqual({ ok: true });
    const context = dmFrom("c_asker", { agentId: "consent-agent" });
    const sentBefore = fakeGoogle.sent.length;
    try {
      // Their own exec, from their own terminal: the rule applies, no approval.
      const askerBearer = await cliSessionFor(asker, "paula-laptop");
      expect((await ownExec(askerBearer, askerDefault, "gmail.message.send", sendParams("Mine"))).status).toBe(200);
      expect(fakeGoogle.sent.length).toBe(sentBefore + 1);

      // An agent acting for them: still their approval.
      const asked = await errorOf(await agentExec("gmail.message.send", sendParams("Agent for Paula"), { context }));
      expect(asked).toMatchObject({ status: 409, error: "connector_approval_required", reason: "policy" });
      expect(await approvalRow(asked.approvalId)).toMatchObject({
        owner_user_id: asker.id,
        requested_by_user_id: operator.id,
        provider_connection_id: askerDefault,
        status: "pending",
      });
      expect(fakeGoogle.sent.length).toBe(sentBefore + 1);
      // Reads follow the rules as usual.
      expect((await agentExec("gmail.message.list", {}, { context })).status).toBe(200);

      // Blocked stays blocked.
      expect(
        await uiJson(`/ui/connect/tools/${askerDefault}`, { ...actor(asker), capability: "gmail.message.send", policy: "blocked" }),
      ).toEqual({ ok: true });
      expect(await errorOf(await agentExec("gmail.message.send", sendParams("Agent for Paula"), { context }))).toMatchObject({
        status: 403,
        error: "connector_tool_blocked",
      });
    } finally {
      await sql`delete from connector_tool_policies where provider_connection_id = ${askerDefault}`;
    }
  }, DB_TEST_TIMEOUT_MS);

  test("the account chosen at consent is used while it is live; then the default", async () => {
    const chosen = await insertConnection({ userId: asker.id });
    const grantId = await consentFor(asker, "c_asker", { agentId: "pinned-agent", connectionId: chosen });
    expect((await grantRow(grantId)).provider_connection_id).toBe(chosen);
    const context = dmFrom("c_asker", { agentId: "pinned-agent" });
    expect((await agentExec("gmail.message.list", {}, { context })).status).toBe(200);
    expect(fakeGoogle.reads.at(-1)).toBe(`at-${chosen}`);

    // Paused, it is still the account chosen: nothing runs on another one.
    await sql`update provider_connections set status = 'suspended' where id = ${chosen}`;
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context }))).toMatchObject({
      status: 503,
      error: "connector_unavailable",
    });
    // No longer live: the person's default.
    await sql`update provider_connections set status = 'tampered' where id = ${chosen}`;
    expect((await agentExec("gmail.message.list", {}, { context })).status).toBe(200);
    const askerDefault = (await sql<{ id: string }[]>`
      select id from provider_connections where user_id = ${asker.id} and is_default
    `)[0]!.id;
    expect(fakeGoogle.reads.at(-1)).toBe(`at-${askerDefault}`);

    // Disconnected: the grants pointing at it go with it, and the agent asks again.
    const other = await insertConnection({ userId: asker.id });
    const otherGrant = await consentFor(asker, "c_asker", { agentId: "pinned-agent-2", connectionId: other });
    expect(await uiJson(`/ui/connect/revoke/${other}`, actor(asker))).toEqual({ revoked: true });
    expect((await grantRow(otherGrant)).status).toBe("revoked");
    expect(
      await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { agentId: "pinned-agent-2" }) })),
    ).toMatchObject({ status: 409, error: "connector_consent_required" });
  }, DB_TEST_TIMEOUT_MS);

  test("a revoked grant stops the agent; only the person who gave it revokes it", async () => {
    const grantId = await consentFor(asker, "c_asker", { agentId: "revoked-agent" });
    const context = dmFrom("c_asker", { agentId: "revoked-agent" });
    expect((await agentExec("gmail.message.list", {}, { context })).status).toBe(200);

    expect((await ui(`/ui/consent/revoke/${grantId}`, actor(operator))).status).toBe(404);
    expect((await ui(`/ui/consent/revoke/${grantId}`, actor(admin, "admin"))).status).toBe(404);
    expect(await uiJson(`/ui/consent/revoke/${grantId}`, actor(asker))).toEqual({ ok: true });
    expect((await grantRow(grantId)).status).toBe("revoked");

    const again = await errorOf(await agentExec("gmail.message.list", {}, { context }));
    expect(again).toMatchObject({ status: 409, error: "connector_consent_required" });
    const requests = await consentRows(asker.id, "revoked-agent");
    expect(requests.map((row) => row.status)).toEqual(["approved", "pending"]);
    expect(again.consentRequestId).toBe(requests[1]!.id);
  }, DB_TEST_TIMEOUT_MS);

  test("a person removed from the organization is no longer asked for", async () => {
    await insertConnection({ userId: leaver.id, isDefault: true });
    await consentFor(leaver, "c_leaver");
    const context = dmFrom("c_leaver");
    expect((await agentExec("gmail.message.list", {}, { context })).status).toBe(200);

    await sql`update organization_memberships set status = 'removed' where organization_id = ${orgId} and user_id = ${leaver.id}`;
    try {
      expect(await errorOf(await agentExec("gmail.message.list", {}, { context }))).toMatchObject({
        status: 403,
        error: "connector_not_linked",
        reason: "speaker_not_member",
      });
    } finally {
      await sql`update organization_memberships set status = 'active' where organization_id = ${orgId} and user_id = ${leaver.id}`;
    }
  }, DB_TEST_TIMEOUT_MS);

  test("with consent but no account connected, the person is sent to Connectors", async () => {
    await consentFor(noAccount, "c_noaccount", { agentId: "lonely-agent" });
    expect(
      await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_noaccount", { agentId: "lonely-agent" }) })),
    ).toMatchObject({
      status: 409,
      error: "connector_connection_required",
      connectorsUrl: `${CONSOLE}/connectors`,
    });
  }, DB_TEST_TIMEOUT_MS);

  test("a consent request expires: the link says so, the schedule closes it, the agent asks anew", async () => {
    const context = dmFrom("c_asker", { agentId: "slow-agent" });
    const asked = await errorOf(await agentExec("gmail.message.list", {}, { context }));
    const token = tokenOf(asked.consentUrl);
    await sql`update connector_consent_requests set expires_at = now() - interval '1 second' where id = ${asked.consentRequestId}`;

    expect(await uiJson("/ui/consent/resolve", { ...actor(asker), token })).toEqual({ state: "expired" });
    expect(await errorOf(await ui("/ui/consent/decide", { ...actor(asker), token, decision: "approve" }))).toMatchObject({
      status: 409,
      error: "connector_connect_unavailable",
      state: "expired",
    });
    expect((await consentRows(asker.id, "slow-agent"))[0]!.status).toBe("expired");

    const late = await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { agentId: "slow-agent-2" }) }));
    await sql`update connector_consent_requests set expires_at = now() - interval '1 second' where id = ${late.consentRequestId}`;
    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    expect(report.expired.consentRequests).toBeGreaterThanOrEqual(1);
    expect((await consentRows(asker.id, "slow-agent-2"))[0]!.status).toBe("expired");

    const anew = await errorOf(await agentExec("gmail.message.list", {}, { context }));
    expect(anew).toMatchObject({ status: 409, error: "connector_consent_required" });
    expect(anew.consentRequestId).not.toBe(asked.consentRequestId);
    const denied = await uiJson("/ui/consent/decide", { ...actor(asker), token: tokenOf(anew.consentUrl), decision: "deny" });
    expect(denied).toEqual({ status: "denied" });
    expect(await errorOf(await agentExec("gmail.message.list", {}, { context }))).toMatchObject({
      status: 409,
      error: "connector_consent_required",
    });
  }, DB_TEST_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Organization accounts
  // -------------------------------------------------------------------------

  let orgAccount: FakeAccount;
  let orgConnection: string;

  test("an organization account: owners and admins only, while sharing is allowed", async () => {
    expect(await errorOf(await startOrgConnect(admin, "admin"))).toMatchObject({
      status: 403,
      error: "connector_disabled_by_org",
      reason: "shared_not_allowed",
    });
    await setSharedAllowed(true);
    // A member, whatever role the request claims.
    expect(await errorOf(await startOrgConnect(member, "admin"))).toMatchObject({ status: 403, error: "connector_forbidden" });
    expect(await errorOf(await startOrgConnect(member, "developer"))).toMatchObject({ status: 403, error: "connector_forbidden" });
    // An admin must also say so.
    expect(await errorOf(await startOrgConnect(admin, "developer"))).toMatchObject({ status: 403, error: "connector_forbidden" });

    orgAccount = newAccount("team");
    const { resolved, finish } = await connectOrgAccount(admin, "admin", orgAccount);
    expect(resolved).toMatchObject({ state: "pending", scopeKind: "organization" });
    orgConnection = finish.connectionId;
    expect(typeof orgConnection).toBe("string");
    expect(finish).toEqual({
      state: "connected",
      connectionId: orgConnection,
      provider: "google",
      email: orgAccount.email,
      created: true,
      reconnected: false,
      accountChanged: false,
      origin: "ui",
      scopeKind: "organization",
    });
    expect(await connectionRow(orgConnection)).toMatchObject({
      scope_kind: "organization",
      user_id: null,
      managed_by_user_id: admin.id,
      granted_by_user_id: admin.id,
      external_account_id: orgAccount.sub,
      external_account_login: orgAccount.email,
      status: "active",
    });

    // Bound to no person in the vault.
    const credentials = await findCredentialsByConnection(vaultDb, orgConnection);
    const refresh = credentials.find((row) => row.payloadKind === "refresh_token")!;
    expect(
      await decryptStoredCredential(rootWrapKey, { id: orgConnection, organizationId: orgId, userId: null }, refresh),
    ).toMatch(/^rt-code-/);
    await expect(
      decryptStoredCredential(rootWrapKey, { id: orgConnection, organizationId: orgId, userId: admin.id }, refresh),
    ).rejects.toThrow();

    // The same account again by its manager: updated in place, still theirs.
    const again = await connectOrgAccount(admin, "admin", orgAccount);
    expect(again.finish).toMatchObject({ connectionId: orgConnection, created: false, reconnected: true, scopeKind: "organization" });
    expect((await connectionRow(orgConnection)).managed_by_user_id).toBe(admin.id);
    expect(
      await sql`select id from audit_events where target_id = ${orgConnection} and action = 'connector.org_connection.manager_changed'`,
    ).toHaveLength(0);

    // Never through the owner's exec.
    const bearer = opBearer;
    const direct = await call(
      new Request(`${LINK}/cli/exec/${orgConnection}`, {
        method: "POST",
        body: JSON.stringify({ capability: "gmail.message.list", parameters: {} }),
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-ravi-exec-context": encodeContext(sharedDm) },
      }),
    );
    expect(await errorOf(direct)).toMatchObject({ status: 403, error: "connector_forbidden" });
  }, DB_TEST_TIMEOUT_MS);

  test("owners and admins list organization accounts with their manager", async () => {
    const listed = await uiJson("/ui/org/connections/list", actor(owner, "owner"));
    expect(listed.connections.find((row: J) => row.id === orgConnection)).toMatchObject({
      id: orgConnection,
      scopeKind: "organization",
      email: orgAccount.email,
      status: "active",
      managedBy: { userId: admin.id, email: admin.email },
    });
    expect(listed.connections.every((row: J) => row.scopeKind === "organization")).toBe(true);
    // Another member sees only the accounts they manage (none yet), whatever role the request claims.
    expect(await uiJson("/ui/org/connections/list", actor(member, "admin"))).toEqual({ connections: [] });
    expect(await uiJson("/ui/org/connections/list", actor(member))).toEqual({ connections: [] });
    // Someone outside the organization sees nothing.
    expect((await ui("/ui/org/connections/list", { userId: randomUUID(), organizationId: orgId, role: "owner" })).status).toBe(403);

    const adminList = await uiJson("/ui/admin/connections/list", actor(admin, "admin"));
    expect(adminList.connections.find((row: J) => row.id === orgConnection)).toMatchObject({
      scopeKind: "organization",
      member: { userId: admin.id, email: admin.email },
    });
  }, DB_TEST_TIMEOUT_MS);

  test("shared: only the agent given the account, in the conversations named", async () => {
    expect(await errorOf(await agentExec("gmail.message.list", {}, { mode: "shared", context: sharedDm }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
      reason: "no_shared_grant",
    });

    // Who may share it, and with what.
    expect(await errorOf(await shareWith(orgConnection, member))).toMatchObject({ status: 403, error: "connector_forbidden" });
    expect(await errorOf(await shareWith(orgConnection, admin, { conversations: ["terminal"] }))).toMatchObject({
      status: 400,
      error: "payload_invalid",
    });
    expect(await errorOf(await shareWith(orgConnection, admin, { installationId: foreignInstallation }))).toMatchObject({
      status: 400,
      error: "payload_invalid",
    });
    const askerConnection = (await sql<{ id: string }[]>`
      select id from provider_connections where user_id = ${asker.id} and is_default
    `)[0]!.id;
    expect((await shareWith(askerConnection, admin)).status).toBe(404);

    const shared = await shareWith(orgConnection, admin);
    expect(shared.status).toBe(201);
    const { grantId } = (await shared.json()) as J;
    expect(await grantRow(grantId)).toMatchObject({
      mode: "shared",
      provider_connection_id: orgConnection,
      granted_by_user_id: admin.id,
      agent_id: "support",
      conversations_json: ["dm"],
    });
    const grants = await uiJson("/ui/org/shared/list", { ...actor(admin, "admin"), connectionId: orgConnection });
    expect(grants.grants).toEqual([
      {
        id: grantId,
        mode: "shared",
        provider: "google",
        agentId: "support",
        installationId: opInstallation,
        installationName: "op-laptop",
        operator: { userId: operator.id, email: operator.email },
        connectionId: orgConnection,
        email: orgAccount.email,
        conversations: ["dm"],
        createdAt: expect.any(String),
      },
    ]);
    expect((await uiJson("/ui/org/shared/list", actor(member))).grants).toEqual([]);
    const detail = await uiJson(`/ui/connect/detail/${orgConnection}`, actor(admin));
    expect(detail.grants.map((row: J) => row.id)).toEqual([grantId]);
    expect(detail.managedBy).toEqual({ userId: admin.id, email: admin.email });
    expect((await ui(`/ui/connect/detail/${orgConnection}`, actor(member))).status).toBe(404);

    // Free/busy runs; other reads are blocked by default.
    const freeBusy = await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm });
    expect(freeBusy.status).toBe(200);
    expect(fakeGoogle.freeBusyTokens.at(-1)).toMatch(/^Bearer at-code-/);
    expect(await usageRow(orgConnection, "shared")).toMatchObject({
      local_installation_id: opInstallation,
      agent_id: "support",
      conversation: "dm",
    });
    expect(await errorOf(await agentExec("gmail.message.list", {}, { mode: "shared", context: sharedDm }))).toMatchObject({
      status: 403,
      error: "connector_tool_blocked",
    });
    const tools = (await uiJson(`/ui/connect/detail/${orgConnection}`, actor(admin))).tools as J[];
    expect(tools.find((tool) => tool.capability === "gmail.message.list")).toMatchObject({ policy: "blocked" });
    expect(tools.find((tool) => tool.capability === "gcal.freebusy.query")).toMatchObject({ policy: "always_allow" });

    // Only the conversations named; another agent has nothing.
    expect(
      await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: { ...sharedDm, conversation: "group" } })),
    ).toMatchObject({ status: 403, error: "connector_group_blocked" });
    expect(
      await errorOf(
        await agentExec("gcal.freebusy.query", freeBusyParams, {
          mode: "shared",
          context: { agentId: "support", speaker: { kind: "terminal" }, conversation: "terminal" },
        }),
      ),
    ).toMatchObject({ status: 403, error: "connector_forbidden" });
    expect(
      await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: { ...sharedDm, agentId: "main" } })),
    ).toMatchObject({ status: 403, error: "connector_forbidden" });

    // Never a relay from another agent, a trigger, or an automation other than the operator's routines.
    const relayed: ExecContext[] = [
      { ...sharedDm, speaker: { kind: "agent" } },
      { ...sharedDm, routine: { kind: "trigger", id: "t1" } },
      { ...sharedDm, speaker: { kind: "automation" } },
      { ...sharedDm, speaker: { kind: "automation" }, routine: { kind: "trigger", id: "t2" } },
    ];
    for (const context of relayed) {
      expect(await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context }))).toMatchObject({
        status: 403,
        error: "connector_speaker_not_owner",
        reason: "speaker_not_allowed",
      });
    }
    // The operator's cron job, in a conversation the grant names, runs.
    expect(
      (
        await agentExec("gcal.freebusy.query", freeBusyParams, {
          mode: "shared",
          context: { ...sharedDm, speaker: { kind: "automation" }, routine: { kind: "cron", id: "daily" } },
        })
      ).status,
    ).toBe(200);

    // Groups once named.
    expect((await shareWith(orgConnection, admin, { conversations: ["group", "dm", "dm"] })).status).toBe(201);
    expect((await grantRow(grantId)).conversations_json).toEqual(["dm", "group"]);
    expect(
      (await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: { ...sharedDm, conversation: "group" } })).status,
    ).toBe(200);

    // Sharing switched off by the organization.
    await setSharedAllowed(false);
    try {
      expect(await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm }))).toMatchObject({
        status: 403,
        error: "connector_disabled_by_org",
        reason: "shared_not_allowed",
      });
    } finally {
      await setSharedAllowed(true);
    }

    // The connector switched off for the organization: refused, with no details.
    expect((await ui("/ui/admin/policy/set", { ...actor(admin, "admin"), provider: "google", enabled: false })).status).toBe(200);
    try {
      const off = await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm }));
      expect(off).toMatchObject({ status: 403, error: "connector_disabled_by_org" });
      expect(off.reason).toBeUndefined();
    } finally {
      expect((await ui("/ui/admin/policy/set", { ...actor(admin, "admin"), provider: "google", enabled: true })).status).toBe(200);
    }
  }, DB_TEST_TIMEOUT_MS);

  test("shared: the manager may allow reads; writes wait for the manager", async () => {
    // A member who does not manage it cannot change its tools.
    expect(
      (await ui(`/ui/connect/tools/${orgConnection}`, { ...actor(member), capability: "gmail.message.list", policy: "always_allow" })).status,
    ).toBe(404);
    expect(
      (await ui(`/ui/connect/tools/${orgConnection}`, { ...actor(admin), capability: "gmail.message.list", policy: "always_allow" })).status,
    ).toBe(200);
    expect((await agentExec("gmail.message.list", {}, { mode: "shared", context: sharedDm })).status).toBe(200);
    expect(fakeGoogle.reads.at(-1)).toMatch(/^at-code-/);

    const asked = await errorOf(await agentExec("gmail.message.send", sendParams("From the team"), { mode: "shared", context: sharedDm }));
    expect(asked).toMatchObject({ status: 409, error: "connector_approval_required" });
    expect(await approvalRow(asked.approvalId)).toMatchObject({
      owner_user_id: admin.id,
      requested_by_user_id: operator.id,
      provider_connection_id: orgConnection,
    });
    expect((await uiJson("/ui/approvals/list", actor(admin))).approvals.map((row: J) => row.id)).toContain(asked.approvalId);
    expect((await uiJson("/ui/approvals/list", actor(owner))).approvals.map((row: J) => row.id)).not.toContain(asked.approvalId);
    expect(await uiJson(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(admin), decision: "approve" })).toEqual({
      status: "approved",
    });
    const sent = await agentExec("gmail.message.send", sendParams("From the team"), {
      mode: "shared",
      context: sharedDm,
      approval: asked.approvalId,
    });
    expect(sent.status).toBe(200);
    expect(fakeGoogle.sent.at(-1)!.subject).toBe("From the team");
    expect(fakeGoogle.sent.at(-1)!.accessToken).toMatch(/^at-code-/);
  }, DB_TEST_TIMEOUT_MS);

  test("Change owner: approvals move to the new manager, who may reconnect the account", async () => {
    const waiting = await errorOf(await agentExec("gmail.message.send", sendParams("Pending"), { mode: "shared", context: sharedDm }));
    expect((await approvalRow(waiting.approvalId)).owner_user_id).toBe(admin.id);

    // Owners and admins only; the new manager must be an active member.
    expect((await ui(`/ui/org/connections/owner/${orgConnection}`, { ...actor(member, "admin"), managedByUserId: member.id })).status).toBe(403);
    expect(
      await errorOf(await ui(`/ui/org/connections/owner/${orgConnection}`, { ...actor(owner, "owner"), managedByUserId: randomUUID() })),
    ).toMatchObject({ status: 400, error: "payload_invalid" });
    const credentialsBefore = await sql`
      select payload_kind, ciphertext from connector_credentials where provider_connection_id = ${orgConnection} order by payload_kind
    `;
    expect(await uiJson(`/ui/org/connections/owner/${orgConnection}`, { ...actor(owner, "owner"), managedByUserId: member.id })).toEqual({
      ok: true,
    });
    expect((await connectionRow(orgConnection)).managed_by_user_id).toBe(member.id);
    expect((await approvalRow(waiting.approvalId)).status).toBe("expired");
    // Nothing re-encrypted.
    expect(
      [...(await sql`select payload_kind, ciphertext from connector_credentials where provider_connection_id = ${orgConnection} order by payload_kind`)],
    ).toEqual([...credentialsBefore]);
    const [changed] = await sql`
      select actor_id, metadata_json from audit_events
      where target_id = ${orgConnection} and action = 'connector.org_connection.manager_changed'
    `;
    expect(changed).toMatchObject({
      actor_id: owner.id,
      metadata_json: { previousManagerUserId: admin.id, managedByUserId: member.id, movedGrants: 1 },
    });

    // The account's shared grants move with it: none still names the previous
    // manager, so that member leaving (the Console revokes the grants they
    // gave) never takes the agents' access to the account with them.
    const sharedGrants = await sql`
      select id, granted_by_user_id from agent_connector_grants
      where provider_connection_id = ${orgConnection} and status = 'active'
    `;
    expect(sharedGrants.map((row) => row.granted_by_user_id)).toEqual([member.id]);
    await sql`
      update agent_connector_grants set status = 'revoked', revoked_at = now(), updated_at = now()
      where organization_id = ${orgId} and status = 'active' and granted_by_user_id = ${admin.id}
        and provider_connection_id = ${orgConnection}
    `;
    expect((await grantRow(sharedGrants[0]!.id)).status).toBe("active");
    expect((await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm })).status).toBe(200);

    // The new manager (a developer) finds the account (only the ones they
    // manage), opens it and sets its tool rules: decided by the Worker from
    // who they are, whatever role the request names.
    expect((await uiJson("/ui/org/connections/list", actor(member))).connections.map((row: J) => row.id)).toEqual([orgConnection]);
    expect(await uiJson(`/ui/connect/detail/${orgConnection}`, actor(member))).toMatchObject({
      id: orgConnection,
      managedBy: { userId: member.id, email: member.email },
    });
    expect(
      await uiJson(`/ui/connect/tools/${orgConnection}`, { ...actor(member), capability: "gmail.message.read", policy: "blocked" }),
    ).toEqual({ ok: true });
    // The previous manager, an admin, still opens it as an admin; a member who never managed it does not.
    expect((await ui(`/ui/connect/detail/${orgConnection}`, actor(admin))).status).toBe(200);
    expect((await ui(`/ui/connect/detail/${orgConnection}`, actor(operator))).status).toBe(404);

    const asked = await errorOf(await agentExec("gmail.message.send", sendParams("New manager"), { mode: "shared", context: sharedDm }));
    expect((await approvalRow(asked.approvalId)).owner_user_id).toBe(member.id);
    expect((await uiJson("/ui/approvals/list", actor(member))).approvals.map((row: J) => row.id)).toContain(asked.approvalId);
    expect((await ui(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(admin), decision: "approve" })).status).toBe(404);

    // The manager now lists and gives shared grants of it.
    expect((await uiJson("/ui/org/shared/list", actor(member))).grants.map((row: J) => row.connectionId)).toEqual([orgConnection]);
    expect(await errorOf(await shareWith(orgConnection, operator))).toMatchObject({ status: 403, error: "connector_forbidden" });

    // The manager reconnects it (a developer, no admin role)...
    const reconnected = await connectOrgAccount(member, "developer", orgAccount, { reconnectConnectionId: orgConnection });
    expect(reconnected.finish).toMatchObject({ connectionId: orgConnection, reconnected: true, scopeKind: "organization" });
    expect((await connectionRow(orgConnection)).managed_by_user_id).toBe(member.id);
    // ...but cannot swap in another account...
    const swapped = await connectOrgAccount(member, "developer", newAccount("swap"), { reconnectConnectionId: orgConnection });
    expect(swapped.finish).toEqual({ state: "rejected", reason: "account_changed" });
    // ...nor start a new one; another member cannot reconnect it.
    expect((await startOrgConnect(member, "developer")).status).toBe(403);
    expect((await startOrgConnect(operator, "developer", { reconnectConnectionId: orgConnection })).status).toBe(403);
  }, DB_TEST_TIMEOUT_MS);

  test("a manager's reconnect never puts an unknown account under an organization account", async () => {
    const account = newAccount("managed-id");
    const id = (await connectOrgAccount(admin, "admin", account)).finish.connectionId;
    expect(await uiJson(`/ui/org/connections/owner/${id}`, { ...actor(owner, "owner"), managedByUserId: member.id })).toEqual({ ok: true });
    const credentials = async () => [
      ...(await sql`select payload_kind, ciphertext from connector_credentials where provider_connection_id = ${id} order by payload_kind`),
    ];
    const before = await credentials();

    // Another Google account, signed in with the identity scopes taken out
    // of the sign-in URL: nothing says whose tokens they are.
    const hidden = await connectOrgAccount(member, "developer", { ...newAccount("hidden"), withoutIdToken: true }, {
      reconnectConnectionId: id,
    });
    expect(hidden.finish).toEqual({ state: "rejected", reason: "identity_missing" });
    expect(await credentials()).toEqual(before);

    // A row whose account is unknown is no row the manager may fill with
    // whichever account they sign in with.
    await sql`
      update provider_connections
      set external_account_id = null, external_account_login = null, metadata_json = metadata_json - 'googleSub'
      where id = ${id}
    `;
    await sql`delete from connector_credentials where provider_connection_id = ${id} and payload_kind = 'id_token'`;
    const withoutIdentity = await credentials();
    const other = await connectOrgAccount(member, "developer", newAccount("other"), { reconnectConnectionId: id });
    expect(other.finish).toEqual({ state: "rejected", reason: "account_changed" });
    expect(await credentials()).toEqual(withoutIdentity);
    expect((await connectionRow(id)).managed_by_user_id).toBe(member.id);

    // An admin adds that account as its own organization account instead.
    const added = await connectOrgAccount(admin, "admin", newAccount("added"), { reconnectConnectionId: id });
    expect(added.finish).toMatchObject({ state: "connected", created: true, accountChanged: true, scopeKind: "organization" });
    expect(added.finish.connectionId).not.toBe(id);
    expect(await credentials()).toEqual(withoutIdentity);
  }, DB_TEST_TIMEOUT_MS);

  test("an account nobody manages: every owner and admin decides, the first owner is asked", async () => {
    const account = newAccount("unmanaged");
    const { finish } = await connectOrgAccount(admin, "admin", account);
    const id = finish.connectionId;
    expect((await shareWith(id, admin, { agentId: "helpdesk" })).status).toBe(201);
    await sql`update provider_connections set managed_by_user_id = null where id = ${id}`;
    const context = { ...sharedDm, agentId: "helpdesk" };

    const asked = await errorOf(await agentExec("gmail.message.send", sendParams("Unmanaged"), { mode: "shared", context }));
    expect(asked).toMatchObject({ status: 409, error: "connector_approval_required" });
    expect((await approvalRow(asked.approvalId)).owner_user_id).toBe(owner.id);
    expect((await uiJson("/ui/approvals/list", actor(owner))).approvals.map((row: J) => row.id)).toContain(asked.approvalId);
    expect((await uiJson("/ui/approvals/list", actor(admin))).approvals.map((row: J) => row.id)).toContain(asked.approvalId);
    expect((await uiJson("/ui/approvals/list", actor(member))).approvals.map((row: J) => row.id)).not.toContain(asked.approvalId);
    expect((await ui(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(member), decision: "approve" })).status).toBe(404);
    // Any owner or admin opens it (with what it would send); another member cannot.
    expect(await uiJson(`/ui/approvals/get/${asked.approvalId}`, actor(admin))).toMatchObject({
      id: asked.approvalId,
      status: "pending",
      preview: { subject: "Unmanaged" },
    });
    expect((await ui(`/ui/approvals/get/${asked.approvalId}`, actor(member))).status).toBe(404);
    expect(await uiJson(`/ui/approvals/decide/${asked.approvalId}`, { ...actor(admin), decision: "approve" })).toEqual({
      status: "approved",
    });
    expect((await approvalRow(asked.approvalId)).decided_by_user_id).toBe(admin.id);
    expect((await approvalRow(asked.approvalId)).owner_user_id).toBe(owner.id);
    expect(
      (await agentExec("gmail.message.send", sendParams("Unmanaged"), { mode: "shared", context, approval: asked.approvalId })).status,
    ).toBe(200);

    // Connected again by an admin, who now manages it: what still waited on
    // the first owner is expired (the admin is asked on the retry), and only
    // the manager sees new requests.
    const stranded = await errorOf(await agentExec("gmail.message.send", sendParams("Stranded"), { mode: "shared", context }));
    expect((await approvalRow(stranded.approvalId)).owner_user_id).toBe(owner.id);
    const reconnected = await connectOrgAccount(admin, "admin", account);
    expect(reconnected.finish).toMatchObject({ connectionId: id, reconnected: true, created: false });
    expect((await connectionRow(id)).managed_by_user_id).toBe(admin.id);
    expect((await approvalRow(stranded.approvalId)).status).toBe("expired");
    expect((await uiJson("/ui/approvals/list", actor(owner))).approvals.map((row: J) => row.id)).not.toContain(stranded.approvalId);
    const [adopted] = await sql`
      select actor_id, metadata_json from audit_events
      where target_id = ${id} and action = 'connector.org_connection.manager_changed'
    `;
    expect(adopted).toMatchObject({
      actor_id: admin.id,
      metadata_json: { reason: "connected", previousManagerUserId: null, managedByUserId: admin.id, expiredApprovals: 1 },
    });
    const retried = await errorOf(await agentExec("gmail.message.send", sendParams("Stranded"), { mode: "shared", context }));
    expect(retried).toMatchObject({ status: 409, error: "connector_approval_required" });
    expect((await approvalRow(retried.approvalId)).owner_user_id).toBe(admin.id);
    expect((await uiJson("/ui/approvals/list", actor(owner))).approvals.map((row: J) => row.id)).not.toContain(retried.approvalId);
    expect((await ui(`/ui/approvals/get/${retried.approvalId}`, actor(owner))).status).toBe(404);

    // An expired access token is refreshed and stored for no person.
    await sql`update connector_credentials set expires_at = now() - interval '1 minute' where provider_connection_id = ${id} and payload_kind = 'access_token'`;
    const refreshed = await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as J).refreshed).toBe(true);
    const freshToken = fakeGoogle.freeBusyTokens.at(-1)!;
    expect(freshToken).toMatch(/^Bearer at-refreshed-/);
    expect((await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context })).status).toBe(200);
    expect(fakeGoogle.freeBusyTokens.at(-1)).toBe(freshToken);
    const access = (await findCredentialsByConnection(vaultDb, id)).find((row) => row.payloadKind === "access_token")!;
    expect(await decryptStoredCredential(rootWrapKey, { id, organizationId: orgId, userId: null }, access)).toBe(
      freshToken.slice("Bearer ".length),
    );

    // Disconnected by an admin from the organization's list: shared grants go with it.
    const grant = (await sql<{ id: string }[]>`select id from agent_connector_grants where provider_connection_id = ${id}`)[0]!;
    expect((await ui(`/ui/admin/connections/revoke/${id}`, actor(member, "admin"))).status).toBe(403);
    const revokedBefore = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/admin/connections/revoke/${id}`, actor(admin, "admin"))).toEqual({ revoked: true });
    expect((await connectionRow(id)).status).toBe("revoked_by_operator");
    expect((await grantRow(grant.id)).status).toBe("revoked");
    // No other row holds the account: its Google grant is revoked too.
    expect(fakeGoogle.revoked.length).toBe(revokedBefore + 1);
    expect(fakeGoogle.revoked.at(-1)).toMatch(/^rt-code-/);
    expect(await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
    });
  }, DB_TEST_TIMEOUT_MS);

  test("revoking a shared grant or the account stops the agent", async () => {
    const [grant] = await sql<{ id: string }[]>`
      select id from agent_connector_grants where provider_connection_id = ${orgConnection} and status = 'active'
    `;
    // The manager (or an owner or admin) revokes a shared grant; not anyone.
    expect((await ui(`/ui/org/shared/revoke/${grant!.id}`, actor(operator))).status).toBe(404);
    expect(await uiJson(`/ui/org/shared/revoke/${grant!.id}`, actor(member))).toEqual({ ok: true });
    expect(await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
    });

    const regrant = (await (await shareWith(orgConnection, member)).json()) as J;
    expect((await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm })).status).toBe(200);

    // Disconnecting the account: not by a member who does not manage it; by its manager.
    expect((await ui(`/ui/connect/revoke/${orgConnection}`, actor(operator))).status).toBe(404);
    const revokedBefore = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${orgConnection}`, actor(member))).toEqual({ revoked: true });
    expect((await connectionRow(orgConnection)).status).toBe("revoked_by_user");
    expect(fakeGoogle.revoked.length).toBe(revokedBefore + 1);
    expect((await grantRow(regrant.grantId)).status).toBe("revoked");
    expect(await sql`select id from connector_credentials where provider_connection_id = ${orgConnection}`).toHaveLength(0);
    expect(await errorOf(await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: sharedDm }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
    });
  }, DB_TEST_TIMEOUT_MS);

  test("a manager cannot take an agent off another organization account; an owner or admin can, audited", async () => {
    const salesAccount = newAccount("sales");
    const sales = (await connectOrgAccount(admin, "admin", salesAccount)).finish.connectionId as string;
    const help = (await connectOrgAccount(admin, "admin", newAccount("help"))).finish.connectionId as string;
    for (const [id, manager] of [[sales, noAccount], [help, leaver]] as const) {
      expect(await uiJson(`/ui/org/connections/owner/${id}`, { ...actor(owner, "owner"), managedByUserId: manager.id })).toEqual({
        ok: true,
      });
    }
    const context = { ...sharedDm, agentId: "desk" };
    const helpGrant = ((await (await shareWith(help, leaver, { agentId: "desk" })).json()) as J).grantId as string;
    expect(await grantRow(helpGrant)).toMatchObject({ provider_connection_id: help, granted_by_user_id: leaver.id });

    // The manager of sales may neither move the agent off help nor revoke its grant there.
    expect(await errorOf(await shareWith(sales, noAccount, { agentId: "desk", conversations: ["dm", "group"] }))).toMatchObject({
      status: 403,
      error: "connector_forbidden",
      reason: "agent_uses_other_account",
    });
    expect((await ui(`/ui/org/shared/revoke/${helpGrant}`, actor(noAccount))).status).toBe(404);
    expect(await grantRow(helpGrant)).toMatchObject({ status: "active", provider_connection_id: help, conversations_json: ["dm"] });
    const onHelp = await errorOf(await agentExec("gmail.message.send", sendParams("Desk"), { mode: "shared", context }));
    expect(await approvalRow(onHelp.approvalId)).toMatchObject({ owner_user_id: leaver.id, provider_connection_id: help });

    // The manager of help updates the agent's grant there in place.
    const updated = ((await (await shareWith(help, leaver, { agentId: "desk", conversations: ["dm", "group"] })).json()) as J).grantId;
    expect(updated).toBe(helpGrant);

    // An admin moves the agent to sales: the grant on help is revoked and audited as replaced.
    const moved = ((await (await shareWith(sales, admin, { agentId: "desk" })).json()) as J).grantId as string;
    expect(moved).not.toBe(helpGrant);
    expect((await grantRow(helpGrant)).status).toBe("revoked");
    // Given in the name of the account's manager, not the admin's.
    expect(await grantRow(moved)).toMatchObject({ provider_connection_id: sales, granted_by_user_id: noAccount.id, status: "active" });
    const [replaced] = await sql`
      select actor_id, metadata_json from audit_events
      where target_id = ${helpGrant} and action = 'connector.agent_grant.revoked'
    `;
    expect(replaced).toMatchObject({
      actor_id: admin.id,
      metadata_json: { reason: "replaced", replacedByGrantId: moved, providerConnectionId: help, agentId: "desk" },
    });
    const active = await sql`
      select id from agent_connector_grants
      where local_installation_id = ${opInstallation} and agent_id = 'desk' and mode = 'shared' and status = 'active'
    `;
    expect(active.map((row) => row.id)).toEqual([moved]);
    const onSales = await errorOf(await agentExec("gmail.message.send", sendParams("Desk"), { mode: "shared", context }));
    expect(await approvalRow(onSales.approvalId)).toMatchObject({ owner_user_id: noAccount.id, provider_connection_id: sales });

    // An admin connects sales again: whoever connects the account manages
    // it, exactly as "Change owner" (the old manager's open requests expire,
    // the account's shared grants move to the new manager).
    const again = await connectOrgAccount(admin, "admin", salesAccount);
    expect(again.finish).toMatchObject({ connectionId: sales, reconnected: true, created: false });
    expect((await connectionRow(sales)).managed_by_user_id).toBe(admin.id);
    expect((await approvalRow(onSales.approvalId)).status).toBe("expired");
    expect(await grantRow(moved)).toMatchObject({ status: "active", granted_by_user_id: admin.id });
    const [adopted] = await sql`
      select metadata_json from audit_events
      where target_id = ${sales} and action = 'connector.org_connection.manager_changed'
        and metadata_json->>'reason' = 'connected'
    `;
    expect(adopted!.metadata_json).toMatchObject({
      previousManagerUserId: noAccount.id,
      managedByUserId: admin.id,
      expiredApprovals: 1,
      movedGrants: 1,
    });
    const retried = await errorOf(await agentExec("gmail.message.send", sendParams("Desk"), { mode: "shared", context }));
    expect(await approvalRow(retried.approvalId)).toMatchObject({ owner_user_id: admin.id, provider_connection_id: sales });
  }, DB_TEST_TIMEOUT_MS);

  test("a grant never outlives a disconnect that runs at the same time", async () => {
    /** Run `during` while the row is locked as a disconnect locks it, and close the row (and its grants) before letting go. */
    async function whileDisconnecting(connectionId: string, during: () => Promise<Response>): Promise<Response> {
      let pending: Promise<Response> | undefined;
      await sql.begin(async (tx) => {
        await tx`select id from provider_connections where id = ${connectionId} for update`;
        const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as "pid"`;
        const pid = backend!.pid;
        pending = during();
        // Until the request waits on this transaction's row lock.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [waiting] = await sql<{ count: number }[]>`
            select count(*)::int as "count" from pg_stat_activity
            where ${pid}::int = any(pg_blocking_pids(pid)) and query ilike '%for share%'
          `;
          if (waiting!.count > 0) break;
          if (Date.now() > deadline) throw new Error("the grant never waited on the connection row");
          await Bun.sleep(20);
        }
        await tx`
          update provider_connections
          set status = 'revoked_by_user', revoked_at = now(), is_default = false, updated_at = now()
          where id = ${connectionId}
        `;
        await tx`
          update agent_connector_grants set status = 'revoked', revoked_at = now(), updated_at = now()
          where provider_connection_id = ${connectionId} and status = 'active'
        `;
      });
      return pending!;
    }
    const activeGrants = async (connectionId: string) =>
      sql`select id from agent_connector_grants where provider_connection_id = ${connectionId} and status = 'active'`;

    // Sharing an organization account.
    const account = (await connectOrgAccount(admin, "admin", newAccount("race"))).finish.connectionId as string;
    const shared = await whileDisconnecting(account, () => shareWith(account, admin, { agentId: "racer" }));
    expect(await errorOf(shared)).toMatchObject({ status: 400, error: "payload_invalid" });
    expect(await activeGrants(account)).toHaveLength(0);

    // Consent pinned to one of the person's accounts.
    const chosen = await insertConnection({ userId: asker.id });
    const asked = await errorOf(await agentExec("gmail.message.list", {}, { context: dmFrom("c_asker", { agentId: "race-agent" }) }));
    expect(asked).toMatchObject({ status: 409, error: "connector_consent_required" });
    const decided = await whileDisconnecting(chosen, () =>
      ui("/ui/consent/decide", { ...actor(asker), token: tokenOf(asked.consentUrl), decision: "approve", connectionId: chosen }),
    );
    expect(await errorOf(decided)).toMatchObject({ status: 400, error: "payload_invalid" });
    expect(await activeGrants(chosen)).toHaveLength(0);
    expect((await consentRows(asker.id, "race-agent")).map((row) => row.status)).toEqual(["pending"]);
  }, DB_TEST_TIMEOUT_MS);

  test("one Google account as a person's own and as an organization account: Google's grant stays while either is connected", async () => {
    const adminBearer = await cliSessionFor(admin, "ada-laptop");

    // The organization account goes first: the person's own keeps working.
    const both = newAccount("both");
    const personal = await insertConnection({ userId: admin.id, sub: both.sub });
    const org = (await connectOrgAccount(admin, "admin", both)).finish.connectionId as string;
    expect(await connectionRow(org)).toMatchObject({ scope_kind: "organization", external_account_id: both.sub });
    const before = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/admin/connections/revoke/${org}`, actor(admin, "admin"))).toEqual({ revoked: true });
    expect((await connectionRow(org)).status).toBe("revoked_by_operator");
    expect(fakeGoogle.revoked.length).toBe(before);
    expect((await ownExec(adminBearer, personal, "gmail.message.list", {})).status).toBe(200);
    expect(fakeGoogle.reads.at(-1)).toBe(`at-${personal}`);
    // Nothing else holds it now: disconnecting the person's own revokes Google's grant.
    expect(await uiJson(`/ui/connect/revoke/${personal}`, actor(admin))).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before + 1);
    expect(fakeGoogle.revoked.at(-1)).toBe(`rt-${personal}`);

    // The person's own goes first: the organization account keeps working.
    const again = newAccount("both-again");
    const personalAgain = await insertConnection({ userId: admin.id, sub: again.sub });
    const orgAgain = (await connectOrgAccount(admin, "admin", again)).finish.connectionId as string;
    expect(await uiJson(`/ui/connect/revoke/${personalAgain}`, actor(admin))).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before + 1);
    expect((await shareWith(orgAgain, admin, { agentId: "both-agent" })).status).toBe(201);
    expect(
      (await agentExec("gcal.freebusy.query", freeBusyParams, { mode: "shared", context: { ...sharedDm, agentId: "both-agent" } })).status,
    ).toBe(200);
    expect(await uiJson(`/ui/admin/connections/revoke/${orgAgain}`, actor(admin, "admin"))).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before + 2);
  }, DB_TEST_TIMEOUT_MS);
});
