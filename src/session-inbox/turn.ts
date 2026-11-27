/**
 * Decides whether a turn drains the session inbox and builds the block. Spec: `runtime/session-inbox`.
 *
 * Only the session's owner drains the inbox (see owner.ts): a human turn from the owner's own direct
 * chat, or a heartbeat when the operator opted in (`inbox.drainOnHeartbeat=true`) and the session's
 * default chat is the owner's direct chat. A turn that also carries a message from any other person
 * never drains. Every other background turn (trigger, cron, observer, another notice) leaves the
 * inbox untouched, so the owner gets the deferred notices together, in their own turn.
 */

import { classifyTurnProvenance, type TurnProvenanceInput } from "../runtime/turn-provenance.js";
import { renderInboxBlock } from "./render.js";
import {
  commitInboxReservation,
  markInboxReservationSent,
  releaseInboxReservation,
  reserveInboxItems,
} from "./store.js";

export const INBOX_DRAIN_ON_HEARTBEAT_SETTING = "inbox.drainOnHeartbeat";
export const INBOX_MAX_ITEMS_PER_TURN = 30;
export const INBOX_MAX_BYTES_PER_TURN = 16 * 1024;

export interface InboxTurnMessage {
  launchPrompt?: TurnProvenanceInput["prompt"];
}

export type InboxDrainReason = "human" | "heartbeat";

export interface InboxDrainOptions {
  drainOnHeartbeat: boolean;
  /** Whether a human message comes from the session owner's own direct chat (owner.ts). */
  isOwnerTurn: (prompt: InboxTurnMessage["launchPrompt"]) => boolean;
  /** Whether the session's default chat is the owner's direct chat, for a heartbeat (owner.ts). */
  isOwnerSession: () => boolean;
}

export function inboxDrainReason(
  messages: readonly InboxTurnMessage[],
  options: InboxDrainOptions,
): InboxDrainReason | null {
  let owner = false;
  let heartbeat = false;
  for (const message of messages) {
    const origin = classifyTurnProvenance({ prompt: message.launchPrompt }).origin;
    if (origin === "human") {
      // Fail closed: one message from anyone but the owner keeps the block out of this turn.
      if (!options.isOwnerTurn(message.launchPrompt)) return null;
      owner = true;
    }
    if (origin === "heartbeat") heartbeat = true;
  }
  if (owner) return "human";
  return heartbeat && options.drainOnHeartbeat && options.isOwnerSession() ? "heartbeat" : null;
}

export interface InboxTurnBlock {
  block: string;
  reason: InboxDrainReason;
  itemIds: string[];
  overflow: number;
  /** The prompt was handed to the provider: the items are marked sent, still reserved. */
  commit: () => void;
  /** The turn never started: the items return to pending. */
  release: (reason: string) => void;
  /**
   * The turn ended. Only a turn that completed after its prompt reached the provider delivers the
   * items; any other end (including a turn that ended before `commit`) returns them to pending, so
   * an aborted or failed turn repeats them instead of losing them.
   */
  finish: (outcome: InboxTurnOutcome) => void;
}

export type InboxTurnOutcome = "completed" | "aborted";

export interface PrepareInboxTurnInput {
  sessionName: string;
  messages: readonly InboxTurnMessage[];
  drainOnHeartbeat: boolean;
  isOwnerTurn: InboxDrainOptions["isOwnerTurn"];
  isOwnerSession: InboxDrainOptions["isOwnerSession"];
  now?: number;
  /** Test seam: the block renderer. */
  render?: typeof renderInboxBlock;
}

/**
 * Reserves the pending items for this turn and renders the block, or returns null when the turn
 * does not drain or the inbox is empty. The caller commits when the prompt reaches the provider and
 * releases when the turn never starts.
 */
export function prepareInboxTurnBlock(input: PrepareInboxTurnInput): InboxTurnBlock | null {
  const reason = inboxDrainReason(input.messages, {
    drainOnHeartbeat: input.drainOnHeartbeat,
    isOwnerTurn: input.isOwnerTurn,
    isOwnerSession: input.isOwnerSession,
  });
  if (!reason) return null;
  const reservation = reserveInboxItems({
    targetSessionName: input.sessionName,
    maxItems: INBOX_MAX_ITEMS_PER_TURN,
    maxBytes: INBOX_MAX_BYTES_PER_TURN,
    now: input.now,
  });
  if (reservation.items.length === 0) return null;
  let block: string;
  try {
    block = (input.render ?? renderInboxBlock)({
      items: reservation.items,
      overflow: reservation.overflow,
      targetSessionName: input.sessionName,
    });
  } catch (error) {
    // Nothing reached a turn: the items go back to pending for the next draining turn.
    releaseInboxReservation(reservation.turnKey);
    throw error;
  }
  let sent = false;
  return {
    block,
    reason,
    itemIds: reservation.items.map((item) => item.id),
    overflow: reservation.overflow,
    commit: () => {
      markInboxReservationSent(reservation.turnKey);
      sent = true;
    },
    release: () => {
      releaseInboxReservation(reservation.turnKey);
    },
    finish: (outcome) => {
      // A turn whose preparation failed ends before the send: nothing reached the model.
      if (outcome === "completed" && sent) commitInboxReservation(reservation.turnKey);
      else releaseInboxReservation(reservation.turnKey);
    },
  };
}
