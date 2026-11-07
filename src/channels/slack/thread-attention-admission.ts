import { isDeepStrictEqual } from "node:util";
import { executeWrite } from "../../db/write-retry.js";
import { getDb } from "../../router/router-db.js";
import { resolveSession } from "../../router/sessions.js";
import {
  isThreadAttentionPrompt,
  assertThreadAttentionSession,
  type RuntimeLaunchPrompt,
} from "../../runtime/message-types.js";
import { RuntimeStartCapacityError } from "../../runtime/start-admission.js";

interface NoticeRow {
  event_id: string;
  request_id: string;
  turn_id: string;
  parent_session_key: string;
  child_session_key: string;
  target_session_name: string;
  payload_json: string;
  admission_status: "pending" | "accepting" | "admitted" | "refused" | "uncertain";
}

function frozenNotice(row: NoticeRow): RuntimeLaunchPrompt {
  const frozen = JSON.parse(row.payload_json) as RuntimeLaunchPrompt;
  const meta = frozen._slackThreadLifecycle;
  if (
    meta?.eventType !== "thread.attention" ||
    meta.eventId !== row.event_id ||
    meta.requestId !== row.request_id ||
    meta.turnId !== row.turn_id ||
    meta.parentSessionKey !== row.parent_session_key ||
    meta.childSessionKey !== row.child_session_key ||
    row.event_id !== `slack-thread-attention:${row.request_id}:${row.turn_id}` ||
    frozen._turnOrigin?.producer !== "channel" ||
    frozen._turnOrigin.action !== "session.return" ||
    !frozen._turnOrigin.callerContextId ||
    !frozen._agentId ||
    frozen._taskAssignmentId ||
    frozen._decisionDeliveryId
  )
    throw new Error("Thread attention receipt identity differs");
  return frozen;
}

/** Freeze producer-owned content and authority before publication. Reason changes do not create new work. */
export function prepareThreadAttentionNotice(
  requestId: string,
  claimId: string,
  sessionName: string,
  payload: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  return executeWrite(
    getDb(),
    (db) => {
      const binding = db
        .query(`SELECT h.turn_id, l.parent_session_key, l.child_session_key
      FROM slack_thread_turn_health h JOIN slack_thread_lifecycle l ON l.request_id=h.request_id
      WHERE h.request_id=? AND h.claim_id=? AND h.claim_expires_at>?
        AND h.state='attention' AND l.status='open'`)
        .get(requestId, claimId, now) as {
        turn_id: string;
        parent_session_key: string;
        child_session_key: string;
      } | null;
      if (!binding || resolveSession(sessionName)?.sessionKey !== binding.parent_session_key)
        throw new Error("Thread attention publication claim or target differs");
      const id = `slack-thread-attention:${requestId}:${binding.turn_id}`;
      const existing = db
        .query("SELECT * FROM slack_thread_attention_notices WHERE event_id=?")
        .get(id) as NoticeRow | null;
      const row: NoticeRow = existing ?? {
        event_id: id,
        request_id: requestId,
        turn_id: binding.turn_id,
        parent_session_key: binding.parent_session_key,
        child_session_key: binding.child_session_key,
        target_session_name: sessionName,
        payload_json: JSON.stringify(payload),
        admission_status: "pending",
      };
      if (
        row.parent_session_key !== binding.parent_session_key ||
        row.child_session_key !== binding.child_session_key ||
        row.target_session_name !== sessionName
      )
        throw new Error("Thread attention publication identity differs");
      const frozen = frozenNotice(row);
      assertThreadAttentionSession(frozen, resolveSession(sessionName));
      if (!existing)
        db.query(`INSERT INTO slack_thread_attention_notices
      (event_id,request_id,turn_id,parent_session_key,child_session_key,target_session_name,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
          id,
          requestId,
          binding.turn_id,
          binding.parent_session_key,
          binding.child_session_key,
          sessionName,
          row.payload_json,
          now,
        );
      return frozen as unknown as Record<string, unknown>;
    },
    { label: "thread-attention-prepare" },
  );
}

/** Admission is independent of producer receipts and broker retention; no lease can replay an uncertain handoff. */
export async function admitThreadAttention(
  sessionName: string,
  prompt: RuntimeLaunchPrompt,
  handle: (prompt: RuntimeLaunchPrompt) => Promise<void>,
): Promise<boolean> {
  const meta = prompt._slackThreadLifecycle;
  if (!isThreadAttentionPrompt(prompt)) return false;
  const id = meta?.eventId;
  if (!id) throw new Error("Thread attention event id missing");
  const expected = executeWrite(
    getDb(),
    (db) => {
      const row = db.query("SELECT * FROM slack_thread_attention_notices WHERE event_id=?").get(id) as NoticeRow | null;
      if (!row) throw new Error("Thread attention receipt missing");
      const frozen = frozenNotice(row);
      if (sessionName !== row.target_session_name || resolveSession(sessionName)?.sessionKey !== row.parent_session_key)
        throw new Error("Thread attention admission target differs");
      assertThreadAttentionSession(frozen, resolveSession(sessionName));
      if (!isDeepStrictEqual(prompt, frozen)) throw new Error("Thread attention admission envelope differs");
      if (!["pending", "refused"].includes(row.admission_status)) return null;
      // The receipt itself binds historical child/turn/authority. A later child turn or close cannot erase it.
      db.query("UPDATE slack_thread_attention_notices SET admission_status='accepting' WHERE event_id=?").run(id);
      return frozen;
    },
    { label: "thread-attention-admit" },
  );
  if (!expected) return true;
  try {
    await handle(expected);
    executeWrite(
      getDb(),
      (db) =>
        db
          .query(`UPDATE slack_thread_attention_notices
      SET admission_status='admitted', admitted_at=? WHERE event_id=? AND admission_status='accepting'`)
          .run(Date.now(), id),
      { label: "thread-attention-admitted" },
    );
  } catch (error) {
    // Only this typed refusal proves the runtime did not accept work. Other outcomes must not replay.
    executeWrite(
      getDb(),
      (db) =>
        db
          .query(`UPDATE slack_thread_attention_notices SET admission_status=?
      WHERE event_id=? AND admission_status='accepting'`)
          .run(error instanceof RuntimeStartCapacityError ? "refused" : "uncertain", id),
      { label: "thread-attention-refused" },
    );
    throw error;
  }
  return true;
}
