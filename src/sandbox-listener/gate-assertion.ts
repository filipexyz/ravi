// Gate request assertion verifier (Console `sandbox-gateway/gate` SPEC §Gate
// Request Assertion, `listener` SPEC §Request Checks step 5). The assertion
// is the Gate's proof that it admitted this exact request for this
// installation: every claim is bound to the received request and to the
// grant stored in the local run record. Results never echo the token.
//
// Replay protection is not optional: the single-use `jti` cache and the
// listener start time are required inputs, and the run record is resolved
// through a callback that runs only after the signature verified, so an
// attacker-controlled `sub` never reaches storage unauthenticated.

import { createHash } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import {
  commandIdFromSegments,
  installationAudience,
  runIdFromSubject,
  SANDBOX_GATE_ALG,
  SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS,
  SANDBOX_GATE_ISSUER,
  SANDBOX_GATE_KID_RE,
  SANDBOX_GATE_TYP,
  SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
  SANDBOX_GRANT_JTI_RE,
} from "./contract.js";
import {
  COMPACT_JWS_RE,
  type CommonRejectReason,
  isUnixSeconds,
  type KeyResolver,
  mapJoseError,
  nowSeconds,
  requireInput,
  toGetKey,
} from "./key-resolver.js";

export const SANDBOX_LISTENER_PATH_PREFIX = "/api/v1/";

/** base64url SHA-256 of exact bytes, the form used by `bodySha256` and `grantSha256`. */
export function sha256Base64url(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/**
 * `/api/v1/<seg…>` → command id, on the raw request target. Encoded
 * characters, `..`, `//`, uppercase, `_`-prefixed segments, queries and
 * fragments never resolve.
 */
export function commandIdFromPath(target: string): string | null {
  if (!target.startsWith(SANDBOX_LISTENER_PATH_PREFIX)) return null;
  const rest = target.slice(SANDBOX_LISTENER_PATH_PREFIX.length);
  if (rest.length === 0 || rest.endsWith("/") || /[%?#]/.test(rest)) return null;
  return commandIdFromSegments(rest.split("/"));
}

export type GateAssertionRejectReason =
  | CommonRejectReason
  | "request_method_invalid"
  | "request_path_invalid"
  | "request_id_invalid"
  | "subject_mismatch"
  // No local run record for the verified `sub`; the listener answers 401 `grant_revoked` (Console listener SPEC step 6).
  | "run_unknown"
  | "jti_invalid"
  | "jti_mismatch"
  | "jti_replayed"
  | "cmd_mismatch"
  | "body_hash_mismatch"
  | "grant_hash_mismatch"
  | "lifetime_exceeded"
  | "issued_before_start";

export type GateAssertionClaims = {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  cmd: string;
  bodySha256: string;
  grantSha256: string;
  iat: number;
  exp: number;
};

/**
 * Single-use `jti` memory: each id is kept until its `exp` + 60 s. Exactly
 * one cache per listener process: two caches accept the same `jti` once
 * each. Across a restart only `listenerStartedAt` closes the window until
 * 04b backs this cache with the persisted served-jti queue.
 */
export class GateAssertionReplayCache {
  private readonly seen = new Map<string, number>();

  has(jti: string, nowSeconds: number) {
    this.prune(nowSeconds);
    return this.seen.has(jti);
  }

  remember(jti: string, expSeconds: number, nowSeconds: number) {
    this.prune(nowSeconds);
    this.seen.set(jti, expSeconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS);
  }

  get size() {
    return this.seen.size;
  }

  private prune(nowSeconds: number) {
    for (const [jti, keepUntil] of this.seen) if (keepUntil < nowSeconds) this.seen.delete(jti);
  }
}

/** The local run record the listener holds for a verified `sub`. */
export type GateAssertionRunRecord = {
  runId: string;
  /** base64url SHA-256 of the grant compact JWS stored in the record (`sha256Base64url(grant)`). */
  grantSha256: string;
};

/**
 * Resolves the run record named by a VERIFIED assertion subject. Invoked at
 * most once per verification, only after `jwtVerify` succeeded and every
 * stateless claim check passed; `null` means no such record.
 */
export type ResolveGateAssertionRun = (
  runId: string,
) => GateAssertionRunRecord | null | Promise<GateAssertionRunRecord | null>;

export type VerifyGateAssertionOptions = {
  /** `JwksCache` for `<consoleIssuer>/api/public/sandbox/gate-jwks`, or any jose key resolver. */
  jwks: KeyResolver;
  /** This daemon's installation. */
  installationId: string;
  /** Run record lookup by the verified `sub`; never invoked for an unverified token. */
  resolveRun: ResolveGateAssertionRun;
  /**
   * The received request, as seen by the listener. `target` is the RAW
   * request target (`req.url` as received: no decoding, normalisation or
   * query stripping); the verifier applies the §Identifiers grammar itself.
   * `body` is the exact bytes received; a string is never accepted.
   */
  request: { method: string; target: string; body: Uint8Array; requestId: string | null | undefined };
  /** Unix seconds the listener started; an `iat` before it is refused, with no skew. */
  listenerStartedAt: number;
  /** The process-wide single-use `jti` cache. */
  replayCache: GateAssertionReplayCache;
  now?: Date;
};

export type GateAssertionVerifyResult =
  | { ok: true; claims: GateAssertionClaims; kid: string; run: GateAssertionRunRecord }
  | { ok: false; reason: GateAssertionRejectReason };

export async function verifyGateAssertion(
  token: unknown,
  options: VerifyGateAssertionOptions,
): Promise<GateAssertionVerifyResult> {
  // Misuse is a thrown TypeError, never a verdict: a listener without replay
  // protection or a run lookup must not serve.
  requireInput(options.replayCache instanceof GateAssertionReplayCache, "verifyGateAssertion: replayCache");
  requireInput(isUnixSeconds(options.listenerStartedAt), "verifyGateAssertion: listenerStartedAt");
  requireInput(typeof options.resolveRun === "function", "verifyGateAssertion: resolveRun");
  const { request } = options;
  requireInput(request.body instanceof Uint8Array, "verifyGateAssertion: request.body must be a Uint8Array");

  if (request.method !== "POST") return reject("request_method_invalid");
  const cmd = commandIdFromPath(request.target);
  if (!cmd) return reject("request_path_invalid");
  if (typeof request.requestId !== "string" || !SANDBOX_GRANT_JTI_RE.test(request.requestId)) {
    return reject("request_id_invalid");
  }

  if (typeof token !== "string" || !COMPACT_JWS_RE.test(token)) return reject("token_malformed");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return reject("token_malformed");
  }
  if (header.alg !== SANDBOX_GATE_ALG) return reject("alg_not_allowed");
  if (header.typ !== SANDBOX_GATE_TYP) return reject("typ_mismatch");
  if (typeof header.kid !== "string" || !SANDBOX_GATE_KID_RE.test(header.kid)) return reject("kid_invalid");
  if ("crit" in header && header.crit !== undefined) return reject("crit_not_allowed");

  const { now, seconds } = nowSeconds(options.now);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, toGetKey(options.jwks), {
      algorithms: [SANDBOX_GATE_ALG],
      typ: SANDBOX_GATE_TYP,
      currentDate: now,
      clockTolerance: SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return reject(mapJoseError(error));
  }

  // From here on every claim is signed by a published Gate key.
  if (payload.iss !== SANDBOX_GATE_ISSUER) return reject("issuer_mismatch");
  if (payload.aud !== installationAudience(options.installationId)) return reject("audience_mismatch");
  const runId = runIdFromSubject(payload.sub);
  if (!runId) return reject("subject_mismatch");
  if (typeof payload.jti !== "string" || !SANDBOX_GRANT_JTI_RE.test(payload.jti)) return reject("jti_invalid");
  if (payload.jti !== request.requestId) return reject("jti_mismatch");
  if (payload.cmd !== cmd) return reject("cmd_mismatch");
  if (payload.bodySha256 !== sha256Base64url(request.body)) return reject("body_hash_mismatch");

  const { iat, exp } = payload;
  if (!isUnixSeconds(iat) || !isUnixSeconds(exp) || exp <= iat) return reject("timestamps_invalid");
  if (iat > seconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("timestamps_invalid");
  if (exp - iat > SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS) return reject("lifetime_exceeded");
  if (exp <= seconds - SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("expired");
  // No skew (Console listener SPEC step 5): an assertion served before a
  // restart must never verify again against the restarted, empty cache.
  if (iat < options.listenerStartedAt) return reject("issued_before_start");
  if (options.replayCache.has(payload.jti, seconds)) return reject("jti_replayed");

  // Storage is reached only with a fully verified, fresh, unseen assertion.
  const run = await options.resolveRun(runId);
  if (!run) return reject("run_unknown");
  if (run.runId !== runId) return reject("subject_mismatch");
  if (typeof run.grantSha256 !== "string" || payload.grantSha256 !== run.grantSha256) {
    return reject("grant_hash_mismatch");
  }

  options.replayCache.remember(payload.jti, exp, seconds);

  return {
    ok: true,
    kid: header.kid,
    run: { runId: run.runId, grantSha256: run.grantSha256 },
    claims: {
      iss: SANDBOX_GATE_ISSUER,
      aud: payload.aud as string,
      sub: payload.sub as string,
      jti: payload.jti,
      cmd,
      bodySha256: payload.bodySha256 as string,
      grantSha256: run.grantSha256,
      iat,
      exp,
    },
  };
}

function reject(reason: GateAssertionRejectReason): GateAssertionVerifyResult {
  return { ok: false, reason };
}
