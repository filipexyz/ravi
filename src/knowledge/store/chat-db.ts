import { openStateDatabase } from "../../db/state-boundary.js";
// chat.db cleanup for synthetic sessions (contract §13.3): a curator turn
// quotes up to 200 of a contact's messages, so its rows are deleted once the
// turn is over.

import { existsSync } from "node:fs";
import { getChatDbPath } from "../../db.js";
import { getSession } from "../../router/sessions.js";

/**
 * Deletes the chat.db rows of one session and returns how many went.
 * chat.db stores the session NAME in `messages.session_id`, so both the given
 * value and, when it is a known session key, that session's name are removed.
 */
export function deleteChatDbSessionMessages(sessionKey: string): number {
  const key = sessionKey.trim();
  if (!key) return 0;
  const ids = new Set([key]);
  try {
    const name = getSession(key)?.name?.trim();
    if (name) ids.add(name);
  } catch {
    // The session may already be gone: delete by the given value only.
  }
  const path = getChatDbPath();
  if (!existsSync(path)) return 0;
  const db = openStateDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const placeholders = [...ids].map(() => "?").join(", ");
    return db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids).changes;
  } finally {
    db.close();
  }
}
