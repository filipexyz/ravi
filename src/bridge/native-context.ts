import type { BridgeStore } from "./store.js";

/** Accepted future requests must not leak into the prompt before their barrier.
 * A multi-agent target uses the same message boundary as its first target. */
export function nativeTurnContext(store: BridgeStore, conversationId: string, turnId: string) {
  const message = store.db
    .query<{ rowid: number; text: string; barrier: string | null }, [string, string, string]>(
      "SELECT m.rowid,m.text,mm.barrier FROM messages m LEFT JOIN message_metadata mm ON mm.message_id=m.id WHERE m.conversation_id=? AND m.id=COALESCE((SELECT message_id FROM turn_targets WHERE turn_id=?),(SELECT id FROM messages WHERE turn_id=? AND role='user'))",
    )
    .get(conversationId, turnId, turnId);
  if (!message) throw new Error("Missing accepted message");
  const notes = store.db
    .query<{ text: string }, [string, number]>(
      "SELECT DISTINCT m.rowid,m.text FROM messages m JOIN queued_messages q ON q.message_id=m.id WHERE m.conversation_id=? AND q.state='recorded' AND m.rowid<? ORDER BY m.rowid DESC LIMIT 20",
    )
    .all(conversationId, message.rowid)
    .reverse();
  const history = store.db
    .query<{ role: string; text: string }, [string, number]>(
      `SELECT role,text FROM (SELECT m.rowid,m.role,m.text FROM messages m
      WHERE m.conversation_id=? AND (m.role='assistant' OR
        (m.rowid<? AND NOT EXISTS (SELECT 1 FROM queued_messages q
          WHERE q.message_id=m.id AND q.state!='dispatched')))
      ORDER BY m.rowid DESC LIMIT 30) ORDER BY rowid`,
    )
    .all(conversationId, message.rowid);
  return { message, notes, history };
}
