import { and, eq, ne, sql } from "drizzle-orm";
import { lockMemberIssuance } from "@/lib/auth/member-issuance";
import { z } from "zod";

import { revokeRemovedMemberConnectorAccess } from "@/server/connectors/member-removal";
import { isUuidRef } from "@/server/console/ref";
import { validateSlugPolicy } from "@/server/console/slug-policy";
import { db, schema } from "@/server/db";

const createOrganizationBodySchema = z.object({
  allowReservedSlug: z.boolean().optional().default(false),
  name: z.string().trim().min(1).max(120).optional(),
  ownerUserRef: z.string().trim().min(1).max(320),
  reason: z.string().trim().min(3).max(500),
  slug: z.string().trim().toLowerCase().min(2).max(63),
});

const membershipRoleSchema = z.enum(["owner", "admin", "developer", "viewer", "billing"]);

const upsertMembershipBodySchema = z.object({
  createUserIfMissing: z.boolean().optional().default(false),
  organizationRef: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(3).max(500),
  role: membershipRoleSchema.default("developer"),
  userRef: z.string().trim().min(1).max(320),
});

const removeMembershipBodySchema = z.object({
  organizationRef: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(3).max(500),
  userRef: z.string().trim().min(1).max(320),
});

const deleteOrganizationBodySchema = z.object({
  organizationRef: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(3).max(500),
});

type CreateAdminOrganizationInput = {
  body: unknown;
  requestId: string;
};

type CreateOrganizationInput = CreateAdminOrganizationInput & {
  /** The signed-in platform operator, when the call comes from /manage rather than the admin token. */
  actorUserId?: string | null;
  source?: string;
  /** Answer "exists" for a taken slug without touching it, instead of adopting it. */
  creationOnly?: boolean;
};

export async function createAdminOrganization(input: CreateOrganizationInput) {
  const body = parseCreateOrganizationBody(input.body);
  if (!body.allowReservedSlug) {
    const slugResult = validateSlugPolicy(body.slug);
    if (!slugResult.ok) {
      return fail("invalid_slug");
    }
  }

  return db.transaction(async (tx) => {
    const ownerRef = body.ownerUserRef.trim();
    const normalizedEmail = ownerRef.toLowerCase();
    const [owner] = await tx
      .select()
      .from(schema.users)
      .where(isUuidRef(ownerRef) ? eq(schema.users.id, ownerRef) : eq(schema.users.primaryEmail, normalizedEmail))
      .limit(1);

    if (!owner) {
      return {
        status: "not_found" as const,
        code: "owner_user_not_found",
      };
    }

    const [existing] = await tx.select().from(schema.organizations).where(eq(schema.organizations.slug, body.slug)).limit(1);
    if (existing && input.creationOnly) {
      return {
        status: "exists" as const,
        billing: null,
        membership: null,
        organization: sanitizeOrganization(existing),
        owner: { id: owner.id, primaryEmail: owner.primaryEmail, status: owner.status },
      };
    }
    const now = new Date();
    const created = !existing;
    const organization =
      existing ??
      (
        await tx
          .insert(schema.organizations)
          .values({
            slug: body.slug,
            name: body.name ?? body.slug,
            metadataJson: {
              createdFrom: "admin_control",
              ownerUserId: owner.id,
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];

    if (!organization) {
      throw new Error("failed_to_create_organization");
    }

    const [billing] = await tx
      .insert(schema.billingAccounts)
      .values({
        organizationId: organization.id,
        provider: "internal",
        status: "trialing",
        planKey: "free",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.billingAccounts.organizationId,
        set: {
          updatedAt: now,
        },
      })
      .returning();

    const [membershipBefore] = await tx
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organization.id),
          eq(schema.organizationMemberships.userId, owner.id),
        ),
      )
      .limit(1);

    const [membership] = await tx
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: owner.id,
        role: "owner",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.organizationMemberships.organizationId, schema.organizationMemberships.userId],
        set: {
          role: "owner",
          status: "active",
          updatedAt: now,
        },
      })
      .returning();

    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId ?? null,
      targetType: "organization",
      targetId: organization.id,
      action: created ? "admin.organization.created" : "admin.organization.owner_ensured",
      requestId: input.requestId,
      beforeJson: existing
        ? {
            organization: sanitizeOrganization(existing),
            membership: membershipBefore ? sanitizeMembership(membershipBefore) : null,
          }
        : null,
      afterJson: {
        organization: sanitizeOrganization(organization),
        membership: membership ? sanitizeMembership(membership) : null,
      },
      metadataJson: {
        billingAccountId: billing?.id ?? null,
        ownerUserId: owner.id,
        reason: body.reason,
        source: input.source ?? "admin_control",
      },
    });

    return {
      status: created ? ("created" as const) : ("exists" as const),
      billing: billing
        ? {
            id: billing.id,
            planKey: billing.planKey,
            status: billing.status,
          }
        : null,
      membership: membership ? sanitizeMembership(membership) : null,
      organization: sanitizeOrganization(organization),
      owner: {
        id: owner.id,
        primaryEmail: owner.primaryEmail,
        status: owner.status,
      },
    };
  });
}

export async function upsertAdminOrganizationMembership(input: CreateAdminOrganizationInput) {
  const body = parseUpsertMembershipBody(input.body);

  return db.transaction(async (tx) => {
    const organization = await findOrganization(tx, body.organizationRef);
    if (!organization) {
      return {
        status: "not_found" as const,
        code: "organization_not_found",
      };
    }

    await lockMemberIssuance(tx, organization.id);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${organization.id}`},0))`);
    const { created: createdUser, user } = await findOrCreateUser(tx, {
      createIfMissing: body.createUserIfMissing,
      reason: body.reason,
      userRef: body.userRef,
    });
    if (!user) {
      return {
        status: "not_found" as const,
        code: "user_not_found",
      };
    }

    const [before] = await tx
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organization.id),
          eq(schema.organizationMemberships.userId, user.id),
        ),
      )
      .limit(1);

    if (before?.role === "owner" && before.status === "active" && body.role !== "owner") {
      await assertNotLastOwner(tx, organization.id);
    }

    const now = new Date();
    if (createdUser) {
      await tx.insert(schema.auditEvents).values({
        organizationId: organization.id,
        actorType: "system",
        actorId: null,
        targetType: "user",
        targetId: user.id,
        action: "admin.user.created_stub",
        requestId: input.requestId,
        beforeJson: null,
        afterJson: { user: sanitizeUser(user) },
        metadataJson: {
          reason: body.reason,
          source: "admin_control",
        },
      });
    }

    const [membership] = await tx
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        userId: user.id,
        role: body.role,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.organizationMemberships.organizationId, schema.organizationMemberships.userId],
        set: {
          role: body.role,
          status: "active",
          updatedAt: now,
        },
      })
      .returning();

    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorType: "system",
      actorId: null,
      targetType: "organization_membership",
      targetId: membership?.id ?? null,
      action: before ? "admin.organization_member.updated" : "admin.organization_member.added",
      requestId: input.requestId,
      beforeJson: before ? { membership: sanitizeMembership(before) } : null,
      afterJson: membership ? { membership: sanitizeMembership(membership) } : null,
      metadataJson: {
        reason: body.reason,
        role: body.role,
        userCreated: createdUser,
        source: "admin_control",
        userId: user.id,
      },
    });

    return {
      status: before ? ("updated" as const) : ("created" as const),
      createdUser,
      membership: membership ? sanitizeMembership(membership) : null,
      organization: sanitizeOrganization(organization),
      user: sanitizeUser(user),
    };
  });
}

export async function removeAdminOrganizationMembership(input: CreateAdminOrganizationInput) {
  const body = parseRemoveMembershipBody(input.body);

  return db.transaction(async (tx) => {
    const organization = await findOrganization(tx, body.organizationRef);
    if (!organization) {
      return {
        status: "not_found" as const,
        code: "organization_not_found",
      };
    }

    await lockMemberIssuance(tx, organization.id);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${organization.id}`},0))`);
    const user = await findUser(tx, body.userRef);
    if (!user) {
      return {
        status: "not_found" as const,
        code: "user_not_found",
      };
    }

    const [before] = await tx
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, organization.id),
          eq(schema.organizationMemberships.userId, user.id),
        ),
      )
      .limit(1);

    if (!before || before.status === "removed") {
      return {
        status: "already_removed" as const,
        membership: before ? sanitizeMembership(before) : null,
        organization: sanitizeOrganization(organization),
        user: sanitizeUser(user),
      };
    }

    if (before.role === "owner" && before.status === "active") {
      await assertNotLastOwner(tx, organization.id);
    }

    const [membership] = await tx
      .update(schema.organizationMemberships)
      .set({
        status: "removed",
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationMemberships.id, before.id))
      .returning();

    const connectors = await revokeRemovedMemberConnectorAccess(tx, {
      organizationId: organization.id,
      userId: user.id,
    });

    await tx.update(schema.apiKeys).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date(),
      revision: sql`${schema.apiKeys.revision}+1` }).where(and(eq(schema.apiKeys.organizationId, organization.id),
      eq(schema.apiKeys.subjectKind, "user"), eq(schema.apiKeys.subjectUserId, user.id), ne(schema.apiKeys.status, "revoked")));

    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorType: "system",
      actorId: null,
      targetType: "organization_membership",
      targetId: before.id,
      action: "admin.organization_member.removed",
      requestId: input.requestId,
      beforeJson: { membership: sanitizeMembership(before) },
      afterJson: membership ? { membership: sanitizeMembership(membership) } : null,
      metadataJson: {
        connectors,
        reason: body.reason,
        source: "admin_control",
        userId: user.id,
      },
    });

    return {
      status: "removed" as const,
      membership: membership ? sanitizeMembership(membership) : null,
      organization: sanitizeOrganization(organization),
      user: sanitizeUser(user),
    };
  });
}

export async function deleteAdminOrganization(input: CreateAdminOrganizationInput) {
  const body = parseDeleteOrganizationBody(input.body);

  return db.transaction(async (tx) => {
    const organization = await findOrganization(tx, body.organizationRef);
    if (!organization) {
      return {
        status: "not_found" as const,
        code: "organization_not_found",
      };
    }

    const metadata = asRecord(organization.metadataJson);
    if (metadata.createdFrom !== "admin_control") {
      return {
        status: "blocked" as const,
        code: "organization_delete_requires_admin_created_org",
        blockers: ["not_admin_created"],
        organization: sanitizeOrganization(organization),
      };
    }

    const blockers = await organizationDeleteBlockers(tx, organization.id);
    if (blockers.length > 0) {
      return {
        status: "blocked" as const,
        code: "organization_not_empty",
        blockers,
        organization: sanitizeOrganization(organization),
      };
    }

    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorType: "system",
      actorId: null,
      targetType: "organization",
      targetId: organization.id,
      action: "admin.organization.deleted",
      requestId: input.requestId,
      beforeJson: { organization: sanitizeOrganization(organization) },
      afterJson: null,
      metadataJson: {
        reason: body.reason,
        source: "admin_control",
      },
    });

    const [deleted] = await tx
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, organization.id))
      .returning();

    if (!deleted) {
      throw new Error("organization_delete_failed");
    }

    return {
      status: "deleted" as const,
      organization: sanitizeOrganization(organization),
    };
  });
}

function parseCreateOrganizationBody(body: unknown) {
  const result = createOrganizationBodySchema.safeParse(body);
  if (!result.success) {
    return fail("invalid_body");
  }
  return result.data;
}

function parseUpsertMembershipBody(body: unknown) {
  const result = upsertMembershipBodySchema.safeParse(body);
  if (!result.success) {
    return fail("invalid_body");
  }
  return result.data;
}

function parseRemoveMembershipBody(body: unknown) {
  const result = removeMembershipBodySchema.safeParse(body);
  if (!result.success) {
    return fail("invalid_body");
  }
  return result.data;
}

function parseDeleteOrganizationBody(body: unknown) {
  const result = deleteOrganizationBodySchema.safeParse(body);
  if (!result.success) {
    return fail("invalid_body");
  }
  return result.data;
}

function fail(code: string): never {
  const error = new Error(code);
  error.name = "AdminOrganizationError";
  throw error;
}

function sanitizeOrganization(organization: typeof schema.organizations.$inferSelect) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

function sanitizeMembership(membership: typeof schema.organizationMemberships.$inferSelect) {
  return {
    id: membership.id,
    role: membership.role,
    status: membership.status,
    userId: membership.userId,
  };
}

function sanitizeUser(user: typeof schema.users.$inferSelect) {
  return {
    id: user.id,
    primaryEmail: user.primaryEmail,
    status: user.status,
  };
}

async function findOrganization(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationRef: string,
) {
  const ref = organizationRef.trim();
  const [organization] = await tx
    .select()
    .from(schema.organizations)
    .where(isUuidRef(ref) ? eq(schema.organizations.id, ref) : eq(schema.organizations.slug, ref))
    .limit(1);
  return organization ?? null;
}

async function findUser(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userRef: string) {
  const ref = userRef.trim();
  const [user] = await tx
    .select()
    .from(schema.users)
    .where(isUuidRef(ref) ? eq(schema.users.id, ref) : eq(schema.users.primaryEmail, ref.toLowerCase()))
    .limit(1);
  return user ?? null;
}

async function organizationDeleteBlockers(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
) {
  const [project, pageSite, domainClaim, mailbox] = await Promise.all([
    tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.organizationId, organizationId), ne(schema.projects.status, "deleted")))
      .limit(1),
    tx
      .select({ id: schema.pageSites.id })
      .from(schema.pageSites)
      .where(and(eq(schema.pageSites.organizationId, organizationId), ne(schema.pageSites.status, "deleted")))
      .limit(1),
    tx
      .select({ id: schema.domainClaims.id })
      .from(schema.domainClaims)
      .where(and(eq(schema.domainClaims.organizationId, organizationId), ne(schema.domainClaims.status, "deleted")))
      .limit(1),
    tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.organizationId, organizationId), ne(schema.mailboxes.status, "deleted")))
      .limit(1),
  ]);

  const blockers: string[] = [];
  if (project.length > 0) blockers.push("projects");
  if (pageSite.length > 0) blockers.push("page_sites");
  if (domainClaim.length > 0) blockers.push("domain_claims");
  if (mailbox.length > 0) blockers.push("mailboxes");
  return blockers;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

async function findOrCreateUser(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    createIfMissing: boolean;
    reason: string;
    userRef: string;
  },
) {
  const existing = await findUser(tx, input.userRef);
  if (existing || !input.createIfMissing) {
    return { created: false, user: existing };
  }

  const email = input.userRef.trim().toLowerCase();
  if (!email.includes("@")) {
    return { created: false, user: null };
  }

  const [created] = await tx
    .insert(schema.users)
    .values({
      primaryEmail: email,
      displayName: email.split("@")[0] || email,
      metadataJson: {
        createdFrom: "admin_control_member_add",
        reason: input.reason,
      },
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { created: true, user: created };
  }

  const user = await findUser(tx, email);
  return { created: false, user };
}

async function assertNotLastOwner(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], organizationId: string) {
  const activeOwners = await tx
    .select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.role, "owner"),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .limit(2);

  if (activeOwners.length <= 1) {
    return fail("last_owner_required");
  }
}
