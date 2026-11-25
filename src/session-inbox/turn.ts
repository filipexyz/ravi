/**
 * Decides whether a turn drains the session inbox and builds the block. Spec: `runtime/session-inbox`.
 *
 * Only two kinds of turn drain the inbox: a turn that carries a verified human message, and a
 * heartbeat turn when the operator opted in (`inbox.drainOnHeartbeat=true`). Every other background
 * turn (trigger, cron, observer, another notice) leaves the inbox untouched, so the person gets the
 * deferred notices together, in their own turn.
 */

import { classifyTurnProvenance, type TurnProvenanceInput } from "../runtime/turn-provenance.js";
import { renderInboxBlock } from "./render.js";
import { commitInboxReservation, releaseInboxReservation, reserveInboxItems } from "./store.js";

export const INBOX_DRAIN_ON_HEARTBEAT_SETTING = "inbox.drainOnHeartbeat";
export const INBOX_MAX_ITEMS_PER_TURN = 30;
export const INBOX_MAX_BYTES_PER_TURN = 16 * 1024;

export interface InboxTurnMessage {
  launchPrompt?: TurnProvenanceInput["prompt"];
}

export type InboxDrainReason = "human" | "heartbeat";

export function inboxDrainReason(
  messages: readonly InboxTurnMessage[],
  options: { drainOnHeartbeat: boolean },
): InboxDrainReason | null {
  let heartbeat = false;
  for (const message of messages) {
    const origin = classifyTurnProvenance({
      prompt: message.launchPrompt,
    }).origin;
    if (origin === "human") return "human";
    if (origin === "heartbeat") heartbeat = true;
  }
  return heartbeat && options.drainOnHeartbeat ? "heartbeat" : null;
}

export interface InboxTurnBlock {
  block: string;
  reason: InboxDrainReason;
  itemIds: string[];
  overflow: number;
  commit: () => void;
  release: (reason: string) => void;
}

export interface PrepareInboxTurnInput {
  sessionName: string;
  messages: readonly InboxTurnMessage[];
  drainOnHeartbeat: boolean;
  now?: number;
}

/**
 * Reserves the pending items for this turn and renders the block, or returns null when the turn
 * does not drain or the inbox is empty. The caller commits when the prompt reaches the provider and
 * releases when the turn never starts.
 */
export function prepareInboxTurnBlock(input: PrepareInboxTurnInput): InboxTurnBlock | null {
  const reason = inboxDrainReason(input.messages, {
    drainOnHeartbeat: input.drainOnHeartbeat,
  });
  if (!reason) return null;
  const reservation = reserveInboxItems({
    targetSessionName: input.sessionName,
    maxItems: INBOX_MAX_ITEMS_PER_TURN,
    maxBytes: INBOX_MAX_BYTES_PER_TURN,
    now: input.now,
  });
  if (reservation.items.length === 0) return null;
  return {
    block: renderInboxBlock({
      items: reservation.items,
      overflow: reservation.overflow,
      targetSessionName: input.sessionName,
    }),
    reason,
    itemIds: reservation.items.map((item) => item.id),
    overflow: reservation.overflow,
    commit: () => {
      commitInboxReservation(reservation.turnKey);
    },
    release: () => {
      releaseInboxReservation(reservation.turnKey);
    },
  };
}
