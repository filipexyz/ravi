import { getSession, getSessionByName } from "../router/index.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";

export const RUNTIME_SESSION_POOL_MAX_ENV = "RAVI_RUNTIME_SESSION_POOL_MAX";
export const LEGACY_RUNTIME_SESSION_POOL_MAX_ENV = "RAVI_STREAMING_POOL_MAX";
export const DEFAULT_RUNTIME_SESSION_POOL_MAX = 60;

export interface RuntimeStreamingSessionIdentity {
  sessionName?: string | null;
  sessionKey?: string | null;
}

export type RuntimeSessionPoolClass = "task" | "group" | "dm" | "other";

export interface RuntimeSessionPoolSnapshot {
  type: "runtime.session_pool.gauge";
  active: number;
  limit: number;
  pendingStarts: number;
  saturated: boolean;
  byAgent: Record<string, number>;
  byClass: Record<RuntimeSessionPoolClass, number>;
  timestamp: string;
}

export function resolveRuntimeSessionPoolMax(
  value = process.env[RUNTIME_SESSION_POOL_MAX_ENV] ?? process.env[LEGACY_RUNTIME_SESSION_POOL_MAX_ENV],
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return DEFAULT_RUNTIME_SESSION_POOL_MAX;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RUNTIME_SESSION_POOL_MAX;
  }

  return parsed;
}

export function resolveRuntimeStreamingSession(
  streamingSessions: Map<string, RuntimeHostStreamingSession>,
  identity: RuntimeStreamingSessionIdentity,
): { name: string; session: RuntimeHostStreamingSession } | null {
  const sessionName = normalizeIdentityValue(identity.sessionName);
  const sessionKey = normalizeIdentityValue(identity.sessionKey);

  if (sessionName) {
    const direct = streamingSessions.get(sessionName);
    if (direct) {
      return { name: sessionName, session: direct };
    }
  }

  if (sessionKey) {
    const direct = streamingSessions.get(sessionKey);
    if (direct) {
      return { name: sessionKey, session: direct };
    }

    const stored = getSession(sessionKey);
    if (stored?.name) {
      const named = streamingSessions.get(stored.name);
      if (named) {
        return { name: stored.name, session: named };
      }
    }
  }

  if (sessionName) {
    const stored = getSessionByName(sessionName) ?? getSession(sessionName);
    if (stored?.sessionKey) {
      const keyed = streamingSessions.get(stored.sessionKey);
      if (keyed) {
        return { name: stored.name ?? stored.sessionKey, session: keyed };
      }
    }
  }

  if (sessionKey) {
    for (const [name, session] of streamingSessions) {
      const stored = getSessionByName(name);
      if (stored?.sessionKey === sessionKey) {
        return { name, session };
      }
    }
  }

  return null;
}

export function buildRuntimeSessionPoolSnapshot(
  streamingSessions: Map<string, RuntimeHostStreamingSession>,
  options: { limit: number; pendingStarts?: number },
): RuntimeSessionPoolSnapshot {
  const byAgent: Record<string, number> = {};
  const byClass: Record<RuntimeSessionPoolClass, number> = {
    task: 0,
    group: 0,
    dm: 0,
    other: 0,
  };

  for (const [sessionName, session] of streamingSessions) {
    const agentId = session.agentId || "unknown";
    byAgent[agentId] = (byAgent[agentId] ?? 0) + 1;
    byClass[classifyRuntimeStreamingSession(sessionName, session)] += 1;
  }

  return {
    type: "runtime.session_pool.gauge",
    active: streamingSessions.size,
    limit: options.limit,
    pendingStarts: options.pendingStarts ?? 0,
    saturated: streamingSessions.size >= options.limit,
    byAgent,
    byClass,
    timestamp: new Date().toISOString(),
  };
}

function classifyRuntimeStreamingSession(
  sessionName: string,
  session: RuntimeHostStreamingSession,
): RuntimeSessionPoolClass {
  if (session.currentTaskBarrierTaskId || isTaskSessionName(sessionName)) {
    return "task";
  }

  const stored = getSessionByName(sessionName);
  if (stored?.chatType === "group" || sessionName.includes(":group:")) {
    return "group";
  }
  if (stored?.chatType === "dm" || sessionName.includes(":dm:")) {
    return "dm";
  }

  return "other";
}

function isTaskSessionName(sessionName: string): boolean {
  return /^task-[A-Za-z0-9_-]+-work(?:$|[:/])/.test(sessionName) || sessionName.endsWith("-work");
}

function normalizeIdentityValue(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}
