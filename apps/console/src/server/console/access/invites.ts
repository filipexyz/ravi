import { randomBytes } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { hashToken } from "@/server/cli/tokens";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import {
  type AccessActor,
  type AccessDb,
  displayNameFor,
  findUserByEmail,
  normalizeAccessEmail,
  zodFieldErrors,
} from "./common";

type InviteRecord = typeof schema.organizationInvites.$inferSelect;
type InviteRole = "admin" | "billing" | "developer" | "owner" | "viewer";

export const ORGANIZATION_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "rvinv_";
const TOKEN_PATTERN = /^rvinv_[A-Za-z0-9_-]{43}$/;
const MANAGE_INVITE_ROLES = new Set(["owner", "admin"]);
export const INVITE_ROLES = ["owner", "admin", "developer", "viewer", "billing"] as const;
const SOURCE = "console.access.invites";

function assertLegacyInvitesSupported() {
  if (process.env.RAVI_AUTH_MODE === "oidc")
    throw new ConsoleApiError(403, { error: "legacy_membership_unsupported" });
}

const createInviteBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  reason: z.string().trim().max(500).optional().nullable(),
  role: z.enum(INVITE_ROLES).default("viewer"),
});

const revokeInviteBodySchema = z.object({
  inviteId: z.string().uuid(),
});

export type OrganizationInviteSummary = {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedBy: string | null;
  role: InviteRole;
};

/** The person opening an invite link, from their Console session. */
export type InviteViewer = {
  actorType: "anonymous" | "user";
  email: string | null;
  emailVerified: boolean;
  impersonated: boolean;
  userId: string;
};

export type OrganizationInviteView =
  | {
      state: "pending";
      email: string;
      expiresAt: string;
      invitedBy: string | null;
      organizationName: string;
      role: InviteRole;
    }
  | { state: "accepted"; organizationId: string; organizationName: string }
  | { state: "already_member"; organizationId: string; organizationName: string }
  | { state: "email_mismatch"; email: string; organizationName: string }
  | { state: "email_unverified"; email: string; organizationName: string }
  | { state: "expired" | "invalid" | "revoked" };

export function generateOrganizationInviteToken() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function normalizeOrganizationInviteToken(token: string | null | undefined) {
  const value = token?.trim() ?? "";
  return TOKEN_PATTERN.test(value) ? value : null;
}

export function organizationInviteTokenHash(token: string) {
  return hashToken(`ravi-org-invite:${token}`);
}

export function organizationInviteUrl(origin: string, token: string) {
  return `${origin.replace(/\/+$/, "")}/invite/${token}`;
}

/** Owners and admins invite; only an owner can invite another owner. */
export function assertCanInvite(actor: Pick<AccessActor, "role">, role: InviteRole) {
  if (!MANAGE_INVITE_ROLES.has(actor.role)) {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }
  if (role === "owner" && actor.role !== "owner") {
    throw new ConsoleApiError(403, { error: "owner_required" });
  }
}

/**
 * Why this viewer may not accept, or null when they may. The invite is bound
 * to its email: the viewer must have signed in with that address, verified.
 */
export function inviteViewerMismatch(invite: Pick<InviteRecord, "email">, viewer: InviteViewer) {
  if (viewer.impersonated || viewer.actorType !== "user") return "email_unverified" as const;
  if (!viewer.email || !viewer.emailVerified) return "email_unverified" as const;
  if (normalizeAccessEmail(viewer.email) !== normalizeAccessEmail(invite.email)) return "email_mismatch" as const;
  return null;
}

export function parseCreateInviteBody(body: unknown) {
  const result = createInviteBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: zodFieldErrors(result.error, {
        email: "Enter a valid email.",
        role: "Choose a valid role.",
      }),
    });
  }
  return result.data;
}

export async function createOrganizationInvite({
  actor,
  body,
  now = new Date(),
  origin,
  requestId,
}: {
  actor: AccessActor;
  body: unknown;
  now?: Date;
  origin: string;
  requestId: string;
}): Promise<{ invite: OrganizationInviteSummary; url: string }> {
  assertLegacyInvitesSupported();
  const input = parseCreateInviteBody(body);
  assertCanInvite(actor, input.role);

  const existingUser = await findUserByEmail(db, input.email);
  if (existingUser) {
    const membership = await findMembership(db, actor.organizationId, existingUser.id);
    if (membership?.status === "active") {
      throw new ConsoleApiError(409, { error: "already_member" });
    }
  }

  const token = generateOrganizationInviteToken();
  const expiresAt = new Date(now.getTime() + ORGANIZATION_INVITE_TTL_MS);

  const invite = await db.transaction(async (tx) => {
    // A new invite to the same address replaces the old link.
    const replaced = await tx
      .update(schema.organizationInvites)
      .set({ revokedAt: now, revokedByUserId: actor.userId, status: "revoked", updatedAt: now })
      .where(
        and(
          eq(schema.organizationInvites.organizationId, actor.organizationId),
          eq(schema.organizationInvites.email, input.email),
          eq(schema.organizationInvites.status, "pending"),
        ),
      )
      .returning({ id: schema.organizationInvites.id });

    const [created] = await tx
      .insert(schema.organizationInvites)
      .values({
        email: input.email,
        expiresAt,
        invitedByActorType: actor.actorType,
        invitedByUserId: actor.userId,
        metadataJson: {
          requestId,
          source: SOURCE,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(actor.via ? { via: actor.via } : {}),
        },
        organizationId: actor.organizationId,
        role: input.role,
        tokenHash: organizationInviteTokenHash(token),
      })
      .returning();
    if (!created) throw new Error("Failed to create organization invite.");

    await tx.insert(schema.auditEvents).values({
      action: "organization_invite.created",
      actorId: actor.userId,
      actorType: actor.actorType,
      afterJson: { invite: sanitizeInvite(created) },
      metadataJson: {
        replacedInviteIds: replaced.map((row) => row.id),
        source: SOURCE,
        ...(actor.via ? { via: actor.via } : {}),
      },
      organizationId: actor.organizationId,
      requestId,
      targetId: created.id,
      targetType: "organization_invite",
    });
    return created;
  });

  const inviter = await findUserById(db, actor.userId);
  return {
    invite: toInviteSummary(invite, displayNameFor(inviter)),
    url: organizationInviteUrl(origin, token),
  };
}

export async function listOrganizationInvites({
  actor,
  now = new Date(),
}: {
  actor: AccessActor;
  now?: Date;
}): Promise<OrganizationInviteSummary[]> {
  assertLegacyInvitesSupported();
  if (!MANAGE_INVITE_ROLES.has(actor.role)) return [];
  const rows = await db
    .select({ invite: schema.organizationInvites, inviter: schema.users })
    .from(schema.organizationInvites)
    .leftJoin(schema.users, eq(schema.users.id, schema.organizationInvites.invitedByUserId))
    .where(
      and(
        eq(schema.organizationInvites.organizationId, actor.organizationId),
        eq(schema.organizationInvites.status, "pending"),
        gt(schema.organizationInvites.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.organizationInvites.createdAt));
  return rows.map((row) => toInviteSummary(row.invite, displayNameFor(row.inviter)));
}

export async function revokeOrganizationInvite({
  actor,
  alsoAuthorize = [],
  body,
  now = new Date(),
  requestId,
}: {
  actor: AccessActor;
  /** Other actors who must also be allowed to manage this invite's role (the CLI session user). */
  alsoAuthorize?: AccessActor[];
  body: unknown;
  now?: Date;
  requestId: string;
}): Promise<{ revoked: boolean }> {
  assertLegacyInvitesSupported();
  const parsed = revokeInviteBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { inviteId: "Choose a valid invite." } });
  }

  const [invite] = await db
    .select()
    .from(schema.organizationInvites)
    .where(
      and(
        eq(schema.organizationInvites.id, parsed.data.inviteId),
        eq(schema.organizationInvites.organizationId, actor.organizationId),
      ),
    )
    .limit(1);
  if (!invite) throw new ConsoleApiError(404, { error: "invite_not_found" });
  assertCanInvite(actor, invite.role);
  for (const other of alsoAuthorize) assertCanInvite(other, invite.role);
  if (invite.status !== "pending") return { revoked: false };

  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(schema.organizationInvites)
      .set({ revokedAt: now, revokedByUserId: actor.userId, status: "revoked", updatedAt: now })
      .where(and(eq(schema.organizationInvites.id, invite.id), eq(schema.organizationInvites.status, "pending")))
      .returning();
    if (!revoked) return { revoked: false };

    await tx.insert(schema.auditEvents).values({
      action: "organization_invite.revoked",
      actorId: actor.userId,
      actorType: actor.actorType,
      beforeJson: { invite: sanitizeInvite(invite) },
      afterJson: { invite: sanitizeInvite(revoked) },
      metadataJson: { source: SOURCE, ...(actor.via ? { via: actor.via } : {}) },
      organizationId: actor.organizationId,
      requestId,
      targetId: invite.id,
      targetType: "organization_invite",
    });
    return { revoked: true };
  });
}

/** What the invite page shows. Opening it changes nothing. */
export async function getOrganizationInviteView({
  now = new Date(),
  token,
  viewer,
}: {
  now?: Date;
  token: string | null | undefined;
  viewer: InviteViewer;
}): Promise<OrganizationInviteView> {
  assertLegacyInvitesSupported();
  const found = await findInviteByToken(db, token);
  if (!found) return { state: "invalid" };
  const { invite, organization, inviter } = found;

  if (invite.status === "accepted") {
    return invite.acceptedByUserId === viewer.userId
      ? { organizationId: organization.id, organizationName: organization.name, state: "accepted" }
      : { state: "invalid" };
  }
  if (invite.status === "revoked") return { state: "revoked" };
  if (invite.status === "expired" || invite.expiresAt <= now) return { state: "expired" };

  const membership = await findMembership(db, organization.id, viewer.userId);
  if (membership?.status === "active") {
    return { organizationId: organization.id, organizationName: organization.name, state: "already_member" };
  }

  const mismatch = inviteViewerMismatch(invite, viewer);
  if (mismatch) return { email: invite.email, organizationName: organization.name, state: mismatch };

  return {
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
    invitedBy: displayNameFor(inviter),
    organizationName: organization.name,
    role: invite.role,
    state: "pending",
  };
}

/** Joins the organization with the invited role. Single use. */
export async function acceptOrganizationInvite({
  now = new Date(),
  requestId,
  token,
  viewer,
}: {
  now?: Date;
  requestId: string;
  token: string | null | undefined;
  viewer: InviteViewer;
}): Promise<{ organizationId: string }> {
  assertLegacyInvitesSupported();
  const found = await findInviteByToken(db, token);
  if (!found) throw new ConsoleApiError(404, { error: "INVITE_INVALID" });
  const { invite, organization } = found;

  if (invite.status === "accepted" && invite.acceptedByUserId === viewer.userId) {
    return { organizationId: organization.id };
  }
  if (invite.status === "revoked") throw new ConsoleApiError(410, { error: "INVITE_REVOKED" });
  if (invite.status === "expired") throw new ConsoleApiError(410, { error: "INVITE_EXPIRED" });
  if (invite.status !== "pending") throw new ConsoleApiError(409, { error: "INVITE_USED" });
  if (invite.expiresAt <= now) {
    await db
      .update(schema.organizationInvites)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(schema.organizationInvites.id, invite.id), eq(schema.organizationInvites.status, "pending")));
    throw new ConsoleApiError(410, { error: "INVITE_EXPIRED" });
  }

  const mismatch = inviteViewerMismatch(invite, viewer);
  if (mismatch) {
    await db.insert(schema.auditEvents).values({
      action: "organization_invite.accept_refused",
      actorId: viewer.userId,
      actorType: viewer.actorType,
      metadataJson: { reason: mismatch, source: SOURCE },
      organizationId: organization.id,
      requestId,
      targetId: invite.id,
      targetType: "organization_invite",
    });
    throw new ConsoleApiError(403, { error: mismatch === "email_mismatch" ? "INVITE_EMAIL_MISMATCH" : "INVITE_EMAIL_UNVERIFIED" });
  }

  await db.transaction(async (tx) => {
    const [accepted] = await tx
      .update(schema.organizationInvites)
      .set({ acceptedAt: now, acceptedByUserId: viewer.userId, status: "accepted", updatedAt: now })
      .where(
        and(
          eq(schema.organizationInvites.id, invite.id),
          eq(schema.organizationInvites.status, "pending"),
          gt(schema.organizationInvites.expiresAt, now),
        ),
      )
      .returning();
    if (!accepted) throw new ConsoleApiError(409, { error: "INVITE_USED" });

    const before = await findMembership(tx, organization.id, viewer.userId);
    if (before?.status === "active") {
      await tx.insert(schema.auditEvents).values({
        action: "organization_invite.accepted",
        actorId: viewer.userId,
        actorType: viewer.actorType,
        afterJson: { invite: sanitizeInvite(accepted) },
        metadataJson: { alreadyMember: true, source: SOURCE },
        organizationId: organization.id,
        requestId,
        targetId: invite.id,
        targetType: "organization_invite",
      });
      return;
    }

    const [membership] = await tx
      .insert(schema.organizationMemberships)
      .values({
        organizationId: organization.id,
        role: invite.role,
        status: "active",
        userId: viewer.userId,
      })
      .onConflictDoUpdate({
        target: [schema.organizationMemberships.organizationId, schema.organizationMemberships.userId],
        set: { role: invite.role, status: "active", updatedAt: now },
      })
      .returning();
    if (!membership) throw new Error("Failed to add the invited member.");

    await tx.insert(schema.auditEvents).values({
      action: "organization_member.added",
      actorId: viewer.userId,
      actorType: viewer.actorType,
      beforeJson: before ? { membership: { id: before.id, role: before.role, status: before.status } } : null,
      afterJson: { membership: { id: membership.id, role: membership.role, status: membership.status } },
      metadataJson: { inviteId: invite.id, invitedByUserId: invite.invitedByUserId, source: SOURCE },
      organizationId: organization.id,
      requestId,
      targetId: membership.id,
      targetType: "organization_membership",
    });
    await tx.insert(schema.auditEvents).values({
      action: "organization_invite.accepted",
      actorId: viewer.userId,
      actorType: viewer.actorType,
      afterJson: { invite: sanitizeInvite(accepted) },
      metadataJson: { source: SOURCE },
      organizationId: organization.id,
      requestId,
      targetId: invite.id,
      targetType: "organization_invite",
    });
  });

  return { organizationId: organization.id };
}

async function findInviteByToken(executor: AccessDb, token: string | null | undefined) {
  const normalized = normalizeOrganizationInviteToken(token);
  if (!normalized) return null;
  const [row] = await executor
    .select({ invite: schema.organizationInvites, organization: schema.organizations })
    .from(schema.organizationInvites)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationInvites.organizationId))
    .where(eq(schema.organizationInvites.tokenHash, organizationInviteTokenHash(normalized)))
    .limit(1);
  if (!row || row.organization.status !== "active") return null;
  const inviter = row.invite.invitedByUserId ? await findUserById(executor, row.invite.invitedByUserId) : null;
  return { ...row, inviter };
}

async function findMembership(executor: AccessDb, organizationId: string, userId: string) {
  const [membership] = await executor
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.userId, userId),
      ),
    )
    .limit(1);
  return membership ?? null;
}

async function findUserById(executor: AccessDb, userId: string) {
  const [user] = await executor.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user ?? null;
}

function toInviteSummary(invite: InviteRecord, invitedBy: string | null): OrganizationInviteSummary {
  return {
    createdAt: invite.createdAt.toISOString(),
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
    id: invite.id,
    invitedBy,
    role: invite.role,
  };
}

function sanitizeInvite(invite: InviteRecord) {
  return {
    email: invite.email,
    expiresAt: invite.expiresAt.toISOString(),
    id: invite.id,
    role: invite.role,
    status: invite.status,
  };
}
