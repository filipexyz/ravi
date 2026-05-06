/**
 * Auth surface for the gateway.
 *
 * Validates `Authorization: Bearer rctx_*` against the runtime context
 * registry. The token resolves to a {@link ContextRecord}; the gateway emits
 * the public `contextId` and capability snapshot to the dispatcher and never
 * surfaces the raw context key past this boundary.
 *
 * Spec: `runtime/context-keys`, `sdk/auth`.
 *
 * Behaviour:
 *  - missing header → unauthenticated; transport responds 401 for non-`open` routes
 *  - malformed header (not `Bearer rctx_*`) → unauthenticated; 401
 *  - expired/revoked/unknown token → unauthenticated; 401
 *  - valid token → authenticated; ScopeContext built from the resolved record
 *
 * Static `bearerTokens`/`anonymousContext` placeholders were removed when this
 * module switched to live registry resolution.
 */

import type { ContextRecord } from "../../router/router-db.js";
import type { ScopeContext } from "../../permissions/scope.js";
import { resolveRuntimeContext } from "../../runtime/context-registry.js";

export interface GatewayAuthConfig {
  /** Optional override for the resolver (tests). */
  resolveContext?: (token: string) => ContextRecord | null;
}

export interface ResolvedAuth {
  context: ScopeContext;
  authenticated: boolean;
  contextRecord: ContextRecord | null;
  /** Reason the token was rejected, when authenticated is false. */
  reason: AuthFailureReason;
}

export type AuthFailureReason = "missing" | "malformed" | "unknown" | "revoked" | "expired" | null;

const RCTX_PREFIX = "rctx_";

export function parseBearer(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.replace(/^bearer\s+/i, "").trim();
  return token.length > 0 ? token : null;
}

export function resolveAuth(request: Request, config: GatewayAuthConfig = {}): ResolvedAuth {
  const headerValue = request.headers.get("authorization");
  if (!headerValue) {
    return unauthenticated("missing");
  }

  const token = parseBearer(headerValue);
  if (!token) {
    return unauthenticated("malformed");
  }

  if (!token.startsWith(RCTX_PREFIX)) {
    return unauthenticated("malformed");
  }

  const resolver = config.resolveContext ?? defaultResolver;
  const record = resolver(token);
  if (!record) {
    return unauthenticated("unknown");
  }

  const now = Date.now();
  if (record.revokedAt && record.revokedAt <= now) {
    return unauthenticated("revoked");
  }
  if (record.expiresAt && record.expiresAt <= now) {
    return unauthenticated("expired");
  }

  return {
    context: toScopeContext(record),
    authenticated: true,
    contextRecord: record,
    reason: null,
  };
}

function defaultResolver(token: string): ContextRecord | null {
  return resolveRuntimeContext(token, { touch: true });
}

function unauthenticated(reason: Exclude<AuthFailureReason, null>): ResolvedAuth {
  return {
    context: {},
    authenticated: false,
    contextRecord: null,
    reason,
  };
}

function toScopeContext(record: ContextRecord): ScopeContext {
  const ctx: ScopeContext = {};
  if (record.agentId) ctx.agentId = record.agentId;
  if (record.sessionKey) ctx.sessionKey = record.sessionKey;
  if (record.sessionName) ctx.sessionName = record.sessionName;
  return ctx;
}
