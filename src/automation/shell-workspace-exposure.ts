import { homedir } from "node:os";
import { isAbsolute, normalize, relative } from "node:path";

export interface ShellAutomationLike {
  kind: "cron" | "trigger";
  id: string;
  name?: string;
  enabled?: boolean;
  shellCommand?: string;
}

export interface AgentWorkspaceLike {
  id: string;
  cwd?: string | null;
}

export interface ShellWorkspaceExposure {
  kind: "cron" | "trigger";
  id: string;
  name?: string;
  agentId: string;
  path: string;
}

/**
 * Shell cron and shell triggers run as the operator. When the command runs a
 * script (or `cd`s) into an agent's workspace, that agent can rewrite what the
 * operator will run next. This lists those commands; it does not refuse them,
 * because existing workflows rely on it and the operator decides.
 */
export function findShellAutomationsInAgentWorkspaces(
  automations: ShellAutomationLike[],
  agents: AgentWorkspaceLike[],
  home: string = homedir(),
): ShellWorkspaceExposure[] {
  const workspaces = agents
    .filter((agent) => agent.cwd?.trim())
    .map((agent) => ({ agentId: agent.id, root: normalize(expandTilde(agent.cwd!.trim(), home)) }))
    .filter((workspace) => isAbsolute(workspace.root) && workspace.root !== "/" && workspace.root !== normalize(home));
  const exposures: ShellWorkspaceExposure[] = [];
  for (const automation of automations) {
    if (automation.enabled === false || !automation.shellCommand?.trim()) continue;
    for (const path of absolutePathsIn(automation.shellCommand, home)) {
      const owner = workspaces.find((workspace) => isUnder(path, workspace.root));
      if (owner) {
        exposures.push({
          kind: automation.kind,
          id: automation.id,
          ...(automation.name ? { name: automation.name } : {}),
          agentId: owner.agentId,
          path,
        });
        break;
      }
    }
  }
  return exposures;
}

function absolutePathsIn(command: string, home: string): string[] {
  const tokens = command.match(/(?:~|\/)[^\s;&|'"`<>()]+/g) ?? [];
  return tokens.map((token) => normalize(expandTilde(token, home))).filter((token) => isAbsolute(token));
}

function expandTilde(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
