import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasActiveMember, lockMemberIssuance } from "@/lib/auth/member-issuance";

import {
  findActiveWorkspaceForProviderOrganization,
  syncConsoleIdentity,
  syncConsoleUserIdentity,
  type ConsoleIdentity,
} from "@/server/console/workspace";
import {
  workosOrganizationRoleDeniedMessage,
  type WorkosOrganizationAccessDiagnostics,
} from "@/server/console/workos-role";
import { db, schema } from "@/server/db";

import {
  resolveCliActor,
  type CliActorDelegation,
  type CliActorDeps,
  type CliActorOptions,
  type CliRequestAccess,
} from "./actor";
import { DEFAULT_CLI_SCOPES } from "./config";
import {
  consumeCliDeviceAuthorization,
  resolveApprovedCliDeviceAuthorizationForExchange,
} from "./device-auth";
import { CliApiError, cliApiError } from "./errors";
import { refreshInstallationCredential } from "./installation-auth";
import type { InstallationCredentialResponse } from "./installations";
import {
  assertCliRecordsActive,
  cliCredentialResponse,
  cliMeResponse,
  type CliAuthRecords,
  type CliCredentialResponse,
  type CliMeResponse,
} from "./state";
import {
  generateCliCredentials,
  getCliAccessTokenSecret,
  hashMachineFingerprint,
  hashToken,
  signCliAccessToken,
  verifyCliAccessToken,
} from "./tokens";
import { validateWorkosCliToken } from "./workos";

const exchangeBodySchema = z.object({
  workosAccessToken: z.string().min(1).optional(),
  providerAccessToken: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  deviceCode: z.string().min(1).optional(),
  installationId: z.string().min(1).optional(),
  installation: z
    .object({
      name: z.string().optional(),
      hostname: z.string().optional(),
      platform: z.string().optional(),
      machineFingerprint: z.string().optional(),
      machineFingerprintHash: z.string().optional(),
      raviVersion: z.string().optional(),
    })
    .optional(),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const CLI_REFRESH_REUSE_RACE_GRACE_MS = 2 * 60 * 1000;
const CLI_REFRESH_REUSE_RACE_MESSAGE =
  "CLI credentials were already refreshed by another local process. Retry with the latest stored credentials.";

export type CliAuthContext = CliAuthRecords & {
  accessTokenJti: string;
  /**
   * Set when the request named the turn's author (`x-ravi-actor-contact`) and
   * Console resolved that person: `user` and `membership` are then theirs
   * (role capped to the executor's), and this keeps the `ravi login` owner.
   */
  delegation?: CliActorDelegation | null;
};

export type CliAuthOptions = {
  touch?: boolean;
  /**
   * `contact` (default): act as the person `x-ravi-actor-contact` names, when
   * their binding allows it. `executor`: always the `ravi login` session user,
   * for installation plumbing and routes with their own actor model.
   */
  actor?: "contact" | "executor";
  /**
   * Replaces the method test for the delegated actor: a POST that only reads
   * (a query) passes `read`, so it is treated as a read (no delegation audit).
   */
  access?: CliRequestAccess;
  /**
   * What a read does when the named person cannot be resolved: `executor`
   * (default) reads as the `ravi login` owner; `refuse` refuses it like a
   * write. Bases passes `refuse`: an unlinked person never reads as the owner.
   */
  unlinkedReads?: CliActorOptions["unlinkedReads"];
  actorDeps?: CliActorDeps;
};

export async function exchangeCliAuth(input: {
  body: unknown;
  requestId: string;
  userAgent?: string | null;
}): Promise<CliCredentialResponse> {
  const parsed = parseExchangeBody(input.body);

  const resolved = await resolveExchangeWorkspace(parsed, input.requestId);
  const workspace = resolved.workspace;
  const secret = getCliAccessTokenSecret();
  if (!secret) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");
  }

  const scopes = [...resolved.scopes];
  const sessionId = randomUUID();

  const result = await db.transaction(async (tx) => {
    await lockMemberIssuance(tx, workspace.organization.id);
    if (!await hasActiveMember(tx, workspace.organization.id, workspace.user.id)) {
      throw cliApiError(403, "ORG_ACCESS_DENIED");
    }
    const deviceAdmission = resolved.deviceAuthorizationId
      ? await consumeCliDeviceAuthorization({
        tx,
        authorizationId: resolved.deviceAuthorizationId,
      }) : null;
    const now = deviceAdmission?.admittedAt ?? new Date();

    const { installation, installationAction } = await upsertLocalInstallation({
      tx,
      input: parsed.installation,
      organizationId: workspace.organization.id,
      userId: workspace.user.id,
      scopes,
      userAgent: input.userAgent,
      now,
    });

    const credentials = await generateCliCredentials({
      secret,
      sessionId,
      localInstallationId: installation.id,
      organizationId: workspace.organization.id,
      userId: workspace.user.id,
      scopes,
      now,
    });

    const [session] = await tx
      .insert(schema.cliSessions)
      .values({
        id: sessionId,
        localInstallationId: installation.id,
        organizationId: workspace.organization.id,
        userId: workspace.user.id,
        refreshTokenHash: credentials.refreshTokenHash,
        accessTokenJti: credentials.accessTokenJti,
        scopesJson: scopes,
        status: "active",
        expiresAt: credentials.refreshTokenExpiresAt,
        lastUsedAt: now,
      })
      .returning();

    if (!session) throw new Error("Failed to create CLI session.");

    if (installationAction) {
      await tx.insert(schema.auditEvents).values({
        organizationId: workspace.organization.id,
        actorType: "cli",
        actorId: workspace.user.id,
        targetType: "local_installation",
        targetId: installation.id,
        action: installationAction,
        requestId: input.requestId,
        metadataJson: {
          localInstallationId: installation.id,
          source: "cli-auth",
        },
      });
    }

    await tx.insert(schema.auditEvents).values({
      organizationId: workspace.organization.id,
      actorType: "cli",
      actorId: workspace.user.id,
      targetType: "cli_session",
      targetId: session.id,
      action: "cli_session.created",
      requestId: input.requestId,
      metadataJson: {
        ...(resolved.deviceAuthorizationId
          ? { cliDeviceAuthorizationId: resolved.deviceAuthorizationId }
          : {}),
        localInstallationId: installation.id,
        scopes,
        source: "cli-auth",
      },
    });

    // Final admission checkpoint follows all possibly blocking effect/audit
    // writes. An expired source rolls back consumption, installation and session.
    if (deviceAdmission && deviceAdmission.expiresAt <= new Date()) throw cliApiError(401, "AUTH_EXPIRED");
    return {
      credentials,
      records: recordsFromJoined({
        user: workspace.user,
        organization: workspace.organization,
        membership: workspace.membership,
        localInstallation: installation,
        cliSession: {
          ...session,
          subjectType: "user" as const,
        },
      }),
    };
  });

  return cliCredentialResponse(result.records, result.credentials);
}

export async function refreshCliAuth(input: {
  body: unknown;
  requestId: string;
}): Promise<CliCredentialResponse | InstallationCredentialResponse> {
  const { refreshToken } = parseRefreshBody(input.body);
  const refreshTokenHash = hashToken(refreshToken);
  const now = new Date();

  // An installation session has no person and no membership; it rotates on
  // its own path. A person's session never matches this lookup.
  const installationCredential = await refreshInstallationCredential({
    refreshToken,
    requestId: input.requestId,
    now,
  });
  if (installationCredential) return installationCredential;

  const row = await findSessionByRefreshTokenHash(refreshTokenHash);

  if (!row) {
    await auditCliDenial({
      action: "cli.auth.refresh.denied",
      requestId: input.requestId,
      reason: "invalid_refresh_token",
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  const reused = row.cliSession.previousRefreshTokenHash === refreshTokenHash;
  const records = recordsFromJoined(row);
  // A revoked session is terminal even during the duplicate-refresh grace
  // window. Do not turn suspension into a misleading "retry pending" result.
  await assertActiveAndAudit(records, input.requestId, "cli.auth.refresh.denied", now);

  if (reused) {
    if (isRefreshReuseRace(row.cliSession.updatedAt, now)) {
      await auditCliEvent({
        records,
        action: "cli_session.refresh_reuse_race_ignored",
        requestId: input.requestId,
        metadata: { reason: "refresh_token_recently_rotated" },
      });
      throw cliApiError(409, "AUTH_PENDING", CLI_REFRESH_REUSE_RACE_MESSAGE);
    }

    await db.update(schema.cliSessions).set({ status: "revoked", revokedAt: now, updatedAt: now }).where(eq(schema.cliSessions.id, row.cliSession.id));
    await auditCliEvent({
      records,
      action: "cli_session.refresh_reuse_detected",
      requestId: input.requestId,
      metadata: { reason: "refresh_token_reuse" },
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  const secret = getCliAccessTokenSecret();
  if (!secret) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");
  }

  return db.transaction(async tx => {
    await lockMemberIssuance(tx, row.organization.id);
    await tx.select({ id: schema.cliSessions.id }).from(schema.cliSessions)
      .where(eq(schema.cliSessions.id, row.cliSession.id)).limit(1).for("update");
    const current = await findSessionByRefreshTokenHash(refreshTokenHash, tx);
    if (!current || current.cliSession.id !== row.cliSession.id) throw cliApiError(401, "AUTH_EXPIRED");
    const now = new Date();
    assertCliRecordsActive(recordsFromJoined(current), now);
    if (current.cliSession.refreshTokenHash !== refreshTokenHash) {
      if (current.cliSession.previousRefreshTokenHash === refreshTokenHash && isRefreshReuseRace(current.cliSession.updatedAt, now))
        throw cliApiError(409, "AUTH_PENDING", CLI_REFRESH_REUSE_RACE_MESSAGE);
      throw cliApiError(401, "AUTH_EXPIRED");
    }
    const refresh = await generateCliCredentials({
      secret,
      sessionId: row.cliSession.id,
      localInstallationId: row.localInstallation.id,
      organizationId: row.organization.id,
      userId: row.user.id,
      scopes: current.cliSession.scopesJson,
      now,
    });

    const [session] = await tx
      .update(schema.cliSessions)
      .set({
        refreshTokenHash: refresh.refreshTokenHash,
        previousRefreshTokenHash: row.cliSession.refreshTokenHash,
        accessTokenJti: refresh.accessTokenJti,
        expiresAt: refresh.refreshTokenExpiresAt,
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

    if (!session) throw cliApiError(401, "AUTH_EXPIRED");

    await tx
      .update(schema.localInstallations)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(schema.localInstallations.id, row.localInstallation.id));

    const refreshedRecords = recordsFromJoined({
      ...current,
      cliSession: session,
      localInstallation: {
        ...current.localInstallation,
        lastSeenAt: now,
      },
    });

    await auditCliEvent({
      records: refreshedRecords,
      action: "cli_session.refreshed",
      requestId: input.requestId,
      metadata: { source: "cli-auth" },
    }, tx);

    // The old source's deadline, not the newly extended deadline. Any later
    // update/audit wait that expired it must roll back rotation and success audit.
    if (current.cliSession.expiresAt <= new Date()) throw cliApiError(401, "AUTH_EXPIRED");
    return cliCredentialResponse(refreshedRecords, refresh);
  });
}

export async function logoutCliAuth(input: {
  request: Request;
  requestId: string;
}): Promise<{ ok: true }> {
  const context = await authenticateCliRequest(input.request, input.requestId, { actor: "executor" });
  const now = new Date();

  await db
    .update(schema.cliSessions)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(eq(schema.cliSessions.id, context.cliSession.id));

  await auditCliEvent({
    records: context,
    action: "cli_session.revoked",
    requestId: input.requestId,
    metadata: { source: "cli-logout" },
  });

  return { ok: true };
}

export async function getCliMe(input: {
  request: Request;
  requestId: string;
}): Promise<CliMeResponse> {
  const context = await authenticateCliRequest(input.request, input.requestId, { actor: "executor" });
  return cliMeResponse(context);
}

export async function authenticateCliRequest(
  request: Request,
  requestId: string,
  options: CliAuthOptions = {},
): Promise<CliAuthContext> {
  const bearerToken = bearerTokenFromRequest(request);
  if (!bearerToken) {
    throw cliApiError(401, "AUTH_REQUIRED");
  }

  const secret = getCliAccessTokenSecret();
  if (!secret) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");
  }

  let claims: Awaited<ReturnType<typeof verifyCliAccessToken>>;
  try {
    claims = await verifyCliAccessToken(bearerToken, secret);
  } catch {
    await auditCliDenial({
      action: "cli.auth.access.denied",
      requestId,
      reason: "invalid_access_token",
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  // Installation credentials are not people: they authenticate only the
  // `console/installations` routes, which verify their own subject below.
  if (claims.subjectType !== "user" || !claims.userId) {
    await auditCliDenial({
      action: "cli.auth.access.denied",
      requestId,
      reason: "installation_subject_on_user_route",
      actorId: claims.localInstallationId,
      targetId: claims.sessionId,
    });
    throw cliApiError(401, "AUTH_REQUIRED");
  }

  const row = await findSessionByAccessClaims(claims);
  if (!row) {
    await auditCliDenial({
      action: "cli.auth.access.denied",
      requestId,
      reason: "session_not_found",
      actorId: claims.userId,
      targetId: claims.sessionId,
    });
    throw cliApiError(401, "AUTH_EXPIRED");
  }

  const records = recordsFromJoined(row);
  await assertActiveAndAudit(records, requestId, "cli.auth.access.denied");

  if (options.touch === false) {
    return withCliActor({ ...records, accessTokenJti: claims.jti }, request, requestId, options);
  }

  const now = new Date();
  await db.update(schema.cliSessions).set({ lastUsedAt: now, updatedAt: now }).where(eq(schema.cliSessions.id, records.cliSession.id));
  await db.update(schema.localInstallations).set({ lastSeenAt: now, updatedAt: now }).where(eq(schema.localInstallations.id, records.localInstallation.id));
  return withCliActor(
    {
      ...records,
      cliSession: {
        ...records.cliSession,
        lastUsedAt: now,
      },
      localInstallation: {
        ...records.localInstallation,
        lastSeenAt: now,
      },
      accessTokenJti: claims.jti,
    },
    request,
    requestId,
    options,
  );
}

/** The session as the person of the turn (see `./actor.ts`), unless the route asks for the executor. */
async function withCliActor(
  context: CliAuthContext,
  request: Request,
  requestId: string,
  options: CliAuthOptions,
): Promise<CliAuthContext> {
  if (options.actor === "executor") return { ...context, delegation: null };
  return resolveCliActor(context, request, requestId, options.actorDeps, {
    access: options.access,
    unlinkedReads: options.unlinkedReads,
  });
}

function parseExchangeBody(body: unknown) {
  const result = exchangeBodySchema.safeParse(body);
  if (!result.success) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }

  const workosAccessToken =
    result.data.workosAccessToken ??
    result.data.providerAccessToken ??
    result.data.accessToken;
  const deviceCode = cleanText(result.data.deviceCode, 512);
  if (!workosAccessToken && !deviceCode) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }

  return {
    workosAccessToken: cleanText(workosAccessToken, 8192),
    deviceCode,
    installation: {
      name: cleanText(result.data.installation?.name, 120),
      hostname: cleanText(result.data.installation?.hostname, 120),
      platform: cleanText(result.data.installation?.platform, 80),
      machineFingerprint: cleanText(
        result.data.installation?.machineFingerprint ?? result.data.installation?.machineFingerprintHash,
        512,
      ),
      raviVersion: cleanText(result.data.installation?.raviVersion, 80),
    },
  };
}

async function resolveExchangeWorkspace(
  parsed: ReturnType<typeof parseExchangeBody>,
  requestId: string,
): Promise<{
  deviceAuthorizationId: string | null;
  scopes: string[];
  workspace: {
    user: typeof schema.users.$inferSelect;
    organization: typeof schema.organizations.$inferSelect;
    membership: typeof schema.organizationMemberships.$inferSelect;
  };
}> {
  if (parsed.deviceCode) {
    const resolved = await resolveApprovedCliDeviceAuthorizationForExchange({
      deviceCode: parsed.deviceCode,
      requestId,
    });
    return {
      deviceAuthorizationId: resolved.authorization.id,
      scopes: resolved.scopes,
      workspace: {
        user: resolved.user,
        organization: resolved.organization,
        membership: resolved.membership,
      },
    };
  }

  if (!parsed.workosAccessToken) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }

  let workosIdentity: Awaited<ReturnType<typeof validateWorkosCliToken>>;
  try {
    workosIdentity = await validateWorkosCliToken(parsed.workosAccessToken);
  } catch (error) {
    if (error instanceof CliApiError) {
      await auditCliDenial({
        action: "cli.auth.exchange.denied",
        requestId,
        reason: error.code,
      });
    }
    throw error;
  }

  return {
    deviceAuthorizationId: null,
    scopes: [...DEFAULT_CLI_SCOPES],
    workspace: await resolveCliExchangeWorkspace({
      identity: workosIdentity.identity,
      organizationRoleMapped: workosIdentity.organizationRoleMapped,
      diagnostics: workosIdentity.diagnostics,
    }),
  };
}

function parseRefreshBody(body: unknown) {
  const result = refreshBodySchema.safeParse(body);
  if (!result.success) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }
  return result.data;
}

async function resolveCliExchangeWorkspace(input: {
  identity: ConsoleIdentity;
  organizationRoleMapped: boolean;
  diagnostics: WorkosOrganizationAccessDiagnostics;
}) {
  const user = await syncConsoleUserIdentity(input.identity);

  if (input.identity.providerOrganizationId) {
    const existing = await findActiveWorkspaceForProviderOrganization({
      provider: input.identity.provider,
      providerOrganizationId: input.identity.providerOrganizationId,
      userId: user.id,
    });
    if (existing) {
      if (!input.organizationRoleMapped) {
        console.info("WorkOS CLI org access resolved from Ravi membership", {
          ...input.diagnostics,
          resolution: "existing_ravi_membership",
        });
      }
      return { user, organization: existing.organization, membership: existing.membership };
    }

    if (input.organizationRoleMapped) {
      return syncConsoleIdentity(input.identity);
    }

    throw cliApiError(403, "ORG_ACCESS_DENIED", workosOrganizationRoleDeniedMessage(input.diagnostics));
  }

  return resolveExistingCliWorkspace({ user });
}

async function resolveExistingCliWorkspace(input: {
  user: typeof schema.users.$inferSelect;
}) {
  const predicates = [
    eq(schema.organizationMemberships.userId, input.user.id),
    eq(schema.organizationMemberships.status, "active"),
    eq(schema.organizations.status, "active"),
  ];

  const rows = await db
    .select({
      organization: schema.organizations,
      membership: schema.organizationMemberships,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.organizations, eq(schema.organizationMemberships.organizationId, schema.organizations.id))
    .where(and(...predicates));

  if (rows.length !== 1) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      rows.length === 0
        ? "No Ravi organization is available for this user."
        : "Multiple Ravi organizations are available. Approve the CLI login in Console and choose an organization there.",
    );
  }

  return { user: input.user, organization: rows[0]!.organization, membership: rows[0]!.membership };
}

async function upsertLocalInstallation(input: {
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  input: ReturnType<typeof parseExchangeBody>["installation"];
  organizationId: string;
  userId: string;
  scopes: string[];
  userAgent?: string | null;
  now: Date;
}) {
  const machineFingerprintHash = input.input.machineFingerprint
    ? hashMachineFingerprint(input.input.machineFingerprint)
    : null;
  const name = input.input.name ?? input.input.hostname ?? "Local Ravi CLI";
  const safeUserAgent = cleanText(input.userAgent ?? undefined, 180);

  if (machineFingerprintHash) {
    const [existing] = await input.tx
      .select()
      .from(schema.localInstallations)
      .where(
        and(
          eq(schema.localInstallations.organizationId, input.organizationId),
          eq(schema.localInstallations.userId, input.userId),
          eq(schema.localInstallations.machineFingerprintHash, machineFingerprintHash),
        ),
      )
      .limit(1);

    if (existing) {
      const installationAction = existing.status === "revoked" ? "local_installation.relinked" : null;
      const [installation] = await input.tx
        .update(schema.localInstallations)
        .set({
          name,
          hostname: input.input.hostname,
          platform: input.input.platform,
          raviVersion: input.input.raviVersion,
          status: "active",
          capabilitiesJson: input.scopes,
          // Merge, so keys other writers keep here (knowledgeInstances) survive a re-login.
          metadataJson: sql`${schema.localInstallations.metadataJson} || ${JSON.stringify({ source: "cli-auth", userAgent: safeUserAgent })}::jsonb`,
          lastSeenAt: input.now,
          revokedAt: null,
          updatedAt: input.now,
        })
        .where(eq(schema.localInstallations.id, existing.id))
        .returning();

      if (!installation) throw new Error("Failed to update local installation.");
      return { installation, installationAction };
    }
  }

  const [installation] = await input.tx
    .insert(schema.localInstallations)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      subjectType: "user",
      name,
      hostname: input.input.hostname,
      platform: input.input.platform,
      machineFingerprintHash,
      raviVersion: input.input.raviVersion,
      status: "active",
      capabilitiesJson: input.scopes,
      metadataJson: { source: "cli-auth", userAgent: safeUserAgent },
      firstSeenAt: input.now,
      lastSeenAt: input.now,
    })
    .returning();

  if (!installation) throw new Error("Failed to create local installation.");
  return { installation, installationAction: "local_installation.created" };
}

async function findSessionByRefreshTokenHash(refreshTokenHash: string, executor: Pick<typeof db, "select"> = db) {
  const [row] = await executor
    .select({
      cliSession: schema.cliSessions,
      localInstallation: schema.localInstallations,
      user: schema.users,
      organization: schema.organizations,
      membership: schema.organizationMemberships,
    })
    .from(schema.cliSessions)
    .innerJoin(schema.localInstallations, eq(schema.cliSessions.localInstallationId, schema.localInstallations.id))
    .innerJoin(schema.users, eq(schema.cliSessions.userId, schema.users.id))
    .innerJoin(schema.organizations, eq(schema.cliSessions.organizationId, schema.organizations.id))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.cliSessions.organizationId),
        eq(schema.organizationMemberships.userId, schema.cliSessions.userId),
      ),
    )
    .where(
      or(
        eq(schema.cliSessions.refreshTokenHash, refreshTokenHash),
        eq(schema.cliSessions.previousRefreshTokenHash, refreshTokenHash),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function findSessionByAccessClaims(claims: Awaited<ReturnType<typeof verifyCliAccessToken>>) {
  const [row] = await db
    .select({
      cliSession: schema.cliSessions,
      localInstallation: schema.localInstallations,
      user: schema.users,
      organization: schema.organizations,
      membership: schema.organizationMemberships,
    })
    .from(schema.cliSessions)
    .innerJoin(schema.localInstallations, eq(schema.cliSessions.localInstallationId, schema.localInstallations.id))
    .innerJoin(schema.users, eq(schema.cliSessions.userId, schema.users.id))
    .innerJoin(schema.organizations, eq(schema.cliSessions.organizationId, schema.organizations.id))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.cliSessions.organizationId),
        eq(schema.organizationMemberships.userId, schema.cliSessions.userId),
      ),
    )
    .where(
      and(
        eq(schema.cliSessions.id, claims.sessionId),
        eq(schema.cliSessions.accessTokenJti, claims.jti),
        eq(schema.cliSessions.localInstallationId, claims.localInstallationId),
        eq(schema.cliSessions.organizationId, claims.organizationId),
        eq(schema.cliSessions.userId, claims.userId ?? ""),
        eq(schema.cliSessions.subjectType, "user"),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function assertActiveAndAudit(
  records: CliAuthRecords,
  requestId: string,
  denialAction: string,
  now = new Date(),
) {
  try {
    assertCliRecordsActive(records, now);
  } catch (error) {
    if (error instanceof CliApiError) {
      if (error.code === "AUTH_EXPIRED" && records.cliSession.status === "active" && records.cliSession.expiresAt <= now) {
        await db
          .update(schema.cliSessions)
          .set({ status: "expired", updatedAt: now })
          .where(eq(schema.cliSessions.id, records.cliSession.id));
      }

      await auditCliEvent({
        records,
        action: denialAction,
        requestId,
        metadata: { reason: error.code },
      });
    }
    throw error;
  }
}

function recordsFromJoined(row: {
  user: typeof schema.users.$inferSelect;
  organization: typeof schema.organizations.$inferSelect;
  membership: typeof schema.organizationMemberships.$inferSelect;
  localInstallation: typeof schema.localInstallations.$inferSelect;
  cliSession: typeof schema.cliSessions.$inferSelect;
}): CliAuthRecords {
  return {
    user: row.user,
    organization: row.organization,
    membership: row.membership,
    localInstallation: row.localInstallation,
    cliSession: row.cliSession,
    scopes: row.cliSession.scopesJson,
  };
}

async function auditCliEvent(input: {
  records: CliAuthRecords;
  action: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}, executor: Pick<typeof db, "insert"> = db) {
  await executor.insert(schema.auditEvents).values({
    organizationId: input.records.organization.id,
    actorType: "cli",
    actorId: input.records.user.id,
    targetType: "cli_session",
    targetId: input.records.cliSession.id,
    action: input.action,
    requestId: input.requestId,
    metadataJson: {
      ...input.metadata,
      localInstallationId: input.records.localInstallation.id,
      cliSessionId: input.records.cliSession.id,
    },
  });
}

async function auditCliDenial(input: {
  action: string;
  requestId: string;
  reason: string;
  actorId?: string;
  targetId?: string;
}) {
  await db.insert(schema.auditEvents).values({
    actorType: "cli",
    actorId: input.actorId,
    targetType: "cli_auth",
    targetId: input.targetId,
    action: input.action,
    requestId: input.requestId,
    metadataJson: {
      reason: input.reason,
    },
  });
}

function bearerTokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isRefreshReuseRace(rotatedAt: Date | null, now: Date) {
  if (!rotatedAt) return false;
  const ageMs = now.getTime() - rotatedAt.getTime();
  return ageMs >= -5_000 && ageMs <= CLI_REFRESH_REUSE_RACE_GRACE_MS;
}

function cleanText(value: string | undefined, maxLength: number) {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}
