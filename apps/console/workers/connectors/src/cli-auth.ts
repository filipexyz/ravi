/**
 * CLI bearer validation inside the connectors Worker.
 *
 * The Ravi CLI carries a JWT issued by Console (HS256, audience
 * `ravi-cli`, issuer `ravi-console`). This module verifies the JWT
 * signature with the shared secret pulled from Secrets Store, then
 * confirms the underlying `cli_sessions` row is still active, its
 * membership is active, and its local installation is active.
 *
 * Failures collapse into a single `connector_unauthorized` from the
 * caller's perspective so the Worker never leaks which check failed.
 */

import { jwtVerify } from "jose";

import type { ConnectorsDb } from "./db";
import type { CliSessionRecord } from "./db";

const CLI_ACCESS_TOKEN_ISSUER = "ravi-console";
const CLI_ACCESS_TOKEN_AUDIENCE = "ravi-cli";

export interface CliPrincipal {
  userId: string;
  organizationId: string;
  membershipId: string;
  sessionId: string;
  /** The `local_installations` row the CLI session belongs to (always active here). */
  localInstallationId: string;
  jti: string;
  scopes: string[];
}

export class CliAuthError extends Error {
  constructor(public readonly reason: CliAuthFailureReason) {
    super(reason);
    this.name = "CliAuthError";
  }
}

export type CliAuthFailureReason =
  | "missing_bearer"
  | "invalid_token"
  | "missing_claim"
  | "session_not_found"
  | "session_inactive"
  | "claim_session_mismatch";

/**
 * Extract and verify the CLI bearer from a `Request`. Returns the
 * resolved principal on success. Caller MUST map any thrown
 * `CliAuthError` to `401 connector_unauthorized` without surfacing
 * `reason` to the public response.
 */
export async function authenticateCliBearer(input: {
  request: Request;
  db: ConnectorsDb;
  cliAccessTokenSecret: string;
}): Promise<{ principal: CliPrincipal; session: CliSessionRecord }> {
  const bearer = bearerFromRequest(input.request);
  if (!bearer) throw new CliAuthError("missing_bearer");

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(bearer, new TextEncoder().encode(input.cliAccessTokenSecret), {
      issuer: CLI_ACCESS_TOKEN_ISSUER,
      audience: CLI_ACCESS_TOKEN_AUDIENCE,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new CliAuthError("invalid_token");
  }

  const sessionId = stringClaim(payload.sid);
  const organizationId = stringClaim(payload.org);
  const userId = stringClaim(payload.sub);
  const jti = stringClaim(payload.jti);
  const installationClaim = stringClaim(payload.li);
  const scopes = stringArrayClaim(payload.scopes);
  if (!sessionId || !organizationId || !userId || !jti) {
    throw new CliAuthError("missing_claim");
  }

  const session = await findActiveCliSessionByJti(input.db, jti);
  if (!session) throw new CliAuthError("session_not_found");
  if (session.userId !== userId || session.organizationId !== organizationId || session.id !== sessionId) {
    throw new CliAuthError("claim_session_mismatch");
  }
  if (installationClaim && installationClaim !== session.localInstallationId) {
    throw new CliAuthError("claim_session_mismatch");
  }
  if (session.status !== "active") throw new CliAuthError("session_inactive");

  return {
    principal: {
      userId,
      organizationId,
      membershipId: session.membershipId,
      sessionId,
      localInstallationId: session.localInstallationId,
      jti,
      scopes,
    },
    session,
  };
}

function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function findActiveCliSessionByJti(
  db: ConnectorsDb,
  jti: string,
): Promise<CliSessionRecord | null> {
  const rows = await db.sql<CliSessionRecord[]>`
    select
      cs.id as "id",
      cs.user_id as "userId",
      cs.organization_id as "organizationId",
      om.id as "membershipId",
      cs.local_installation_id as "localInstallationId",
      cs.status as "status",
      cs.expires_at as "expiresAt",
      cs.revoked_at as "revokedAt"
    from cli_sessions cs
    join organization_memberships om
      on om.user_id = cs.user_id
      and om.organization_id = cs.organization_id
      and om.status = 'active'
    join local_installations li
      on li.id = cs.local_installation_id
      and li.organization_id = cs.organization_id
      and li.status = 'active'
      and li.revoked_at is null
    where cs.access_token_jti = ${jti}
      and cs.status = 'active'
      and cs.revoked_at is null
      and (cs.expires_at is null or cs.expires_at > now())
    limit 1
  `;
  return rows[0] ?? null;
}
