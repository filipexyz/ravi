import { logger } from "../utils/logger.js";
import type { Handoff } from "./store.js";

const log = logger.child("handoffs:events");

export type HandoffEventType = "pending" | "acknowledged" | "stale";

/**
 * `ravi.handoff.<type>`: the contract observers consume as a ready-made
 * condition (they never infer a wait from report text). Best effort: a lost
 * event never changes the stored handoff, which stays the source of truth.
 */
export function handoffEventPayload(type: HandoffEventType, handoff: Handoff, now: number): Record<string, unknown> {
  return {
    type: `handoff.${type}`,
    handoffId: handoff.id,
    threadSession: handoff.childSessionKey,
    parentSession: handoff.parentSessionKey,
    kind: handoff.kind,
    ...(handoff.ref ? { sha: handoff.ref } : {}),
    since: handoff.createdAt,
    ageMin: Math.max(0, Math.floor((now - handoff.createdAt) / 60_000)),
    ...(handoff.ackReason ? { reason: handoff.ackReason } : {}),
  };
}

export async function publishHandoffEvent(type: HandoffEventType, handoff: Handoff, now: number): Promise<void> {
  try {
    const { publish } = await import("../nats.js");
    await publish(`ravi.handoff.${type}`, handoffEventPayload(type, handoff, now), { quietConnect: true });
  } catch (error) {
    log.debug("Handoff event not published", {
      type,
      handoffId: handoff.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
