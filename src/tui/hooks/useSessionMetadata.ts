import { useEffect, useState } from "react";
import { subscribe } from "../../nats.js";
import { dbGetAgent } from "../../router/router-db.js";
import { resolveSession } from "../../router/sessions.js";
import type { AgentConfig, SessionEntry } from "../../router/index.js";
import { loadConfig } from "../../utils/config.js";

export interface SessionMetadata {
  session: SessionEntry | null;
  agent: AgentConfig | null;
  defaultModel: string;
}

function snapshot(sessionName: string): SessionMetadata {
  const session = resolveSession(sessionName);
  const agentId = session?.agentId;
  const agent = agentId ? dbGetAgent(agentId) : null;
  return { session, agent, defaultModel: loadConfig().model };
}

/**
 * Cached session/agent/config metadata for the TUI status bar and cockpit.
 *
 * Replaces synchronous SQLite queries that previously ran on every render
 * (which became a hot-path bottleneck during streaming). The snapshot is
 * loaded once on mount and refreshed whenever NATS broadcasts
 * `ravi.config.changed` (emitted by CLI mutations to agents/instances/
 * settings/contacts and by `applyAgentRuntimeSelection` in the TUI itself).
 */
export function useSessionMetadata(sessionName: string): SessionMetadata {
  const [meta, setMeta] = useState<SessionMetadata>(() => snapshot(sessionName));

  useEffect(() => {
    let aborted = false;
    setMeta(snapshot(sessionName));

    const run = async () => {
      try {
        for await (const _event of subscribe("ravi.config.changed")) {
          if (aborted) return;
          setMeta(snapshot(sessionName));
        }
      } catch {
        // subscription ended or failed — keep cached snapshot
      }
    };
    void run();

    return () => {
      aborted = true;
    };
  }, [sessionName]);

  return meta;
}
