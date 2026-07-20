import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { classifyTurnProvenance, type TurnOrigin, type TurnProvenance } from "./turn-provenance.js";

/**
 * Best-effort classification of what kind of turn is effectively executing when
 * a compaction status transition happens. Used only to decide whether the
 * external "compacting / compacted" announcements may be emitted. Internal
 * observability (runtime status, `runtime.status` trace, live state, skill
 * visibility reset, logs) is never affected by this classification.
 */
export type CompactionTurnOrigin = TurnOrigin;

export interface CompactionAnnouncementSnapshot {
  /** Whether external compaction announcements may be emitted for the effective turn. */
  externalAnnouncementsAllowed: boolean;
  /** Whether the effective turn originated from automation/background work. */
  automationOriginated: boolean;
  /** Best-effort origin label for observability/tracing. */
  origin: CompactionTurnOrigin;
  /** Short, machine-readable reason for the decision. */
  reason: string;
}

type CompactionAnnouncementSource = Pick<
  RuntimeMessageTarget,
  "actorType" | "automationId" | "identityProvenance" | "suppressPresence"
>;

export interface CompactionAnnouncementClassificationInput {
  /** Launch prompt of the turn effectively executing (not pending/after_response messages). */
  prompt?: Partial<RuntimeLaunchPrompt>;
  /** Resolved output source for the turn effectively executing. */
  source?: CompactionAnnouncementSource;
}

export function compactionAnnouncementForTurn(provenance: TurnProvenance): CompactionAnnouncementSnapshot {
  return {
    externalAnnouncementsAllowed: !provenance.background,
    automationOriginated: provenance.automationOriginated,
    origin: provenance.origin,
    reason: provenance.reason,
  };
}

/**
 * Decide whether external compaction announcements may be externalized for the
 * turn that is effectively executing.
 *
 * The decision reuses existing turn metadata rather than adding a new signal:
 * automation prompt markers (`_cron`, `_trigger`, `_sessionFollowup`,
 * `_heartbeat`), automation actor metadata (`actorType=automation` with an
 * `automationId`), automation `identityProvenance.source`, and the background
 * routing hint `suppressPresence`. `suppressPresence` is intentionally only one
 * of several signals because triggers and session followups may not set it.
 */
export function classifyCompactionAnnouncement(
  input: CompactionAnnouncementClassificationInput,
): CompactionAnnouncementSnapshot {
  return compactionAnnouncementForTurn(classifyTurnProvenance(input));
}
