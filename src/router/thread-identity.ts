import type { Database } from "bun:sqlite";
import { getDb } from "./router-db.js";
import type { SessionEntry } from "./types.js";

/**
 * Channel thread identity, read from the thread registry without channel code.
 *
 * An open channel thread (today, a Slack thread child) owns its session name:
 * the session behind it MUST live under the thread key (`<parent>:thread:<ts>`).
 * The registry has no foreign key to `sessions`, so a thread can outlive its
 * session; anything that would create a session by that bare name (task
 * dispatch, for example) has to ask here first, or it shadows the thread.
 * See .ravi/specs/channels/slack/threads/SPEC.md.
 */
export interface OpenThreadIdentity {
  requestId: string;
  parentSessionKey: string;
  parentSessionName: string;
  childSessionKey: string;
  childSessionName: string | null;
  providerThreadId: string | null;
}

export type SessionThreadIdentityAssessment =
  | { kind: "none" }
  | { kind: "ok"; thread: OpenThreadIdentity }
  /** The thread is open but its session row is gone. */
  | { kind: "child_missing"; thread: OpenThreadIdentity }
  /** The name resolves to a session under another key than the thread's. */
  | { kind: "key_mismatch"; thread: OpenThreadIdentity; sessionKey: string };

interface OpenThreadIdentityRow {
  request_id: string;
  parent_session_key: string;
  parent_session_name: string;
  child_session_key: string;
  child_session_name: string | null;
  provider_thread_id: string | null;
}

/** The most recent open thread whose child session is named (or keyed) `ref`. */
export function findOpenThreadIdentity(ref: string): OpenThreadIdentity | null {
  const normalized = ref.trim();
  if (!normalized) return null;
  const row = getDb()
    .prepare(
      `
      SELECT request_id, parent_session_key, parent_session_name, child_session_key, child_session_name, provider_thread_id
      FROM slack_thread_lifecycle
      WHERE status = 'open'
        AND child_session_key IS NOT NULL
        AND (child_session_name = ? OR child_session_key = ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    )
    .get(normalized, normalized) as OpenThreadIdentityRow | undefined;
  if (!row) return null;
  return {
    requestId: row.request_id,
    parentSessionKey: row.parent_session_key,
    parentSessionName: row.parent_session_name,
    childSessionKey: row.child_session_key,
    childSessionName: row.child_session_name,
    providerThreadId: row.provider_thread_id,
  };
}

/**
 * Whether `ref` names an open thread, and whether `session` (what `ref`
 * resolves to in the sessions table, or null) is that thread's session.
 */
export function assessSessionThreadIdentity(
  ref: string,
  session: Pick<SessionEntry, "sessionKey"> | null,
): SessionThreadIdentityAssessment {
  const thread = findOpenThreadIdentity(ref);
  if (!thread) return { kind: "none" };
  if (!session) return { kind: "child_missing", thread };
  if (session.sessionKey !== thread.childSessionKey) {
    return { kind: "key_mismatch", thread, sessionKey: session.sessionKey };
  }
  return { kind: "ok", thread };
}

/**
 * A session rename keeps the thread registry's saved names in step, so a
 * renamed thread child stays protected by its new name (and its old name is
 * free again), and a renamed parent is named correctly in refusals.
 * Runs inside the rename's write.
 */
export function renameThreadSessionNames(database: Database, sessionKey: string, newName: string): void {
  database
    .prepare("UPDATE slack_thread_lifecycle SET child_session_name = ? WHERE child_session_key = ?")
    .run(newName, sessionKey);
  database
    .prepare("UPDATE slack_thread_lifecycle SET parent_session_name = ? WHERE parent_session_key = ?")
    .run(newName, sessionKey);
}
