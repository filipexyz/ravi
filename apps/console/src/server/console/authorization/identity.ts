import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { ConsoleApiError } from "../api-error";
import type { AuthorizationFacts, OrganizationFacts } from "./engine";

export type AuthorizationExecutor = Pick<typeof db, "select" | "insert" | "update" | "execute">;
export type AuthorizationActor = {
  organizationId: string;
  userId: string;
  // Trusted server adapter fields; NEVER parse this object from the request body.
  delegation?: { installationId: string; sessionId: string; bindingId: string | null; accessTokenJti: string };
};
export type ActiveActor = AuthorizationActor & { organizationRole: string; active: true };

export async function loadActiveActor(executor: AuthorizationExecutor, actor: AuthorizationActor, lock = false): Promise<ActiveActor> {
  const query = executor.select({ role: schema.organizationMemberships.role })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.organizationId))
    .where(and(eq(schema.organizationMemberships.organizationId, actor.organizationId),
      eq(schema.organizationMemberships.userId, actor.userId), eq(schema.organizationMemberships.status, "active"),
      eq(schema.users.status, "active"), eq(schema.organizations.status, "active"))).limit(1);
  const [row] = lock ? await query.for("share") : await query;
  if (!row) throw new ConsoleApiError(403, { error: "authorization_identity_invalid" });
  return { ...actor, organizationRole: row.role, active: true };
}

export async function loadProjectFacts(executor: AuthorizationExecutor, actor: ActiveActor, projectId: string): Promise<AuthorizationFacts | null> {
  const [project] = await executor.select({ id: schema.projects.id, organizationId: schema.projects.organizationId })
    .from(schema.projects).where(and(eq(schema.projects.id, projectId), eq(schema.projects.organizationId, actor.organizationId))).limit(1).for("share");
  if (!project) return null;
  const [membership] = await executor.select({ role: schema.projectMemberships.role })
    .from(schema.projectMemberships).where(and(eq(schema.projectMemberships.projectId, project.id),
      eq(schema.projectMemberships.userId, actor.userId), eq(schema.projectMemberships.status, "active"))).limit(1).for("share");
  const facts: AuthorizationFacts = { organizationId: actor.organizationId, projectOrganizationId: project.organizationId,
    projectId: project.id, userId: actor.userId, active: actor.active, organizationRole: actor.organizationRole, projectRole: membership?.role ?? null };
  return { ...facts, ...(await loadOrganizationFacts(executor, actor)) };
}

/** Reuses the native session/link ceiling without fabricating a project. */
export async function loadOrganizationFacts(executor: AuthorizationExecutor, actor: ActiveActor): Promise<OrganizationFacts> {
  const facts: OrganizationFacts = { organizationId: actor.organizationId, userId: actor.userId,
    organizationRole: actor.organizationRole, active: actor.active };
  const delegation = actor.delegation;
  if (!delegation) return facts;
  const [session] = await executor.select({ userId: schema.cliSessions.userId, subjectType: schema.cliSessions.subjectType })
    .from(schema.cliSessions).innerJoin(schema.localInstallations, eq(schema.localInstallations.id, schema.cliSessions.localInstallationId))
    .where(and(eq(schema.cliSessions.id, delegation.sessionId), eq(schema.cliSessions.localInstallationId, delegation.installationId),
      eq(schema.cliSessions.organizationId, actor.organizationId), eq(schema.cliSessions.accessTokenJti, delegation.accessTokenJti),
      eq(schema.cliSessions.status, "active"), isNull(schema.cliSessions.revokedAt), sql`${schema.cliSessions.expiresAt} > now()`,
      eq(schema.localInstallations.organizationId, actor.organizationId), eq(schema.localInstallations.status, "active"),
      isNull(schema.localInstallations.revokedAt), isNull(schema.localInstallations.decommissionedAt))).limit(1).for("share");
  let valid = Boolean(session);
  if (valid && delegation.bindingId) {
    const [binding] = await executor.select({ id: schema.raviActorBindings.id }).from(schema.raviActorBindings)
      .where(and(eq(schema.raviActorBindings.id, delegation.bindingId), eq(schema.raviActorBindings.installationId, delegation.installationId),
        eq(schema.raviActorBindings.organizationId, actor.organizationId), eq(schema.raviActorBindings.consoleUserId, actor.userId),
        eq(schema.raviActorBindings.linkedBy, actor.userId), eq(schema.raviActorBindings.status, "active"), isNull(schema.raviActorBindings.revokedAt))).limit(1).for("share");
    valid = Boolean(binding);
  } else if (valid) {
    // A native personal CLI session may act for itself. Installation-only sessions
    // require a verified link; they cannot invent a human or use the owner fallback.
    valid = session?.subjectType === "user" && session.userId === actor.userId;
  }
  facts.delegation = { installationId: delegation.installationId, organizationId: actor.organizationId,
    userId: actor.userId, bindingId: delegation.bindingId, active: valid };
  return facts;
}
