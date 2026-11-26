import { homedir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";

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

// A path word: single-quoted, double-quoted, or bare with backslash escapes.
// The command is only parsed, never run.
const PATH_WORD = /'((?:~|\/)[^']*)'|"((?:~|\/)[^"]*)"|((?:~|\/)(?:\\.|[^\s;&|'"`<>()\\])+)/g;

function absolutePathsIn(command: string, home: string): string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(PATH_WORD)) {
    const word = match[1] ?? match[2] ?? match[3]?.replace(/\\(.)/g, "$1");
    if (word) tokens.push(word);
  }
  return tokens.map((token) => normalize(expandTilde(token, home))).filter((token) => isAbsolute(token));
}

function expandTilde(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
