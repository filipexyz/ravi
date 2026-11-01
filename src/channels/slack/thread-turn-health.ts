import { getDb } from "../../router/router-db.js";
import { getRuntimeBootEpoch, listRuntimeTurnAttempts } from "../../runtime/crash-recovery-store.js";
import { getRuntimeLiveState, type RuntimeLiveState } from "../../runtime/live-state.js";
import { resolveToolInactivityTimeoutMs } from "../../runtime/tool-liveness.js";
import { getLatestSessionTurn } from "../../session-trace/session-trace-db.js";
import type { SlackThreadLifecycleRecord } from "./thread-lifecycle-store.js";
import type { ThreadTurnHealth, ThreadTurnReason, ThreadTurnState } from "./thread-turn-health-store.js";

export const THREAD_NO_SIGNAL_MS = 15 * 60_000;
export const THREAD_REPLY_GRACE_MS = 60_000;

/** Only the daemon reconciliation tick calls this. CLI reads the stored result. */
export function observeThreadTurn(
  record: SlackThreadLifecycleRecord,
  now: number,
  readLive: (name: string) => RuntimeLiveState | null = getRuntimeLiveState,
): ThreadTurnHealth {
  const turn = record.childSessionKey ? getLatestSessionTurn(record.childSessionKey) : null;
  let lastSignalAt: number | null = turn?.startedAt ?? null;
  const result = (state: ThreadTurnState, reason: ThreadTurnReason | null = null): ThreadTurnHealth => ({
    turnId: turn?.turnId ?? null,
    state,
    reason,
    since: now,
    lastSignalAt,
    checkedAt: now,
  });
  if (record.status === "closed") return result("closed");
  if (!turn) return result("idle");

  // Do not load tool outputs or scan the session's entire history. The turn index is bounded to one turn.
  const evidence = getDb()
    .prepare(`
    SELECT MAX(CASE WHEN event_type IN ('adapter.request','tool.start','tool.end','assistant.message',
      'runtime.status','response.emitted','delivery.delivered') THEN timestamp END) AS last_signal,
      MAX(CASE WHEN event_type IN ('response.emitted','delivery.delivered')
        AND COALESCE(json_extract(payload_json, '$.textLen'), 0) > 0
        AND COALESCE(json_extract(payload_json, '$.hasError'), 0) = 0
        AND json_extract(payload_json, '$.responsePhase') = 'final_answer' THEN 1 ELSE 0 END) AS final_reply
    FROM session_events WHERE turn_id = ?
  `)
    .get(turn.turnId) as { last_signal: number | null; final_reply: number };
  const live = record.childSessionName ? readLive(record.childSessionName) : null;
  lastSignalAt = Math.max(
    turn.startedAt,
    evidence.last_signal ?? 0,
    live?.turnId === turn.turnId ? (live.lastSignalAt ?? 0) : 0,
  );

  // A partial or even final-looking message cannot substitute for a terminal record.
  if (turn.completedAt !== null) {
    if (turn.status === "interrupted" || turn.status === "aborted") return result("interrupted");
    if (turn.status === "failed" || turn.status === "timeout") return result("attention", "failed");
    if (turn.status === "complete") {
      if (turn.outputState === "silent" || turn.outputState === "final" || evidence.final_reply) return result("idle");
      return now - turn.completedAt >= THREAD_REPLY_GRACE_MS ? result("attention", "no_reply") : result("running");
    }
  }

  const attempt = listRuntimeTurnAttempts({ turnId: turn.turnId, limit: 1 })[0];
  if (attempt?.status === "running") {
    const boot = getRuntimeBootEpoch(attempt.bootEpoch);
    if (attempt.leaseExpiresAt <= now || !boot || boot.status !== "active" || boot.leaseExpiresAt <= now) {
      return result("attention", "owner_lost");
    }
  }

  // Host lease heartbeats prove ownership, never provider progress. Long declared tools retain their budget.
  const openTools = getDb()
    .prepare(`
    SELECT json_extract(s.payload_json, '$.toolName') AS name,
      json_extract(s.payload_json, '$.input') AS input
    FROM session_events s WHERE s.turn_id = ? AND s.event_type = 'tool.start'
      AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.turn_id = s.turn_id
        AND e.event_type = 'tool.end' AND e.id > s.id
        AND json_extract(e.payload_json, '$.toolId') = json_extract(s.payload_json, '$.toolId'))
    ORDER BY s.id DESC LIMIT 64
  `)
    .all(turn.turnId) as Array<{ name: string | null; input: string | null }>;
  let quietAfterMs = THREAD_NO_SIGNAL_MS;
  for (const tool of openTools) {
    let input: unknown;
    try {
      input = tool.input ? JSON.parse(tool.input) : undefined;
    } catch {
      input = undefined;
    }
    quietAfterMs = Math.max(quietAfterMs, resolveToolInactivityTimeoutMs(tool.name ?? undefined, input));
  }
  return now - lastSignalAt >= quietAfterMs ? result("attention", "no_signal") : result("running");
}
