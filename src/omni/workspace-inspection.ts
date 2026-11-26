export interface WorkspaceChangeInspection {
  state: "clean" | "dirty" | "unavailable";
  changedFiles: number;
  preview: string[];
}

/**
 * What the daemon reports about an agent's workspace after a message edit.
 *
 * The daemon does not run tools inside the agent's workspace. A `git status`
 * there honours the repository's own config (`core.fsmonitor`, clean filters,
 * submodules), which the agent can write, so it would run the agent's code
 * with the daemon's authority. The agent checks its workspace itself, inside
 * its own runtime, so the answer is always "unavailable".
 */
export async function inspectAgentWorkspaceChanges(_cwd: string): Promise<WorkspaceChangeInspection> {
  return { state: "unavailable", changedFiles: 0, preview: [] };
}
