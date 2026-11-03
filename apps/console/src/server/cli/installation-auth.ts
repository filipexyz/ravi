/**
 * Authentication for the installation credential.
 *
 * A bootstrap token is exchanged once for a `cli_sessions` row whose subject
 * is the installation itself (`subject_type = installation`, `user_id = null`).
 * That credential can read its own desired state and report its own observed
 * state. It is never accepted by the person-facing `/api/cli/**` routes.
 *
 * Contract: spec console/managed-runtime/installations.
 */

import { and, eq, or } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { cliApiError } from "./errors";
import {
  installationCredentialResponse,
  type InstallationCredentialResponse,
} from "./installations";
import {
  generateCliCredentials,
  getCliAccessTokenSecret,
  hashToken,
  verifyCliAccessToken,
} from "./tokens";

export type InstallationAuthContext = {
  installation: typeof schema.localInstallations.$inferSelect;
  organization: typeof schema.organizations.$inferSelect;
  cliSession: typeof schema.cliSessions.$inferSelect;
  scopes: string[];
  accessTokenJti: string;
};

function bearerTokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function authenticateInstallationRequest(
  request: Request,
  requestId: string,
): Promise<InstallationAuthContext> {
  const bearerToken = bearerTokenFromRequest(request);
  if (!bearerToken) throw cliApiError(401, "AUTH_REQUIRED");

  const secret = getCliAccessTokenSecret();
  if (!secret) throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");

  let claims: Awaited<ReturnType<typeof verifyCliAccessToken>>;
  try {
    claims = await verifyCliAccessToken(bearerToken, secret);
  } catch {
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  if (claims.subjectType !== "installation" || claims.userId !== null) {
    throw cliApiError(401, "AUTH_REQUIRED", "An installation credential is required.");
  }

  const [row] = await db
    .select({
      cliSession: schema.cliSessions,
      installation: schema.localInstallations,
      organization: schema.organizations,
    })
    .from(schema.cliSessions)
    .innerJoin(
      schema.localInstallations,
      eq(schema.cliSessions.localInstallationId, schema.localInstallations.id),
    )
    .innerJoin(schema.organizations, eq(schema.cliSessions.organizationId, schema.organizations.id))
    .where(
      and(
        eq(schema.cliSessions.id, claims.sessionId),
        eq(schema.cliSessions.accessTokenJti, claims.jti),
        eq(schema.cliSessions.localInstallationId, claims.localInstallationId),
        eq(schema.cliSessions.organizationId, claims.organizationId),
        eq(schema.cliSessions.subjectType, "installation"),
        eq(schema.localInstallations.subjectType, "installation"),
      ),
    )
    .limit(1);

  if (!row) throw cliApiError(401, "AUTH_EXPIRED");

  const now = new Date();
  if (row.cliSession.status !== "active" || row.cliSession.expiresAt <= now) {
    if (row.cliSession.status === "active") {
      await db
        .update(schema.cliSessions)
        .set({ status: "expired", updatedAt: now })
        .where(eq(schema.cliSessions.id, row.cliSession.id));
    }
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  if (
    row.installation.status === "revoked" ||
    row.installation.status === "decommissioned" ||
    row.installation.installState === "decommissioned"
  ) {
    throw cliApiError(403, "INSTALLATION_REVOKED");
  }

  if (row.organization.status !== "active") {
    throw cliApiError(403, "ORG_ACCESS_DENIED");
  }

  await db
    .update(schema.cliSessions)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(schema.cliSessions.id, row.cliSession.id));
  await db
    .update(schema.localInstallations)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(eq(schema.localInstallations.id, row.installation.id));

  void requestId;
  return {
    installation: row.installation,
    organization: row.organization,
    cliSession: row.cliSession,
    scopes: row.cliSession.scopesJson,
    accessTokenJti: claims.jti,
  };
}

/**
 * Rotates an installation credential. Returns `null` when the refresh token
 * does not belong to an installation session, so the person refresh path in
 * `auth.ts` keeps handling `subject_type = user` unchanged.
 *
 * Reuse of an already-rotated token revokes the session, like the person path.
 */
export async function refreshInstallationCredential(input: {
  refreshToken: string;
  requestId: string;
  now?: Date;
}): Promise<InstallationCredentialResponse | null> {
  const now = input.now ?? new Date();
  const refreshTokenHash = hashToken(input.refreshToken);

  const [row] = await db
    .select({
      cliSession: schema.cliSessions,
      installation: schema.localInstallations,
      organization: schema.organizations,
    })
    .from(schema.cliSessions)
    .innerJoin(
      schema.localInstallations,
      eq(schema.cliSessions.localInstallationId, schema.localInstallations.id),
    )
    .innerJoin(schema.organizations, eq(schema.cliSessions.organizationId, schema.organizations.id))
    .where(
      and(
        eq(schema.cliSessions.subjectType, "installation"),
        or(
          eq(schema.cliSessions.refreshTokenHash, refreshTokenHash),
          eq(schema.cliSessions.previousRefreshTokenHash, refreshTokenHash),
        ),
      ),
    )
    .limit(1);

  if (!row) return null;

  const reused = row.cliSession.previousRefreshTokenHash === refreshTokenHash;
  if (reused) {
    await db
      .update(schema.cliSessions)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(schema.cliSessions.id, row.cliSession.id));
    await auditInstallationEvent({
      action: "cli_session.refresh_reuse_detected",
      installation: row.installation,
      organizationId: row.organization.id,
      requestId: input.requestId,
      sessionId: row.cliSession.id,
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  await assertInstallationSessionActive(row, now, "cli.auth.refresh.denied", input.requestId);

  const secret = getCliAccessTokenSecret();
  if (!secret) throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");

  const credentials = await generateCliCredentials({
    secret,
    sessionId: row.cliSession.id,
    localInstallationId: row.installation.id,
    organizationId: row.organization.id,
    userId: null,
    subjectType: "installation",
    scopes: row.cliSession.scopesJson,
    now,
  });

  const [session] = await db
    .update(schema.cliSessions)
    .set({
      refreshTokenHash: credentials.refreshTokenHash,
      previousRefreshTokenHash: row.cliSession.refreshTokenHash,
      accessTokenJti: credentials.accessTokenJti,
      expiresAt: credentials.refreshTokenExpiresAt,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.cliSessions.id, row.cliSession.id),
        eq(schema.cliSessions.refreshTokenHash, refreshTokenHash),
        eq(schema.cliSessions.status, "active"),
      ),
    )
    .returning();

  if (!session) {
    await db
      .update(schema.cliSessions)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(schema.cliSessions.id, row.cliSession.id));
    await auditInstallationEvent({
      action: "cli_session.refresh_reuse_detected",
      installation: row.installation,
      organizationId: row.organization.id,
      requestId: input.requestId,
      sessionId: row.cliSession.id,
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  const [installation] = await db
    .update(schema.localInstallations)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(eq(schema.localInstallations.id, row.installation.id))
    .returning();

  await auditInstallationEvent({
    action: "cli_session.refreshed",
    installation: row.installation,
    organizationId: row.organization.id,
    requestId: input.requestId,
    sessionId: session.id,
  });

  return installationCredentialResponse({
    installation: installation ?? { ...row.installation, lastSeenAt: now },
    organization: row.organization,
    cliSession: session,
    credentials,
    now,
  });
}

async function assertInstallationSessionActive(
  row: {
    cliSession: typeof schema.cliSessions.$inferSelect;
    installation: typeof schema.localInstallations.$inferSelect;
    organization: typeof schema.organizations.$inferSelect;
  },
  now: Date,
  denialAction: string,
  requestId: string,
) {
  if (row.cliSession.status !== "active" || row.cliSession.expiresAt <= now) {
    if (row.cliSession.status === "active") {
      await db
        .update(schema.cliSessions)
        .set({ status: "expired", updatedAt: now })
        .where(eq(schema.cliSessions.id, row.cliSession.id));
    }
    await auditInstallationEvent({
      action: denialAction,
      installation: row.installation,
      organizationId: row.organization.id,
      requestId,
      sessionId: row.cliSession.id,
      reason: "AUTH_EXPIRED",
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  if (
    row.installation.status === "revoked" ||
    row.installation.status === "decommissioned" ||
    row.installation.installState === "decommissioned"
  ) {
    throw cliApiError(403, "INSTALLATION_REVOKED");
  }

  if (row.organization.status !== "active") {
    throw cliApiError(403, "ORG_ACCESS_DENIED");
  }
}

async function auditInstallationEvent(input: {
  action: string;
  installation: typeof schema.localInstallations.$inferSelect;
  organizationId: string;
  requestId: string;
  sessionId: string;
  reason?: string;
}) {
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorType: "cli",
    actorId: input.installation.id,
    targetType: "cli_session",
    targetId: input.sessionId,
    action: input.action,
    requestId: input.requestId,
    metadataJson: {
      localInstallationId: input.installation.id,
      cliSessionId: input.sessionId,
      subjectType: "installation",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}
