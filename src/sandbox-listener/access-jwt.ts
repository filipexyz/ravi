// Cloudflare Access JWT verifier (`Cf-Access-Jwt-Assertion`), Console
// `sandbox-gateway/listener` SPEC §Request Checks step 4: RS256 only, keys
// only from `https://<accessTeamDomain>/cdn-cgi/access/certs`, exact issuer,
// audience containing the stored AUD, `type` `app`, ±60 s skew and
// `common_name` pinned to the Gate's service token client id. The listener
// (04b) MUST configure `serviceTokenClientId` (= `accessClientId`) and MUST
// refuse to start without it; the parameter stays optional here only so the
// library can be exercised without a pinned id. `kid` is required on the
// Access JWT header (note for the Console spec: step 4 does not state it).

import { decodeProtectedHeader, jwtVerify } from "jose";
import { SANDBOX_GRANT_CLOCK_SKEW_SECONDS } from "./contract.js";
import {
  COMPACT_JWS_RE,
  type CommonRejectReason,
  type KeyResolver,
  mapJoseError,
  nowSeconds,
  toGetKey,
} from "./key-resolver.js";

export const ACCESS_JWT_ALG = "RS256";
export const ACCESS_TEAM_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;
export const ACCESS_AUD_RE = /^[0-9a-f]{64}$/;

export function accessIssuer(teamDomain: string) {
  return `https://${teamDomain}`;
}

export function accessCertsUrl(teamDomain: string) {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

export type AccessAssertionRejectReason =
  | CommonRejectReason
  | "config_invalid"
  | "type_invalid"
  | "common_name_mismatch";

export type AccessAssertionClaims = {
  iss: string;
  aud: string[];
  sub: string;
  type: string;
  common_name?: string;
  iat?: number;
  exp: number;
};

export type VerifyAccessAssertionOptions = {
  /** The stored team domain, e.g. `acme.cloudflareaccess.com`; the issuer is derived from it, never from the token. */
  teamDomain: string;
  /** The stored Access application AUD tag. */
  aud: string;
  /** `JwksCache` for `accessCertsUrl(teamDomain)`, or any jose key resolver. */
  jwks: KeyResolver;
  /**
   * The configured `accessClientId` (the Gate service token client id):
   * `common_name` must equal it. The listener MUST set it (and refuse to
   * start without it); omitting it is for library tests only.
   */
  serviceTokenClientId?: string;
  now?: Date;
};

export type AccessAssertionVerifyResult =
  | { ok: true; claims: AccessAssertionClaims; kid: string }
  | { ok: false; reason: AccessAssertionRejectReason };

export async function verifyAccessAssertion(
  token: unknown,
  options: VerifyAccessAssertionOptions,
): Promise<AccessAssertionVerifyResult> {
  if (!ACCESS_TEAM_DOMAIN_RE.test(options.teamDomain) || !ACCESS_AUD_RE.test(options.aud))
    return reject("config_invalid");
  if (options.serviceTokenClientId !== undefined && !options.serviceTokenClientId) return reject("config_invalid");
  if (typeof token !== "string" || !COMPACT_JWS_RE.test(token)) return reject("token_malformed");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return reject("token_malformed");
  }
  if (header.alg !== ACCESS_JWT_ALG) return reject("alg_not_allowed");
  if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 256)
    return reject("kid_invalid");
  if ("crit" in header && header.crit !== undefined) return reject("crit_not_allowed");

  const { now } = nowSeconds(options.now);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, toGetKey(options.jwks), {
      algorithms: [ACCESS_JWT_ALG],
      issuer: accessIssuer(options.teamDomain),
      audience: options.aud,
      currentDate: now,
      clockTolerance: SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
      requiredClaims: ["exp"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return reject(mapJoseError(error));
  }

  if (payload.type !== "app") return reject("type_invalid");
  if (options.serviceTokenClientId !== undefined && payload.common_name !== options.serviceTokenClientId) {
    return reject("common_name_mismatch");
  }

  const aud = Array.isArray(payload.aud) ? [...(payload.aud as string[])] : [payload.aud as string];
  const claims: AccessAssertionClaims = {
    iss: accessIssuer(options.teamDomain),
    aud,
    sub: typeof payload.sub === "string" ? payload.sub : "",
    type: "app",
    exp: payload.exp as number,
  };
  if (typeof payload.common_name === "string") claims.common_name = payload.common_name;
  if (typeof payload.iat === "number") claims.iat = payload.iat;
  return { ok: true, claims, kid: header.kid };
}

function reject(reason: AccessAssertionRejectReason): AccessAssertionVerifyResult {
  return { ok: false, reason };
}
