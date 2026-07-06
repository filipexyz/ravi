import type { RuntimeMessageTarget } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";

/**
 * Best-effort classification of what kind of turn is effectively executing when
 * a compaction status transition happens. Used only to decide whether the
 * external "compacting / compacted" announcements may be emitted. Internal
 * observability (runtime status, `runtime.status` trace, live state, skill
 * visibility reset, logs) is never affected by this classification.
 */
export type CompactionTurnOrigin =
  | "human"
  | "cron"
  | "trigger"
  | "session-followup"
  | "heartbeat"
  | "automation"
  | "background";

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
  prompt?: Pick<RuntimeLaunchPrompt, "_cron" | "_trigger" | "_sessionFollowup" | "_heartbeat">;
  /** Resolved output source for the turn effectively executing. */
  source?: CompactionAnnouncementSource;
}

const AUTOMATION_PROVENANCE_SOURCES = new Set([
  "cron",
  "trigger",
  "session-followup",
  "sessionfollowup",
  "heartbeat",
  "routine",
  "task",
  "background",
  "automation",
  "daemon-restart",
]);

function readProvenanceSource(source: CompactionAnnouncementSource | undefined): string | undefined {
  const provenance = source?.identityProvenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const value = (provenance as Record<string, unknown>).source;
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
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
  const { prompt, source } = input;

  const suppress = (origin: CompactionTurnOrigin, reason: string): CompactionAnnouncementSnapshot => ({
    externalAnnouncementsAllowed: false,
    automationOriginated: true,
    origin,
    reason,
  });

  if (prompt?._cron) return suppress("cron", "prompt._cron");
  if (prompt?._trigger) return suppress("trigger", "prompt._trigger");
  if (prompt?._sessionFollowup) return suppress("session-followup", "prompt._sessionFollowup");
  if (prompt?._heartbeat) return suppress("heartbeat", "prompt._heartbeat");

  if (source?.actorType === "automation" && source.automationId) {
    return suppress("automation", "source.actorType=automation");
  }

  const provenanceSource = readProvenanceSource(source);
  if (provenanceSource && AUTOMATION_PROVENANCE_SOURCES.has(provenanceSource)) {
    return suppress("automation", `identityProvenance.source=${provenanceSource}`);
  }

  if (source?.suppressPresence === true) {
    return suppress("background", "source.suppressPresence");
  }

  return {
    externalAnnouncementsAllowed: true,
    automationOriginated: false,
    origin: "human",
    reason: "no automation signal",
  };
}
