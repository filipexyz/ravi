/**
 * What removing a member does to their connectors, inside the same
 * transaction as the removal. Plain metadata only: nothing here reads or
 * deletes credentials. Personal connections that may still hold credentials
 * are suspended at once, so agents stop using them, and handed to the Worker
 * through `connector_revocation_outbox`, which revokes them at the provider.
 */

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Statuses of rows that still hold, or may hold, credentials. */
const LIVE_CONNECTION_STATUSES = ["active", "degraded", "suspended", "revoke_pending"] as const;

export type RemovedMemberConnectorChanges = {
  suspendedConnections: number;
  revokedAgentGrants: number;
  expiredApprovals: number;
  expiredConsentRequests: number;
  unmanagedOrganizationConnections: number;
};

export async function revokeRemovedMemberConnectorAccess(
  tx: Transaction,
  input: { organizationId: string; userId: string; now?: Date },
): Promise<RemovedMemberConnectorChanges> {
  const now = input.now ?? new Date();
  const connections = schema.providerConnections;

  // The lock the Worker's connect finish takes before it checks the
  // membership and stores an account (`lockOrganizationMember`, same key):
  // a finish holding it commits first and its row is suspended below, or
  // waits for this transaction and finds the person removed.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('ravi-connectors:member'), hashtext(${`${input.organizationId}:${input.userId}`}::text))`,
  );

  // The person's own accounts. Google rows a Worker from before personal
  // connections still files under a project are theirs too; GitHub rows are
  // the project's installation and stay.
  const suspended = await tx
    .update(connections)
    .set({ status: "suspended", updatedAt: now })
    .where(
      and(
        eq(connections.organizationId, input.organizationId),
        eq(connections.userId, input.userId),
        inArray(connections.status, [...LIVE_CONNECTION_STATUSES]),
        or(
          eq(connections.scopeKind, "user"),
          and(eq(connections.scopeKind, "project"), ne(connections.provider, "github")),
        ),
      ),
    )
    .returning({ id: connections.id });
  const suspendedIds = suspended.map((row) => row.id);

  if (suspendedIds.length) {
    const outbox = schema.connectorRevocationOutbox;
    const queued = await tx
      .select({ providerConnectionId: outbox.providerConnectionId })
      .from(outbox)
      .where(and(inArray(outbox.providerConnectionId, suspendedIds), eq(outbox.status, "pending")));
    const alreadyQueued = new Set(queued.map((row) => row.providerConnectionId));
    const toQueue = suspendedIds.filter((id) => !alreadyQueued.has(id));
    if (toQueue.length) {
      await tx.insert(outbox).values(
        toQueue.map((providerConnectionId) => ({
          organizationId: input.organizationId,
          providerConnectionId,
          reason: "member_removed",
        })),
      );
    }
  }

  // The consents they gave ("The person asking") and every grant on the
  // accounts just suspended. Shared grants they gave belong to the
  // organization account, not to them: they stay, its approvals go to
  // owners and admins until a new manager is set, and the Worker moves
  // `granted_by_user_id` to that manager.
  const grants = schema.agentConnectorGrants;
  const givenConsents = and(eq(grants.grantedByUserId, input.userId), eq(grants.mode, "person_asking"));
  const revokedGrants = await tx
    .update(grants)
    .set({ revokedAt: now, status: "revoked", updatedAt: now })
    .where(
      and(
        eq(grants.organizationId, input.organizationId),
        eq(grants.status, "active"),
        suspendedIds.length ? or(givenConsents, inArray(grants.providerConnectionId, suspendedIds)) : givenConsents,
      ),
    )
    .returning({ id: grants.id });

  const approvals = schema.connectorActionApprovals;
  const expiredApprovals = await tx
    .update(approvals)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(approvals.organizationId, input.organizationId),
        eq(approvals.status, "pending"),
        or(eq(approvals.ownerUserId, input.userId), eq(approvals.requestedByUserId, input.userId)),
      ),
    )
    .returning({ id: approvals.id });

  const consent = schema.connectorConsentRequests;
  const expiredConsent = await tx
    .update(consent)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(consent.organizationId, input.organizationId),
        eq(consent.status, "pending"),
        or(eq(consent.consoleUserId, input.userId), eq(consent.requestedByUserId, input.userId)),
      ),
    )
    .returning({ id: consent.id });

  // Organization accounts they managed keep working, with their shared
  // grants; an owner or admin picks a new manager.
  const unmanaged = await tx
    .update(connections)
    .set({ managedByUserId: null, updatedAt: now })
    .where(
      and(
        eq(connections.organizationId, input.organizationId),
        eq(connections.scopeKind, "organization"),
        eq(connections.managedByUserId, input.userId),
      ),
    )
    .returning({ id: connections.id });

  return {
    expiredApprovals: expiredApprovals.length,
    expiredConsentRequests: expiredConsent.length,
    revokedAgentGrants: revokedGrants.length,
    suspendedConnections: suspendedIds.length,
    unmanagedOrganizationConnections: unmanaged.length,
  };
}
