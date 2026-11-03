/**
 * Google connector adapter.
 *
 * Implements the Google OAuth 2.0 web server flow with PKCE for the
 * shared Ravi `ravi-connectors` Worker. Capabilities for Gmail, Google
 * Calendar, and Google Drive dispatch through a per-capability
 * implementation table (see ./google-capabilities). This module does
 * not perform any persistence — it returns provider responses that the
 * vault and proxy layers persist or project.
 *
 * Refs:
 *   - https://developers.google.com/identity/protocols/oauth2/web-server
 *   - https://developers.google.com/identity/protocols/oauth2#expiration
 */

import {
  AdapterProviderError,
  type AdapterAuthorizationInput,
  type AdapterExchangeInput,
  type AdapterExecuteInput,
  type AdapterRefreshInput,
  type AdapterRevokeInput,
  type ConnectorAdapter,
  type ProviderTokenBundle,
} from "./adapter";
import { decodeIdTokenClaims } from "../identity";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
// A revoke runs while the account's rows are locked; a slow one fails and
// is retried by the scheduled handler.
const GOOGLE_REVOKE_TIMEOUT_MS = 10_000;

// Identity: `openid` makes the token endpoint return an id_token whose
// `sub` and `email` identify the connected account.
export const GOOGLE_IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

// Scopes that allow writing. `read_only` access never requests them, and a
// connection holding none of them is shown as read only.
export const GOOGLE_WRITE_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

// Short names Google may return in a token response for scopes requested
// by their full URL.
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

const DEFAULT_GOOGLE_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  // Capability families
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export interface GoogleAdapterConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

export interface GoogleCapabilityHandler {
  execute(input: { parameters: unknown; accessToken: string; abortSignal: AbortSignal }): Promise<unknown>;
}

export interface GoogleAdapterDeps {
  config: GoogleAdapterConfig;
  capabilities: Map<string, GoogleCapabilityHandler>;
}

export function createGoogleAdapter(deps: GoogleAdapterDeps): ConnectorAdapter {
  const fetchImpl = deps.config.fetchImpl ?? fetch;

  return {
    providerId: "google",
    displayName: "Google",
    supportsPkce: true,
    defaultScopes: DEFAULT_GOOGLE_SCOPES,
    identityScopes: GOOGLE_IDENTITY_SCOPES,
    writeScopes: GOOGLE_WRITE_SCOPES,

    buildAuthorizationUrl(input: AdapterAuthorizationInput): string {
      const params = new URLSearchParams({
        client_id: deps.config.clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: (input.scopes.length ? input.scopes : DEFAULT_GOOGLE_SCOPES).join(" "),
        state: input.state,
        access_type: "offline",
        prompt: "consent",
      });
      if (input.includeGrantedScopes !== false) {
        params.set("include_granted_scopes", "true");
      }
      if (input.pkceChallenge) {
        params.set("code_challenge", input.pkceChallenge);
        params.set("code_challenge_method", "S256");
      }
      if (input.loginHint) {
        params.set("login_hint", input.loginHint);
      }
      return `${GOOGLE_AUTH_URL}?${params.toString()}`;
    },

    async exchangeAuthorizationCode(input: AdapterExchangeInput): Promise<ProviderTokenBundle> {
      const body = new URLSearchParams({
        client_id: deps.config.clientId,
        client_secret: deps.config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      });
      if (input.pkceVerifier) body.set("code_verifier", input.pkceVerifier);
      return tokenRequest(fetchImpl, body);
    },

    async refresh(input: AdapterRefreshInput): Promise<ProviderTokenBundle> {
      const body = new URLSearchParams({
        client_id: deps.config.clientId,
        client_secret: deps.config.clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      });
      return tokenRequest(fetchImpl, body);
    },

    async revoke(input: AdapterRevokeInput): Promise<void> {
      // Google's revoke endpoint accepts either access or refresh tokens
      // and irreversibly invalidates the entire grant. Prefer the
      // refresh token because it is longer-lived and revoking it kills
      // all derived access tokens too.
      const token = input.refreshToken ?? input.accessToken;
      if (!token) return;
      const body = new URLSearchParams({ token });
      const response = await fetchImpl(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(GOOGLE_REVOKE_TIMEOUT_MS),
      });
      if (!response.ok && response.status !== 400) {
        // 400 from Google's revoke endpoint commonly means the token was
        // already invalid; treat it as success.
        throw new AdapterProviderError(
          response.status,
          await safeProviderCode(response),
          "Google revoke failed",
        );
      }
    },

    async executeCapability<TIn, TOut>(input: AdapterExecuteInput<TIn>): Promise<TOut> {
      const handler = deps.capabilities.get(input.capability);
      if (!handler) {
        throw new AdapterProviderError(501, "not_implemented", "Capability not supported");
      }
      const result = await handler.execute({
        parameters: input.parameters,
        accessToken: input.accessToken,
        abortSignal: input.abortSignal,
      });
      return result as TOut;
    },
  };
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  body: URLSearchParams,
): Promise<ProviderTokenBundle> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AdapterProviderError(
      response.status,
      await safeProviderCodeFromText(text),
      "Google token request failed",
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AdapterProviderError(
      502,
      "invalid_response",
      "Google token response was not valid JSON",
    );
  }

  const accessToken = stringField(payload, "access_token");
  if (!accessToken) {
    throw new AdapterProviderError(502, "missing_access_token", "Google response missing access_token");
  }
  const refreshToken = stringField(payload, "refresh_token") ?? undefined;
  const idToken = stringField(payload, "id_token") ?? undefined;
  const expiresInSeconds = numberField(payload, "expires_in") ?? undefined;
  const scopeString = stringField(payload, "scope");
  const scopes = scopeString
    ? scopeString.split(/\s+/).filter(Boolean).map((scope) => GOOGLE_SCOPE_ALIASES[scope] ?? scope)
    : [];
  const identity = decodeIdTokenClaims(idToken);

  return {
    accessToken,
    refreshToken,
    idToken,
    expiresInSeconds,
    scopes,
    externalAccountId: identity?.sub ?? undefined,
    externalAccountLogin: identity?.email ?? undefined,
  };
}

async function safeProviderCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return safeProviderCodeFromText(text);
  } catch {
    return null;
  }
}

function safeProviderCodeFromText(text: string): string | null {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (json && typeof json === "object" && typeof json.error === "string") {
      return json.error;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
