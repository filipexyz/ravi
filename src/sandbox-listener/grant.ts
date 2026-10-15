// Sandbox grant verifier, the daemon's parity copy of Console's
// `src/shared/sandbox/grant-verify.ts`: same checks, same order, same reason
// codes. Normative source: Console `sandbox-gateway/grants` SPEC §Verification;
// OSS mirror `.ravi/specs/sandbox/grant-verify`. Results never echo the token
// or any claim value.

import { decodeProtectedHeader, jwtVerify } from "jose";
import {
  checkSandboxGrantPolicy,
  installationIdFromAudience,
  isSandboxAgentId,
  isSandboxGrantLlmPolicy,
  ORG_ID_RE,
  runIdFromSubject,
  SANDBOX_GRANT_ALG,
  SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
  SANDBOX_GRANT_JTI_RE,
  SANDBOX_GRANT_KID_RE,
  SANDBOX_GRANT_MAX_LIFETIME_SECONDS,
  SANDBOX_GRANT_TYP,
  type SandboxGrantClaims,
  type SandboxGrantPolicyRejection,
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

export type SandboxGrantRejectReason =
  | CommonRejectReason
  | "audience_invalid"
  | "inst_mismatch"
  | "subject_invalid"
  | "org_invalid"
  | "agent_invalid"
  | "jti_invalid"
  | "lifetime_exceeded"
  | "llm_invalid"
  | SandboxGrantPolicyRejection;

export type VerifySandboxGrantOptions = {
  /**
   * The configured Console origin the host CLI logged in to
   * (`gateway.consoleUrl`), passed explicitly: there is no default and the
   * value never comes from the token.
   */
  consoleIssuer: string;
  /** The installation this daemon serves. */
  installationId: string;
  /** `JwksCache` for `<consoleIssuer>/api/public/sandbox/jwks`, or any jose key resolver. Never keys from the token. */
  jwks: KeyResolver;
  now?: Date;
};

export type SandboxGrantVerifyResult =
  | { ok: true; claims: SandboxGrantClaims; kid: string; installationId: string; runId: string }
  | { ok: false; reason: SandboxGrantRejectReason };

export async function verifySandboxGrant(
  token: unknown,
  options: VerifySandboxGrantOptions,
): Promise<SandboxGrantVerifyResult> {
  // A missing issuer would let a token without `iss` pass the equality below.
  requireInput(
    typeof options.consoleIssuer === "string" && options.consoleIssuer.length > 0,
    "verifySandboxGrant: consoleIssuer",
  );
  if (typeof token !== "string" || !COMPACT_JWS_RE.test(token)) return reject("token_malformed");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return reject("token_malformed");
  }
  if (header.alg !== SANDBOX_GRANT_ALG) return reject("alg_not_allowed");
  if (header.typ !== SANDBOX_GRANT_TYP) return reject("typ_mismatch");
  if (typeof header.kid !== "string" || !SANDBOX_GRANT_KID_RE.test(header.kid)) return reject("kid_invalid");
  if ("crit" in header && header.crit !== undefined) return reject("crit_not_allowed");
  // `jku`, `x5u`, `x5c` and `jwk` are ignored: keys come only from `jwks`.

  const issuer = options.consoleIssuer;
  const { now, seconds } = nowSeconds(options.now);

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, toGetKey(options.jwks), {
      algorithms: [SANDBOX_GRANT_ALG],
      typ: SANDBOX_GRANT_TYP,
      currentDate: now,
      clockTolerance: SANDBOX_GRANT_CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    return reject(mapJoseError(error));
  }

  if (payload.iss !== issuer) return reject("issuer_mismatch");

  const installationId = installationIdFromAudience(payload.aud);
  if (!installationId) return reject("audience_invalid");
  if (payload.inst !== installationId) return reject("inst_mismatch");
  if (options.installationId !== installationId) return reject("audience_mismatch");

  const runId = runIdFromSubject(payload.sub);
  if (!runId) return reject("subject_invalid");
  if (typeof payload.org !== "string" || !ORG_ID_RE.test(payload.org)) return reject("org_invalid");
  if (!isSandboxAgentId(payload.agent)) return reject("agent_invalid");
  if (typeof payload.jti !== "string" || !SANDBOX_GRANT_JTI_RE.test(payload.jti)) return reject("jti_invalid");

  const { iat, nbf, exp } = payload;
  if (!isUnixSeconds(iat) || !isUnixSeconds(nbf) || !isUnixSeconds(exp)) return reject("timestamps_invalid");
  if (nbf < iat || exp <= iat || nbf > exp) return reject("timestamps_invalid");
  if (iat > seconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("timestamps_invalid");
  if (exp - iat > SANDBOX_GRANT_MAX_LIFETIME_SECONDS) return reject("lifetime_exceeded");
  if (nbf > seconds + SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("not_yet_valid");
  if (exp <= seconds - SANDBOX_GRANT_CLOCK_SKEW_SECONDS) return reject("expired");

  const policy = checkSandboxGrantPolicy({ cmds: payload.cmds, caps: payload.caps, task: payload.task });
  if (policy) return reject(policy);
  if (payload.llm !== undefined && !isSandboxGrantLlmPolicy(payload.llm)) return reject("llm_invalid");

  // Rebuild the claims from validated fields only; unknown claims are ignored.
  const claims: SandboxGrantClaims = {
    iss: issuer,
    aud: payload.aud as string,
    sub: payload.sub as string,
    org: payload.org,
    inst: installationId,
    agent: payload.agent,
    caps: [...(payload.caps as string[])],
    cmds: [...(payload.cmds as string[])],
    iat,
    nbf,
    exp,
    jti: payload.jti,
  };
  if (typeof payload.task === "string") claims.task = payload.task;
  if (payload.llm !== undefined) claims.llm = { models: [...payload.llm.models], budgetUsd: payload.llm.budgetUsd };

  return { ok: true, claims, kid: header.kid, installationId, runId };
}

function reject(reason: SandboxGrantRejectReason): SandboxGrantVerifyResult {
  return { ok: false, reason };
}
