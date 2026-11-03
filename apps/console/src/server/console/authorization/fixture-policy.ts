/** Synthetic service-unit fixtures ONLY, not the production authorization
 * resolver. This helper supplies explicit user grants for existing service tests;
 * security/role semantics are asserted independently against real policy/DB. */
import { createHash } from "node:crypto";
import { compilePolicy } from "./engine";
import type { ProjectAction, ProjectPolicy } from "./policy";
import type { ProjectAccessWorkspace, ProjectAccessAction } from "../project-access";
function uuid(value: string) {
  const h = createHash("sha256").update("fixture-only:" + value).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-8" + h.slice(17, 20) + "-" + h.slice(20, 32);
}
export async function authorizeFixtureProject(workspace: ProjectAccessWorkspace, projectId: string, action: ProjectAccessAction, input: {
  projects: { id: string; organizationId: string }[]; projectRole?: string | null;
}) {
  const project = input.projects.find(p => p.id === projectId && p.organizationId === workspace.organization.id);
  if (!project) return false;
  // Existing unit fixtures describe service scenarios using these labels. They
  // are converted to an explicit grant here, never imported by production code.
  const actions = new Set<ProjectAction>();
  if (["owner", "admin"].includes(workspace.membership.role)) {
    actions.add("project.read"); actions.add("project.write"); actions.add("project.admin");
  }
  if (workspace.membership.role === "developer") { actions.add("project.read"); actions.add("project.write"); }
  if (["viewer", "developer", "project_admin"].includes(input.projectRole ?? "")) actions.add("project.read");
  if (["developer", "project_admin"].includes(input.projectRole ?? "")) actions.add("project.write");
  const policy: ProjectPolicy = { format: 1, organizationId: uuid(project.organizationId),
    administrators: [{ kind: "user", id: uuid("fixture-manager") }], groups: [],
    rules: actions.size ? [{ id: "fixture-explicit-user", effect: "allow", projects: [uuid(projectId)],
      principals: [{ kind: "user", id: uuid(workspace.user.id) }], actions: [...actions] }] : [],
  };
  return (await (await compilePolicy(policy)).decide({ organizationId: uuid(workspace.organization.id), projectOrganizationId: uuid(project.organizationId),
    projectId: uuid(projectId), userId: uuid(workspace.user.id), active: true, organizationRole: workspace.membership.role,
    projectRole: input.projectRole ?? null }, "project." + action as ProjectAction)).allowed;
}
