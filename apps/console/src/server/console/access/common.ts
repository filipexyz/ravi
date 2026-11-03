import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { db, schema } from "@/server/db";
import type { ConsoleWorkspace } from "../workspace";

export type AccessTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AccessDb = Pick<typeof db, "insert" | "select" | "update">;
type UserRecord = typeof schema.users.$inferSelect;

/**
 * Who is changing access. A person in the Console, or the CLI and agents
 * acting for a signed-in person: every grant and invite names a person.
 */
export type AccessActor = {
  actorType: "anonymous" | "cli" | "user";
  organizationId: string;
  role: string;
  userId: string;
  /** Extra attribution for the audit trail, such as the agent and chat that asked. */
  via?: Record<string, unknown>;
};

export function accessActorFromWorkspace(
  workspace: Pick<ConsoleWorkspace, "membership" | "mode" | "organization" | "user">,
): AccessActor {
  return {
    actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
    organizationId: workspace.organization.id,
    role: workspace.membership.role,
    userId: workspace.user.id,
  };
}

export function normalizeAccessEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(executor: AccessDb, email: string): Promise<UserRecord | null> {
  const [user] = await executor
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.primaryEmail}) = ${normalizeAccessEmail(email)}`)
    .limit(1);
  return user ?? null;
}

/**
 * The account an email will sign in as. A new address gets a stub user that
 * the person claims at first sign-in, only with a verified email.
 */
export async function findOrCreateUserByEmail(
  tx: AccessTransaction,
  input: { actor: AccessActor; createdFrom: string; email: string; requestId: string },
): Promise<{ created: boolean; user: UserRecord }> {
  const email = normalizeAccessEmail(input.email);
  const existing = await findUserByEmail(tx, email);
  if (existing) return { created: false, user: existing };

  const [created] = await tx
    .insert(schema.users)
    .values({
      displayName: email.split("@")[0] || email,
      metadataJson: {
        actorId: input.actor.userId,
        createdFrom: input.createdFrom,
        organizationId: input.actor.organizationId,
        requestId: input.requestId,
      },
      primaryEmail: email,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    await tx.insert(schema.auditEvents).values({
      action: "user.created_stub",
      actorId: input.actor.userId,
      actorType: input.actor.actorType,
      afterJson: { user: { id: created.id, primaryEmail: created.primaryEmail, status: created.status } },
      metadataJson: { source: input.createdFrom, ...(input.actor.via ? { via: input.actor.via } : {}) },
      organizationId: input.actor.organizationId,
      requestId: input.requestId,
      targetId: created.id,
      targetType: "user",
    });
    return { created: true, user: created };
  }

  const user = await findUserByEmail(tx, email);
  if (!user) throw new Error("Failed to create or find Console user.");
  return { created: false, user };
}

export function zodFieldErrors(error: z.ZodError, fallback: Record<string, string>) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string") {
      fieldErrors[field] = fallback[field] ?? issue.message;
    }
  }
  return Object.keys(fieldErrors).length ? fieldErrors : fallback;
}

export function displayNameFor(user: Pick<UserRecord, "displayName" | "primaryEmail"> | null | undefined) {
  if (!user) return null;
  return user.displayName?.trim() || user.primaryEmail;
}

/**
 * The person as an actor in one organization, from their own active
 * membership there; `null` when they are not an active member.
 */
export async function memberActorForOrganization(
  input: { organizationId: string; userId: string; via?: Record<string, unknown> },
  executor: AccessDb = db,
): Promise<AccessActor | null> {
  const [membership] = await executor
    .select({ role: schema.organizationMemberships.role })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  if (!membership) return null;
  return {
    actorType: "user",
    organizationId: input.organizationId,
    role: membership.role,
    userId: input.userId,
    ...(input.via ? { via: input.via } : {}),
  };
}
