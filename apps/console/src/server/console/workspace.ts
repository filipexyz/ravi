import { and, eq, sql } from "drizzle-orm";

import type { ConsoleAuthState, ConsoleRole } from "@/lib/auth/session";
import {
  applyWorkosUserManagementMetadataToIdentity,
  syncPlatformOperatorMirror,
} from "@/server/console/platform-operator";
import { db, schema } from "@/server/db";
import { normalizeConsoleRole } from "@/server/console/workos-role";
import { resolveOidcWorkspace } from "@/lib/auth/oidc-store";

export {
  CONSOLE_ORGANIZATION_ROLES,
  mapWorkosOrganizationRole,
  normalizeConsoleRole,
  parseConsoleRole,
} from "@/server/console/workos-role";

export type ConsoleWorkspace = {
  mode: ConsoleAuthState["mode"];
  /** Server-derived OIDC credential provenance, never a grant or browser token. */
  browserSessionId?: string;
  user: typeof schema.users.$inferSelect;
  organization: typeof schema.organizations.$inferSelect;
  membership: typeof schema.organizationMemberships.$inferSelect;
};

export const CONSOLE_ORGANIZATION_COOKIE = "ravi_console_org";

export type ConsoleIdentity = {
  provider: string;
  providerUserId: string;
  providerOrganizationId?: string;
  providerMembershipId?: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  organizationName: string;
  organizationSlug: string;
  role: ConsoleRole;
  rawProfile: Record<string, unknown>;
};

export type ConsoleUserIdentity = Pick<
  ConsoleIdentity,
  "avatarUrl" | "email" | "name" | "provider" | "providerUserId" | "rawProfile"
>;

export type ConsoleOrganizationMembership = {
  billing: typeof schema.billingAccounts.$inferSelect | null;
  membership: typeof schema.organizationMemberships.$inferSelect;
  organization: typeof schema.organizations.$inferSelect;
};

export class ConsoleWorkspaceSelectionRequiredError extends Error {
  readonly code = "organization_selection_required";

  constructor(public readonly organizations: ConsoleOrganizationMembership[]) {
    super(
      organizations.length === 0
        ? "No Ravi organization is available for this user."
        : "Select a Ravi organization before opening Console.",
    );
  }
}

/**
 * The sign-in matched an account someone else created for this email (an
 * invite, a member added by email, a shared page) but the provider has not
 * verified that the person owns the address. Taking over the account then
 * would let anyone who types the email inherit its access.
 */
export class ConsoleEmailVerificationRequiredError extends Error {
  readonly code = "email_verification_required";

  constructor() {
    super("Verify your email address before signing in to this account.");
  }
}

export async function getConsoleWorkspace(
  auth: ConsoleAuthState,
  options: { organizationRef?: string | null } = {},
): Promise<ConsoleWorkspace> {
  const { user, organization, membership } =
    auth.mode === "oidc"
      ? await resolveSingleTenantWorkspace(auth, options)
      : auth.mode === "anonymous"
      ? await syncConsoleIdentity(anonymousIdentity(auth))
      : await resolveWorkosWorkspace(auth, options);
  return {
    mode: auth.mode,
    browserSessionId: auth.oidc?.sessionId,
    user,
    organization,
    membership,
  };
}

export async function getLinkedProviderOrganizationIdForOrganization(input: {
  organizationId: string;
  provider: string;
}) {
  const [link] = await db
    .select({ providerOrganizationId: schema.authOrganizationLinks.providerOrganizationId })
    .from(schema.authOrganizationLinks)
    .where(
      and(
        eq(schema.authOrganizationLinks.organizationId, input.organizationId),
        eq(schema.authOrganizationLinks.provider, input.provider),
      ),
    )
    .limit(1);

  return link?.providerOrganizationId ?? null;
}

export async function syncConsoleIdentity(identity: ConsoleIdentity) {
  if (identity.provider.startsWith("oidc:")) {
    const row = await resolveOidcWorkspace({ issuer: identity.provider.slice(5), subject: identity.providerUserId });
    if (!row || identity.rawProfile.emailVerified !== true) throw new ConsoleWorkspaceSelectionRequiredError([]);
    return { user: row.user, organization: row.organization, membership: row.membership };
  }
  const user = await syncConsoleUserIdentity(identity);
  const organization = await upsertOrganization(identity, user.id);
  const membership = await upsertMembership(organization.id, user.id, identity.role);

  if (identity.providerOrganizationId) {
    await upsertAuthOrganizationLink(identity.provider, identity.providerOrganizationId, organization.id);
  }

  if (identity.providerMembershipId) {
    await upsertAuthMembershipLink(identity.provider, identity.providerMembershipId, membership.id);
  }

  return {
    user,
    organization,
    membership,
  };
}

export async function syncConsoleUserIdentity(identity: ConsoleUserIdentity) {
  if (identity.provider.startsWith("oidc:")) {
    if (identity.rawProfile.emailVerified !== true) throw new ConsoleEmailVerificationRequiredError();
    const row = await resolveOidcWorkspace({ issuer: identity.provider.slice(5), subject: identity.providerUserId });
    if (!row) throw new ConsoleWorkspaceSelectionRequiredError([]);
    return row.user;
  }
  const resolved = await applyWorkosUserManagementMetadataToIdentity(identity);
  return upsertUser(resolved.identity, {
    workosMetadataResolved: resolved.workosMetadataResolved,
  });
}

export function consoleUserIdentityFromAuth(auth: ConsoleAuthState): ConsoleUserIdentity {
  if (auth.mode === "oidc") {
    if (!auth.oidc) throw new ConsoleWorkspaceSelectionRequiredError([]);
    return { provider: `oidc:${auth.oidc.issuer}`, providerUserId: auth.oidc.subject,
      email: auth.oidc.email, name: auth.oidc.name, avatarUrl: null,
      rawProfile: { issuer: auth.oidc.issuer, subject: auth.oidc.subject, emailVerified: true } };
  }
  return auth.mode === "anonymous" ? anonymousIdentity(auth) : workosIdentity(auth);
}

export async function getConsoleUserFromAuth(auth: ConsoleAuthState) {
  if (auth.mode === "oidc") return (await resolveSingleTenantWorkspace(auth)).user;
  return syncConsoleUserIdentity(consoleUserIdentityFromAuth(auth));
}

export async function listSelectableConsoleOrganizationMemberships(
  auth: ConsoleAuthState,
): Promise<ConsoleOrganizationMembership[]> {
  if (auth.mode === "oidc") {
    const workspace = await resolveSingleTenantWorkspace(auth);
    const [billing] = await db.select().from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.organizationId, workspace.organization.id)).limit(1);
    return [{ organization: workspace.organization, membership: workspace.membership, billing: billing ?? null }];
  }
  const identity = auth.mode === "anonymous" ? anonymousIdentity(auth) : workosIdentity(auth);
  const user = await syncConsoleUserIdentity(identity);
  return listSelectableOrganizationMemberships(user.id);
}

async function resolveSingleTenantWorkspace(auth: ConsoleAuthState, options: { organizationRef?: string | null } = {}) {
  if (!auth.oidc) throw new ConsoleWorkspaceSelectionRequiredError([]);
  const row = await resolveOidcWorkspace(auth.oidc);
  if (!row) throw new ConsoleWorkspaceSelectionRequiredError([]);
  const ref = options.organizationRef?.trim();
  if (ref && ref !== row.organization.id && ref !== row.organization.slug) {
    throw new ConsoleWorkspaceSelectionRequiredError([]);
  }
  return { user: row.user, organization: row.organization, membership: row.membership };
}

function anonymousIdentity(auth: ConsoleAuthState): ConsoleIdentity {
  return {
    provider: "anonymous",
    providerUserId: "anonymous_user",
    providerOrganizationId: "anonymous_org",
    providerMembershipId: "anonymous_membership",
    email: auth.viewer.email,
    name: auth.viewer.name,
    avatarUrl: null,
    organizationName: "Anonymous Workspace",
    organizationSlug: "anonymous",
    role: "owner" as ConsoleRole,
    rawProfile: { mode: "anonymous" },
  };
}

function workosIdentity(auth: ConsoleAuthState): ConsoleIdentity {
  const user = auth.initialAuth?.user;
  const email = user?.email ?? auth.viewer.email;
  const providerUserId = user?.id ?? `email:${email}`;
  const workosOrganizationId = auth.initialAuth?.organizationId;
  const role = normalizeConsoleRole(auth.initialAuth?.role);
  const organizationSlug = workosOrganizationId
    ? `workos-${workosOrganizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-24)}`
    : "organization-required";

  return {
    provider: "workos",
    providerUserId,
    providerOrganizationId: workosOrganizationId ?? undefined,
    email,
    name: auth.viewer.name,
    avatarUrl: user?.profilePictureUrl ?? null,
    organizationName: workosOrganizationId ? `WorkOS ${workosOrganizationId.slice(-6)}` : "Organization required",
    organizationSlug,
    role,
    rawProfile: user ? JSON.parse(JSON.stringify(user)) : { email },
  };
}

async function resolveWorkosWorkspace(
  auth: ConsoleAuthState,
  options: { organizationRef?: string | null },
) {
  const identity = workosIdentity(auth);
  const user = await syncConsoleUserIdentity(identity);

  if (options.organizationRef?.trim()) {
    return resolveExistingWorkspaceForUser(user, options);
  }

  if (identity.providerOrganizationId) {
    const linkedWorkspace = await resolveProviderLinkedWorkspace(identity, user);
    if (linkedWorkspace) return linkedWorkspace;

    const selectableWorkspaces = await listSelectableOrganizationMemberships(user.id);
    if (selectableWorkspaces.length === 1) {
      const selected = selectableWorkspaces[0]!;
      await linkIdentityToWorkspace(identity, selected.organization.id, selected.membership.id);
      return {
        user,
        organization: selected.organization,
        membership: selected.membership,
      };
    }

    if (selectableWorkspaces.length > 1) {
      throw new ConsoleWorkspaceSelectionRequiredError(selectableWorkspaces);
    }

    return syncConsoleIdentity(identity);
  }

  return resolveExistingWorkspaceForUser(user, options);
}

async function resolveProviderLinkedWorkspace(
  identity: ConsoleIdentity,
  user: typeof schema.users.$inferSelect,
) {
  if (!identity.providerOrganizationId) return null;

  const [linked] = await db
    .select({
      membership: schema.organizationMemberships,
      organization: schema.organizations,
    })
    .from(schema.authOrganizationLinks)
    .innerJoin(schema.organizations, eq(schema.authOrganizationLinks.organizationId, schema.organizations.id))
    .leftJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.organizations.id),
        eq(schema.organizationMemberships.userId, user.id),
      ),
    )
    .where(
      and(
        eq(schema.authOrganizationLinks.provider, identity.provider),
        eq(schema.authOrganizationLinks.providerOrganizationId, identity.providerOrganizationId),
        eq(schema.organizations.status, "active"),
      ),
    )
    .limit(1);

  if (!linked?.organization) return null;

  const membership =
    linked.membership?.status === "active"
      ? linked.membership
      : await upsertMembership(linked.organization.id, user.id, identity.role);

  if (identity.providerMembershipId) {
    await upsertAuthMembershipLink(identity.provider, identity.providerMembershipId, membership.id);
  }

  return {
    user,
    organization: linked.organization,
    membership,
  };
}

async function linkIdentityToWorkspace(
  identity: ConsoleIdentity,
  organizationId: string,
  membershipId: string,
) {
  if (!identity.providerOrganizationId) return;

  await upsertAuthOrganizationLink(identity.provider, identity.providerOrganizationId, organizationId);

  if (identity.providerMembershipId) {
    await upsertAuthMembershipLink(identity.provider, identity.providerMembershipId, membershipId);
  }
}

async function resolveExistingWorkspaceForUser(
  user: typeof schema.users.$inferSelect,
  options: { organizationRef?: string | null } = {},
) {
  const rows = await listSelectableOrganizationMemberships(user.id);
  const organizationRef = options.organizationRef?.trim();

  if (organizationRef) {
    const selected = rows.find(
      (row) => row.organization.id === organizationRef || row.organization.slug === organizationRef,
    );
    if (!selected) {
      throw new ConsoleWorkspaceSelectionRequiredError(rows);
    }
    return {
      user,
      organization: selected.organization,
      membership: selected.membership,
    };
  }

  if (rows.length !== 1) {
    throw new ConsoleWorkspaceSelectionRequiredError(rows);
  }

  return {
    user,
    organization: rows[0]!.organization,
    membership: rows[0]!.membership,
  };
}

async function listSelectableOrganizationMemberships(userId: string): Promise<ConsoleOrganizationMembership[]> {
  return db
    .select({
      billing: schema.billingAccounts,
      organization: schema.organizations,
      membership: schema.organizationMemberships,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.organizations, eq(schema.organizationMemberships.organizationId, schema.organizations.id))
    .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.organizationId, schema.organizations.id))
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.organizations.status, "active"),
      ),
    );
}

export async function findActiveWorkspaceForProviderOrganization(input: {
  provider: string;
  providerOrganizationId: string;
  userId: string;
}) {
  const [linked] = await db
    .select({
      membership: schema.organizationMemberships,
      organization: schema.organizations,
    })
    .from(schema.authOrganizationLinks)
    .innerJoin(schema.organizations, eq(schema.authOrganizationLinks.organizationId, schema.organizations.id))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.organizations.id),
        eq(schema.organizationMemberships.userId, input.userId),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .where(
      and(
        eq(schema.authOrganizationLinks.provider, input.provider),
        eq(schema.authOrganizationLinks.providerOrganizationId, input.providerOrganizationId),
        eq(schema.organizations.status, "active"),
      ),
    )
    .limit(1);

  if (!linked?.organization || !linked.membership) return null;
  return {
    organization: linked.organization,
    membership: linked.membership,
  };
}

export function isSwitchableWorkOSOrganizationId(value: string | null | undefined): value is string {
  return /^org_[A-Za-z0-9]+$/.test(value ?? "");
}

async function upsertUser(
  identity: ConsoleUserIdentity,
  options: { workosMetadataResolved?: boolean } = {},
) {
  const normalizedEmail = normalizeConsoleUserEmail(identity.email);
  const existingIdentity = await db.query.authIdentities.findFirst({
    where: and(
      eq(schema.authIdentities.provider, identity.provider),
      eq(schema.authIdentities.providerUserId, identity.providerUserId),
    ),
  });

  if (existingIdentity) {
    const [updated] = await db
      .update(schema.users)
      .set({
        primaryEmail: normalizedEmail,
        displayName: identity.name,
        avatarUrl: identity.avatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, existingIdentity.userId))
      .returning();

    await db
      .update(schema.authIdentities)
      .set({
        email: normalizedEmail,
        rawProfileJson: identity.rawProfile,
        updatedAt: new Date(),
      })
      .where(eq(schema.authIdentities.id, existingIdentity.id));

    if (updated) {
      await syncPlatformOperatorMirror({
        identity,
        user: updated,
        workosMetadataResolved: options.workosMetadataResolved,
      });
      return updated;
    }
  }

  const [existingByEmail] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.primaryEmail}) = ${normalizedEmail}`)
    .limit(1);

  if (existingByEmail && identity.provider === "workos" && !identityEmailVerified(identity)) {
    throw new ConsoleEmailVerificationRequiredError();
  }

  const user =
    existingByEmail ??
    (
      await db
        .insert(schema.users)
        .values({
          primaryEmail: normalizedEmail,
          displayName: identity.name,
          avatarUrl: identity.avatarUrl,
        })
        .returning()
    )[0];

  if (!user) throw new Error("Failed to sync console user.");

  await db
    .insert(schema.authIdentities)
    .values({
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      userId: user.id,
      email: normalizedEmail,
      rawProfileJson: identity.rawProfile,
    })
    .onConflictDoUpdate({
      target: [schema.authIdentities.provider, schema.authIdentities.providerUserId],
      set: {
        userId: user.id,
        email: normalizedEmail,
        rawProfileJson: identity.rawProfile,
        updatedAt: new Date(),
      },
    });

  await syncPlatformOperatorMirror({
    identity,
    user,
    workosMetadataResolved: options.workosMetadataResolved,
  });
  return user;
}

function identityEmailVerified(identity: ConsoleUserIdentity) {
  return identity.rawProfile.emailVerified === true;
}

function normalizeConsoleUserEmail(email: string) {
  return email.trim().toLowerCase();
}

async function upsertOrganization(
  identity: ConsoleIdentity,
  userId: string,
) {
  if (!identity.providerOrganizationId) {
    throw new Error("Console organization sync requires an explicit organization context.");
  }

  if (identity.providerOrganizationId) {
    const [link] = await db
      .select({ organization: schema.organizations })
      .from(schema.authOrganizationLinks)
      .innerJoin(
        schema.organizations,
        eq(schema.authOrganizationLinks.organizationId, schema.organizations.id),
      )
      .where(
        and(
          eq(schema.authOrganizationLinks.provider, identity.provider),
          eq(schema.authOrganizationLinks.providerOrganizationId, identity.providerOrganizationId),
        ),
      )
      .limit(1);
    if (link?.organization) return link.organization;
  }

  const [existing] = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, identity.organizationSlug))
    .limit(1);

  if (existing) return existing;

  const [organization] = await db
    .insert(schema.organizations)
    .values({
      slug: identity.organizationSlug,
      name: identity.organizationName,
      metadataJson: {
        createdFrom: identity.provider,
        ownerUserId: userId,
      },
    })
    .returning();

  if (!organization) throw new Error("Failed to sync console organization.");

  await db.insert(schema.billingAccounts).values({
    organizationId: organization.id,
    provider: "internal",
    status: "trialing",
    planKey: "free",
  });

  await db.insert(schema.auditEvents).values({
    organizationId: organization.id,
    actorType: "system",
    targetType: "organization",
    targetId: organization.id,
    action: "organization.created",
    metadataJson: { source: "auth-sync" },
  });

  return organization;
}

async function upsertMembership(organizationId: string, userId: string, role: ConsoleRole) {
  const [membership] = await db
    .insert(schema.organizationMemberships)
    .values({
      organizationId,
      userId,
      role,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [schema.organizationMemberships.organizationId, schema.organizationMemberships.userId],
      set: {
        status: "active",
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!membership) throw new Error("Failed to sync console membership.");
  return membership;
}

async function upsertAuthOrganizationLink(provider: string, providerOrganizationId: string, organizationId: string) {
  await db
    .insert(schema.authOrganizationLinks)
    .values({
      provider,
      providerOrganizationId,
      organizationId,
    })
    .onConflictDoUpdate({
      target: [schema.authOrganizationLinks.provider, schema.authOrganizationLinks.providerOrganizationId],
      set: {
        organizationId,
        updatedAt: new Date(),
      },
    });
}

async function upsertAuthMembershipLink(provider: string, providerMembershipId: string, membershipId: string) {
  await db
    .insert(schema.authMembershipLinks)
    .values({
      provider,
      providerMembershipId,
      membershipId,
    })
    .onConflictDoUpdate({
      target: [schema.authMembershipLinks.provider, schema.authMembershipLinks.providerMembershipId],
      set: {
        membershipId,
        updatedAt: new Date(),
      },
    });
}
