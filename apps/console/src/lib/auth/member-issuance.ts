import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";

export type MemberIssuanceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** First lock in a member credential transaction, BEFORE policy, membership or
 * credential row locks. Membership lifecycle uses the identical Fleet key.
 * The caller must recheck admission/source credentials and insert/update/audit
 * using this SAME transaction. No network calls or nested transactions here. */
export async function lockMemberIssuance(tx: Pick<MemberIssuanceTransaction, "execute">, organizationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fleet:${organizationId}`},0))`);
}

export async function hasActiveMember(tx: Pick<MemberIssuanceTransaction, "select">, organizationId: string, userId: string) {
  const [row] = await tx.select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.organizationId))
    .where(and(eq(schema.organizationMemberships.organizationId, organizationId),
      eq(schema.organizationMemberships.userId, userId), eq(schema.organizationMemberships.status, "active"),
      eq(schema.users.status, "active"), eq(schema.organizations.status, "active"))).limit(1);
  return !!row;
}

/** A browser identity snapshot is not a live credential. Revalidate its opaque
 * server-derived session ID inside the issuance transaction, never from body. */
export async function hasActiveBrowserSession(tx: Pick<MemberIssuanceTransaction, "select">, organizationId: string, userId: string, sessionId: string | undefined) {
  if (!sessionId) return false;
  const [row] = await tx.select({ expiresAt: schema.consoleBrowserSessions.expiresAt }).from(schema.consoleBrowserSessions)
    .where(and(eq(schema.consoleBrowserSessions.id, sessionId), eq(schema.consoleBrowserSessions.organizationId, organizationId),
      eq(schema.consoleBrowserSessions.userId, userId), isNull(schema.consoleBrowserSessions.revokedAt))).limit(1);
  // Sample after the read, including any relation-lock wait, not at query build.
  return !!row && row.expiresAt > new Date();
}
