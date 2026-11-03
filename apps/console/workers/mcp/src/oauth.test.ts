import { describe, expect, it } from "bun:test";

import type { BridgeRecord, McpDb, OAuthAccessTokenRecord } from "./db";
import { pkceS256 } from "./crypto";
import { McpHttpError } from "./errors";
import {
  authenticateAccessToken,
  authorizeRedirect,
  bearerTokenFromAuthorization,
  exchangeToken,
  normalizeRequestedScopes,
  parseResourceTarget,
  scopesForResource,
} from "./oauth";
import { BRIDGE_TOKEN, makeBridge as makeSupportBridge, makeEnv, makeFakeDb } from "./test-support";

describe("MCP OAuth access token handling", () => {
  it("extracts bearer tokens without accepting other auth schemes", () => {
    expect(bearerTokenFromAuthorization("Bearer mcp_at_123")).toBe("mcp_at_123");
    expect(bearerTokenFromAuthorization("bearer   mcp_at_123  ")).toBe("mcp_at_123");
    expect(bearerTokenFromAuthorization("Basic abc")).toBeNull();
    expect(bearerTokenFromAuthorization(null)).toBeNull();
  });

  it("normalizes scopes and always includes connect", () => {
    expect(normalizeRequestedScopes(["mcp.bridge.tools.read", "mcp.bridge.tools.read"])).toEqual([
      "mcp.bridge.connect",
      "mcp.bridge.tools.read",
    ]);
    expect(normalizeRequestedScopes(undefined)).toEqual(["mcp.bridge.connect"]);
    expect(() => normalizeRequestedScopes(["admin"])).toThrow(McpHttpError);
  });

  it("resolves a valid access token to the OAuth client identity", async () => {
    const bridge = makeBridge();
    const token = makeToken();
    const db = makeDb(token);

    const auth = await authenticateAccessToken({
      db,
      bridge,
      authorizationHeader: "Bearer mcp_at_secret",
      now: new Date("2026-05-21T12:00:00Z"),
    });

    expect(auth).toMatchObject({
      oauthClientId: "client-row-1",
      clientId: "mcp_client_1",
      clientName: "Claude Desktop",
      subjectUserId: "user-1",
      scopes: ["mcp.bridge.connect", "mcp.bridge.tools.read"],
    });
    expect(db.queries.some((query) => query.includes("from mcp_oauth_tokens token"))).toBe(true);
    expect(db.queries.filter((query) => query.includes("last_used_at = now()"))).toHaveLength(2);
  });

  it("rejects access tokens for a different bridge", async () => {
    const db = makeDb({ ...makeToken(), bridgeId: "other-bridge" });

    await expect(
      authenticateAccessToken({
        db,
        bridge: makeBridge(),
        authorizationHeader: "Bearer mcp_at_secret",
        now: new Date("2026-05-21T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ status: 403, code: "mcp_forbidden" });
  });

  it("rejects revoked or expired access tokens", async () => {
    const expired = makeDb({
      ...makeToken(),
      accessTokenExpiresAt: new Date("2026-05-21T11:59:59Z"),
    });
    await expect(
      authenticateAccessToken({
        db: expired,
        bridge: makeBridge(),
        authorizationHeader: "Bearer mcp_at_secret",
        now: new Date("2026-05-21T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ status: 401, code: "mcp_unauthorized" });

    const revoked = makeDb({ ...makeToken(), revokedAt: new Date("2026-05-21T11:00:00Z") });
    await expect(
      authenticateAccessToken({
        db: revoked,
        bridge: makeBridge(),
        authorizationHeader: "Bearer mcp_at_secret",
        now: new Date("2026-05-21T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ status: 401, code: "mcp_unauthorized" });
  });
});

function makeBridge(): BridgeRecord {
  return {
    id: "bridge-1",
    organizationId: "org-1",
    projectId: "project-1",
    name: "Default bridge",
    status: "active",
    allowedCapabilityClassesJson: ["read"],
    rateLimitOverridesJson: null,
    cachedToolsJson: null,
    expiresAt: null,
  };
}

function makeToken(): OAuthAccessTokenRecord {
  return {
    id: "token-1",
    bridgeId: "bridge-1",
    oauthClientId: "client-row-1",
    organizationId: "org-1",
    projectId: "project-1",
    subjectUserId: "user-1",
    scopesJson: ["mcp.bridge.tools.read"],
    accessTokenExpiresAt: new Date("2026-05-21T13:00:00Z"),
    revokedAt: null,
    clientId: "mcp_client_1",
    clientName: "Claude Desktop",
    softwareId: "claude",
    softwareVersion: "1.0.0",
  };
}

function makeDb(token: OAuthAccessTokenRecord | null): McpDb & { queries: string[] } {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("from mcp_oauth_tokens token")) return Promise.resolve(token ? [token] : []);
    return Promise.resolve([]);
  }) as unknown as McpDb["sql"];

  return {
    sql,
    queries,
    async close() {},
  };
}

describe("MCP OAuth resource binding (RFC 8707)", () => {
  const env = makeEnv();

  it("parses only this host's bridge and Console MCP servers", () => {
    expect(parseResourceTarget(env, `https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`)).toEqual({
      kind: "console",
      bridgeToken: BRIDGE_TOKEN,
      resource: `https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`,
    });
    expect(parseResourceTarget(env, `https://mcp.ravi.so/${BRIDGE_TOKEN}/mcp/`)?.kind).toBe("bridge");
    expect(parseResourceTarget(env, `https://evil.example/${BRIDGE_TOKEN}/mcp`)).toBeNull();
    expect(parseResourceTarget(env, `https://mcp.ravi.so/${BRIDGE_TOKEN}/other`)).toBeNull();
    expect(parseResourceTarget(env, `https://mcp.ravi.so/${BRIDGE_TOKEN}/mcp?x=1`)).toBeNull();
    expect(parseResourceTarget(env, "not a url")).toBeNull();
  });

  it("keeps Console scopes off daemon tokens and daemon scopes off Console tokens", () => {
    const all = ["mcp.bridge.connect", "mcp.bridge.tools.invoke", "mcp.console.tools.read", "mcp.console.tools.write"];
    expect(scopesForResource("console", all)).toEqual(["mcp.bridge.connect", "mcp.console.tools.read", "mcp.console.tools.write"]);
    expect(scopesForResource("bridge", all)).toEqual(["mcp.bridge.connect", "mcp.bridge.tools.invoke"]);
  });

  it("narrows the issued token to the requested resource and rejects another bridge's resource", async () => {
    const verifier = "verifier-0123456789-0123456789-0123456789";
    const authorization = {
      id: "auth-1",
      bridgeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      oauthClientId: "client-row-1",
      organizationId: "org-1",
      projectId: "project-1",
      codeChallenge: await pkceS256(verifier),
      codeChallengeMethod: "S256",
      scopesJson: ["mcp.bridge.connect", "mcp.bridge.tools.read", "mcp.console.tools.read"],
      redirectUri: "https://client.example/callback",
      subjectUserId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    };
    const client = { id: "client-row-1", clientId: "mcp_client_1", tokenEndpointAuthMethod: "none", clientSecretHash: null };
    const makeTokenDb = (bridge: BridgeRecord) =>
      makeFakeDb([
        { match: "from mcp_oauth_clients", rows: [client] },
        { match: "from mcp_oauth_authorizations", rows: [authorization] },
        { match: "from mcp_bridges", rows: [bridge] },
      ]);
    const body = {
      grant_type: "authorization_code",
      client_id: "mcp_client_1",
      code: "code-1",
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: `https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`,
    };

    const db = makeTokenDb(makeSupportBridge());
    const tokens = await exchangeToken({ db, env, body, authorizationHeader: null });
    expect(tokens.scope).toBe("mcp.bridge.connect mcp.console.tools.read");
    const insert = db.queries.find((query) => query.query.includes("insert into mcp_oauth_tokens"));
    expect(JSON.stringify(insert?.values)).toContain("mcp.console.tools.read");
    expect(JSON.stringify(insert?.values)).not.toContain("mcp.bridge.tools.read");

    const otherBridgeDb = makeTokenDb(makeSupportBridge({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }));
    await expect(exchangeToken({ db: otherBridgeDb, env, body, authorizationHeader: null })).rejects.toMatchObject({
      status: 400,
      code: "invalid_target",
    });
    expect(otherBridgeDb.queries.some((query) => query.query.includes("insert into mcp_oauth_tokens"))).toBe(false);
  });

  it("forwards a valid resource to the consent page and defaults a Console resource to read scope", async () => {
    const db = makeFakeDb([
      {
        match: "from mcp_oauth_clients",
        rows: [
          {
            id: "client-row-1",
            bridgeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            clientId: "mcp_client_1",
            redirectUrisJson: ["https://client.example/callback"],
          },
        ],
      },
      { match: "from mcp_bridges", rows: [makeSupportBridge()] },
    ]);
    const url = new URL("https://mcp.ravi.so/oauth/mcp/authorize");
    url.searchParams.set("client_id", "mcp_client_1");
    url.searchParams.set("redirect_uri", "https://client.example/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "challenge-0123456789-0123456789");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", `https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`);

    const response = await authorizeRedirect({ db, env, url });
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://console.ravi.bot/mcp/authorize");
    expect(location.searchParams.get("scope")).toBe("mcp.bridge.connect mcp.console.tools.read");
    expect(location.searchParams.get("resource")).toBe(`https://mcp.ravi.so/${BRIDGE_TOKEN}/console/mcp`);

    url.searchParams.set("resource", "https://mcp.ravi.so/elsewhere");
    await expect(authorizeRedirect({ db, env, url })).rejects.toMatchObject({ status: 400, code: "invalid_target" });
  });
});

describe("MCP OAuth refresh rotation", () => {
  const env = makeEnv();
  const parent = {
    id: "token-1",
    bridgeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    oauthClientId: "client-row-1",
    organizationId: "org-1",
    projectId: "project-1",
    subjectUserId: "user-1",
    refreshTokenHash: "hash",
    scopesJson: ["mcp.bridge.connect", "mcp.console.tools.read"],
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
  };
  const refreshDb = (clientId: string, rotated: boolean) =>
    makeFakeDb([
      { match: "from mcp_oauth_clients", rows: [{ id: "client-row-1", clientId, tokenEndpointAuthMethod: "none", clientSecretHash: null }] },
      { match: "where refresh_token_hash", rows: [parent] },
      { match: "with parent as", rows: rotated ? [{ id: "token-2" }] : [] },
    ]);
  const body = (clientId: string) => ({ grant_type: "refresh_token", client_id: clientId, refresh_token: "mcp_rt_old" });

  it("revokes and issues in one statement; a cloud run client keeps the parent's expiry", async () => {
    const db = refreshDb("ravi-cloud-agents.bridge-1", true);
    const tokens = await exchangeToken({ db, env, body: body("ravi-cloud-agents.bridge-1"), authorizationHeader: null });
    expect(tokens.refresh_token).toStartWith("mcp_rt_");
    const rotation = db.queries.filter((query) => query.query.includes("with parent as"));
    expect(rotation).toHaveLength(1);
    expect(rotation[0]!.query).toContain("revoked_at is null");
    expect(rotation[0]!.values).toContain(true);
    // No separate revoke or insert.
    expect(db.queries.filter((query) => !query.query.includes("with parent as") && query.query.includes("mcp_oauth_tokens") && /update|insert/.test(query.query))).toHaveLength(0);

    const person = refreshDb("mcp_client_1", true);
    await exchangeToken({ db: person, env, body: body("mcp_client_1"), authorizationHeader: null });
    expect(person.queries.find((query) => query.query.includes("with parent as"))!.values).toContain(false);
  });

  it("a refresh token whose parent was revoked meanwhile issues nothing", async () => {
    const db = refreshDb("mcp_client_1", false);
    await expect(exchangeToken({ db, env, body: body("mcp_client_1"), authorizationHeader: null })).rejects.toMatchObject({
      status: 401,
      code: "mcp_unauthorized",
    });
  });
});
