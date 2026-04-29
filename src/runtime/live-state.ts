import type { SessionEntry } from "../router/types.js";
import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeProviderId } from "./types.js";

export type RuntimeLiveActivity = "idle" | "thinking" | "streaming" | "compacting" | "awaiting_approval" | "blocked";

export interface RuntimeLiveState {
  activity: RuntimeLiveActivity;
  summary?: string;
  updatedAt: number;
  busySince?: number;
  agentId?: string;
  runId?: string;
  provider?: RuntimeProviderId;
  model?: string;
  toolName?: string;
  source?: RuntimeMessageTarget;
}

export interface RuntimeLiveStatePatch {
  activity: RuntimeLiveActivity;
  summary?: string;
  agentId?: string;
  runId?: string;
  provider?: RuntimeProviderId;
  model?: string;
  toolName?: string;
  source?: RuntimeMessageTarget;
}

const liveBySessionName = new Map<string, RuntimeLiveState>();

export function updateRuntimeLiveState(sessionName: string, patch: RuntimeLiveStatePatch): RuntimeLiveState {
  const now = Date.now();
  const current = liveBySessionName.get(sessionName);
  const busy = patch.activity !== "idle";
  const next: RuntimeLiveState = {
    ...(current ?? { updatedAt: now }),
    activity: patch.activity,
    updatedAt: now,
    ...(busy ? { busySince: current?.busySince ?? now } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.toolName !== undefined ? { toolName: patch.toolName } : {}),
    ...(patch.source !== undefined ? { source: patch.source } : {}),
  };
  if (!busy) {
    delete next.busySince;
    delete next.toolName;
  }
  liveBySessionName.set(sessionName, next);
  return { ...next };
}

export function markRuntimeLiveIdle(sessionName: string, summary = "idle"): RuntimeLiveState {
  return updateRuntimeLiveState(sessionName, { activity: "idle", summary });
}

export function getRuntimeLiveState(sessionName: string): RuntimeLiveState | null {
  const live = liveBySessionName.get(sessionName);
  return live ? { ...live } : null;
}

export function getRuntimeLiveStateForSession(session: SessionEntry): RuntimeLiveState | null {
  const byName = session.name ? getRuntimeLiveState(session.name) : null;
  if (byName) return byName;
  const byKey = getRuntimeLiveState(session.sessionKey);
  if (byKey) return byKey;
  if (session.abortedLastRun) {
    return {
      activity: "blocked",
      summary: "last run aborted",
      updatedAt: session.updatedAt,
      busySince: session.updatedAt,
      agentId: session.agentId,
    };
  }
  return null;
}

export function clearRuntimeLiveState(sessionName: string): void {
  liveBySessionName.delete(sessionName);
}
