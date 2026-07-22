import {
  getCredentialConnection,
  recordCredentialAuditEvent,
  replaceSecret,
  resolveCredentialSecret,
  type CredentialStoreOptions,
} from "../../credentials/index.js";
import type { TinyTenantConfig } from "./config.js";
import { TINY_V3_QUOTA, publicTinyQuota } from "./quota.js";

export const TINY_OAUTH_AUTHORIZATION_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth";
export const TINY_OAUTH_TOKEN_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token";
export const TINY_OAUTH_DOC = "https://api-docs.erp.olist.com/documentacao/comecando/autenticacao";
export const TINY_OAUTH_ACCESS_LIFETIME_SECONDS = 4 * 60 * 60;
export const TINY_OAUTH_REFRESH_LIFETIME_SECONDS = 24 * 60 * 60;

export interface TinyOAuthBundle {
  version: 1;
  tokenType: "Bearer";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  scopes: string[];
  updatedAt: number;
}

export interface TinyOAuthResolution {
  accessToken: string;
  refreshed: boolean;
  bundle: TinyOAuthBundle;
}

export interface TinyOAuthEnsureOptions {
  now?: number;
  fetchImpl?: TinyOAuthFetch;
  persist: (bundle: TinyOAuthBundle) => Promise<void>;
}

export type TinyOAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseTinyOAuthBundle(secret: string): TinyOAuthBundle {
  let value: unknown;
  try {
    value = JSON.parse(secret) as unknown;
  } catch {
    throw new Error("Bundle OAuth Tiny invalido no broker; reautorize a conexao.");
  }
  if (!isRecord(value) || value.version !== 1 || value.tokenType !== "Bearer") {
    throw new Error("Bundle OAuth Tiny tem versao/tokenType invalido; reautorize a conexao.");
  }
  const clientId = requiredSecretString(value.clientId, "clientId");
  const clientSecret = requiredSecretString(value.clientSecret, "clientSecret");
  const accessToken = requiredSecretString(value.accessToken, "accessToken");
  const refreshToken = requiredSecretString(value.refreshToken, "refreshToken");
  const redirectUri = requiredString(value.redirectUri, "redirectUri");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    throw new Error("Bundle OAuth Tiny usa redirectUri insegura; configure HTTPS ou localhost controlado.");
  }
  const accessTokenExpiresAt = requiredTimestamp(value.accessTokenExpiresAt, "accessTokenExpiresAt");
  const refreshTokenExpiresAt = requiredTimestamp(value.refreshTokenExpiresAt, "refreshTokenExpiresAt");
  const updatedAt = requiredTimestamp(value.updatedAt, "updatedAt");
  const scopes = normalizeScopes(value.scopes);
  if (!scopes.includes("openid")) throw new Error("Bundle OAuth Tiny sem scope openid; reautorize a conexao.");
  return {
    version: 1,
    tokenType: "Bearer",
    clientId,
    clientSecret,
    redirectUri,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    scopes,
    updatedAt,
  };
}

export async function ensureTinyOAuthAccess(
  bundle: TinyOAuthBundle,
  options: TinyOAuthEnsureOptions,
): Promise<TinyOAuthResolution> {
  const now = options.now ?? Date.now();
  if (bundle.accessTokenExpiresAt > now + 5 * 60 * 1000) {
    return { accessToken: bundle.accessToken, refreshed: false, bundle };
  }
  if (bundle.refreshTokenExpiresAt <= now) {
    throw new Error("Refresh token Tiny expirado; novo consentimento OAuth e obrigatorio.");
  }

  const response = await (options.fetchImpl ?? fetch)(TINY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: bundle.clientId,
      client_secret: bundle.clientSecret,
      refresh_token: bundle.refreshToken,
    }),
  });
  if (!response.ok)
    throw new Error(`Refresh OAuth Tiny falhou (HTTP ${response.status}); reautentique sem repetir em loop.`);
  const payload = (await response.json()) as unknown;
  if (!isRecord(payload)) throw new Error("Refresh OAuth Tiny retornou contrato invalido; reautentique.");
  const accessToken = requiredSecretString(payload.access_token, "access_token");
  const refreshToken =
    typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : bundle.refreshToken;
  const expiresIn = requiredPositiveSeconds(payload.expires_in, "expires_in");
  const returnedScopes = parseReturnedScopes(payload.scope, bundle.scopes);
  const unexpectedScope = returnedScopes.find((scope) => !bundle.scopes.includes(scope));
  if (unexpectedScope)
    throw new Error("Refresh OAuth Tiny tentou ampliar scopes; novo consentimento e revisao sao obrigatorios.");
  if (!returnedScopes.includes("openid")) throw new Error("Refresh OAuth Tiny perdeu scope openid; reautentique.");

  const receivedNewRefreshToken = refreshToken !== bundle.refreshToken;
  const refreshExpiresIn = optionalPositiveSeconds(payload.refresh_expires_in);
  const next: TinyOAuthBundle = {
    ...bundle,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt:
      refreshExpiresIn !== null
        ? now + refreshExpiresIn * 1000
        : receivedNewRefreshToken
          ? now + TINY_OAUTH_REFRESH_LIFETIME_SECONDS * 1000
          : bundle.refreshTokenExpiresAt,
    scopes: returnedScopes,
    updatedAt: now,
  };
  await options.persist(next);
  return { accessToken, refreshed: true, bundle: next };
}

export function inspectTinyV3AuthPlan(config: TinyTenantConfig, options: CredentialStoreOptions = {}) {
  if (config.apiVersion !== "v3") throw new Error("v3-auth-check exige tenant apiVersion v3.");
  const connection = getCredentialConnection(config.credentialProvider, config.credentialConnection, options);
  return {
    ok: true,
    dryRun: true,
    tenant: config.tenant,
    apiVersion: "v3" as const,
    credentialProvider: config.credentialProvider,
    credentialConnection: config.credentialConnection,
    credentialConfigured: connection !== null,
    credentialActive: connection?.status === "active",
    credentialBackend: connection?.backend ?? null,
    configuredScopes: connection?.scopes ?? [],
    requiredScopes: ["openid"],
    secretResolved: false,
    networkCalled: false,
    authorizationUrl: TINY_OAUTH_AUTHORIZATION_URL,
    tokenUrl: TINY_OAUTH_TOKEN_URL,
    accessTokenLifetimeSeconds: TINY_OAUTH_ACCESS_LIFETIME_SECONDS,
    refreshTokenLifetimeSeconds: TINY_OAUTH_REFRESH_LIFETIME_SECONDS,
    refreshSkewSeconds: 300,
    refreshPersistence: "same-broker-secret-ref" as const,
    auditActions: ["oauth.access", "oauth.refresh"],
    quota: publicTinyQuota(TINY_V3_QUOTA),
    provenance: { officialDoc: TINY_OAUTH_DOC, verifiedAt: "2026-07-14" as const },
  };
}

export async function resolveTinyV3AccessToken(
  config: TinyTenantConfig,
  options: CredentialStoreOptions & { now?: number; fetchImpl?: TinyOAuthFetch } = {},
): Promise<{ accessToken: string; refreshed: boolean }> {
  if (config.apiVersion !== "v3") throw new Error("Resolver OAuth Tiny v3 exige tenant apiVersion v3.");
  const connection = getCredentialConnection(config.credentialProvider, config.credentialConnection, options);
  if (!connection || connection.status !== "active") throw new Error("Conexao OAuth Tiny v3 ausente ou inativa.");
  if (!connection.scopes.includes("openid")) throw new Error("Conexao OAuth Tiny v3 sem scope openid; reautorize.");
  const resolved = await resolveCredentialSecret({
    provider: config.credentialProvider,
    connection: config.credentialConnection,
    action: "oauth.access",
    authorization: { tenant: config.tenant },
    options,
  });
  const bundle = parseTinyOAuthBundle(resolved.secret);
  try {
    const ensured = await ensureTinyOAuthAccess(bundle, {
      now: options.now,
      fetchImpl: options.fetchImpl,
      persist: async (next) => replaceSecret(connection.secretRef, JSON.stringify(next)),
    });
    if (ensured.refreshed) {
      recordCredentialAuditEvent(
        {
          provider: config.credentialProvider,
          connection: config.credentialConnection,
          action: "oauth.refresh",
          decision: "allow",
          approvalRequired: false,
          approvalStatus: "not_required",
          resultStatus: "token_refreshed",
        },
        options,
      );
    }
    return { accessToken: ensured.accessToken, refreshed: ensured.refreshed };
  } catch (error) {
    recordCredentialAuditEvent(
      {
        provider: config.credentialProvider,
        connection: config.credentialConnection,
        action: "oauth.refresh",
        decision: "deny",
        approvalRequired: false,
        approvalStatus: "not_required",
        resultStatus: "failed",
        errorCode: oauthErrorCode(error),
      },
      options,
    );
    throw error;
  }
}

function requiredSecretString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 8) throw new Error(`Bundle OAuth Tiny sem ${field}; reautorize.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Bundle OAuth Tiny sem ${field}; reautorize.`);
  return value.trim();
}

function requiredTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Bundle OAuth Tiny com ${field} invalido; reautorize.`);
  }
  return value;
}

function requiredPositiveSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Refresh OAuth Tiny sem ${field} valido; reautentique.`);
  }
  return value;
}

function optionalPositiveSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error("Bundle OAuth Tiny sem scopes validos; reautorize.");
  }
  return Array.from(new Set(value.map((scope) => String(scope).trim()))).sort();
}

function parseReturnedScopes(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null || value === "") return [...fallback];
  if (typeof value !== "string") throw new Error("Refresh OAuth Tiny retornou scope invalido; reautentique.");
  return Array.from(new Set(value.split(/\s+/).filter(Boolean))).sort();
}

function oauthErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  if (message.includes("expirado")) return "refresh_expired";
  if (message.includes("scopes") || message.includes("scope")) return "scope_mismatch";
  if (message.includes("HTTP")) return "refresh_http_error";
  return "oauth_refresh_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
