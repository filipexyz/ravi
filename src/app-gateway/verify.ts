/**
 * Target grant and viewer assertion verification for the Pages app gateway
 * executor (Console `pages/app-gateway/relay` SPEC, steps 2 and 3).
 *
 * Header rules are checked before any key lookup so a token of one family can
 * never be verified with another family's key. Claims are verified exactly as
 * the wire contract pins them; anything else is refused.
 */

import { decodeProtectedHeader, jwtVerify, type FlattenedJWSInput, type JWSHeaderParameters } from "jose";
import {
  CLOCK_TOLERANCE_SECONDS,
  isAppId,
  isAudience,
  isOperationId,
  MAX_GRANT_OPERATIONS,
  MAX_GRANT_ORIGINS,
  TARGET_GRANT_KID_PREFIX,
  TARGET_GRANT_MAX_CHARS,
  TARGET_GRANT_MAX_LIFETIME_SECONDS,
  TARGET_GRANT_TYP,
  VIEWER_ASSERTION_ACTOR,
  VIEWER_ASSERTION_KID_PREFIX,
  VIEWER_ASSERTION_TTL_SECONDS,
  VIEWER_ASSERTION_TYP,
  type ExecutorErrorCode,
} from "./constants.js";
import { AppGatewayJwksUnavailableError } from "./jwks.js";

export const VIEWER_ASSERTION_MAX_CHARS = 4_096;

const KID_SUFFIX = "[a-z0-9][a-z0-9-]{0,62}";
const GRANT_KID_PATTERN = new RegExp(`^${TARGET_GRANT_KID_PREFIX}${KID_SUFFIX}$`);
const ASSERTION_KID_PATTERN = new RegExp(`^${VIEWER_ASSERTION_KID_PREFIX}${KID_SUFFIX}$`);
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const GRANT_CLAIMS = [
  "iss",
  "aud",
  "site",
  "project",
  "raviOrgId",
  "installation",
  "app",
  "operations",
  "origins",
  "target",
  "jti",
  "iat",
  "exp",
] as const;

export type KeyResolver = (header: JWSHeaderParameters, token: FlattenedJWSInput) => Promise<CryptoKey>;

export interface VerifiedTargetGrant {
  aud: string;
  site: string;
  project: string;
  raviOrgId: string;
  installation: string;
  app: string;
  operations: string[];
  origins: string[];
  target: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface VerifiedViewerAssertion {
  aud: string;
  sub: string;
  raviUserId: string;
  raviOrgId: string;
  site: string;
  project: string;
  iat: number;
  exp: number;
}

/** A refusal carrying the exact `apps.error` code. Never carries token material. */
export class AppGatewayRefusal extends Error {
  readonly code: ExecutorErrorCode;

  constructor(code: ExecutorErrorCode, message: string = code) {
    super(message);
    this.name = "AppGatewayRefusal";
    this.code = code;
  }
}

export interface AppGatewayVerifierOptions {
  resolveKey: KeyResolver;
  /** Issuer from the relay ticket response (Console's pinned issuer). */
  issuer: string;
  now?: () => number;
}

export interface InstallationBinding {
  /** This installation's Console id (ticket response), never `credentials.installationId`. */
  installationId: string;
  organizationId: string;
}

export class AppGatewayVerifier {
  private readonly resolveKey: KeyResolver;
  private readonly issuer: string;
  private readonly now: () => number;

  constructor(options: AppGatewayVerifierOptions) {
    this.resolveKey = options.resolveKey;
    this.issuer = options.issuer;
    this.now = options.now ?? Date.now;
  }

  /** Step 2: grant verifies on the Console JWKS and is bound to this installation. */
  async verifyGrant(grant: string, binding: InstallationBinding): Promise<VerifiedTargetGrant> {
    const refuse = (): never => {
      throw new AppGatewayRefusal("app_gateway_grant_invalid");
    };
    if (grant.length > TARGET_GRANT_MAX_CHARS || !COMPACT_JWS_PATTERN.test(grant)) refuse();
    if (!headerMatches(grant, TARGET_GRANT_TYP, GRANT_KID_PATTERN)) refuse();

    const payload = await this.verifySignature(grant, TARGET_GRANT_TYP, "app_gateway_grant_invalid");
    const keys = Object.keys(payload);
    if (keys.length !== GRANT_CLAIMS.length || !GRANT_CLAIMS.every((claim) => Object.hasOwn(payload, claim))) refuse();

    const { aud, site, project, raviOrgId, installation, app, operations, origins, target, jti, iat, exp } = payload;
    if (!isAudience(aud)) refuse();
    // Installation and organization are pinned to the ticket's UUIDs below; the
    // other ids only need to be non-empty strings, as in Console's parser.
    if (![site, project, raviOrgId, installation, target, jti].every(isNonEmptyString)) refuse();
    if (!isAppId(app)) refuse();
    if (!isStringList(operations, MAX_GRANT_OPERATIONS) || !operations.every(isOperationId)) refuse();
    if (!isStringList(origins, MAX_GRANT_ORIGINS) || !origins.every(isHttpsOrigin)) refuse();
    if (!this.lifetimeOk(iat, exp, (lifetime) => lifetime > 0 && lifetime <= TARGET_GRANT_MAX_LIFETIME_SECONDS)) {
      refuse();
    }
    if (installation !== binding.installationId || raviOrgId !== binding.organizationId) refuse();

    return {
      aud: aud as string,
      site: site as string,
      project: project as string,
      raviOrgId: raviOrgId as string,
      installation: installation as string,
      app: app as string,
      operations: operations as string[],
      origins: origins as string[],
      target: target as string,
      jti: jti as string,
      iat: iat as number,
      exp: exp as number,
    };
  }

  /** Step 3: viewer assertion verifies with `audience = grant.aud` and matches the grant's site, project, org. */
  async verifyAssertion(assertion: string, grant: VerifiedTargetGrant): Promise<VerifiedViewerAssertion> {
    const refuse = (): never => {
      throw new AppGatewayRefusal("app_gateway_assertion_invalid");
    };
    if (assertion.length > VIEWER_ASSERTION_MAX_CHARS || !COMPACT_JWS_PATTERN.test(assertion)) refuse();
    if (!headerMatches(assertion, VIEWER_ASSERTION_TYP, ASSERTION_KID_PATTERN)) refuse();

    const payload = await this.verifySignature(assertion, VIEWER_ASSERTION_TYP, "app_gateway_assertion_invalid");
    const { aud, sub, raviUserId, raviOrgId, site, project, actor, jti, iat, exp } = payload;
    if (typeof aud !== "string" || !isAudience(aud) || aud !== grant.aud) refuse();
    if (actor !== VIEWER_ASSERTION_ACTOR) refuse();
    if (!isNonEmptyString(raviUserId) || sub !== raviUserId) refuse();
    if (!isNonEmptyString(jti)) refuse();
    if (!this.lifetimeOk(iat, exp, (lifetime) => lifetime === VIEWER_ASSERTION_TTL_SECONDS)) refuse();
    if (site !== grant.site || project !== grant.project || raviOrgId !== grant.raviOrgId) refuse();

    return {
      aud: aud as string,
      sub: sub as string,
      raviUserId: raviUserId as string,
      raviOrgId: raviOrgId as string,
      site: site as string,
      project: project as string,
      iat: iat as number,
      exp: exp as number,
    };
  }

  private async verifySignature(
    token: string,
    typ: string,
    invalidCode: ExecutorErrorCode,
  ): Promise<Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(token, this.resolveKey, {
        algorithms: ["ES256"],
        issuer: this.issuer,
        typ,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(this.now()),
      });
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AppGatewayJwksUnavailableError) {
        throw new AppGatewayRefusal("app_gateway_unavailable");
      }
      throw new AppGatewayRefusal(invalidCode);
    }
  }

  /**
   * `exp > now - 5` and the lifetime rule of the token family. A future `iat`
   * is not refused (same as Console's parsers): the lifetime is fixed by
   * `exp - iat`, so it cannot extend a token, and refusing it would break
   * fresh assertions whenever this machine's clock lags Console's.
   */
  private lifetimeOk(iat: unknown, exp: unknown, lifetimeOk: (lifetime: number) => boolean): boolean {
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) return false;
    const nowSeconds = Math.floor(this.now() / 1000);
    const issuedAt = iat as number;
    const expiresAt = exp as number;
    if (expiresAt <= nowSeconds - CLOCK_TOLERANCE_SECONDS) return false;
    return lifetimeOk(expiresAt - issuedAt);
  }
}

function headerMatches(token: string, typ: string, kidPattern: RegExp): boolean {
  let header: JWSHeaderParameters;
  try {
    header = decodeProtectedHeader(token) as JWSHeaderParameters;
  } catch {
    return false;
  }
  return (
    header.alg === "ES256" &&
    header.typ === typ &&
    typeof header.kid === "string" &&
    kidPattern.test(header.kid) &&
    header.crit === undefined &&
    header.b64 === undefined
  );
}

function isStringList(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= max &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

function isHttpsOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
