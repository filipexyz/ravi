// The cloud agents service for Console screens: every function takes a
// CloudContext (build it with `cloudContextForWorkspace`) and returns the
// contract shapes in `./types`. Failures are CloudAgentsError (code, message,
// status), the same codes the CLI API returns.

import type { ConsoleWorkspace } from "@/server/console/workspace";

import { assertCloudAgentsEnabled, CLOUD_ADMIN_ROLES, CLOUD_WRITE_ROLES, type CloudContext, type CloudDeps } from "./access";
import { isCloudAgentsError } from "./errors";

export { decideCloudApproval } from "./approvals";
export { getCloudCredential, removeCloudCredential, setCloudCredential, setCloudMonthlyAlert } from "./credential";
export { archiveCloudAgent, deployCloudAgent, getCloudAgent, listCloudAgents } from "./deploy";
export { CloudAgentsError, isCloudAgentsError, type CloudAgentsErrorCode } from "./errors";
export { getCloudAgentHeartbeat, listDeployableLibraryAgents, type CloudLibraryAgent } from "./library-agents";
export {
  downloadCloudRunOutput,
  getCloudRun,
  listCloudRunEvents,
  listCloudRuns,
  sendCloudRunMessage,
  startCloudRun,
  stopCloudRun,
} from "./runs";
export { createCloudSchedule, deleteCloudSchedule, listCloudSchedules, updateCloudSchedule } from "./schedules";
export type { CloudContext, CloudDeps } from "./access";
export type { ProviderDownload as CloudRunDownload } from "./providers/types";
export * from "./types";

/** The context for a signed-in Console user. */
export function cloudContextForWorkspace(workspace: ConsoleWorkspace, requestId: string, deps?: CloudDeps): CloudContext {
  return {
    workspace: {
      user: { id: workspace.user.id },
      organization: { id: workspace.organization.id, slug: workspace.organization.slug },
      membership: { role: workspace.membership.role },
    },
    requestId,
    surface: "console",
    deps,
  };
}

export type CloudAgentsAvailability = {
  /** `unconfigured`: no RAVI_CLOUD_AGENTS_KEY on this deployment; `not_enabled`: allowlist or feature. */
  state: "available" | "unconfigured" | "not_enabled";
  canWrite: boolean;
  canManageKey: boolean;
};

/** Whether the screens should show cloud agents to this person, and which actions. */
export async function cloudAgentsAvailability(ctx: CloudContext): Promise<CloudAgentsAvailability> {
  const role = ctx.workspace.membership.role;
  const roles = { canWrite: CLOUD_WRITE_ROLES.has(role), canManageKey: CLOUD_ADMIN_ROLES.has(role) };
  try {
    await assertCloudAgentsEnabled(ctx);
    return { state: "available", ...roles };
  } catch (error) {
    if (isCloudAgentsError(error, "cloud_agents_unconfigured")) return { state: "unconfigured", ...roles };
    if (isCloudAgentsError(error, "cloud_agents_not_enabled")) return { state: "not_enabled", ...roles };
    throw error;
  }
}
