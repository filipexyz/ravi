import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";

/**
 * Ask grants: the answer path of `ravi sessions ask`.
 *
 * An Ask tells the asked session to reply with `ravi sessions answer <origin>`.
 * Before this table that reply needed general access to the origin session, so
 * an agent asked by a session it cannot see (another agent, another owner) was
 * told to run a command its permissions refuse, and the asker never heard back.
 *
 * The Ask itself is now the authorization, and only for that one action: while
 * the row is open, the asked session may deliver an answer to the asker. It
 * does not let the asked session read, recap, inspect or prompt the asker, nor
 * redirect the delivery (`--channel`/`--to`). Channel-free: rows are keyed by
 * session keys; any adapter that delivers the Ask also delivers the answer.
 *
 * An Ask stays open for a window rather than until the first answer: the Ask
 * text asks for one answer per follow-up of the person being asked.
 */

export const ASK_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AskGrant {
  id: string;
  originSessionKey: string;
  targetSessionKey: string;
  sender: string | null;
  createdAt: number;
  expiresAt: number;
}

interface AskGrantRow {
  id: string;
  origin_session_key: string;
  target_session_key: string;
  sender: string | null;
  created_at: number;
  expires_at: number;
}

function fromRow(row: AskGrantRow): AskGrant {
  return {
    id: row.id,
    originSessionKey: row.origin_session_key,
    targetSessionKey: row.target_session_key,
    sender: row.sender,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Record that `originSessionKey` asked `targetSessionKey`. Only a real session can be answered. */
export function recordAskGrant(input: {
  originSessionKey: string;
  targetSessionKey: string;
  sender?: string | null;
  now?: number;
}): AskGrant {
  const now = input.now ?? Date.now();
  const grant: AskGrant = {
    id: `ask_${randomUUID()}`,
    originSessionKey: input.originSessionKey,
    targetSessionKey: input.targetSessionKey,
    sender: input.sender ?? null,
    createdAt: now,
    expiresAt: now + ASK_GRANT_TTL_MS,
  };
  executeWrite(getDb(), (db) => {
    db.prepare(
      `INSERT INTO session_asks (id, origin_session_key, target_session_key, sender, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(grant.id, grant.originSessionKey, grant.targetSessionKey, grant.sender, grant.createdAt, grant.expiresAt);
    // Expired rows authorize nothing; drop them so the table does not grow.
    db.prepare("DELETE FROM session_asks WHERE expires_at <= ?").run(now);
  });
  return grant;
}

/** The session key a reference names: a stored key, or the key of a session found by name. */
function originKeyFor(originRef: string): string {
  // Same order as resolveSession: a key-shaped ref is a key, otherwise a name, otherwise a key.
  if (originRef.startsWith("agent:")) return originRef;
  const row = getDb().prepare("SELECT session_key FROM sessions WHERE name = ? LIMIT 1").get(originRef) as {
    session_key: string;
  } | null;
  return row?.session_key ?? originRef;
}

/**
 * The open Ask that lets `callerSessionKey` answer `originRef`, or null.
 * Only the asked session holds it: a third session, a closed (expired) Ask or
 * a reversed pair (the asker answering itself into the asked) find nothing.
 */
export function findOpenAskGrant(
  originRef: string,
  callerSessionKey: string | undefined,
  now = Date.now(),
): AskGrant | null {
  if (!callerSessionKey || !originRef) return null;
  const originKey = originKeyFor(originRef);
  const row = getDb()
    .prepare(
      `SELECT * FROM session_asks
       WHERE target_session_key = ? AND origin_session_key = ? AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(callerSessionKey, originKey, now) as AskGrantRow | null;
  return row ? fromRow(row) : null;
}
