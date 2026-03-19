import { useState, useEffect, useCallback } from "react";
import { listSessions } from "../../router/sessions.js";
import { dbGetAgent } from "../../router/router-db.js";

export interface SessionItem {
  name: string;
  sessionKey: string;
  agentId: string;
  model: string | null;
  updatedAt: number;
}

export interface UseSessionsResult {
  sessions: SessionItem[];
  refresh: () => void;
}

export interface UseSessionsOptions {
  agentId?: string | null;
}

/**
 * React hook that loads the session list from SQLite.
 *
 * Loads once on mount. Call `refresh()` to reload.
 * Each session is mapped to { name, sessionKey, agentId, model, updatedAt }.
 */
export function useSessions(options: UseSessionsOptions = {}): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  const refresh = useCallback(() => {
    try {
      const entries = listSessions().filter((entry) => !options.agentId || entry.agentId === options.agentId);
      const items: SessionItem[] = entries.map((entry) => {
        const agent = dbGetAgent(entry.agentId);
        const model = entry.modelOverride ?? agent?.model ?? null;
        return {
          name: entry.name ?? entry.sessionKey,
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          model,
          updatedAt: entry.updatedAt,
        };
      });
      setSessions(items);
    } catch {
      // DB not available or error — keep empty list
      setSessions([]);
    }
  }, [options.agentId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { sessions, refresh };
}
