import { desc, eq, inArray, or } from "drizzle-orm";

import { db, schema } from "@/server/db";

/**
 * Read-only diagnostic snapshot of a Ravi user's auth/org state.
 *
 * Returns enough context to decide whether a membership was lost to cleanup,
 * whether the WorkOS↔org link is wired correctly, and which orgs the user can
 * see today. Used to drive break-glass fixes without ad-hoc SQL against prod.
 *
 * The function never mutates DB state outside of the audit event that records
 * the diagnose attempt itself (left for the route handler so the audit row
 * carries the bearer client id).
 */

export interface DiagnoseUserResult {
  query: { email: string };
  user: DiagnoseUserSummary | null;
  identities: DiagnoseIdentity[];
  memberships: DiagnoseMembership[];
  organizationLinks: DiagnoseOrganizationLink[];
  recentAuditEvents: DiagnoseAuditEvent[];
}

export interface DiagnoseUserSummary {
  id: string;
  primaryEmail: string;
  displayName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnoseIdentity {
  id: string;
  provider: string;
  providerUserId: string;
  email: string | null;
  providerOrganizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnoseMembership {
  id: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  organizationStatus: string;
  organizationCreatedFrom: string | null;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnoseOrganizationLink {
  id: string;
  organizationId: string;
  organizationSlug: string;
  organizationStatus: string;
  provider: string;
  providerOrganizationId: string;
  createdAt: string;
}

export interface DiagnoseAuditEvent {
  id: string;
  organizationId: string | null;
  actorType: string;
  actorId: string | null;
  targetType: string;
  targetId: string | null;
  action: string;
  metadata: unknown;
  createdAt: string;
}

export async function diagnoseUser(input: { email: string }): Promise<DiagnoseUserResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("diagnoseUser requires a valid email");
  }

  const userRow = await db.query.users.findFirst({
    where: eq(schema.users.primaryEmail, email),
  });

  if (!userRow) {
    return {
      query: { email },
      user: null,
      identities: [],
      memberships: [],
      organizationLinks: [],
      recentAuditEvents: [],
    };
  }

  const identityRows = await db
    .select()
    .from(schema.authIdentities)
    .where(eq(schema.authIdentities.userId, userRow.id));

  const membershipRows = await db
    .select({
      membership: schema.organizationMemberships,
      organization: schema.organizations,
    })
    .from(schema.organizationMemberships)
    .innerJoin(
      schema.organizations,
      eq(schema.organizationMemberships.organizationId, schema.organizations.id),
    )
    .where(eq(schema.organizationMemberships.userId, userRow.id));

  const organizationIds = Array.from(new Set(membershipRows.map((row) => row.organization.id)));

  const linkRows = organizationIds.length
    ? await db
        .select({ link: schema.authOrganizationLinks, organization: schema.organizations })
        .from(schema.authOrganizationLinks)
        .innerJoin(
          schema.organizations,
          eq(schema.authOrganizationLinks.organizationId, schema.organizations.id),
        )
        .where(inArray(schema.authOrganizationLinks.organizationId, organizationIds))
    : [];

  const auditFilter = organizationIds.length
    ? or(
        eq(schema.auditEvents.actorId, userRow.id),
        inArray(schema.auditEvents.organizationId, organizationIds),
      )
    : eq(schema.auditEvents.actorId, userRow.id);

  const auditRows = await db
    .select()
    .from(schema.auditEvents)
    .where(auditFilter)
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(20);

  return {
    query: { email },
    user: {
      id: userRow.id,
      primaryEmail: userRow.primaryEmail,
      displayName: userRow.displayName,
      status: userRow.status,
      createdAt: userRow.createdAt.toISOString(),
      updatedAt: userRow.updatedAt.toISOString(),
    },
    identities: identityRows.map((row) => {
      const profile = row.rawProfileJson as Record<string, unknown> | null | undefined;
      const providerOrgId =
        typeof profile?.organizationId === "string" ? (profile.organizationId as string) : null;
      return {
        id: row.id,
        provider: row.provider,
        providerUserId: row.providerUserId,
        email: row.email,
        providerOrganizationId: providerOrgId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    memberships: membershipRows.map((row) => {
      const metadata = row.organization.metadataJson as Record<string, unknown> | null | undefined;
      const createdFrom =
        typeof metadata?.createdFrom === "string" ? (metadata.createdFrom as string) : null;
      return {
        id: row.membership.id,
        organizationId: row.organization.id,
        organizationSlug: row.organization.slug,
        organizationName: row.organization.name,
        organizationStatus: row.organization.status,
        organizationCreatedFrom: createdFrom,
        role: row.membership.role,
        status: row.membership.status,
        createdAt: row.membership.createdAt.toISOString(),
        updatedAt: row.membership.updatedAt.toISOString(),
      };
    }),
    organizationLinks: linkRows.map((row) => ({
      id: row.link.id,
      organizationId: row.organization.id,
      organizationSlug: row.organization.slug,
      organizationStatus: row.organization.status,
      provider: row.link.provider,
      providerOrganizationId: row.link.providerOrganizationId,
      createdAt: row.link.createdAt.toISOString(),
    })),
    recentAuditEvents: auditRows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorId: row.actorId,
      targetType: row.targetType,
      targetId: row.targetId,
      action: row.action,
      metadata: row.metadataJson,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
