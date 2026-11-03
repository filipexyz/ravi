import { and, eq, or } from "drizzle-orm";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { authorizationStore } from "./authorization/store";
import type { AuthorizationActor } from "./authorization/identity";
import { isUuidRef } from "./ref";

export type ProjectAccessAction = "read" | "write" | "admin";
export type ProjectAccessWorkspace = {
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
  /** Server-derived only. CLI adapters MUST preserve the authenticated ceiling. */
  authorization?: AuthorizationActor["delegation"];
};
export type ProjectAccessRecord = typeof schema.projects.$inferSelect;
/** Repository ports may use this seam, never a role-only substitute. */
export type ProjectAuthorizationCheck = (workspace: ProjectAccessWorkspace, projectId: string, action: ProjectAccessAction) => Promise<boolean>;

export function authorizationActorFromWorkspace(workspace: ProjectAccessWorkspace): AuthorizationActor {
  return { userId: workspace.user.id, organizationId: workspace.organization.id, delegation: workspace.authorization };
}

export async function assertProjectAccess(workspace: ProjectAccessWorkspace, projectId: string, action: ProjectAccessAction,
  check: ProjectAuthorizationCheck = canAccessProject) {
  if (await check(workspace, projectId, action)) return;
  throw new ConsoleApiError(403, { error: "project_forbidden" });
}
export async function canAccessProject(workspace: ProjectAccessWorkspace, projectId: string, action: ProjectAccessAction) {
  return (await authorizationStore.decide(authorizationActorFromWorkspace(workspace), projectId, `project.${action}`)).allowed;
}
export async function listAccessibleProjectRecords(workspace: ProjectAccessWorkspace): Promise<ProjectAccessRecord[]> {
  return authorizationStore.accessibleProjects(authorizationActorFromWorkspace(workspace));
}
export async function findAccessibleProjectRecord(workspace: ProjectAccessWorkspace, projectRef: string,
  action: ProjectAccessAction = "read"): Promise<ProjectAccessRecord | null> {
  const refPredicate = isUuidRef(projectRef)
    ? or(eq(schema.projects.id, projectRef), eq(schema.projects.slug, projectRef))
    : eq(schema.projects.slug, projectRef);
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.organizationId, workspace.organization.id), refPredicate)).limit(1);
  if (!project) return null;
  return await canAccessProject(workspace, project.id, action) ? project : null;
}
