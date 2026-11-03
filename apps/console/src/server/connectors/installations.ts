/**
 * "Your computers" on /connectors: the person's `ravi` installations in the
 * selected organization, and "Revoke installation". Console-owned plain
 * metadata; the Worker reads the same rows, so a revoked installation's CLI
 * sessions stop working everywhere at once.
 */

import { and, desc, eq } from "drizzle-orm";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

export type InstallationRow = {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  raviVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

/** A computer in the organization, with the member signed in there (organization accounts' shared grants). */
export type OrganizationInstallationRow = InstallationRow & {
  owner: { userId: string | null; email: string | null; name: string | null };
};

export type RevokeInstallationResult = {
  revoked: true;
  /** It was already revoked; nothing changed. */
  alreadyRevoked: boolean;
};

export class InstallationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "InstallationRequestError";
  }
}

const MANAGE_ROLES = new Set(["owner", "admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The person's active installations here, most recently seen first. */
export async function listOwnInstallations(workspace: ConsoleWorkspace): Promise<InstallationRow[]> {
  const table = schema.localInstallations;
  const rows = await db
    .select({
      firstSeenAt: table.firstSeenAt,
      hostname: table.hostname,
      id: table.id,
      lastSeenAt: table.lastSeenAt,
      name: table.name,
      platform: table.platform,
      raviVersion: table.raviVersion,
    })
    .from(table)
    .where(
      and(
        eq(table.organizationId, workspace.organization.id),
        eq(table.userId, workspace.user.id),
        eq(table.status, "active"),
      ),
    )
    .orderBy(desc(table.lastSeenAt))
    .limit(50);
  return rows.map((row) => ({
    ...row,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

/**
 * Every active installation in the organization whose owner is still an
 * active member, most recently seen first, for choosing where an
 * organization account may be used: owners and admins, and a member the
 * Worker said manages an organization account (`managesAnAccount`). A
 * removed or suspended member's computer can't sign in, so it isn't
 * offered. Anyone else gets none.
 */
export async function listOrganizationInstallations(
  workspace: ConsoleWorkspace,
  options: { managesAnAccount?: boolean } = {},
): Promise<OrganizationInstallationRow[]> {
  if (workspace.membership.status !== "active") return [];
  if (!MANAGE_ROLES.has(workspace.membership.role) && options.managesAnAccount !== true) return [];
  const table = schema.localInstallations;
  const rows = await db
    .select({
      email: schema.users.primaryEmail,
      firstSeenAt: table.firstSeenAt,
      hostname: table.hostname,
      id: table.id,
      lastSeenAt: table.lastSeenAt,
      name: table.name,
      ownerName: schema.users.displayName,
      platform: table.platform,
      raviVersion: table.raviVersion,
      userId: table.userId,
    })
    .from(table)
    .innerJoin(schema.users, eq(schema.users.id, table.userId))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, table.organizationId),
        eq(schema.organizationMemberships.userId, table.userId),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .where(and(eq(table.organizationId, workspace.organization.id), eq(table.status, "active")))
    .orderBy(desc(table.lastSeenAt))
    .limit(200);
  return rows.map(({ email, ownerName, userId, ...row }) => ({
    ...row,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    owner: { email: email ?? null, name: ownerName ?? null, userId },
  }));
}

/**
 * Revokes one installation: the installation, every CLI session on it, the
 * agent grants made for it, and the consent requests and approvals still
 * waiting from it. Its owner or an organization owner or admin may do it;
 * anyone else is told it doesn't exist.
 */
export async function revokeLocalInstallation(input: {
  workspace: ConsoleWorkspace;
  installationId: string;
  requestId: string;
  now?: Date;
}): Promise<RevokeInstallationResult> {
  const { workspace } = input;
  if (!UUID_RE.test(input.installationId)) throw new InstallationRequestError(404, "not_found");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const installations = schema.localInstallations;
    const [installation] = await tx
      .select({ id: installations.id, status: installations.status, subjectType: installations.subjectType, userId: installations.userId })
      .from(installations)
      .where(
        and(eq(installations.id, input.installationId), eq(installations.organizationId, workspace.organization.id)),
      )
      .limit(1)
      .for("update");
    const own = installation?.userId === workspace.user.id;
    if (!installation || (!own && !MANAGE_ROLES.has(workspace.membership.role))) {
      throw new InstallationRequestError(404, "not_found");
    }
    if (installation.status === "revoked" || installation.status === "decommissioned") return { alreadyRevoked: true, revoked: true };

    // A person's computer can be signed in again (`revoked`); an installation
    // owned by the organization is tombstoned (`decommissioned`), and its
    // machine fingerprint stays burned so a bootstrap cannot revive it.
    const decommission = installation.subjectType === "installation";
    const terminalStatus = decommission ? "decommissioned" : "revoked";

    await tx
      .update(installations)
      .set({
        revokedAt: now,
        status: terminalStatus,
        ...(decommission
          ? {
              decommissionedAt: now,
              decommissionReason: "revoked_in_console",
              installState: "decommissioned" as const,
              installStateReason: "revoked_in_console",
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(installations.id, installation.id));

    const sessions = await tx
      .update(schema.cliSessions)
      .set({ revokedAt: now, status: "revoked", updatedAt: now })
      .where(and(eq(schema.cliSessions.localInstallationId, installation.id), eq(schema.cliSessions.status, "active")))
      .returning({ id: schema.cliSessions.id });

    const grants = await tx
      .update(schema.agentConnectorGrants)
      .set({ revokedAt: now, status: "revoked", updatedAt: now })
      .where(
        and(
          eq(schema.agentConnectorGrants.localInstallationId, installation.id),
          eq(schema.agentConnectorGrants.status, "active"),
        ),
      )
      .returning({ id: schema.agentConnectorGrants.id });

    const consent = await tx
      .update(schema.connectorConsentRequests)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(schema.connectorConsentRequests.localInstallationId, installation.id),
          eq(schema.connectorConsentRequests.status, "pending"),
        ),
      )
      .returning({ id: schema.connectorConsentRequests.id });

    const approvals = await tx
      .update(schema.connectorActionApprovals)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(schema.connectorActionApprovals.localInstallationId, installation.id),
          eq(schema.connectorActionApprovals.status, "pending"),
        ),
      )
      .returning({ id: schema.connectorActionApprovals.id });

    await tx.insert(schema.auditEvents).values({
      action: decommission ? "local_installation.decommissioned" : "local_installation.revoked",
      actorId: workspace.user.id,
      actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
      metadataJson: {
        agentGrants: grants.length,
        by: own ? "owner" : "organization_admin",
        cliSessions: sessions.length,
        consentRequests: consent.length,
        installationSubjectType: installation.subjectType,
        installationUserId: installation.userId,
        pendingApprovals: approvals.length,
        source: "console.connectors",
      },
      organizationId: workspace.organization.id,
      requestId: input.requestId,
      targetId: installation.id,
      targetType: "local_installation",
    });

    return { alreadyRevoked: false, revoked: true };
  });
}
