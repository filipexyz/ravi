import { getAgent } from "../router/config.js";
import { resolveSession } from "../router/sessions.js";
import { RaviTmuxManager } from "./manager.js";

export interface TuiTargetResolution {
  agentId: string;
  sessionName?: string;
  source: "agent" | "session";
}

export interface TuiTargetResolverDeps {
  getAgentById?: typeof getAgent;
  resolveSessionByName?: typeof resolveSession;
}

export function resolveTuiTarget(target: string, deps: TuiTargetResolverDeps = {}): TuiTargetResolution {
  const resolveSessionByName = deps.resolveSessionByName ?? resolveSession;
  const getAgentById = deps.getAgentById ?? getAgent;

  const session = resolveSessionByName(target);
  if (session) {
    return {
      agentId: session.agentId,
      sessionName: session.name ?? session.sessionKey,
      source: "session",
    };
  }

  const agent = getAgentById(target);
  if (agent) {
    return {
      agentId: agent.id,
      source: "agent",
    };
  }

  throw new Error(`Unknown agent or session: ${target}`);
}

export async function launchTmuxTui(target: string): Promise<void> {
  const resolution = resolveTuiTarget(target);
  const manager = new RaviTmuxManager();
  await manager.ensureWatcherRunning({ restartIfRunning: true });
  await manager.attach(resolution.agentId, resolution.sessionName);
}
