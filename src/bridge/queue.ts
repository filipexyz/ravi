import { BridgeError, LEASE_MS, type BridgeGrant } from "./protocol.js";
import type { BridgeStore, ConversationRow } from "./store.js";
import type { BridgeRuntime } from "./service.js";

export type DeliveryBarrier = "after_tool" | "after_reply" | "after_task" | "record_only";
export interface QueuedMessage {
  turn_id: string;
  conversation_id: string;
  message_id: string;
  barrier: DeliveryBarrier;
  state: "pending" | "dispatched" | "recorded" | "cancelled" | "expired";
  authority: string;
  lease_until: number;
  created_at: number;
}
export function recordDelivery(
  store: BridgeStore,
  value: {
    messageId: string;
    requestId: string;
    barrier: DeliveryBarrier;
    delivery: string;
    replyTo?: { authorName: string; excerpt: string };
  },
) {
  store.db
    .query("INSERT INTO message_metadata VALUES (?,?,?,?,?)")
    .run(
      value.messageId,
      value.requestId,
      value.barrier,
      value.delivery,
      value.replyTo ? JSON.stringify(value.replyTo) : null,
    );
}
export function messageMetadata(store: BridgeStore, id: string) {
  const row = store.db
    .query<
      {
        request_id: string;
        barrier: DeliveryBarrier;
        delivery: "sent" | "queued" | "recorded" | "cancelled" | "expired";
        reply_to: string | null;
      },
      [string]
    >("SELECT * FROM message_metadata WHERE message_id=?")
    .get(id);
  const handoff = store.db
    .query<{ definition: string; state: string }, [string]>(
      "SELECT definition,state FROM team_handoffs WHERE message_id=?",
    )
    .get(id);
  const extra = handoff ? { handoff: { ...JSON.parse(handoff.definition), status: handoff.state } } : {};
  return row
    ? {
        ...extra,
        requestId: row.request_id,
        barrier: row.barrier,
        delivery: row.delivery,
        ...(row.reply_to ? { replyTo: JSON.parse(row.reply_to) } : {}),
      }
    : extra;
}
export function queueMessage(
  store: BridgeStore,
  c: ConversationRow,
  grant: BridgeGrant,
  messageId: string,
  turnId: string,
  barrier: DeliveryBarrier,
) {
  if (
    store.db
      .query<{ count: number }, [string]>(
        "SELECT count(*) count FROM queued_messages WHERE conversation_id=? AND state='pending'",
      )
      .get(c.id)!.count >= 20
  )
    throw new BridgeError("QUEUE_FULL");
  store.db
    .query("INSERT INTO queued_messages VALUES (?,?,?,?,?,?,?,?)")
    .run(
      turnId,
      c.id,
      messageId,
      barrier,
      barrier === "record_only" ? "recorded" : "pending",
      JSON.stringify(grant),
      Math.min(Date.now() + LEASE_MS, grant.exp * 1000),
      Date.now(),
    );
}
function delivery(store: BridgeStore, row: QueuedMessage, state: QueuedMessage["state"], value: string) {
  store.db.query("UPDATE queued_messages SET state=? WHERE turn_id=?").run(state, row.turn_id);
  if (store.db.query("SELECT 1 FROM queued_messages WHERE message_id=? AND state='pending'").get(row.message_id))
    value = "queued";
  const handoff = store.db
    .query<{ definition: string }, [string]>("SELECT definition FROM team_handoffs WHERE message_id=?")
    .get(row.message_id);
  if (handoff) {
    const status =
      state === "dispatched"
        ? "accepted"
        : state === "expired"
          ? "expired"
          : state === "cancelled"
            ? "cancelled"
            : "pending";
    store.db.query("UPDATE team_handoffs SET state=? WHERE message_id=?").run(status, row.message_id);
    store.event(row.conversation_id, "handoff.state", { id: row.message_id, status });
  }
  store.db.query("UPDATE message_metadata SET delivery=? WHERE message_id=?").run(value, row.message_id);
  store.event(row.conversation_id, "message.delivery", { id: row.message_id, delivery: value });
}
export function cancelQueued(store: BridgeStore, conversationId: string, turnId: string) {
  const row = store.db
    .query<QueuedMessage, [string, string]>(
      "SELECT * FROM queued_messages WHERE conversation_id=? AND turn_id=? AND state IN ('pending','cancelled','expired')",
    )
    .get(conversationId, turnId);
  if (!row) return null;
  if (row.state === "pending") delivery(store, row, "cancelled", "cancelled");
  return {
    conversationId,
    turnId,
    cancelRequested: true,
    status: row.state === "expired" ? ("authorization_expired" as const) : ("cancelled" as const),
  };
}
export function renewQueued(store: BridgeStore, conversationId: string, grant: BridgeGrant) {
  return (
    store.db
      .query(
        "UPDATE queued_messages SET authority=?,lease_until=? WHERE conversation_id=? AND state='pending' AND lease_until>? AND json_extract(authority,'$.sub')=?",
      )
      .run(
        JSON.stringify(grant),
        Math.min(Date.now() + LEASE_MS, grant.exp * 1000),
        conversationId,
        Date.now(),
        grant.sub,
      ).changes > 0
  );
}
/** Only the head of each durable queue may interrupt or dispatch. No browser timers. */
export function drainQueues(store: BridgeStore, runtime: BridgeRuntime) {
  const rows = store.db
    .query<QueuedMessage, []>("SELECT * FROM queued_messages WHERE state='pending' ORDER BY created_at,rowid")
    .all();
  const visited = new Set<string>();
  for (const row of rows) {
    const grant = JSON.parse(row.authority) as BridgeGrant;
    const c = store.conversation(row.conversation_id);
    const enrollment = store.enrollment(grant.enrollmentId);
    const live =
      c &&
      enrollment?.active &&
      enrollment.epoch === grant.epoch &&
      c.enrollment_id === grant.enrollmentId &&
      store.hasParticipant(c, grant.sub) &&
      c.project_id === grant.projectId &&
      grant.canSend &&
      grant.agents.some((a) => a.id === (store.turnAgent(row.turn_id) ?? c.agent_id)) &&
      row.lease_until > Date.now() &&
      grant.exp * 1000 > Date.now();
    if (!live) {
      store.atomic(() => delivery(store, row, "expired", "expired"));
      continue;
    }
    if (visited.has(c.id)) continue;
    visited.add(c.id);
    const active = store.activeTurn(c.id);
    if (active) {
      if (
        row.barrier === "after_tool" &&
        runtime.canStart?.(c.session_name, "after_tool") &&
        !active.cancel_requested
      ) {
        store.atomic(() => {
          store.db.query("UPDATE turns SET cancel_requested=1 WHERE id=?").run(active.id);
          store.invalidateApprovals(active.id);
          store.event(c.id, "cancel.requested", { turnId: active.id });
        });
        if (runtime.cancel(c.session_name) === false) store.setTurn(active.id, "cancelled");
      }
      continue;
    }
    const handoff = store.db
      .query<{ parent_turn_id: string }, [string]>("SELECT parent_turn_id FROM team_handoffs WHERE turn_id=?")
      .get(row.turn_id);
    if (handoff && store.turn(handoff.parent_turn_id)?.status !== "completed") {
      store.atomic(() => delivery(store, row, "cancelled", "cancelled"));
      continue;
    }
    if (runtime.canStart && !runtime.canStart(c.session_name, row.barrier)) continue;
    const count = store.db
      .query<{ count: number }, [string, string]>(
        "SELECT count(*) count FROM turns t JOIN conversations c ON c.id=t.conversation_id WHERE c.enrollment_id=? AND json_extract(t.authority,'$.sub')=? AND t.status IN ('queued','running','awaiting_approval')",
      )
      .get(c.enrollment_id, grant.sub)!.count;
    if (count >= 3) continue;
    store.atomic(() => {
      store.db
        .query(
          "INSERT INTO turns(id,conversation_id,status,lease_until,authority,created_at) VALUES (?,?,'queued',?,?,?)",
        )
        .run(row.turn_id, c.id, row.lease_until, row.authority, Date.now());
      delivery(store, row, "dispatched", "sent");
      store.event(c.id, "turn.state", {
        id: row.turn_id,
        status: "queued",
        cancelRequested: false,
        ...(store.turnAgent(row.turn_id) ? { agentId: store.turnAgent(row.turn_id) } : {}),
      });
    });
  }
}
