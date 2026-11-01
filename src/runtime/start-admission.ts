import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeSessionStartLane } from "./session-pool.js";

export function isRuntimeSessionServing(session: RuntimeHostStreamingSession): boolean {
  return Boolean(
    session.starting ||
      session.turnActive ||
      session.compacting ||
      session.toolRunning ||
      session.toolResultDeliveryPending ||
      session.pendingMessages.length ||
      session.pendingWake,
  );
}

export interface RuntimeStartCapacitySnapshot {
  lane: RuntimeSessionStartLane;
  reason: string;
  active: number;
  reserved: number;
  max: number;
  backgroundLimit: number;
  queuePosition: number | null;
  occupants: Array<{
    sessionName: string;
    agentId: string;
    provider?: string;
    state: string;
    inactiveMs: number;
  }>;
  largestConsumer: { agentId: string; slots: number } | null;
}

/** Rejection before provider handoff: the transport must retain the original delivery. */
export class RuntimeStartCapacityError extends Error {
  readonly code = "RUNTIME_START_CAPACITY";
  constructor(readonly capacity: RuntimeStartCapacitySnapshot) {
    super(`Runtime start refused: ${capacity.reason} (${capacity.active + capacity.reserved}/${capacity.max} slots)`);
    this.name = "RuntimeStartCapacityError";
  }
}
