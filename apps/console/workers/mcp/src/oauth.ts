import {
  consumeAuthorization,
  createOAuthClient,
  createOAuthToken,
  findAccessTokenByHash,
  findAuthorizationByCodeHash,
  findBridgeByToken,
  findClientByClientId,
  findRefreshToken,
  markOAuthAccessTokenUsed,
  revokeTokenByHash,
  rotateOAuthToken,
  type BridgeRecord,
  type McpDb,
  type OAuthAccessTokenRecord,
  type OAuthAuthorizationRecord,
  type OAuthClientRecord,
} from "./db";
import type { McpWorkerEnv } from "./env";
import { McpHttpError } from "./errors";
import { pkceS256, randomBase64Url, sha256Hex } from "./crypto";

/** Scopes of the daemon bridge resource (`/{bridge_token}/mcp`). */
export const BRIDGE_RESOURCE_SCOPES = [
  "mcp.bridge.connect",
  "mcp.bridge.tools.read",
  "mcp.bridge.tools.invoke",
  "mcp.bridge.tools.invoke_destructive",
  "mcp.bridge.resources.read",
  "mcp.bridge.prompts.read",
] as const;

/**
 * Scopes of the Console mode resource (`/{bridge_token}/console/mcp`): the
 * Console operation registry as the signed-in person. `read` lists tools and
 * runs read operations; `write` also runs write operations, each only after
 * the two-step confirmation.
 */
export const CONSOLE_SCOPES = {
  read: "mcp.console.tools.read",
  write: "mcp.console.tools.write",
} as const;
export const CONSOLE_RESOURCE_SCOPES = [CONSOLE_SCOPES.read, CONSOLE_SCOPES.write] as const;

const SUPPORTED_SCOPES: string[] = [...BRIDGE_RESOURCE_SCOPES, ...CONSOLE_RESOURCE_SCOPES];
const SUPPORTED_SCOPE_SET = new Set(SUPPORTED_SCOPES);
const MANDATORY_CONNECT_SCOPE = "mcp.bridge.connect";

/** The two MCP servers one bridge URL token serves. */
export type McpResourceKind = "bridge" | "console";
export type McpResourceTarget = { kind: McpResourceKind; bridgeToken: string; resource: string };

export type McpAccessTokenContext = {
  tokenId: string;
  oauthClientId: string;
  clientId: string;
  clientName: string;
  softwareId: string | null;
  softwareVersion: string | null;
  subjectUserId: string;
  scopes: string[];
};

export function baseUrl(env: McpWorkerEnv) {
  return env.RAVI_MCP_BASE_URL.replace(/\/$/, "");
}

/**
 * RFC 8414 metadata. Without a bridge token it is the shared issuer. With one
 * (`/.well-known/oauth-authorization-server/{bridge_token}`) the issuer is
 * `{base}/{bridge_token}` and the registration endpoint carries the bridge, so
 * a standard MCP client can register (RFC 7591) without knowing Ravi's
 * `bridge_token` query parameter.
 */
export function discovery(env: McpWorkerEnv, bridgeToken?: string | null) {
  const base = baseUrl(env);
  const issuer = bridgeToken ? `${base}/${bridgeToken}` : base;
  const registration = bridgeToken
    ? `${base}/oauth/mcp/register?bridge_token=${encodeURIComponent(bridgeToken)}`
    : `${base}/oauth/mcp/register`;
  return {
    issuer,
    authorization_endpoint: `${base}/oauth/mcp/authorize`,
    token_endpoint: `${base}/oauth/mcp/token`,
    registration_endpoint: registration,
    revocation_endpoint: `${base}/oauth/mcp/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: SUPPORTED_SCOPES,
  };
}

/** The canonical resource URL (RFC 8707) of one of a bridge's MCP servers. */
export function resourceUrl(env: McpWorkerEnv, kind: McpResourceKind, bridgeToken: string) {
  return kind === "console" ? `${baseUrl(env)}/${bridgeToken}/console/mcp` : `${baseUrl(env)}/${bridgeToken}/mcp`;
}

/** Where the RFC 9728 metadata of that resource lives (path-inserted well-known URI). */
export function protectedResourceMetadataUrl(env: McpWorkerEnv, kind: McpResourceKind, bridgeToken: string) {
  const path = kind === "console" ? `${bridgeToken}/console/mcp` : `${bridgeToken}/mcp`;
  return `${baseUrl(env)}/.well-known/oauth-protected-resource/${path}`;
}

/**
 * RFC 9728 protected resource metadata. With a target it describes that MCP
 * server; without one (`/.well-known/oauth-protected-resource`) it describes
 * the host and points at the shared issuer.
 */
export function protectedResourceMetadata(env: McpWorkerEnv, target?: Omit<McpResourceTarget, "resource"> | null) {
  const base = baseUrl(env);
  if (!target) {
    return {
      resource: base,
      authorization_servers: [base],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Ravi MCP",
    };
  }
  return {
    resource: resourceUrl(env, target.kind, target.bridgeToken),
    authorization_servers: [`${base}/${target.bridgeToken}`],
    scopes_supported: target.kind === "console" ? [...CONSOLE_RESOURCE_SCOPES] : [...BRIDGE_RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: target.kind === "console" ? "Ravi Console" : "Ravi MCP Bridge",
  };
}

/** Parses a `resource` value (RFC 8707) into one of this host's MCP servers, or null. */
export function parseResourceTarget(env: McpWorkerEnv, resource: string): McpResourceTarget | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl(env)).origin || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/([A-Za-z0-9_-]{16,128})\/(console\/)?mcp\/?$/);
  if (!match) return null;
  const bridgeToken = match[1]!;
  const kind: McpResourceKind = match[2] ? "console" : "bridge";
  return { kind, bridgeToken, resource: resourceUrl(env, kind, bridgeToken) };
}

/**
 * Binds a request to a resource (RFC 8707): the resource must be one of the
 * MCP servers of the bridge the client registered on, else `invalid_target`.
 */
export async function resolveResourceForBridge(input: {
  db: McpDb;
  env: McpWorkerEnv;
  resource: string;
  bridgeId: string;
}): Promise<McpResourceTarget> {
  const target = parseResourceTarget(input.env, input.resource);
  if (!target) throw new McpHttpError(400, "invalid_target", "resource is not an MCP server of this host");
  const bridge = await findBridgeByToken(input.db, target.bridgeToken);
  if (!bridge || bridge.id !== input.bridgeId) {
    throw new McpHttpError(400, "invalid_target", "resource does not belong to this client's bridge");
  }
  return target;
}

/**
 * The scopes a token for `kind` keeps: Console scopes stay off daemon bridge
 * tokens and daemon scopes off Console tokens, so a token minted for one MCP
 * server cannot be replayed against the other (audience binding by scope).
 */
export function scopesForResource(kind: McpResourceKind, scopes: string[]): string[] {
  const allowed = new Set<string>(kind === "console" ? [MANDATORY_CONNECT_SCOPE, ...CONSOLE_RESOURCE_SCOPES] : BRIDGE_RESOURCE_SCOPES);
  return normalizeRequestedScopes(scopes.filter((scope) => allowed.has(scope)));
}

export async function registerClient(input: {
  db: McpDb;
  bridgeToken: string | null;
  body: Record<string, unknown>;
}) {
  if (!input.bridgeToken) throw new McpHttpError(400, "payload_invalid", "bridge token required");
  const bridge = await findBridgeByToken(input.db, input.bridgeToken);
  if (!bridge) throw new McpHttpError(404, "not_found", "bridge not found");

  const redirectUris = stringArray(input.body.redirect_uris);
  const clientName = stringField(input.body, "client_name") ?? "MCP Client";
  if (redirectUris.length === 0) throw new McpHttpError(400, "payload_invalid", "redirect_uris required");

  const authMethod = stringField(input.body, "token_endpoint_auth_method") ?? "none";
  if (authMethod !== "none" && authMethod !== "client_secret_basic") {
    throw new McpHttpError(400, "payload_invalid", "unsupported auth method");
  }

  const clientId = `mcp_client_${randomBase64Url(24)}`;
  const clientSecret = authMethod === "client_secret_basic" ? randomBase64Url(32) : null;
  const client = await createOAuthClient({
    db: input.db,
    bridge,
    clientId,
    clientSecretHash: clientSecret ? await sha256Hex(clientSecret) : null,
    clientName,
    softwareId: stringField(input.body, "software_id"),
    softwareVersion: stringField(input.body, "software_version"),
    redirectUris,
    grantTypes: stringArray(input.body.grant_types, ["authorization_code", "refresh_token"]),
    tokenEndpointAuthMethod: authMethod,
  });

  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUrisJson,
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: authMethod,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
}

export async function authorizeRedirect(input: {
  db: McpDb;
  env: McpWorkerEnv;
  url: URL;
}) {
  const clientId = input.url.searchParams.get("client_id");
  const redirectUri = input.url.searchParams.get("redirect_uri");
  const responseType = input.url.searchParams.get("response_type");
  const codeChallenge = input.url.searchParams.get("code_challenge");
  const codeChallengeMethod = input.url.searchParams.get("code_challenge_method");

  if (
    !clientId ||
    !redirectUri ||
    responseType !== "code" ||
    !codeChallenge ||
    codeChallengeMethod !== "S256"
  ) {
    throw new McpHttpError(400, "payload_invalid", "invalid authorization request");
  }

  const client = await findClientByClientId(input.db, clientId);
  if (!client || !client.redirectUrisJson.includes(redirectUri)) {
    throw new McpHttpError(400, "payload_invalid", "unknown client or redirect_uri");
  }
  const resource = input.url.searchParams.get("resource");
  const target = resource
    ? await resolveResourceForBridge({ db: input.db, env: input.env, resource, bridgeId: client.bridgeId })
    : null;
  const scopeParam = input.url.searchParams.get("scope")?.split(/\s+/).filter(Boolean);
  // A client that names the Console resource but no scope gets the read-only Console set.
  const requestedScopes = normalizeRequestedScopes(
    scopeParam?.length ? scopeParam : target?.kind === "console" ? [CONSOLE_SCOPES.read] : undefined,
  );

  const consoleUrl = new URL(`${input.env.RAVI_CONSOLE_BASE_URL.replace(/\/$/, "")}/mcp/authorize`);
  input.url.searchParams.forEach((value, key) => consoleUrl.searchParams.set(key, value));
  consoleUrl.searchParams.set("bridge_id", client.bridgeId);
  consoleUrl.searchParams.set("scope", requestedScopes.join(" "));
  if (target) consoleUrl.searchParams.set("resource", target.resource);
  return Response.redirect(consoleUrl.toString(), 302);
}

export async function exchangeToken(input: {
  db: McpDb;
  env: McpWorkerEnv;
  body: Record<string, unknown>;
  authorizationHeader: string | null;
}) {
  const grantType = stringField(input.body, "grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(input);
  if (grantType === "refresh_token") return refreshAccessToken(input);
  throw new McpHttpError(400, "payload_invalid", "unsupported grant_type");
}

export async function revokeToken(input: { db: McpDb; body: Record<string, unknown> }) {
  const token = stringField(input.body, "token");
  if (!token) throw new McpHttpError(400, "payload_invalid", "token required");
  await revokeTokenByHash(input.db, await sha256Hex(token));
  return { revoked: true };
}

export async function authenticateAccessToken(input: {
  db: McpDb;
  bridge: BridgeRecord;
  authorizationHeader: string | null;
  now?: Date;
}): Promise<McpAccessTokenContext> {
  const bearerToken = bearerTokenFromAuthorization(input.authorizationHeader);
  if (!bearerToken) throw new McpHttpError(401, "mcp_unauthorized", "Bearer access token required");

  const token = await findAccessTokenByHash(input.db, await sha256Hex(bearerToken));
  assertAccessTokenUsableForBridge(token, input.bridge, input.now ?? new Date());
  await markOAuthAccessTokenUsed(input.db, token);

  return {
    tokenId: token.id,
    oauthClientId: token.oauthClientId,
    clientId: token.clientId,
    clientName: token.clientName,
    softwareId: token.softwareId,
    softwareVersion: token.softwareVersion,
    subjectUserId: token.subjectUserId,
    scopes: normalizeRequestedScopes(token.scopesJson),
  };
}

async function exchangeAuthorizationCode(input: {
  db: McpDb;
  env: McpWorkerEnv;
  body: Record<string, unknown>;
  authorizationHeader: string | null;
}) {
  const client = await authenticatedClient(input);
  const code = stringField(input.body, "code");
  const redirectUri = stringField(input.body, "redirect_uri");
  const codeVerifier = stringField(input.body, "code_verifier");
  if (!code || !redirectUri || !codeVerifier) {
    throw new McpHttpError(400, "payload_invalid", "code exchange requires code, redirect_uri and code_verifier");
  }

  const authorization = await findAuthorizationByCodeHash(input.db, await sha256Hex(code));
  assertAuthorizationUsable(authorization, client, redirectUri);

  const verifierChallenge = await pkceS256(codeVerifier);
  if (verifierChallenge !== authorization.codeChallenge) {
    throw new McpHttpError(401, "mcp_unauthorized", "PKCE mismatch");
  }

  const scopesJson = await scopesForRequestedResource(input, authorization.bridgeId, authorization.scopesJson);
  const tokens = await issueTokens(input.db, { ...authorization, scopesJson });
  await consumeAuthorization(input.db, authorization.id);
  return tokens;
}

async function refreshAccessToken(input: {
  db: McpDb;
  env: McpWorkerEnv;
  body: Record<string, unknown>;
  authorizationHeader: string | null;
}) {
  const client = await authenticatedClient(input);
  const refreshToken = stringField(input.body, "refresh_token");
  if (!refreshToken) throw new McpHttpError(400, "payload_invalid", "refresh_token required");
  const existing = await findRefreshToken(input.db, await sha256Hex(refreshToken));
  if (
    !existing ||
    existing.revokedAt ||
    existing.refreshTokenExpiresAt.getTime() <= Date.now() ||
    existing.oauthClientId !== client.id
  ) {
    throw new McpHttpError(401, "mcp_unauthorized", "refresh token rejected");
  }

  const scopesJson = normalizeRequestedScopes(await scopesForRequestedResource(input, existing.bridgeId, existing.scopesJson));
  const accessToken = `mcp_at_${randomBase64Url(32)}`;
  const nextRefreshToken = `mcp_rt_${randomBase64Url(32)}`;
  const rotated = await rotateOAuthToken({
    db: input.db,
    parentTokenId: existing.id,
    scopesJson,
    accessTokenHash: await sha256Hex(accessToken),
    refreshTokenHash: await sha256Hex(nextRefreshToken),
    accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    // A cloud run's token chain never outlives the run's hard end.
    capToParent: client.clientId.startsWith(CLOUD_RUN_CLIENT_PREFIX),
  });
  if (!rotated) throw new McpHttpError(401, "mcp_unauthorized", "refresh token rejected");
  return {
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: nextRefreshToken,
    scope: scopesJson.join(" "),
  };
}

/** With a `resource` (RFC 8707) the token is narrowed to the scopes that resource accepts. */
async function scopesForRequestedResource(
  input: { db: McpDb; env: McpWorkerEnv; body: Record<string, unknown> },
  bridgeId: string,
  scopes: string[],
) {
  const resource = stringField(input.body, "resource");
  if (!resource) return scopes;
  const target = await resolveResourceForBridge({ db: input.db, env: input.env, resource, bridgeId });
  return scopesForResource(target.kind, scopes);
}

async function authenticatedClient(input: {
  db: McpDb;
  body: Record<string, unknown>;
  authorizationHeader: string | null;
}) {
  const clientIdFromBody = stringField(input.body, "client_id");
  const basic = parseBasic(input.authorizationHeader);
  const clientId = basic?.clientId ?? clientIdFromBody;
  if (!clientId) throw new McpHttpError(401, "mcp_unauthorized", "client_id required");
  const client = await findClientByClientId(input.db, clientId);
  if (!client) throw new McpHttpError(401, "mcp_unauthorized", "client rejected");

  if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    const secret = basic?.clientSecret ?? stringField(input.body, "client_secret");
    if (!secret || !client.clientSecretHash || (await sha256Hex(secret)) !== client.clientSecretHash) {
      throw new McpHttpError(401, "mcp_unauthorized", "client secret rejected");
    }
  }
  return client;
}

function assertAuthorizationUsable(
  authorization: OAuthAuthorizationRecord | null,
  client: OAuthClientRecord,
  redirectUri: string,
): asserts authorization is OAuthAuthorizationRecord {
  if (
    !authorization ||
    authorization.oauthClientId !== client.id ||
    authorization.redirectUri !== redirectUri ||
    authorization.consumedAt ||
    authorization.expiresAt.getTime() <= Date.now()
  ) {
    throw new McpHttpError(401, "mcp_unauthorized", "authorization rejected");
  }
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** OAuth clients the Console mints for cloud agent runs (`ravi-cloud-agents.<bridgeId>`). */
const CLOUD_RUN_CLIENT_PREFIX = "ravi-cloud-agents.";

async function issueTokens(db: McpDb, authorization: OAuthAuthorizationRecord) {
  const accessToken = `mcp_at_${randomBase64Url(32)}`;
  const refreshToken = `mcp_rt_${randomBase64Url(32)}`;
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const normalizedScopes = normalizeRequestedScopes(authorization.scopesJson);
  await createOAuthToken({
    db,
    authorization: { ...authorization, scopesJson: normalizedScopes },
    accessTokenHash: await sha256Hex(accessToken),
    refreshTokenHash: await sha256Hex(refreshToken),
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  });
  return {
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: normalizedScopes.join(" "),
  };
}

export function bearerTokenFromAuthorization(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

export function normalizeRequestedScopes(scopes: string[] | undefined): string[] {
  const requested = scopes?.length ? scopes : [MANDATORY_CONNECT_SCOPE];
  const normalized: string[] = [];

  for (const scope of requested) {
    const value = scope.trim();
    if (!value) continue;
    if (!SUPPORTED_SCOPE_SET.has(value)) {
      throw new McpHttpError(400, "payload_invalid", `unsupported OAuth scope: ${value}`);
    }
    if (!normalized.includes(value)) normalized.push(value);
  }

  if (!normalized.includes(MANDATORY_CONNECT_SCOPE)) normalized.unshift(MANDATORY_CONNECT_SCOPE);
  return normalized.length ? normalized : [MANDATORY_CONNECT_SCOPE];
}

export function accessTokenAllowsScope(auth: McpAccessTokenContext, scope: string): boolean {
  return auth.scopes.includes(scope);
}

function assertAccessTokenUsableForBridge(
  token: OAuthAccessTokenRecord | null,
  bridge: BridgeRecord,
  now: Date,
): asserts token is OAuthAccessTokenRecord {
  if (!token || token.revokedAt || token.accessTokenExpiresAt.getTime() <= now.getTime()) {
    throw new McpHttpError(401, "mcp_unauthorized", "access token rejected");
  }
  if (
    token.bridgeId !== bridge.id ||
    token.organizationId !== bridge.organizationId ||
    token.projectId !== bridge.projectId
  ) {
    throw new McpHttpError(403, "mcp_forbidden", "access token is not valid for this bridge");
  }
}

function parseBasic(value: string | null) {
  if (!value?.startsWith("Basic ")) return null;
  const decoded = atob(value.slice("Basic ".length));
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return {
    clientId: decoded.slice(0, separator),
    clientSecret: decoded.slice(separator + 1),
  };
}

function stringField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function scopesSupported() {
  return SUPPORTED_SCOPES;
}

export function bridgeCapabilities(_bridge: BridgeRecord) {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {
      tools: { listChanged: true },
      resources: {},
      prompts: {},
    },
    serverInfo: {
      name: "Ravi MCP Bridge",
      version: "0.1.0",
    },
  };
}
