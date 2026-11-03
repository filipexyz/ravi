import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import postgres from "postgres";

import { createGoogleAdapter, type GoogleCapabilityHandler } from "./adapters/google";
import type { ConnectorAdapter } from "./adapters/adapter";
import { importRootWrapKey } from "./crypto";
import {
  lockProviderConnection,
  openConnectorsDb,
  refreshConnectionAfterConnect,
  withTransaction,
  type ConnectorsDb,
} from "./db";
import type { ConnectorsWorkerEnv, HyperdriveBinding } from "./env";
import { signHmacRequest } from "./hmac";
import { createConnectorsWorker } from "./router";
import { runScheduledMaintenance } from "./scheduled";
import { decryptStoredCredential, storeConnectionTokens } from "./vault";

// End-to-end connect flow, lists, revoke, refresh and scheduled maintenance
// against a migrated Console database (migration 0050), with a fake Google
// token/revoke endpoint. Runs only with CONNECTORS_TEST_DATABASE_URL; creates
// and deletes its own fixtures.
const url = process.env.CONNECTORS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
// Every committed write waits for the database to flush; a flow test makes
// a dozen of them.
const DB_TEST_TIMEOUT_MS = 60_000;

type J = any;

const ROOT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const HMAC_KEY = "connect-flow-test-hmac-key";
const HMAC_KEY_ID = "k_connect_flow";
const CLI_SECRET = "connect-flow-test-cli-secret-0123456789";
const CONSOLE = "https://console.test";
const LINK = "https://link.test";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const DRIVE = "https://www.googleapis.com/auth/drive";
const GMAIL_SETTINGS_SHARING = "https://www.googleapis.com/auth/gmail.settings.sharing";

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const org2Id = randomUUID();
const userA = { id: randomUUID(), email: `cf-${suffix}-a@example.test` };
const userB = { id: randomUUID(), email: `cf-${suffix}-b@example.test` };
const projectId = randomUUID();
const installationA = randomUUID();
const revokedInstallationA = randomUUID();
const sessionA = { id: randomUUID(), jti: randomUUID() };
const sessionRevokedInstallation = { id: randomUUID(), jti: randomUUID() };
const actorA = { userId: userA.id, organizationId: orgId };
const actorB = { userId: userB.id, organizationId: orgId };

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
  exchanges: 0,
  revoked: [] as string[],
  refreshes: [] as string[],
  revokeFails: false,
  refreshFails: false,
  seq: 0,
  execAccessTokens: [] as string[],
};

function idTokenFor(account: { sub: string; email: string }): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: account.sub, email: account.email, aud: "client" })}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (target === GOOGLE_TOKEN_URL && body.get("grant_type") === "authorization_code") {
    fakeGoogle.exchanges += 1;
    const account = fakeGoogle.codes.get(body.get("code") ?? "");
    if (!account || !body.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
    fakeGoogle.seq += 1;
    return json({
      access_token: `at-${fakeGoogle.seq}`,
      refresh_token: `rt-${fakeGoogle.seq}`,
      ...(account.withoutIdToken ? {} : { id_token: idTokenFor(account) }),
      expires_in: 3600,
      scope: (account.scopes ?? []).join(" "),
      token_type: "Bearer",
    });
  }
  if (target === GOOGLE_TOKEN_URL && body.get("grant_type") === "refresh_token") {
    fakeGoogle.refreshes.push(body.get("refresh_token") ?? "");
    if (fakeGoogle.refreshFails) return json({ error: "invalid_grant" }, 400);
    fakeGoogle.seq += 1;
    return json({
      access_token: `at-refreshed-${fakeGoogle.seq}`,
      refresh_token: `rt-refreshed-${fakeGoogle.seq}`,
      expires_in: 3600,
    });
  }
  if (target === GOOGLE_REVOKE_URL) {
    if (fakeGoogle.revokeFails) return json({ error: "backend" }, 503);
    fakeGoogle.revoked.push(body.get("token") ?? "");
    return json({});
  }
  throw new Error(`unexpected fetch ${target}`);
}) as typeof fetch;

const listHandler: GoogleCapabilityHandler = {
  async execute(input) {
    fakeGoogle.execAccessTokens.push(input.accessToken);
    return { messages: [], resultSizeEstimate: 0 };
  },
};

const adapters = new Map<string, ConnectorAdapter>([
  [
    "google",
    createGoogleAdapter({
      config: { clientId: "client", clientSecret: "secret", fetchImpl: fakeFetch },
      capabilities: new Map([["gmail.message.list", listHandler]]),
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

async function cli(method: "GET" | "POST", path: string, bearer: string, body?: unknown): Promise<Response> {
  return call(
    new Request(`${LINK}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    }),
  );
}

async function bearerFor(
  session: { id: string; jti: string },
  installationId: string,
  userId: string = userA.id,
): Promise<string> {
  return new SignJWT({ sid: session.id, li: installationId, org: orgId, scopes: [] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("ravi-console")
    .setAudience("ravi-cli")
    .setSubject(userId)
    .setJti(session.jti)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(CLI_SECRET));
}

function newAccount(label = "acct"): FakeAccount {
  const id = randomUUID().slice(0, 8);
  return { sub: `sub-${id}`, email: `${label}-${id}@gmail.test` };
}

interface ConnectOptions {
  accessMode?: string;
  reconnectConnectionId?: string;
  /** Sent in the start body; the Worker must ignore it. */
  scopes?: string[];
  /** Scopes the fake token response adds, as Google does for scopes granted earlier. */
  grantExtraScopes?: string[];
}

/** start → resolve → continue → callback; finish only when asked. */
async function authorize(
  actor: { userId: string; organizationId: string },
  account: FakeAccount,
  options: ConnectOptions = {},
) {
  const { grantExtraScopes, ...startOptions } = options;
  const startResponse = await ui("/ui/connect/start", { ...actor, provider: "google", ...startOptions });
  expect(startResponse.status).toBe(201);
  const started = (await startResponse.json()) as J;
  expect(started.connectUrl.startsWith(`${CONSOLE}/connect/`)).toBe(true);
  const connectToken = new URL(started.connectUrl).pathname.split("/").pop()!;
  const resolved = await uiJson("/ui/connect/resolve", { ...actor, connectToken });
  const continued = await uiJson("/ui/connect/continue", { ...actor, connectToken });
  const authorizationUrl = new URL(continued.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state")!;
  const scopes = authorizationUrl.searchParams.get("scope")!.split(" ");
  const code = `code-${randomUUID()}`;
  fakeGoogle.codes.set(code, { ...account, scopes: [...scopes, ...(grantExtraScopes ?? [])] });
  const callbackUrl = `${LINK}/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`;
  const callback = await call(new Request(callbackUrl));
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${CONSOLE}/connect/finish`);
  return {
    started,
    connectToken,
    resolved,
    authorizationUrl,
    scopes,
    callbackUrl,
    pendingId: location.searchParams.get("p")!,
    resultToken: location.searchParams.get("r")!,
  };
}

async function connect(
  actor: { userId: string; organizationId: string },
  account: FakeAccount,
  options: ConnectOptions = {},
) {
  const flow = await authorize(actor, account, options);
  const finish = await uiJson("/ui/connect/finish", {
    ...actor,
    pendingId: flow.pendingId,
    resultToken: flow.resultToken,
  });
  return { ...flow, finish };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sql: postgres.Sql;
let vaultDb: ConnectorsDb;
let rootWrapKey: CryptoKey;
let bearerA: string;
let bearerRevokedInstallation: string;
const extraUserIds: string[] = [];

/**
 * A member of the test organization with no other connections, for checks
 * that depend on every row a person holds (provider revoke decisions,
 * defaults). With `cli`, also an active installation, session and bearer.
 */
async function freshUser(label: string, options: { cli?: boolean } = {}) {
  const id = randomUUID();
  extraUserIds.push(id);
  await sql`insert into users (id, primary_email) values (${id}, ${`cf-${suffix}-${label}-${id.slice(0, 6)}@example.test`})`;
  await sql`insert into organization_memberships (organization_id, user_id, role) values (${orgId}, ${id}, 'developer')`;
  let bearer: string | null = null;
  if (options.cli) {
    const installationId = randomUUID();
    const session = { id: randomUUID(), jti: randomUUID() };
    await sql`
      insert into local_installations (id, organization_id, user_id, name, status)
      values (${installationId}, ${orgId}, ${id}, ${`${label}-laptop`}, 'active')
    `;
    await sql`
      insert into cli_sessions (
        id, local_installation_id, organization_id, user_id,
        refresh_token_hash, access_token_jti, expires_at
      ) values (
        ${session.id}, ${installationId}, ${orgId}, ${id},
        ${`rh-${randomUUID()}`}, ${session.jti}, now() + interval '1 day'
      )
    `;
    bearer = await bearerFor(session, installationId, id);
  }
  return { id, actor: { userId: id, organizationId: orgId }, bearer };
}
async function connectionRow(id: string): Promise<J> {
  const [row] = await sql`select * from provider_connections where id = ${id}`;
  return row;
}

async function credentialRows(id: string): Promise<J[]> {
  const rows = await sql`
    select payload_kind, payload_key_version
    from connector_credentials
    where provider_connection_id = ${id}
  `;
  return [...rows].sort((a, b) => String(a.payload_kind).localeCompare(String(b.payload_kind)));
}

async function pendingRow(id: string): Promise<J> {
  const [row] = await sql`select * from connector_grants_pending where id = ${id}`;
  return row;
}

/** The access and refresh tokens a personal row holds, decrypted. */
async function decryptedTokens(id: string, userId: string): Promise<{ accessToken?: string; refreshToken?: string }> {
  const rows = await sql`
    select * from connector_credentials
    where provider_connection_id = ${id} and payload_kind in ('access_token', 'refresh_token')
  `;
  const tokens: { accessToken?: string; refreshToken?: string } = {};
  for (const row of rows) {
    const plain = await decryptStoredCredential(
      rootWrapKey,
      { id, organizationId: row.organization_id, userId },
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        aadHash: row.aad_hash,
        wrappedDek: row.wrapped_dek,
        payloadKind: row.payload_kind,
        dekKeyVersion: row.dek_key_version,
        payloadKeyVersion: row.payload_key_version,
      },
    );
    if (row.payload_kind === "access_token") tokens.accessToken = plain;
    else tokens.refreshToken = plain;
  }
  return tokens;
}

async function insertLegacyGoogleRow(input: {
  userId?: string;
  organizationId?: string;
  scopeKind?: "user" | "project";
  externalAccountId?: string | null;
  status?: string;
  idToken?: { sub: string; email: string } | null;
  /** Store access + refresh tokens even without an id_token. */
  credentials?: boolean;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): Promise<string> {
  const organizationId = input.organizationId ?? orgId;
  const [row] = await sql<{ id: string }[]>`
    insert into provider_connections (
      organization_id, project_id, user_id, provider, scope_kind,
      external_account_id, display_name, status, scopes_json, metadata_json, created_at
    ) values (
      ${organizationId},
      ${input.scopeKind === "project" ? projectId : null},
      ${input.userId ?? userA.id},
      'google',
      ${input.scopeKind ?? "user"},
      ${input.externalAccountId ?? null},
      'google',
      ${input.status ?? "active"},
      ${sql.json(["openid", "https://www.googleapis.com/auth/gmail.readonly"])},
      ${sql.json((input.metadata ?? {}) as never)},
      ${input.createdAt ?? new Date().toISOString()}
    )
    returning id
  `;
  if (input.idToken || input.credentials) {
    await storeConnectionTokens(vaultDb, {
      rootWrapKey,
      dekKeyVersion: 1,
      connection: { id: row!.id, organizationId, userId: input.userId ?? userA.id },
      tokens: {
        accessToken: "legacy-at",
        refreshToken: "legacy-rt",
        idToken: input.idToken ? idTokenFor(input.idToken) : undefined,
        scopes: [],
      },
      existing: [],
    });
  }
  return row!.id;
}

describeDb("connectors Worker: identity-bound connect flow (DB)", () => {
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, fetch_types: false, onnotice: () => {} });
    vaultDb = openConnectorsDb({ connectionString: url! } as HyperdriveBinding);
    rootWrapKey = await importRootWrapKey(ROOT_KEY);

    await sql`
      insert into organizations (id, slug, name) values
        (${orgId}, ${`cf-${suffix}`}, 'Connect flow test'),
        (${org2Id}, ${`cf-${suffix}-2`}, 'Connect flow test 2')
    `;
    await sql`
      insert into users (id, primary_email) values
        (${userA.id}, ${userA.email}),
        (${userB.id}, ${userB.email})
    `;
    await sql`
      insert into organization_memberships (organization_id, user_id, role) values
        (${orgId}, ${userA.id}, 'developer'),
        (${orgId}, ${userB.id}, 'developer')
    `;
    await sql`insert into projects (id, organization_id, slug, name) values (${projectId}, ${orgId}, ${`cf-${suffix}`}, 'P')`;
    await sql`
      insert into local_installations (id, organization_id, user_id, name, status, revoked_at) values
        (${installationA}, ${orgId}, ${userA.id}, 'ana-laptop', 'active', null),
        (${revokedInstallationA}, ${orgId}, ${userA.id}, 'old-laptop', 'revoked', now())
    `;
    await sql`
      insert into cli_sessions (
        id, local_installation_id, organization_id, user_id,
        refresh_token_hash, access_token_jti, expires_at
      ) values
        (${sessionA.id}, ${installationA}, ${orgId}, ${userA.id}, ${`rh-${randomUUID()}`}, ${sessionA.jti}, now() + interval '1 day'),
        (${sessionRevokedInstallation.id}, ${revokedInstallationA}, ${orgId}, ${userA.id}, ${`rh-${randomUUID()}`}, ${sessionRevokedInstallation.jti}, now() + interval '1 day')
    `;
    bearerA = await bearerFor(sessionA, installationA);
    bearerRevokedInstallation = await bearerFor(sessionRevokedInstallation, revokedInstallationA);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (!sql) return;
    if (requestIds.length > 0) {
      await sql`delete from audit_events where request_id in ${sql(requestIds)}`;
    }
    const userIds = [userA.id, userB.id, ...extraUserIds];
    await sql`delete from audit_events where organization_id in ${sql([orgId, org2Id])} or actor_id in ${sql(userIds)}`;
    await sql`delete from organizations where id in ${sql([orgId, org2Id])}`;
    await sql`delete from users where id in ${sql(userIds)}`;
    await vaultDb.close();
    await sql.end({ timeout: 5 });
  }, DB_TEST_TIMEOUT_MS);

  test("start → resolve → continue → callback → finish connects the initiator's account", async () => {
    const account = newAccount("ana");
    const exchangesBefore = fakeGoogle.exchanges;
    const flow = await connect(actorA, account);

    expect(flow.resolved).toMatchObject({ state: "pending", provider: "google", accessMode: "full", origin: "ui" });
    expect(flow.resolved.reconnect).toBeNull();
    expect(flow.scopes).toEqual(expect.arrayContaining([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      GMAIL_SEND,
    ]));
    expect(flow.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.finish).toEqual({
      state: "connected",
      connectionId: expect.any(String),
      provider: "google",
      email: account.email,
      created: true,
      reconnected: false,
      accountChanged: false,
      origin: "ui",
      scopeKind: "user",
    });
    expect(fakeGoogle.exchanges).toBe(exchangesBefore + 1);

    const row = await connectionRow(flow.finish.connectionId);
    expect(row.scope_kind).toBe("user");
    expect(row.project_id).toBeNull();
    expect(row.user_id).toBe(userA.id);
    expect(row.external_account_id).toBe(account.sub);
    expect(row.external_account_login).toBe(account.email);
    expect(row.metadata_json.googleSub).toBe(account.sub);
    expect(row.display_name).toBe(account.email);
    expect(row.status).toBe("active");
    expect((await credentialRows(row.id)).map((c) => c.payload_kind)).toEqual([
      "access_token",
      "id_token",
      "refresh_token",
    ]);

    const pending = await pendingRow(flow.pendingId);
    expect(pending.status).toBe("consumed");
    expect(pending.code_encrypted).toBeNull();
    expect(pending.resulting_connection_id).toBe(row.id);
    expect(pending.project_id).toBeNull();
    expect(String(pending.state_token_hash).startsWith("placeholder:")).toBe(false);

    expect(await uiJson("/ui/connect/resolve", { ...actorA, connectToken: flow.connectToken })).toEqual({
      state: "used",
    });
  }, DB_TEST_TIMEOUT_MS);

  test("read only access never requests gmail.send and lists as read only", async () => {
    const flow = await connect(actorA, newAccount("ro"), { accessMode: "read_only" });
    expect(flow.resolved.accessMode).toBe("read_only");
    expect(flow.scopes).not.toContain(GMAIL_SEND);
    expect(flow.scopes).toContain("openid");
    const listed = await uiJson("/ui/connect/list", actorA);
    const item = listed.connections.find((c: J) => c.id === flow.finish.connectionId);
    expect(item.accessMode).toBe("read_only");
    expect(item.email).toContain("ro-");
  }, DB_TEST_TIMEOUT_MS);

  test("the same account updates its row in place, with or without Reconnect", async () => {
    const account = newAccount("same");
    const first = await connect(actorA, account);
    const id = first.finish.connectionId;
    await sql`update provider_connections set requires_reauth = true, status = 'degraded' where id = ${id}`;

    const reconnect = await connect(actorA, account, { reconnectConnectionId: id });
    expect(reconnect.resolved.reconnect).toEqual({ connectionId: id, email: account.email });
    expect(reconnect.authorizationUrl.searchParams.get("login_hint")).toBe(account.email);
    expect(reconnect.finish).toMatchObject({
      state: "connected",
      connectionId: id,
      created: false,
      reconnected: true,
      accountChanged: false,
    });
    const row = await connectionRow(id);
    expect(row.requires_reauth).toBe(false);
    expect(row.status).toBe("active");
    expect(row.last_reauth_at).not.toBeNull();
    const versions = Object.fromEntries((await credentialRows(id)).map((c) => [c.payload_kind, c.payload_key_version]));
    expect(versions).toEqual({ access_token: 2, id_token: 2, refresh_token: 2 });

    const again = await connect(actorA, account);
    expect(again.finish).toMatchObject({ connectionId: id, created: false, reconnected: true });
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from provider_connections
      where organization_id = ${orgId} and user_id = ${userA.id} and external_account_id = ${account.sub}
    `;
    expect(counted!.count).toBe(1);
  }, DB_TEST_TIMEOUT_MS);

  test("Reconnect with a different account creates a new row and says accountChanged", async () => {
    const original = newAccount("orig");
    const first = await connect(actorA, original);
    const other = newAccount("other");
    const second = await connect(actorA, other, { reconnectConnectionId: first.finish.connectionId });
    expect(second.finish).toMatchObject({
      state: "connected",
      created: true,
      reconnected: false,
      accountChanged: true,
      email: other.email,
    });
    expect(second.finish.connectionId).not.toBe(first.finish.connectionId);
    const kept = await connectionRow(first.finish.connectionId);
    expect(kept.external_account_id).toBe(original.sub);
    expect(kept.external_account_login).toBe(original.email);
    expect(kept.status).toBe("active");
  }, DB_TEST_TIMEOUT_MS);

  test("a sign-in that names no account stores nothing, and a reconnect never swaps in an unknown account", async () => {
    const owner = await freshUser("noid");
    const account = newAccount("noid");
    const id = (await connect(owner.actor, account)).finish.connectionId;
    const tokensBefore = await decryptedTokens(id, owner.id);

    // The identity scopes taken out of the sign-in URL: Google answers
    // with tokens of whoever signed in, and no id_token.
    const intruder = { ...newAccount("noid-intruder"), withoutIdToken: true };
    const reconnect = await connect(owner.actor, intruder, { reconnectConnectionId: id });
    expect(reconnect.finish).toEqual({ state: "rejected", reason: "identity_missing" });
    expect(await pendingRow(reconnect.pendingId)).toMatchObject({ status: "rejected", rejected_reason: "identity_missing" });
    expect(await decryptedTokens(id, owner.id)).toEqual(tokensBefore);
    expect((await connectionRow(id)).external_account_id).toBe(account.sub);
    const fresh = await connect(owner.actor, intruder);
    expect(fresh.finish).toEqual({ state: "rejected", reason: "identity_missing" });
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from provider_connections where user_id = ${owner.id}
    `;
    expect(counted!.count).toBe(1);

    // A legacy row that never learned its account is not taken over by
    // whichever account the reconnect signs in with: that one gets its own row.
    const unknown = await insertLegacyGoogleRow({ userId: owner.id, credentials: true });
    const other = newAccount("noid-other");
    const replaced = await connect(owner.actor, other, { reconnectConnectionId: unknown });
    expect(replaced.finish).toMatchObject({ state: "connected", created: true, reconnected: false, accountChanged: true });
    expect(replaced.finish.connectionId).not.toBe(unknown);
    const kept = await connectionRow(unknown);
    expect(kept.external_account_id).toBeNull();
    expect(kept.external_account_login).toBeNull();
    expect((await decryptedTokens(unknown, owner.id)).accessToken).toBe("legacy-at");
  }, DB_TEST_TIMEOUT_MS);

  test("another user can neither continue nor finish; the code is discarded", async () => {
    const start = await uiJson("/ui/connect/start", { ...actorA, provider: "google" });
    const connectToken = new URL(start.connectUrl).pathname.split("/").pop()!;
    expect(await uiJson("/ui/connect/resolve", { ...actorB, connectToken })).toEqual({ state: "user_mismatch" });
    const blocked = await ui("/ui/connect/continue", { ...actorB, connectToken });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "connector_connect_unavailable", state: "user_mismatch" });

    const continued = await uiJson("/ui/connect/continue", { ...actorA, connectToken });
    const state = new URL(continued.authorizationUrl).searchParams.get("state")!;
    const code = `code-${randomUUID()}`;
    fakeGoogle.codes.set(code, { ...newAccount("intruder"), scopes: ["openid"] });
    const callback = await call(new Request(`${LINK}/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`));
    const location = new URL(callback.headers.get("location")!);
    const pendingId = location.searchParams.get("p")!;
    const resultToken = location.searchParams.get("r")!;
    expect((await pendingRow(pendingId)).code_encrypted).not.toBeNull();

    const exchangesBefore = fakeGoogle.exchanges;
    expect(await uiJson("/ui/connect/finish", { ...actorB, pendingId, resultToken })).toEqual({
      state: "rejected",
      reason: "user_mismatch",
    });
    const pending = await pendingRow(pendingId);
    expect(pending.status).toBe("rejected");
    expect(pending.rejected_reason).toBe("user_mismatch");
    expect(pending.code_encrypted).toBeNull();

    expect(await uiJson("/ui/connect/finish", { ...actorA, pendingId, resultToken })).toEqual({
      state: "rejected",
      reason: "user_mismatch",
    });
    expect(fakeGoogle.exchanges).toBe(exchangesBefore);
  }, DB_TEST_TIMEOUT_MS);

  test("a replayed callback is refused and a replayed finish returns the stored result", async () => {
    const flow = await connect(actorA, newAccount("replay"));
    const exchanges = fakeGoogle.exchanges;
    const replayedCallback = await call(new Request(flow.callbackUrl));
    expect(replayedCallback.status).toBe(400);
    const replayedFinish = await uiJson("/ui/connect/finish", {
      ...actorA,
      pendingId: flow.pendingId,
      resultToken: flow.resultToken,
    });
    expect(replayedFinish).toEqual(flow.finish);
    expect(fakeGoogle.exchanges).toBe(exchanges);
    expect(
      await uiJson("/ui/connect/finish", { ...actorA, pendingId: flow.pendingId, resultToken: "wrong-token" }),
    ).toEqual({ state: "invalid" });
  }, DB_TEST_TIMEOUT_MS);

  test("a provider denial rejects the grant and lands on the finish page", async () => {
    const start = await uiJson("/ui/connect/start", { ...actorA, provider: "google" });
    const connectToken = new URL(start.connectUrl).pathname.split("/").pop()!;
    const continued = await uiJson("/ui/connect/continue", { ...actorA, connectToken });
    const state = new URL(continued.authorizationUrl).searchParams.get("state")!;
    const denied = await call(
      new Request(`${LINK}/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`),
    );
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("p")).toBe(start.pendingGrantId);
    expect(location.searchParams.get("error")).toBe("provider_denied");
    const pending = await pendingRow(start.pendingGrantId);
    expect(pending.status).toBe("rejected");
    expect(pending.rejected_reason).toBe("provider_denied");
  }, DB_TEST_TIMEOUT_MS);

  test("continueNow goes straight to Google for the signed-in user", async () => {
    const response = await ui("/ui/connect/start", { ...actorA, provider: "google", continueNow: true });
    expect(response.status).toBe(201);
    const started = (await response.json()) as J;
    expect(started.connectUrl).toBeUndefined();
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    const pending = await pendingRow(started.pendingGrantId);
    expect(pending.continued_at).not.toBeNull();
  }, DB_TEST_TIMEOUT_MS);

  test("legacy CLI start with projectId gets a Console connect URL bound to the CLI user", async () => {
    const response = await cli("POST", "/cli/connect/start", bearerA, { provider: "google", projectId });
    expect(response.status).toBe(201);
    const started = (await response.json()) as J;
    expect(started.connectUrl.startsWith(`${CONSOLE}/connect/`)).toBe(true);
    const pending = await pendingRow(started.pendingGrantId);
    expect(pending.project_id).toBeNull();
    expect(pending.origin).toBe("cli");
    expect(pending.cli_session_id).toBe(sessionA.id);
    expect(pending.metadata_json.localInstallationId).toBe(installationA);

    const connectToken = new URL(started.connectUrl).pathname.split("/").pop()!;
    const resolved = await uiJson("/ui/connect/resolve", { ...actorA, connectToken });
    expect(resolved).toMatchObject({ state: "pending", origin: "cli", installationName: "ana-laptop" });

    const status = await (await cli("GET", `/cli/connect/status/${started.pendingGrantId}`, bearerA)).json();
    expect(status).toMatchObject({ status: "pending", provider: "google", connectorId: null });

    const continued = await uiJson("/ui/connect/continue", { ...actorA, connectToken });
    const state = new URL(continued.authorizationUrl).searchParams.get("state")!;
    const code = `code-${randomUUID()}`;
    fakeGoogle.codes.set(code, { ...newAccount("cli"), scopes: ["openid"] });
    const callback = await call(new Request(`${LINK}/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`));
    const location = new URL(callback.headers.get("location")!);
    const finish = await uiJson("/ui/connect/finish", {
      ...actorA,
      pendingId: location.searchParams.get("p"),
      resultToken: location.searchParams.get("r"),
    });
    expect(finish).toMatchObject({ state: "connected", origin: "cli" });
    const done = await (await cli("GET", `/cli/connect/status/${started.pendingGrantId}`, bearerA)).json();
    expect(done).toMatchObject({ status: "consumed", connectorId: finish.connectionId });
  }, DB_TEST_TIMEOUT_MS);

  test("a CLI session on a revoked installation is rejected", async () => {
    const response = await cli("GET", "/cli/connect/list", bearerRevokedInstallation);
    expect(response.status).toBe(401);
  }, DB_TEST_TIMEOUT_MS);

  test("the Console can forward a CLI start only for the user's own active CLI session", async () => {
    const forwarded = await ui("/ui/connect/start", {
      ...actorA,
      provider: "google",
      origin: "cli",
      cliSessionId: sessionA.id,
      localInstallationId: installationA,
    });
    expect(forwarded.status).toBe(201);
    const started = (await forwarded.json()) as J;
    expect((await pendingRow(started.pendingGrantId)).metadata_json.localInstallationId).toBe(installationA);

    const foreign = await ui("/ui/connect/start", {
      ...actorB,
      provider: "google",
      origin: "cli",
      cliSessionId: sessionA.id,
    });
    expect(foreign.status).toBe(403);
    const revoked = await ui("/ui/connect/start", {
      ...actorA,
      provider: "google",
      origin: "cli",
      cliSessionId: sessionRevokedInstallation.id,
    });
    expect(revoked.status).toBe(403);
  }, DB_TEST_TIMEOUT_MS);

  test("an organization that disabled Google blocks start, resolve and finish", async () => {
    const before = await uiJson("/ui/connect/start", { ...actorA, provider: "google" });
    const connectToken = new URL(before.connectUrl).pathname.split("/").pop()!;
    await sql`
      insert into connector_org_policies (organization_id, provider, enabled)
      values (${orgId}, 'google', false)
    `;
    try {
      const blocked = await ui("/ui/connect/start", { ...actorA, provider: "google" });
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).error).toBe("connector_disabled_by_org");
      const cliBlocked = await cli("POST", "/cli/connect/start", bearerA, { provider: "google" });
      expect(cliBlocked.status).toBe(403);
      expect(await uiJson("/ui/connect/resolve", { ...actorA, connectToken })).toEqual({ state: "disabled_by_org" });
    } finally {
      await sql`delete from connector_org_policies where organization_id = ${orgId}`;
    }
  }, DB_TEST_TIMEOUT_MS);

  test("lists exclude GitHub, carry no project but the one older CLIs need, and put the default first", async () => {
    const connected = await connect(actorA, newAccount("list"));
    const legacy = await insertLegacyGoogleRow({ scopeKind: "project", createdAt: "2020-01-01T00:00:00Z" });
    const historic = await insertLegacyGoogleRow({ status: "revoked_by_user" });
    await sql`
      insert into provider_connections (organization_id, project_id, user_id, provider, scope_kind, display_name)
      values (${orgId}, ${projectId}, ${userA.id}, 'github', 'project', 'repo')
    `;
    expect((await ui(`/ui/connect/default/${legacy}`, actorA)).status).toBe(200);

    const cliList = (await (await cli("GET", `/cli/connect/list?project=${projectId}`, bearerA)).json()) as J;
    expect(cliList.connections.some((c: J) => c.provider === "github")).toBe(false);
    // Older CLIs require a string: the project a legacy row was filed under, else "".
    expect(cliList.connections.every((c: J) => typeof c.projectId === "string")).toBe(true);
    expect(cliList.connections[0].id).toBe(legacy);
    expect(cliList.connections[0]).toMatchObject({ isDefault: true, scopeKind: "user", accessMode: "read_only", projectId });
    expect(cliList.connections.find((c: J) => c.id === connected.finish.connectionId).projectId).toBe("");
    expect(cliList.connections.map((c: J) => c.id)).toContain(historic);
    expect(JSON.stringify(cliList)).not.toContain("legacyProjectId");
    const live = (await (await cli("GET", "/cli/connect/list?includeHistory=false", bearerA)).json()) as J;
    expect(live.connections.map((c: J) => c.id)).not.toContain(historic);

    const uiList = await uiJson("/ui/connect/list", { ...actorA, projectId });
    expect(uiList.connections.some((c: J) => c.provider === "github")).toBe(false);
    expect(uiList.connections.map((c: J) => c.id)).not.toContain(historic);
    expect(uiList.connections[0]).toMatchObject({ id: legacy, isDefault: true, scopeKind: "user", usedBy: [] });
    const withHistory = await uiJson("/ui/connect/list", { ...actorA, includeHistory: true });
    expect(withHistory.connections.map((c: J) => c.id)).toContain(historic);
    expect(JSON.stringify(withHistory)).not.toContain(projectId);

    const shown = (await (await cli("GET", `/cli/connect/show/${connected.finish.connectionId}`, bearerA)).json()) as J;
    expect(shown.connection).toMatchObject({
      id: connected.finish.connectionId,
      projectId: "",
      scopeKind: "user",
      accessMode: "full",
      externalAccountLogin: expect.stringContaining("list-"),
    });
    const [github] = await sql<{ id: string }[]>`
      select id from provider_connections where organization_id = ${orgId} and provider = 'github' limit 1
    `;
    expect((await cli("GET", `/cli/connect/show/${github!.id}`, bearerA)).status).toBe(404);
  }, DB_TEST_TIMEOUT_MS);

  test("rename and make default stay with the owner", async () => {
    const one = await connect(actorA, newAccount("one"));
    const two = await connect(actorA, newAccount("two"));
    const idOne = one.finish.connectionId;
    const idTwo = two.finish.connectionId;
    expect((await ui(`/ui/connect/default/${idOne}`, actorA)).status).toBe(200);
    expect((await ui(`/ui/connect/default/${idTwo}`, actorA)).status).toBe(200);
    expect((await connectionRow(idOne)).is_default).toBe(false);
    expect((await connectionRow(idTwo)).is_default).toBe(true);

    expect(await uiJson(`/ui/connect/rename/${idTwo}`, { ...actorA, displayName: "  Work mail " })).toEqual({ ok: true });
    expect((await connectionRow(idTwo)).display_name).toBe("Work mail");
    expect((await ui(`/ui/connect/rename/${idTwo}`, { ...actorA, displayName: " " })).status).toBe(400);
    expect((await ui(`/ui/connect/rename/${idTwo}`, { ...actorB, displayName: "Mine" })).status).toBe(404);
    expect((await ui(`/ui/connect/default/${idTwo}`, actorB)).status).toBe(404);
  }, DB_TEST_TIMEOUT_MS);

  test("revoke calls Google only when no other live row shares the account", async () => {
    const shared = newAccount("shared");
    const rowA = (await connect(actorA, shared)).finish.connectionId;
    const rowB = (await connect(actorB, shared)).finish.connectionId;
    await ui(`/ui/connect/default/${rowA}`, actorA);
    const [grant] = await sql<{ id: string }[]>`
      insert into agent_connector_grants (
        organization_id, local_installation_id, agent_id, provider, mode,
        provider_connection_id, granted_by_user_id
      ) values (${orgId}, ${installationA}, 'main', 'google', 'person_asking', ${rowA}, ${userA.id})
      returning id
    `;

    const revokedBefore = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${rowA}`, actorA)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(revokedBefore);
    const closed = await connectionRow(rowA);
    expect(closed.status).toBe("revoked_by_user");
    expect(closed.revoked_at).not.toBeNull();
    expect(closed.is_default).toBe(false);
    expect(await credentialRows(rowA)).toEqual([]);
    const [grantRow] = await sql`select status, revoked_at from agent_connector_grants where id = ${grant!.id}`;
    expect(grantRow!.status).toBe("revoked");

    expect((await ui(`/ui/connect/revoke/${rowB}`, actorA)).status).toBe(404);
    const refreshB = await sql`
      select * from connector_credentials
      where provider_connection_id = ${rowB} and payload_kind = 'refresh_token'
    `;
    const refreshPlain = await decryptStoredCredential(
      rootWrapKey,
      { id: rowB, organizationId: orgId, userId: userB.id },
      {
        ciphertext: refreshB[0]!.ciphertext,
        nonce: refreshB[0]!.nonce,
        aadHash: refreshB[0]!.aad_hash,
        wrappedDek: refreshB[0]!.wrapped_dek,
        payloadKind: "refresh_token",
        dekKeyVersion: refreshB[0]!.dek_key_version,
        payloadKeyVersion: refreshB[0]!.payload_key_version,
      },
    );
    expect(await uiJson(`/ui/connect/revoke/${rowB}`, actorB)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.slice(revokedBefore)).toEqual([refreshPlain]);
    expect((await connectionRow(rowB)).status).toBe("revoked_by_user");
    expect(await credentialRows(rowB)).toEqual([]);

    expect(await uiJson(`/ui/connect/revoke/${rowB}`, actorB)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(revokedBefore + 1);
  }, DB_TEST_TIMEOUT_MS);

  test("a failed provider revoke keeps credentials; the scheduler gives up after 5 attempts", async () => {
    const owner = await freshUser("stuck", { cli: true });
    const id = (await connect(owner.actor, newAccount("stuck"))).finish.connectionId;
    fakeGoogle.revokeFails = true;
    try {
      const failed = await cli("POST", `/cli/connect/revoke/${id}`, owner.bearer!);
      expect(failed.status).toBe(502);
      expect((await failed.json()).error).toBe("connector_provider_error");
      let row = await connectionRow(id);
      expect(row.status).toBe("revoke_pending");
      expect(row.metadata_json.revokeAttempts).toBe(1);
      expect((await credentialRows(id)).length).toBe(3);

      for (let run = 0; run < 3; run += 1) {
        await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
      }
      row = await connectionRow(id);
      expect(row.status).toBe("revoke_pending");
      expect(row.metadata_json.revokeAttempts).toBe(4);

      const report = await runScheduledMaintenance({
        db: vaultDb,
        rootWrapKey,
        adapters,
        scope: { organizationId: orgId },
      });
      expect(report.revokeRetries.gaveUp).toBe(1);
      row = await connectionRow(id);
      expect(row.status).toBe("revoked_by_user");
      expect(await credentialRows(id)).toEqual([]);
      const [audit] = await sql`
        select count(*)::int as count from audit_events
        where target_id = ${id} and action = 'connector.revoke.provider_gave_up'
      `;
      expect(audit!.count).toBe(1);
    } finally {
      fakeGoogle.revokeFails = false;
    }
  }, DB_TEST_TIMEOUT_MS);

  test("identity is backfilled from the stored id_token, lazily on list and by the scheduler", async () => {
    const lazyAccount = newAccount("lazy");
    const lazy = await insertLegacyGoogleRow({ idToken: lazyAccount });
    const listed = (await (await cli("GET", "/cli/connect/list", bearerA)).json()) as J;
    expect(listed.connections.find((c: J) => c.id === lazy).externalAccountLogin).toBe(lazyAccount.email);
    const lazyRow = await connectionRow(lazy);
    expect(lazyRow.external_account_id).toBe(lazyAccount.sub);
    expect(lazyRow.metadata_json.googleSub).toBe(lazyAccount.sub);

    // A second row of the same account cannot take external_account_id.
    const duplicate = await insertLegacyGoogleRow({ idToken: lazyAccount });
    const scheduledAccount = newAccount("cron");
    const scheduled = await insertLegacyGoogleRow({ idToken: scheduledAccount });
    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.identityBackfilled).toBeGreaterThanOrEqual(2);

    const duplicateRow = await connectionRow(duplicate);
    expect(duplicateRow.external_account_id).toBeNull();
    expect(duplicateRow.external_account_login).toBe(lazyAccount.email);
    expect(duplicateRow.metadata_json).toMatchObject({ googleSub: lazyAccount.sub, duplicateOf: lazy });
    const scheduledRow = await connectionRow(scheduled);
    expect(scheduledRow.external_account_id).toBe(scheduledAccount.sub);
    expect(scheduledRow.external_account_login).toBe(scheduledAccount.email);

    // A new connect of that account updates the oldest holder in place.
    const reconnect = await connect(actorA, lazyAccount);
    expect(reconnect.finish).toMatchObject({ connectionId: lazy, created: false });

    const noToken = await insertLegacyGoogleRow({});
    await cli("GET", "/cli/connect/list", bearerA);
    expect((await connectionRow(noToken)).metadata_json.identityBackfill).toBe("unavailable");
  }, DB_TEST_TIMEOUT_MS);

  test("the scheduler reclassifies legacy project rows and expires stale state", async () => {
    const holderAccount = newAccount("holder");
    const holder = (await connect(actorA, holderAccount)).finish.connectionId;
    const legacy = await insertLegacyGoogleRow({ scopeKind: "project", externalAccountId: holderAccount.sub });
    const plainLegacy = await insertLegacyGoogleRow({ scopeKind: "project" });
    const [stale] = await sql<{ id: string }[]>`
      insert into connector_grants_pending (
        organization_id, user_id, provider, state_token_hash, origin, expires_at, code_encrypted
      ) values (${orgId}, ${userA.id}, 'google', ${`placeholder:${randomUUID()}`}, 'ui', now() - interval '1 minute', 'x.y.z.w')
      returning id
    `;
    await sql`
      insert into connector_turn_reads (local_installation_id, turn_key_hash, organization_id, expires_at)
      values (${installationA}, ${`turn-${suffix}`}, ${orgId}, now() - interval '1 minute')
    `;

    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    expect(report.reclassified).toBeGreaterThanOrEqual(2);

    const legacyRow = await connectionRow(legacy);
    expect(legacyRow.scope_kind).toBe("user");
    expect(legacyRow.project_id).toBeNull();
    expect(legacyRow.metadata_json).toMatchObject({
      legacyProjectId: projectId,
      googleSub: holderAccount.sub,
      duplicateOf: holder,
    });
    expect(legacyRow.external_account_id).toBeNull();
    const plainRow = await connectionRow(plainLegacy);
    expect(plainRow.scope_kind).toBe("user");
    expect(plainRow.metadata_json.legacyProjectId).toBe(projectId);

    const pending = await pendingRow(stale!.id);
    expect(pending.status).toBe("expired");
    expect(pending.code_encrypted).toBeNull();
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from connector_turn_reads where organization_id = ${orgId}
    `;
    expect(counted!.count).toBe(0);

    const second = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(second.reclassified).toBe(0);
  }, DB_TEST_TIMEOUT_MS);

  test("refresh stores the key version it encrypted with; invalid_grant needs reconnecting", async () => {
    const account = newAccount("refresh");
    const id = (await connect(actorA, account)).finish.connectionId;
    const exec = () =>
      cli("POST", `/cli/exec/${id}`, bearerA, { capability: "gmail.message.list", parameters: {} });
    const expireAccess = () =>
      sql`
        update connector_credentials set expires_at = now() - interval '1 hour'
        where provider_connection_id = ${id} and payload_kind = 'access_token'
      `;
    const versions = async () =>
      Object.fromEntries((await credentialRows(id)).map((c) => [c.payload_kind, c.payload_key_version]));

    await expireAccess();
    expect((await exec()).status).toBe(200);
    expect(await versions()).toMatchObject({ access_token: 2, refresh_token: 2 });
    expect(fakeGoogle.execAccessTokens.at(-1)).toMatch(/^at-refreshed-/);

    // Decrypts the stored access row (no refresh) and then the refresh row.
    expect((await exec()).status).toBe(200);
    await expireAccess();
    const refreshesBefore = fakeGoogle.refreshes.length;
    expect((await exec()).status).toBe(200);
    expect(fakeGoogle.refreshes.at(-1)).toMatch(/^rt-refreshed-/);
    expect(fakeGoogle.refreshes.length).toBe(refreshesBefore + 1);
    expect(await versions()).toMatchObject({ access_token: 3, refresh_token: 3 });

    fakeGoogle.refreshFails = true;
    try {
      await expireAccess();
      const failed = await exec();
      expect((await failed.json()).error).toBe("connector_reauth_required");
      expect((await connectionRow(id)).requires_reauth).toBe(true);
      const [audit] = await sql`
        select count(*)::int as count from audit_events
        where target_id = ${id} and action = 'connector.reauth_required'
      `;
      expect(audit!.count).toBe(1);
    } finally {
      fakeGoogle.refreshFails = false;
    }

    const reconnected = await connect(actorA, account, { reconnectConnectionId: id });
    expect(reconnected.finish).toMatchObject({ connectionId: id, reconnected: true });
    expect((await connectionRow(id)).requires_reauth).toBe(false);
  }, DB_TEST_TIMEOUT_MS);

  test("read only stays read only when Google reports write scopes granted earlier", async () => {
    const account = newAccount("ro-wide");
    const sendEmail = (id: string) =>
      cli("POST", `/cli/exec/${id}`, bearerA, {
        capability: "gmail.message.send",
        parameters: { to: ["someone@example.test"], subject: "Hi", body: "Hello" },
      });
    const listedMode = async (id: string) =>
      (await uiJson("/ui/connect/list", actorA)).connections.find((c: J) => c.id === id).accessMode;

    // New row: incremental grants are not asked for, and what Google adds anyway is not stored.
    const first = await connect(actorA, account, { accessMode: "read_only", grantExtraScopes: [GMAIL_SEND, DRIVE] });
    expect(first.authorizationUrl.searchParams.has("include_granted_scopes")).toBe(false);
    const id = first.finish.connectionId;
    let row = await connectionRow(id);
    expect(row.scopes_json).not.toContain(GMAIL_SEND);
    expect(row.scopes_json).not.toContain(DRIVE);
    expect(row.scopes_json).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(row.metadata_json.accessMode).toBe("read_only");
    expect(await listedMode(id)).toBe("read_only");

    // "Allow writing": a reconnect of the same account with full access, in place.
    const full = await connect(actorA, account, { accessMode: "full", reconnectConnectionId: id });
    expect(full.authorizationUrl.searchParams.get("include_granted_scopes")).toBe("true");
    expect(full.finish).toMatchObject({ connectionId: id, reconnected: true });
    row = await connectionRow(id);
    expect(row.scopes_json).toContain(GMAIL_SEND);
    expect(row.metadata_json.accessMode).toBe("full");
    expect(await listedMode(id)).toBe("full");

    // Back to read only with a plain Connect: updated in place, gmail.send dropped again.
    const back = await connect(actorA, account, { accessMode: "read_only", grantExtraScopes: [GMAIL_SEND] });
    expect(back.finish).toMatchObject({ connectionId: id, created: false });
    row = await connectionRow(id);
    expect(row.scopes_json).not.toContain(GMAIL_SEND);
    expect(row.metadata_json.accessMode).toBe("read_only");
    expect(await listedMode(id)).toBe("read_only");
    let denied = await sendEmail(id);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("connector_permission_required");

    // Even with gmail.send in its scopes, a read-only row never writes.
    await sql`update provider_connections set scopes_json = scopes_json || ${sql.json([GMAIL_SEND])} where id = ${id}`;
    denied = await sendEmail(id);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "connector_permission_required", accessMode: "read_only" });
    expect(await listedMode(id)).toBe("read_only");

    // A Reconnect that does not choose keeps read only.
    const kept = await authorize(actorA, account, { reconnectConnectionId: id });
    expect(kept.resolved.accessMode).toBe("read_only");
    expect(kept.scopes).not.toContain(GMAIL_SEND);
  }, DB_TEST_TIMEOUT_MS);

  test("start ignores provider scopes sent by the caller", async () => {
    const flow = await authorize(actorA, newAccount("scopes"), {
      accessMode: "read_only",
      scopes: [DRIVE, GMAIL_SETTINGS_SHARING, GMAIL_SEND],
    });
    expect(flow.scopes).not.toContain(DRIVE);
    expect(flow.scopes).not.toContain(GMAIL_SETTINGS_SHARING);
    expect(flow.scopes).not.toContain(GMAIL_SEND);
    expect(flow.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");

    const response = await cli("POST", "/cli/connect/start", bearerA, { provider: "google", scopes: [DRIVE] });
    expect(response.status).toBe(201);
    const pending = await pendingRow(((await response.json()) as J).pendingGrantId);
    expect(pending.requested_scopes_json).not.toContain(DRIVE);
    expect(pending.requested_scopes_json).toContain(GMAIL_SEND);
  }, DB_TEST_TIMEOUT_MS);

  test("a finish never brings back a row disconnected before or while it stores", async () => {
    const account = newAccount("revived");
    const id = (await connect(actorA, account)).finish.connectionId;

    // Disconnected between callback and finish: the finish creates a new row.
    const flow = await authorize(actorA, account, { reconnectConnectionId: id });
    expect(await uiJson(`/ui/connect/revoke/${id}`, actorA)).toEqual({ revoked: true });
    const finish = await uiJson("/ui/connect/finish", { ...actorA, pendingId: flow.pendingId, resultToken: flow.resultToken });
    expect(finish).toMatchObject({ state: "connected", created: true });
    expect(finish.connectionId).not.toBe(id);
    expect((await connectionRow(id)).status).toBe("revoked_by_user");
    expect(await credentialRows(id)).toEqual([]);

    // The guarded update itself refuses a closed row.
    expect(
      await refreshConnectionAfterConnect(vaultDb, {
        id,
        scopes: ["openid"],
        email: null,
        displayName: null,
        accessMode: "full",
      }),
    ).toBeNull();
    expect((await connectionRow(id)).status).toBe("revoked_by_user");

    // A revoke that arrives while a finish holds the row waits, then shreds
    // what that finish stored too (here a credential kind the row lacked).
    const live = finish.connectionId as string;
    await sql`delete from connector_credentials where provider_connection_id = ${live} and payload_kind = 'id_token'`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const finishing = withTransaction(vaultDb, async (tx) => {
      const row = await lockProviderConnection(tx, live, orgId);
      locked();
      await gate;
      await refreshConnectionAfterConnect(tx, {
        id: live,
        scopes: ["openid"],
        email: account.email,
        displayName: null,
        accessMode: "full",
      });
      await storeConnectionTokens(tx, {
        rootWrapKey,
        dekKeyVersion: 1,
        connection: row!,
        tokens: { accessToken: "late-at", idToken: idTokenFor(account), scopes: [] },
        existing: [],
      });
    });
    await holding;
    const revoking = ui(`/ui/connect/revoke/${live}`, actorA);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await finishing;
    expect((await revoking).status).toBe(200);
    expect((await connectionRow(live)).status).toBe("revoked_by_user");
    expect(await credentialRows(live)).toEqual([]);

    // Finish and revoke at the same time: whichever wins, the row ends closed and shredded.
    const raced = (await connect(actorA, account)).finish.connectionId;
    const racing = await authorize(actorA, account, { reconnectConnectionId: raced });
    const [finished, revoked] = await Promise.all([
      uiJson("/ui/connect/finish", { ...actorA, pendingId: racing.pendingId, resultToken: racing.resultToken }),
      ui(`/ui/connect/revoke/${raced}`, actorA),
    ]);
    expect(finished.state).toBe("connected");
    expect(revoked.status).toBe(200);
    expect((await connectionRow(raced)).status).toBe("revoked_by_user");
    expect(await credentialRows(raced)).toEqual([]);
  }, DB_TEST_TIMEOUT_MS);

  test("a finish that races the member's removal neither brings back their rows nor adds one", async () => {
    // What the Console's member removal does, in one transaction: the
    // membership first, then (under the member lock) the person's live rows.
    const removeMember = async (tx: postgres.TransactionSql, userId: string) => {
      await tx`update organization_memberships set status = 'removed' where organization_id = ${orgId} and user_id = ${userId}`;
      await tx`select pg_advisory_xact_lock(hashtext('ravi-connectors:member'), hashtext(${`${orgId}:${userId}`}))`;
      await tx`
        update provider_connections set status = 'suspended'
        where organization_id = ${orgId} and user_id = ${userId} and status in ('active', 'degraded', 'revoke_pending')
      `;
    };
    const rowsOf = async (userId: string) => [
      ...(await sql`select id, status from provider_connections where user_id = ${userId} order by created_at`),
    ];

    // Removed after the Console forwarded the finish: neither a reconnect
    // nor a new account stores anything.
    const leaver = await freshUser("leaver");
    const account = newAccount("leaver");
    const id = (await connect(leaver.actor, account)).finish.connectionId;
    const reconnect = await authorize(leaver.actor, account, { reconnectConnectionId: id });
    const added = await authorize(leaver.actor, newAccount("leaver-new"));
    await sql.begin((tx) => removeMember(tx, leaver.id));
    for (const flow of [reconnect, added]) {
      const finish = await uiJson("/ui/connect/finish", { ...leaver.actor, pendingId: flow.pendingId, resultToken: flow.resultToken });
      expect(finish).toEqual({ state: "rejected", reason: "not_member" });
      expect(await pendingRow(flow.pendingId)).toMatchObject({ status: "rejected", rejected_reason: "not_member" });
    }
    expect(await rowsOf(leaver.id)).toEqual([{ id, status: "suspended" }]);

    // Removed while the finish stores: it waits for the removal and sees it.
    const racer = await freshUser("racer");
    const racerAccount = newAccount("racer");
    const racerRow = (await connect(racer.actor, racerAccount)).finish.connectionId;
    const racing = await authorize(racer.actor, racerAccount, { reconnectConnectionId: racerRow });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let removing!: () => void;
    const holding = new Promise<void>((resolve) => (removing = resolve));
    const removal = sql.begin(async (tx) => {
      await removeMember(tx, racer.id);
      removing();
      await gate;
    });
    await holding;
    const finishing = uiJson("/ui/connect/finish", { ...racer.actor, pendingId: racing.pendingId, resultToken: racing.resultToken });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await removal;
    expect(await finishing).toEqual({ state: "rejected", reason: "not_member" });
    expect(await rowsOf(racer.id)).toEqual([{ id: racerRow, status: "suspended" }]);
  }, DB_TEST_TIMEOUT_MS);

  test("legacy rows that have not learned their account are found before connect and revoke decide", async () => {
    const owner = await freshUser("legacy");

    // Same organization: the connect updates the legacy row in place.
    const sameOrg = newAccount("legacy-same");
    const legacy = await insertLegacyGoogleRow({ userId: owner.id, idToken: sameOrg });
    const first = await connect(owner.actor, sameOrg);
    expect(first.finish).toMatchObject({ connectionId: legacy, created: false, reconnected: true });
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from provider_connections
      where user_id = ${owner.id} and status = 'active' and metadata_json->>'googleSub' = ${sameOrg.sub}
    `;
    expect(counted!.count).toBe(1);

    // Another organization, not backfilled yet when the revoke comes: the
    // revoke learns it holds the same account and keeps the Google grant.
    const elsewhere = newAccount("legacy-other-org");
    const created = (await connect(owner.actor, elsewhere)).finish;
    expect(created.created).toBe(true);
    const otherOrg = await insertLegacyGoogleRow({ userId: owner.id, organizationId: org2Id, idToken: elsewhere });
    const before = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${created.connectionId}`, owner.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before);
    const kept = await connectionRow(otherOrg);
    expect(kept.status).toBe("active");
    expect(kept.metadata_json.googleSub).toBe(elsewhere.sub);
    expect((await credentialRows(otherOrg)).length).toBe(3);
  }, DB_TEST_TIMEOUT_MS);

  test("an unknown account is revoked at Google only when it cannot be another live row's", async () => {
    // Both rows unknown: only the person's last live row calls Google.
    const owner = await freshUser("unknown");
    const firstUnknown = await insertLegacyGoogleRow({ userId: owner.id, credentials: true });
    const secondUnknown = await insertLegacyGoogleRow({ userId: owner.id, credentials: true });
    let before = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${firstUnknown}`, owner.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before);
    expect((await connectionRow(firstUnknown)).status).toBe("revoked_by_user");
    expect((await connectionRow(secondUnknown)).metadata_json.identityBackfill).toBe("unavailable");
    expect(await uiJson(`/ui/connect/revoke/${secondUnknown}`, owner.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.slice(before)).toEqual(["legacy-rt"]);

    // A known account next to an unknown row of the same person: maybe the same account.
    const other = await freshUser("maybe");
    const known = (await connect(other.actor, newAccount("maybe"))).finish.connectionId;
    const unknown = await insertLegacyGoogleRow({ userId: other.id, credentials: true });
    before = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${known}`, other.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before);
    expect(await credentialRows(known)).toEqual([]);
    expect(await uiJson(`/ui/connect/revoke/${unknown}`, other.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.slice(before)).toEqual(["legacy-rt"]);
  }, DB_TEST_TIMEOUT_MS);

  test("a duplicate row known only by its recorded sub keeps the Google grant alive", async () => {
    const owner = await freshUser("duplicate");
    const account = newAccount("duplicate");
    const holder = await insertLegacyGoogleRow({ userId: owner.id, externalAccountId: account.sub, credentials: true });
    const duplicate = await insertLegacyGoogleRow({
      userId: owner.id,
      credentials: true,
      metadata: { googleSub: account.sub, duplicateOf: holder },
    });
    const before = fakeGoogle.revoked.length;
    expect(await uiJson(`/ui/connect/revoke/${holder}`, owner.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.length).toBe(before);
    expect((await connectionRow(duplicate)).status).toBe("active");
    expect((await credentialRows(duplicate)).length).toBe(2);
    expect(await uiJson(`/ui/connect/revoke/${duplicate}`, owner.actor)).toEqual({ revoked: true });
    expect(fakeGoogle.revoked.slice(before)).toEqual(["legacy-rt"]);
  }, DB_TEST_TIMEOUT_MS);

  test("a pending revoke retried after someone else connected the account keeps their grant", async () => {
    const owner = await freshUser("pending-owner");
    const other = await freshUser("pending-other");
    const account = newAccount("pending");
    const pendingId = (await connect(owner.actor, account)).finish.connectionId;
    fakeGoogle.revokeFails = true;
    try {
      expect((await ui(`/ui/connect/revoke/${pendingId}`, owner.actor)).status).toBe(502);
    } finally {
      fakeGoogle.revokeFails = false;
    }
    expect((await connectionRow(pendingId)).status).toBe("revoke_pending");

    const otherId = (await connect(other.actor, account)).finish.connectionId;
    const before = fakeGoogle.revoked.length;
    await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(fakeGoogle.revoked.length).toBe(before);
    expect((await connectionRow(pendingId)).status).toBe("revoked_by_user");
    expect(await credentialRows(pendingId)).toEqual([]);
    expect((await connectionRow(otherId)).status).toBe("active");
    expect((await credentialRows(otherId)).length).toBe(3);
  }, DB_TEST_TIMEOUT_MS);

  test("two revokes of one account at once revoke the Google grant exactly once", async () => {
    const one = await freshUser("race-one");
    const two = await freshUser("race-two");
    const account = newAccount("race");
    const a = (await connect(one.actor, account)).finish.connectionId;
    const b = (await connect(two.actor, account)).finish.connectionId;
    const before = fakeGoogle.revoked.length;
    const responses = await Promise.all([
      ui(`/ui/connect/revoke/${a}`, one.actor),
      ui(`/ui/connect/revoke/${b}`, two.actor),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fakeGoogle.revoked.length).toBe(before + 1);
    expect((await connectionRow(a)).status).toBe("revoked_by_user");
    expect((await connectionRow(b)).status).toBe("revoked_by_user");
  }, DB_TEST_TIMEOUT_MS);

  test("a grant claimed by a finish that died is reported and closed as rejected", async () => {
    const start = async () =>
      ((await (await cli("POST", "/cli/connect/start", bearerA, { provider: "google" })).json()) as J).pendingGrantId as string;
    const status = async (id: string) => (await (await cli("GET", `/cli/connect/status/${id}`, bearerA)).json()) as J;
    const dead = await start();
    const running = await start();
    await sql`
      update connector_grants_pending
      set status = 'consumed', consumed_at = now() - interval '5 minutes',
          expires_at = now() - interval '1 minute', code_encrypted = 'x.y.z.w'
      where id = ${dead}
    `;
    await sql`update connector_grants_pending set status = 'consumed', consumed_at = now() where id = ${running}`;

    expect(await status(dead)).toMatchObject({ status: "rejected", connectorId: null });
    expect(await status(running)).toMatchObject({ status: "pending", connectorId: null });

    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    expect(report.expired.staleClaims).toBeGreaterThanOrEqual(1);
    const closed = await pendingRow(dead);
    expect(closed.status).toBe("rejected");
    expect(closed.rejected_reason).toBe("exchange_failed");
    expect(closed.code_encrypted).toBeNull();
    expect((await pendingRow(running)).status).toBe("consumed");
    expect(await status(dead)).toMatchObject({ status: "rejected" });
  }, DB_TEST_TIMEOUT_MS);

  test("one default per person survives legacy project rows becoming personal", async () => {
    const owner = await freshUser("default");
    const legacy = await insertLegacyGoogleRow({ userId: owner.id, scopeKind: "project" });
    expect((await ui(`/ui/connect/default/${legacy}`, owner.actor)).status).toBe(200);
    const personal = (await connect(owner.actor, newAccount("default"))).finish.connectionId;
    expect((await ui(`/ui/connect/default/${personal}`, owner.actor)).status).toBe(200);
    expect((await connectionRow(legacy)).is_default).toBe(false);
    expect((await connectionRow(personal)).is_default).toBe(true);

    // Project rows left as default next to a personal default (older state):
    // a reconnect and the scheduler both make them personal without a second default.
    const reconnectedAccount = newAccount("default-re");
    const reconnected = await insertLegacyGoogleRow({ userId: owner.id, scopeKind: "project", idToken: reconnectedAccount });
    const stale = await insertLegacyGoogleRow({ userId: owner.id, scopeKind: "project" });
    await sql`update provider_connections set is_default = true where id in ${sql([reconnected, stale])}`;
    const reconnect = await connect(owner.actor, reconnectedAccount, { reconnectConnectionId: reconnected });
    expect(reconnect.finish).toMatchObject({ state: "connected", connectionId: reconnected, reconnected: true });
    const reconnectedRow = await connectionRow(reconnected);
    expect(reconnectedRow.scope_kind).toBe("user");
    expect(reconnectedRow.is_default).toBe(false);

    const report = await runScheduledMaintenance({ db: vaultDb, rootWrapKey, adapters, scope: { organizationId: orgId } });
    expect(report.failedTasks).toEqual([]);
    const staleRow = await connectionRow(stale);
    expect(staleRow.scope_kind).toBe("user");
    expect(staleRow.is_default).toBe(false);
    expect((await connectionRow(personal)).is_default).toBe(true);
  }, DB_TEST_TIMEOUT_MS);
});
