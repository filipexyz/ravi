// Shared glue for the three verifiers: accept a `JwksCache` or a bare jose
// key resolver, and map jose/transport errors to the shared reason codes
// exactly as Console's `grant-verify.ts` does.

import { errors as joseErrors, type JWTVerifyGetKey } from "jose";

export type KeyResolver = JWTVerifyGetKey | { resolveKey: JWTVerifyGetKey };

export function toGetKey(resolver: KeyResolver): JWTVerifyGetKey {
  return typeof resolver === "function" ? resolver : resolver.resolveKey;
}

// Three base64url segments; also bounds the work done on garbage input.
export const COMPACT_JWS_RE = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,1024}$/;

export type CommonRejectReason =
  | "token_malformed"
  | "alg_not_allowed"
  | "typ_mismatch"
  | "kid_invalid"
  | "crit_not_allowed"
  | "key_unknown"
  // The key set could not be loaded (JWKS timeout, invalid document, network
  // failure, stale window over). Not a verdict on the token: callers answer
  // 503 `jwks_unavailable`, never 401.
  | "key_set_unavailable"
  | "signature_invalid"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "timestamps_invalid"
  | "not_yet_valid"
  | "expired";

export function mapJoseError(error: unknown): CommonRejectReason {
  // Anything that is not a jose verdict came from the key set itself: an
  // outage, not a bad token.
  if (!(error instanceof joseErrors.JOSEError)) return "key_set_unavailable";
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) return "key_set_unavailable";
  if (error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return "key_unknown";
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return "signature_invalid";
  if (error instanceof joseErrors.JWTExpired) return "expired";
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return "alg_not_allowed";
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "nbf") return "not_yet_valid";
    if (error.claim === "typ") return "typ_mismatch";
    if (error.claim === "iss") return "issuer_mismatch";
    if (error.claim === "aud") return "audience_mismatch";
    return "timestamps_invalid";
  }
  return "token_malformed";
}

export function isUnixSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function nowSeconds(now: Date | undefined): { now: Date; seconds: number } {
  const date = now ?? new Date();
  return { now: date, seconds: Math.floor(date.getTime() / 1000) };
}

/**
 * A missing or malformed REQUIRED input is library misuse, not a token
 * verdict: it throws (the listener fails closed with a 500) instead of
 * returning a reason that a caller could map to 401. `config_invalid` stays
 * for stored operator configuration with a bad grammar.
 */
export function requireInput(condition: boolean, what: string): asserts condition {
  if (!condition) throw new TypeError(`${what} is required.`);
}
