import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export const CLI_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const CLI_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CLI_ACCESS_TOKEN_ISSUER = "ravi-console";
export const CLI_ACCESS_TOKEN_AUDIENCE = "ravi-cli";

const MIN_SECRET_LENGTH = 32;
const UNSAFE_SECRET_PLACEHOLDERS = new Set([
  "replace-with-at-least-32-characters",
]);
const textEncoder = new TextEncoder();

export type CliSubjectType = "user" | "installation";

export type CliAccessTokenClaims = {
  sessionId: string;
  localInstallationId: string;
  organizationId: string;
  /** Null for an installation credential: the machine has no person behind it. */
  userId: string | null;
  subjectType: CliSubjectType;
  scopes: string[];
  jti: string;
  expiresAt: Date;
};

export type SignedCliAccessToken = {
  accessToken: string;
  accessTokenJti: string;
  accessTokenExpiresAt: Date;
};

export type GeneratedCliCredentials = SignedCliAccessToken & {
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
};

export function getCliAccessTokenSecret() {
  const value = process.env.RAVI_CLI_ACCESS_TOKEN_SECRET?.trim();
  if (!value || value.length < MIN_SECRET_LENGTH) return null;
  if (UNSAFE_SECRET_PLACEHOLDERS.has(value)) return null;
  return value;
}

export function generateRefreshToken() {
  return `ravi_crt_${randomBytes(48).toString("base64url")}`;
}

export function hashToken(token: string) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function verifyTokenHash(token: string, expectedHash: string) {
  const actual = hashToken(token);
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expectedHash);

  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function hashMachineFingerprint(fingerprint: string) {
  const normalized = fingerprint.trim();
  if (!normalized) return null;
  return hashToken(`machine:${normalized}`);
}

export async function generateCliCredentials(input: {
  secret: string;
  sessionId: string;
  localInstallationId: string;
  organizationId: string;
  userId: string | null;
  subjectType?: CliSubjectType;
  scopes: string[];
  now?: Date;
}): Promise<GeneratedCliCredentials> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(refreshToken);
  const now = input.now ?? new Date();
  const access = await signCliAccessToken(input);

  return {
    ...access,
    refreshToken,
    refreshTokenHash,
    refreshTokenExpiresAt: addSeconds(now, CLI_REFRESH_TOKEN_TTL_SECONDS),
  };
}

export async function signCliAccessToken(input: {
  secret: string;
  sessionId: string;
  localInstallationId: string;
  organizationId: string;
  userId: string | null;
  subjectType?: CliSubjectType;
  scopes: string[];
  now?: Date;
}): Promise<SignedCliAccessToken> {
  const now = input.now ?? new Date();
  const accessTokenJti = randomUUID();
  const accessTokenExpiresAt = addSeconds(now, CLI_ACCESS_TOKEN_TTL_SECONDS);
  const subjectType = input.subjectType ?? "user";

  const accessToken = await new SignJWT({
    sid: input.sessionId,
    li: input.localInstallationId,
    org: input.organizationId,
    st: subjectType,
    scopes: input.scopes,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(CLI_ACCESS_TOKEN_ISSUER)
    .setAudience(CLI_ACCESS_TOKEN_AUDIENCE)
    .setSubject(input.userId ?? input.localInstallationId)
    .setJti(accessTokenJti)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(accessTokenExpiresAt.getTime() / 1000))
    .sign(textEncoder.encode(input.secret));

  return {
    accessToken,
    accessTokenJti,
    accessTokenExpiresAt,
  };
}

export async function verifyCliAccessToken(token: string, secret: string): Promise<CliAccessTokenClaims> {
  const { payload } = await jwtVerify(token, textEncoder.encode(secret), {
    issuer: CLI_ACCESS_TOKEN_ISSUER,
    audience: CLI_ACCESS_TOKEN_AUDIENCE,
  });

  const sessionId = stringClaim(payload.sid);
  const localInstallationId = stringClaim(payload.li);
  const organizationId = stringClaim(payload.org);
  const subject = stringClaim(payload.sub);
  const jti = stringClaim(payload.jti);
  const scopes = stringArrayClaim(payload.scopes);
  const subjectType: CliSubjectType = payload.st === "installation" ? "installation" : "user";
  const userId = subjectType === "user" ? subject : null;

  if (!sessionId || !localInstallationId || !organizationId || !subject || !jti) {
    throw new Error("CLI access token is missing required claims.");
  }

  return {
    sessionId,
    localInstallationId,
    organizationId,
    userId,
    subjectType,
    scopes,
    jti,
    expiresAt: new Date(Number(payload.exp) * 1000),
  };
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArrayClaim(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
