import { logger } from "../utils/logger.js";
import {
  type Handoff,
  acknowledgeHandoff,
  claimOwnerEscalation,
  claimParentNudge,
  listHandoffs,
  releaseOwnerEscalation,
} from "./store.js";
import { publishHandoffEvent } from "./events.js";

const log = logger.child("handoffs");

/** The parent gets one reminder when a handoff has waited this long. */
export const HANDOFF_PARENT_NUDGE_MS = 15 * 60_000;
/** The owner gets one aggregated notice for handoffs that waited this long. */
export const HANDOFF_OWNER_ESCALATION_MS = 45 * 60_000;
/** A reminder lists the waits that are due plus the ones opened in this window, not every old one. */
export const HANDOFF_REMINDER_WINDOW_MS = 24 * 60 * 60_000;
/** An open handoff nobody acted on for this long is closed as expired: an abandoned thread is not a live wait. */
export const HANDOFF_EXPIRY_MS = 7 * 24 * 60 * 60_000;
/** A delivery that takes longer is a failure: a hung port must not hold every later tick. */
export const HANDOFF_PORT_TIMEOUT_MS = 60_000;

/** A delivery that did not answer in time: it may still land, so it is treated as possibly delivered. */
class HandoffPortTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new HandoffPortTimeout(`${label} timed out after ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface HandoffPlan {
  expire: Handoff[];
  nudge: Handoff[];
  /** Handoffs to escalate to the owner, grouped by parent session. */
  escalate: Map<string, Handoff[]>;
}

/** Pure policy: which open handoffs are owed a parent reminder or an owner notice now. */
export function planHandoffActions(open: readonly Handoff[], now: number): HandoffPlan {
  const expire: Handoff[] = [];
  const nudge: Handoff[] = [];
  const escalate = new Map<string, Handoff[]>();
  for (const handoff of open) {
    if (handoff.status !== "open") continue;
    const age = now - handoff.createdAt;
    if (age >= HANDOFF_EXPIRY_MS) {
      expire.push(handoff);
      continue;
    }
    if (age >= HANDOFF_PARENT_NUDGE_MS && handoff.parentNudgedAt === null) nudge.push(handoff);
    if (age >= HANDOFF_OWNER_ESCALATION_MS && handoff.ownerEscalatedAt === null) {
      const group = escalate.get(handoff.parentSessionKey) ?? [];
      group.push(handoff);
      escalate.set(handoff.parentSessionKey, group);
    }
  }
  return { expire, nudge, escalate };
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

/** The waits a reminder to this parent lists: the due ones and the ones opened in the reminder window. */
export function handoffsForReminder(
  open: readonly Handoff[],
  parentSessionKey: string,
  due: readonly Handoff[],
  now: number,
): Handoff[] {
  const dueIds = new Set(due.map((h) => h.id));
  return open.filter(
    (h) =>
      h.parentSessionKey === parentSessionKey && (dueIds.has(h.id) || now - h.createdAt < HANDOFF_REMINDER_WINDOW_MS),
  );
}

let ticking = false;

type ReconcileResult = {
  nudged: number;
  escalated: number;
  expired: number;
  failures: number;
  skipped?: true;
};

export async function reconcileHandoffs(
  options: { now?: number; ports?: HandoffDeliveryPorts; portTimeoutMs?: number } = {},
): Promise<ReconcileResult> {
  // Ticks overlap when a delivery outlasts the interval: the late one would deliver the same notice again.
  if (ticking) return { nudged: 0, escalated: 0, expired: 0, failures: 0, skipped: true };
  ticking = true;
  try {
    return await reconcileOnce(options);
  } finally {
    ticking = false;
  }
}

async function reconcileOnce(options: {
  now?: number;
  ports?: HandoffDeliveryPorts;
  portTimeoutMs?: number;
}): Promise<ReconcileResult> {
  const now = options.now ?? Date.now();
  const ports = options.ports ?? registered;
  const timeoutMs = options.portTimeoutMs ?? HANDOFF_PORT_TIMEOUT_MS;
  let nudged = 0;
  let escalated = 0;
  let expired = 0;
  let failures = 0;

  const all = listHandoffs();
  const plan = planHandoffActions(all, now);

  for (const handoff of plan.expire) {
    const acked = acknowledgeHandoff(handoff.id, "expired: no action for 7 days", now);
    if (!acked) continue;
    expired++;
    await publishHandoffEvent("acknowledged", acked, now);
  }
  const expiredIds = new Set(plan.expire.map((h) => h.id));
  const open = all.filter((h) => !expiredIds.has(h.id));

  const nudgedNow = new Set<string>();
  const nudgeByParent = new Map<string, Handoff[]>();
  for (const handoff of plan.nudge) {
    const group = nudgeByParent.get(handoff.parentSessionKey) ?? [];
    group.push(handoff);
    nudgeByParent.set(handoff.parentSessionKey, group);
  }
  for (const [parentSessionKey, due] of nudgeByParent) {
    if (!ports.notifyParent) break;
    const siblings = handoffsForReminder(open, parentSessionKey, due, now);
    try {
      let delivered: boolean;
      try {
        delivered = await withTimeout(
          ports.notifyParent({ parentSessionKey, due, open: siblings, now }),
          "Parent reminder",
          timeoutMs,
        );
      } catch (error) {
        // At most once: a reminder that timed out may still be delivered, so it is claimed, never resent.
        if (!(error instanceof HandoffPortTimeout)) throw error;
        failures++;
        log.warn("Handoff parent reminder timed out; not resent", { parentSessionKey, error: errorMessage(error) });
        delivered = true;
      }
      if (!delivered) continue;
      for (const handoff of due) {
        if (!claimParentNudge(handoff.id, now)) continue;
        nudged++;
        nudgedNow.add(handoff.id);
        await publishHandoffEvent("stale", { ...handoff, parentNudgedAt: now }, now);
      }
    } catch (error) {
      failures++;
      log.warn("Handoff parent reminder failed", { parentSessionKey, error: errorMessage(error) });
    }
  }

  for (const [parentSessionKey, due] of plan.escalate) {
    if (!ports.notifyOwner) break;
    // Claim before delivering: a delivery that is slow, or a crash right after it, must not send the notice
    // twice. A delivery that did not happen releases the claim, so the next tick tries again.
    const claimed = new Set(
      claimOwnerEscalation(
        due.map((h) => h.id),
        now,
      ),
    );
    const handoffs = due.filter((h) => claimed.has(h.id)).map((h) => ({ ...h, ownerEscalatedAt: now }));
    if (handoffs.length === 0) continue;
    // The parent may have been reminded in this same tick: the notice states what actually happened.
    const reminded = handoffs.map((h) =>
      h.parentNudgedAt === null && nudgedNow.has(h.id) ? { ...h, parentNudgedAt: now } : h,
    );
    let delivered = false;
    let maybeDelivered = false;
    try {
      delivered = await withTimeout(
        ports.notifyOwner({ parentSessionKey, handoffs: reminded, now }),
        "Owner notice",
        timeoutMs,
      );
    } catch (error) {
      failures++;
      // At most once: the timeout does not cancel the delivery, so a timed-out notice keeps its claim and is
      // never sent again. Only a delivery that answered "not delivered" or failed releases it for the next tick.
      maybeDelivered = error instanceof HandoffPortTimeout;
      log.warn(maybeDelivered ? "Handoff owner notice timed out; not resent" : "Handoff owner notice failed", {
        parentSessionKey,
        error: errorMessage(error),
      });
    }
    if (delivered) escalated += handoffs.length;
    else if (!maybeDelivered) releaseOwnerEscalation([...claimed], now);
  }
  return { nudged, escalated, expired, failures };
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
