import { getDb } from "../router/router-db.js";
import { rowToSessionEvent, type SessionEventRow } from "../session-trace/session-trace-db.js";
import type { SessionEventRecord } from "../session-trace/types.js";

/**
 * Test-only: every event a session wrote, in insertion order.
 *
 * This lives in `src/test/` on purpose. An unbounded session scan is how the
 * daemon died on 2026-10-20: `listSessionEvents(sessionKey).filter(turnId)`
 * loaded 940k rows / 395MB to use 137 of them, blocked the event loop for 22.6s,
 * and expired the 30s crash-recovery lease. Tests seed a handful of rows;
 * production sessions have hundreds of thousands.
 *
 * Product code must read session events through a scoped query instead
 * (`listSessionEventsByTurn`, `listRecentSessionEventsByType`, or
 * `querySessionTrace`, which all bound the result).
 */
export function listSessionEventsForTest(sessionKey: string): SessionEventRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM session_events WHERE session_key = ? ORDER BY id ASC")
    .all(sessionKey) as SessionEventRow[];
  return rows.map(rowToSessionEvent);
}
