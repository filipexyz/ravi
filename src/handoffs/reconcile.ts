import { logger } from "../utils/logger.js";
import { type Handoff, claimOwnerEscalation, claimParentNudge, listHandoffs } from "./store.js";
import { publishHandoffEvent } from "./events.js";

const log = logger.child("handoffs");

/** The parent gets one reminder when a handoff has waited this long. */
export const HANDOFF_PARENT_NUDGE_MS = 15 * 60_000;
/** The owner gets one aggregated notice for handoffs that waited this long. */
export const HANDOFF_OWNER_ESCALATION_MS = 45 * 60_000;

export interface HandoffPlan {
  nudge: Handoff[];
  /** Handoffs to escalate to the owner, grouped by parent session. */
  escalate: Map<string, Handoff[]>;
}

/** Pure policy: which open handoffs are owed a parent reminder or an owner notice now. */
export function planHandoffActions(open: readonly Handoff[], now: number): HandoffPlan {
  const nudge: Handoff[] = [];
  const escalate = new Map<string, Handoff[]>();
  for (const handoff of open) {
    if (handoff.status !== "open") continue;
    const age = now - handoff.createdAt;
    if (age >= HANDOFF_PARENT_NUDGE_MS && handoff.parentNudgedAt === null) nudge.push(handoff);
    if (age >= HANDOFF_OWNER_ESCALATION_MS && handoff.ownerEscalatedAt === null) {
      const group = escalate.get(handoff.parentSessionKey) ?? [];
      group.push(handoff);
      escalate.set(handoff.parentSessionKey, group);
    }
  }
  return { nudge, escalate };
}

/**
 * Delivery ports. The core decides who is owed what; a channel adapter delivers.
 * `notifyParent` reminds the parent session (an internal turn); `notifyOwner`
 * tells the human owner directly. Either may be absent: the core then keeps the
 * row open and never claims a delivery it could not make.
 */
export interface HandoffDeliveryPorts {
  /** One call per parent per tick: `due` are the handoffs owed a reminder now, `open` every open one of that parent. */
  notifyParent?: (input: {
    parentSessionKey: string;
    due: readonly Handoff[];
    open: readonly Handoff[];
    now: number;
  }) => Promise<boolean>;
  notifyOwner?: (input: { parentSessionKey: string; handoffs: readonly Handoff[]; now: number }) => Promise<boolean>;
}

let registered: HandoffDeliveryPorts = {};

/** Channel adapters register how they deliver; the latest registration for a port wins. */
export function registerHandoffDeliveryPorts(ports: HandoffDeliveryPorts): void {
  registered = { ...registered, ...ports };
}

export function resetHandoffDeliveryPortsForTest(): void {
  registered = {};
}

export async function reconcileHandoffs(
  options: { now?: number; ports?: HandoffDeliveryPorts } = {},
): Promise<{ nudged: number; escalated: number; failures: number }> {
  const now = options.now ?? Date.now();
  const ports = options.ports ?? registered;
  const open = listHandoffs();
  const plan = planHandoffActions(open, now);
  let nudged = 0;
  let escalated = 0;
  let failures = 0;

  const nudgeByParent = new Map<string, Handoff[]>();
  for (const handoff of plan.nudge) {
    const group = nudgeByParent.get(handoff.parentSessionKey) ?? [];
    group.push(handoff);
    nudgeByParent.set(handoff.parentSessionKey, group);
  }
  for (const [parentSessionKey, due] of nudgeByParent) {
    if (!ports.notifyParent) break;
    const siblings = open.filter((h) => h.parentSessionKey === parentSessionKey);
    try {
      const delivered = await ports.notifyParent({ parentSessionKey, due, open: siblings, now });
      if (!delivered) continue;
      for (const handoff of due) {
        if (!claimParentNudge(handoff.id, now)) continue;
        nudged++;
        await publishHandoffEvent("stale", { ...handoff, parentNudgedAt: now }, now);
      }
    } catch (error) {
      failures++;
      log.warn("Handoff parent reminder failed", { parentSessionKey, error: errorMessage(error) });
    }
  }

  for (const [parentSessionKey, handoffs] of plan.escalate) {
    if (!ports.notifyOwner) break;
    try {
      const delivered = await ports.notifyOwner({ parentSessionKey, handoffs, now });
      if (!delivered) continue;
      const claimed = claimOwnerEscalation(
        handoffs.map((h) => h.id),
        now,
      );
      escalated += claimed.length;
    } catch (error) {
      failures++;
      log.warn("Handoff owner notice failed", { parentSessionKey, error: errorMessage(error) });
    }
  }
  return { nudged, escalated, failures };
}

export function formatHandoffAge(handoff: Handoff, now: number): string {
  const minutes = Math.max(0, Math.floor((now - handoff.createdAt) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

const KIND_LABEL: Record<Handoff["kind"], string> = {
  review: "revisão",
  decision: "decisão",
  merge: "merge",
  dispatch: "despacho",
  instruction: "instrução",
};

export function handoffKindLabel(kind: Handoff["kind"]): string {
  return KIND_LABEL[kind];
}

/** One line per handoff, shared by the parent reminder and the owner notice. */
export function describeHandoff(handoff: Handoff, childName: string, now: number): string {
  const ref = handoff.ref ? ` (${handoff.ref})` : "";
  const note = handoff.note ? `: ${handoff.note}` : "";
  return `- ${childName} espera ${handoffKindLabel(handoff.kind)}${ref} há ${formatHandoffAge(handoff, now)}${note} [${handoff.id}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
