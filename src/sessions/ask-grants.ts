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
 *
 * A grant belongs to the two sessions as they were when the Ask was made: it
 * records each session's creation time, and a session deleted and recreated
 * under the same key has a new one, so the old grant authorizes nothing there.
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

/** When the session stored under `key` was created, or null when no such session exists. */
function sessionCreatedAt(key: string): number | null {
  const row = getDb().prepare("SELECT created_at FROM sessions WHERE session_key = ?").get(key) as {
    created_at: number;
  } | null;
  return row ? row.created_at : null;
}

/**
 * Record that `originSessionKey` asked `targetSessionKey`. Only two existing sessions can make
 * an Ask: the grant is bound to their current incarnation.
 */
export function recordAskGrant(input: {
  originSessionKey: string;
  targetSessionKey: string;
  sender?: string | null;
  now?: number;
}): AskGrant | null {
  const now = input.now ?? Date.now();
  const originCreatedAt = sessionCreatedAt(input.originSessionKey);
  const targetCreatedAt = sessionCreatedAt(input.targetSessionKey);
  if (originCreatedAt === null || targetCreatedAt === null) return null;
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
      `INSERT INTO session_asks (id, origin_session_key, target_session_key, sender, created_at, expires_at,
         origin_session_created_at, target_session_created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      grant.id,
      grant.originSessionKey,
      grant.targetSessionKey,
      grant.sender,
      grant.createdAt,
      grant.expiresAt,
      originCreatedAt,
      targetCreatedAt,
    );
    // Expired rows authorize nothing; drop them so the table does not grow.
    db.prepare("DELETE FROM session_asks WHERE expires_at <= ?").run(now);
  });
  return grant;
}

/** Withdraw a grant whose Ask was never delivered. */
export function revokeAskGrant(id: string): void {
  executeWrite(getDb(), (db) => {
    db.prepare("DELETE FROM session_asks WHERE id = ?").run(id);
  });
}

/**
 * The session key a reference names, in the order the CLI resolves a session
 * (`resolveSession`): a stored key, then a name, then the reference itself as a key.
 * Chat ids are not answer targets: the Ask hands out the session key.
 */
export function askOriginKeyFor(originRef: string): string {
  if (originRef.startsWith("agent:") && sessionCreatedAt(originRef) !== null) return originRef;
  const row = getDb().prepare("SELECT session_key FROM sessions WHERE name = ? LIMIT 1").get(originRef) as {
    session_key: string;
  } | null;
  return row?.session_key ?? originRef;
}

/**
 * The open Ask that lets `callerSessionKey` answer `originRef`, or null.
 * Only the asked session holds it: a third session, a closed (expired) Ask, a
 * reversed pair (the asker answering itself into the asked) or a session that
 * was deleted and recreated since the Ask find nothing.
 */
export function findOpenAskGrant(
  originRef: string,
  callerSessionKey: string | undefined,
  now = Date.now(),
): AskGrant | null {
  if (!callerSessionKey || !originRef) return null;
  const originKey = askOriginKeyFor(originRef);
  const row = getDb()
    .prepare(
      `SELECT a.* FROM session_asks a
       JOIN sessions o ON o.session_key = a.origin_session_key AND o.created_at = a.origin_session_created_at
       JOIN sessions t ON t.session_key = a.target_session_key AND t.created_at = a.target_session_created_at
       WHERE a.target_session_key = ? AND a.origin_session_key = ? AND a.expires_at > ?
       ORDER BY a.created_at DESC LIMIT 1`,
    )
    .get(callerSessionKey, originKey, now) as AskGrantRow | null;
  return row ? fromRow(row) : null;
}
