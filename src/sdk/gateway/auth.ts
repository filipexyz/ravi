/**
 * Auth surface for the gateway.
 *
 * TODO(sdk/auth, draft): the `sdk/auth` spec is in draft. Today this module
 * only forwards Bearer tokens — it does NOT validate them against any
 * authority. The mapping from token → `ScopeContext` is a static configuration
 * passed by the caller (`createGatewayHandlerContext({ auth: { bearerTokens } })`),
 * used in tests and dev. Production deployments must keep the daemon's HTTP
 * server bound to `127.0.0.1` until `sdk/auth` lands and provides token
 * verification.
 *
 * v0 behavior: when no `Authorization` header is present, the gateway uses an
 * anonymous local-host `ScopeContext`. The default `ScopeContext` is sourced
 * from env vars (`RAVI_AGENT_ID`, etc.) by the CLI; the gateway forwards
 * whatever it receives without re-validating.
 *
 * The point of this layer is to keep auth concerns out of the dispatcher.
 * Future iterations can swap in JWT, mTLS, or session-bound tokens without
 * touching the dispatch path.
 */

import type { ScopeContext } from "../../permissions/scope.js";

export interface BearerTokenBinding {
  token: string;
  context: ScopeContext;
}

export interface GatewayAuthConfig {
  /**
   * Static tokens. First match wins. Keep tokens out of source — pass them
   * via env or call site.
   */
  bearerTokens?: BearerTokenBinding[];
  /**
   * Default ScopeContext when no `Authorization` header is provided.
   * For local-only dev we leave `agentId` undefined which makes
   * `isScopeEnforced` return `false`.
   */
  anonymousContext?: ScopeContext;
}

export interface ResolvedAuth {
  context: ScopeContext;
  authenticated: boolean;
  token?: string;
}

export function parseBearer(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.replace(/^bearer\s+/i, "").trim();
  return token.length > 0 ? token : null;
}

export function resolveAuth(request: Request, config: GatewayAuthConfig): ResolvedAuth {
  const headerToken = parseBearer(request.headers.get("authorization"));
  if (headerToken && config.bearerTokens) {
    for (const binding of config.bearerTokens) {
      if (binding.token && binding.token === headerToken) {
        return { context: { ...binding.context }, authenticated: true, token: headerToken };
      }
    }
  }
  return {
    context: { ...(config.anonymousContext ?? {}) },
    authenticated: false,
  };
}
