import { getSession } from "../router/index.js";
import { logger } from "../utils/logger.js";
import { publishHandoffEvent } from "./events.js";
import { describeHandoff, registerHandoffDeliveryPorts } from "./reconcile.js";
import {
  type Handoff,
  type HandoffKind,
  acknowledgeHandoff,
  acknowledgeHandoffsForChild,
  listHandoffs,
  newHandoffId,
  openHandoff,
} from "./store.js";

export { newHandoffId };

const log = logger.child("handoffs");

export function sessionDisplayName(sessionKey: string): string {
  const session = getSession(sessionKey);
  return session?.name ?? sessionKey;
}

/** A child declares it waits for its parent. Supersedes the child's previous open handoff. */
export async function declareHandoff(input: {
  id?: string;
  childSessionKey: string;
  parentSessionKey: string;
  kind: HandoffKind;
  ref?: string | null;
  note?: string | null;
  callerContextId?: string | null;
  closedReason?: string | null;
  now?: number;
}): Promise<Handoff> {
  const now = input.now ?? Date.now();
  const { handoff, superseded } = openHandoff({ ...input, now });
  for (const old of superseded) await publishHandoffEvent("acknowledged", { ...old, ackReason: "superseded" }, now);
  // A wait recorded already closed never was pending: one event, not a pending that vanishes.
  await publishHandoffEvent(handoff.status === "open" ? "pending" : "acknowledged", handoff, now);
  return handoff;
}

/**
 * The parent acted on a child (sent it instructions, closed it, or acknowledged
 * explicitly). Only an explicit reference to the child or the handoff closes it:
 * unrelated activity of the parent never does.
 */
export async function acknowledgeChildHandoffs(
  childSessionKey: string,
  reason: string,
  now = Date.now(),
  kinds?: readonly HandoffKind[],
) {
  const acked = acknowledgeHandoffsForChild(childSessionKey, reason, now, kinds);
  for (const handoff of acked) await publishHandoffEvent("acknowledged", handoff, now);
  return acked;
}

export async function acknowledgeHandoffById(id: string, reason: string, now = Date.now()) {
  const acked = acknowledgeHandoff(id, reason, now);
  if (acked) await publishHandoffEvent("acknowledged", acked, now);
  return acked;
}

/**
 * What a message from the parent to the thread answers. A review, a merge or a dispatch is an action the
 * parent takes elsewhere: a message to the thread ("hold on", "publish PR 2") does not do it, so those stay
 * open until the thread closes or the parent runs `handoff-ack`.
 */
export const HANDOFF_KINDS_ANSWERED_BY_MESSAGE: readonly HandoffKind[] = ["instruction", "decision"];

export function listOpenHandoffs(parentSessionKey?: string): Handoff[] {
  return listHandoffs({ parentSessionKey });
}

/** Owner notice text: one aggregated message per parent, never per handoff. */
export function ownerHandoffNoticeText(parentSessionKey: string, handoffs: readonly Handoff[], now: number): string {
  const parentName = sessionDisplayName(parentSessionKey);
  const lines = handoffs.map((h) => describeHandoff(h, sessionDisplayName(h.childSessionKey), now));
  const count = handoffs.length;
  return [
    `${count === 1 ? "1 thread espera" : `${count} threads esperam`} a sessão ${parentName} há mais de 45 min:`,
    ...lines,
    handoffs.every((h) => h.parentNudgedAt !== null)
      ? `A sessão ${parentName} já foi lembrada. Ver: ravi sessions handoffs`
      : `O lembrete à sessão ${parentName} não saiu. Ver: ravi sessions handoffs`,
  ].join("\n");
}

/**
 * Default owner port: a direct message to the operator through the gateway,
 * with no model in the path (the same route cron failures use). Channel-free:
 * the owner's direct chat is resolved from contacts and identities.
 */
let warnedNoOwnerTarget = false;

export function registerDefaultHandoffOwnerPort(): void {
  registerHandoffDeliveryPorts({
    notifyOwner: async ({ parentSessionKey, handoffs, now }) => {
      const { resolveOwnerDirectTarget } = await import("../knowledge/owner.js");
      const target = resolveOwnerDirectTarget();
      if (!target) {
        if (!warnedNoOwnerTarget) {
          warnedNoOwnerTarget = true;
          log.warn("Handoff owner notice has no owner direct chat; the handoff stays owed", { parentSessionKey });
        }
        return false;
      }
      const { deliverToChat } = await import("../cloud-agents/chat-target.js");
      await deliverToChat(target, { text: ownerHandoffNoticeText(parentSessionKey, handoffs, now) });
      return true;
    },
  });
}
