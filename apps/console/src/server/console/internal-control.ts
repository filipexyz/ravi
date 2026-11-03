import type { CliAuthContext } from "@/server/cli/auth";
import type { ConsoleFeatureAccessData } from "@/features/console/types";
import { cliApiError } from "@/server/cli/errors";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { db, schema } from "@/server/db";
import { asc, desc, eq, or, sql } from "drizzle-orm";
import { isUuidRef } from "./ref";

const INTERNAL_CONTROL_READ_SCOPE = "console.control.read";

const IMPLEMENTED_OPERATIONS = [
  "GET /api/cli/internal/control/summary",
  "GET /api/cli/internal/control/orgs",
  "GET /api/cli/internal/control/orgs/:orgRef",
  "GET /api/cli/internal/control/features",
  "GET /api/cli/internal/control/orgs/:orgRef/features",
  "GET /api/cli/internal/control/users",
  "GET /api/cli/internal/control/users/:userRef",
] as const;

const PLANNED_OPERATIONS = [
  "POST /api/cli/internal/control/orgs/:orgRef/entitlements",
  "DELETE /api/cli/internal/control/orgs/:orgRef/entitlements/:featureKey",
  "GET /api/cli/internal/control/access-requests",
  "POST /api/cli/internal/control/access-requests/:id/approve",
  "POST /api/cli/internal/control/access-requests/:id/reject",
  "POST /api/cli/internal/control/orgs/:orgRef/members",
  "GET /api/cli/internal/control/pages/diagnostics?host=:hostname",
  "POST /api/cli/internal/control/pages/bindings/:bindingId/check",
  "GET /api/cli/internal/control/audit",
] as const;

export async function getInternalControlSummary(input: {
  auth: CliAuthContext;
}) {
  const access = await requireInternalControlRead(input.auth);
  return buildInternalControlSummary({ access, auth: input.auth });
}

export function buildInternalControlSummary(input: {
  access: ConsoleFeatureAccessData;
  auth: CliAuthContext;
}) {
  return {
    version: 1,
    app: {
      id: "console.internal_control",
      name: "Console Backoffice",
    },
    actor: sanitizeActor(input.auth),
    access: summarizeFeatureAccess(input.access),
    operations: {
      implemented: [...IMPLEMENTED_OPERATIONS],
      planned: [...PLANNED_OPERATIONS],
    },
  };
}

export async function getInternalControlFeatures(input: {
  auth: CliAuthContext;
  organizationRef?: string | null;
}) {
  assertCurrentOrganization(input.auth, input.organizationRef);
  const access = await requireInternalControlRead(input.auth);
  return buildInternalControlFeatures({ access, auth: input.auth });
}

export function buildInternalControlFeatures(input: {
  access: ConsoleFeatureAccessData;
  auth: CliAuthContext;
}) {
  return {
    version: 1,
    organization: sanitizeOrganization(input.auth),
    access: summarizeFeatureAccess(input.access),
    features: input.access.features,
  };
}

export async function listInternalControlOrganizations(input: {
  auth: CliAuthContext;
  limit?: number;
  query?: string | null;
}) {
  await requireInternalControlRead(input.auth);

  const rows = await db
    .select({
      billing: schema.billingAccounts,
      organization: schema.organizations,
    })
    .from(schema.organizations)
    .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.organizationId, schema.organizations.id))
    .where(organizationSearchWhere(input.query))
    .orderBy(asc(schema.organizations.name))
    .limit(limit(input.limit));

  return {
    version: 1,
    organizations: rows.map(({ billing, organization }) =>
      sanitizeOrganizationRecord(organization, {
        billing,
      }),
    ),
  };
}

export async function getInternalControlOrganization(input: {
  auth: CliAuthContext;
  organizationRef: string;
}) {
  await requireInternalControlRead(input.auth);

  const organization = await findOrganization(input.organizationRef);
  if (!organization) {
    throw cliApiError(404, "ORG_ACCESS_DENIED", "Organization was not found.");
  }

  const [billing, members, projects, entitlements, providerLinks] = await Promise.all([
    db
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, organization.id))
      .limit(1),
    db
      .select({
        membership: schema.organizationMemberships,
        user: schema.users,
      })
      .from(schema.organizationMemberships)
      .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
      .where(eq(schema.organizationMemberships.organizationId, organization.id))
      .orderBy(asc(schema.users.primaryEmail))
      .limit(100),
    db
      .select({
        id: schema.projects.id,
        slug: schema.projects.slug,
        name: schema.projects.name,
        status: schema.projects.status,
        defaultVisibility: schema.projects.defaultVisibility,
        updatedAt: schema.projects.updatedAt,
      })
      .from(schema.projects)
      .where(eq(schema.projects.organizationId, organization.id))
      .orderBy(desc(schema.projects.updatedAt))
      .limit(50),
    db
      .select({
        id: schema.entitlements.id,
        key: schema.entitlements.key,
        source: schema.entitlements.source,
        startsAt: schema.entitlements.startsAt,
        endsAt: schema.entitlements.endsAt,
        valueJson: schema.entitlements.valueJson,
        updatedAt: schema.entitlements.updatedAt,
      })
      .from(schema.entitlements)
      .where(eq(schema.entitlements.organizationId, organization.id))
      .orderBy(asc(schema.entitlements.key)),
    db
      .select({
        id: schema.authOrganizationLinks.id,
        provider: schema.authOrganizationLinks.provider,
        providerOrganizationId: schema.authOrganizationLinks.providerOrganizationId,
        createdAt: schema.authOrganizationLinks.createdAt,
      })
      .from(schema.authOrganizationLinks)
      .where(eq(schema.authOrganizationLinks.organizationId, organization.id))
      .orderBy(asc(schema.authOrganizationLinks.provider)),
  ]);

  return {
    version: 1,
    organization: sanitizeOrganizationRecord(organization, {
      billing: billing[0] ?? null,
    }),
    entitlements: entitlements.map(sanitizeEntitlement),
    members: members.map(({ membership, user }) => ({
      membership: {
        id: membership.id,
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      },
      user: sanitizeUserRecord(user),
    })),
    projects: projects.map((project) => ({
      ...project,
      updatedAt: project.updatedAt.toISOString(),
    })),
    providerLinks: providerLinks.map((link) => ({
      id: link.id,
      provider: link.provider,
      providerOrganizationId: link.providerOrganizationId,
      createdAt: link.createdAt.toISOString(),
    })),
  };
}

export async function listInternalControlUsers(input: {
  auth: CliAuthContext;
  limit?: number;
  query?: string | null;
}) {
  await requireInternalControlRead(input.auth);

  const users = await db
    .select()
    .from(schema.users)
    .where(userSearchWhere(input.query))
    .orderBy(asc(schema.users.primaryEmail))
    .limit(limit(input.limit));

  return {
    version: 1,
    users: users.map(sanitizeUserRecord),
  };
}

export async function getInternalControlUser(input: {
  auth: CliAuthContext;
  userRef: string;
}) {
  await requireInternalControlRead(input.auth);

  const user = await findUser(input.userRef);
  if (!user) {
    throw cliApiError(404, "ORG_ACCESS_DENIED", "User was not found.");
  }

  const [memberships, identities] = await Promise.all([
    db
      .select({
        billing: schema.billingAccounts,
        membership: schema.organizationMemberships,
        organization: schema.organizations,
      })
      .from(schema.organizationMemberships)
      .innerJoin(schema.organizations, eq(schema.organizationMemberships.organizationId, schema.organizations.id))
      .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.organizationId, schema.organizations.id))
      .where(eq(schema.organizationMemberships.userId, user.id))
      .orderBy(asc(schema.organizations.name)),
    db
      .select({
        id: schema.authIdentities.id,
        provider: schema.authIdentities.provider,
        providerUserId: schema.authIdentities.providerUserId,
        email: schema.authIdentities.email,
        createdAt: schema.authIdentities.createdAt,
      })
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, user.id))
      .orderBy(asc(schema.authIdentities.provider)),
  ]);

  return {
    version: 1,
    user: sanitizeUserRecord(user),
    identities: identities.map((identity) => ({
      id: identity.id,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      email: identity.email,
      createdAt: identity.createdAt.toISOString(),
    })),
    memberships: memberships.map(({ billing, membership, organization }) => ({
      membership: {
        id: membership.id,
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt.toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      },
      organization: sanitizeOrganizationRecord(organization, { billing }),
    })),
  };
}

async function requireInternalControlRead(auth: CliAuthContext): Promise<ConsoleFeatureAccessData> {
  requireScope(auth, INTERNAL_CONTROL_READ_SCOPE);

  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: auth.organization.id,
    role: auth.membership.role,
  });
  const internalControl = access.byKey["console.internal_control"];

  if (!internalControl.enabled) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      "Internal Console control is not enabled for this organization.",
    );
  }

  return access;
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Internal Console control scope is required.");
  }
}

function assertCurrentOrganization(auth: CliAuthContext, organizationRef?: string | null) {
  const normalized = organizationRef?.trim();
  if (!normalized) return;
  if (normalized === auth.organization.id || normalized === auth.organization.slug) return;

  throw cliApiError(
    403,
    "ORG_ACCESS_DENIED",
    "Cross-organization backoffice lookup is not implemented for this endpoint.",
  );
}

function sanitizeActor(auth: CliAuthContext) {
  return {
    user: {
      id: auth.user.id,
      email: auth.user.primaryEmail,
      name: auth.user.displayName,
      status: auth.user.status,
    },
    organization: sanitizeOrganization(auth),
    membership: {
      id: auth.membership.id,
      role: auth.membership.role,
      status: auth.membership.status,
    },
    localInstallation: {
      id: auth.localInstallation.id,
      name: auth.localInstallation.name,
      hostname: auth.localInstallation.hostname,
      platform: auth.localInstallation.platform,
      raviVersion: auth.localInstallation.raviVersion,
      status: auth.localInstallation.status,
      lastSeenAt: auth.localInstallation.lastSeenAt.toISOString(),
    },
    cliSession: {
      id: auth.cliSession.id,
      status: auth.cliSession.status,
      expiresAt: auth.cliSession.expiresAt.toISOString(),
      lastUsedAt: auth.cliSession.lastUsedAt?.toISOString() ?? null,
    },
  };
}

function sanitizeOrganization(auth: CliAuthContext) {
  return {
    id: auth.organization.id,
    slug: auth.organization.slug,
    name: auth.organization.name,
    status: auth.organization.status,
  };
}

function summarizeFeatureAccess(access: ConsoleFeatureAccessData) {
  return {
    organizationId: access.organizationId,
    plan: access.plan,
    role: access.role,
    internalControl: access.byKey["console.internal_control"],
  };
}

async function findOrganization(ref: string) {
  const normalized = ref.trim();
  if (!normalized) return null;

  const [organization] = await db
    .select()
    .from(schema.organizations)
    .where(isUuidRef(normalized) ? eq(schema.organizations.id, normalized) : eq(schema.organizations.slug, normalized))
    .limit(1);

  return organization ?? null;
}

async function findUser(ref: string) {
  const normalized = ref.trim().toLowerCase();
  if (!normalized) return null;

  const [user] = await db
    .select()
    .from(schema.users)
    .where(isUuidRef(ref.trim()) ? eq(schema.users.id, ref.trim()) : eq(schema.users.primaryEmail, normalized))
    .limit(1);

  return user ?? null;
}

function sanitizeOrganizationRecord(
  organization: typeof schema.organizations.$inferSelect,
  options: {
    billing: typeof schema.billingAccounts.$inferSelect | null;
  },
) {
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    status: organization.status,
    planKey: options.billing?.planKey ?? "free",
    billingStatus: options.billing?.status ?? null,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

function sanitizeUserRecord(user: typeof schema.users.$inferSelect) {
  return {
    id: user.id,
    primaryEmail: user.primaryEmail,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function sanitizeEntitlement(entitlement: {
  endsAt: Date | null;
  id: string;
  key: string;
  source: string;
  startsAt: Date | null;
  updatedAt: Date;
  valueJson: Record<string, unknown>;
}) {
  return {
    id: entitlement.id,
    key: entitlement.key,
    source: entitlement.source,
    startsAt: entitlement.startsAt?.toISOString() ?? null,
    endsAt: entitlement.endsAt?.toISOString() ?? null,
    valueJson: entitlement.valueJson,
    updatedAt: entitlement.updatedAt.toISOString(),
  };
}

function organizationSearchWhere(query?: string | null) {
  const normalized = likeQuery(query);
  if (!normalized) return sql`true`;
  return or(
    sql`lower(${schema.organizations.id}::text) like ${normalized}`,
    sql`lower(${schema.organizations.slug}) like ${normalized}`,
    sql`lower(${schema.organizations.name}) like ${normalized}`,
  );
}

function userSearchWhere(query?: string | null) {
  const normalized = likeQuery(query);
  if (!normalized) return sql`true`;
  return or(
    sql`lower(${schema.users.id}::text) like ${normalized}`,
    sql`lower(${schema.users.primaryEmail}) like ${normalized}`,
    sql`lower(coalesce(${schema.users.displayName}, '')) like ${normalized}`,
  );
}

function likeQuery(query?: string | null) {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return null;
  return `%${normalized.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function limit(value?: number) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.trunc(value ?? 50), 1), 100);
}
