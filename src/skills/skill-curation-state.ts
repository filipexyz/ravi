/**
 * Durable skill-curation watermark — the skill loop's half of I16.
 *
 * I16 (learning-loop/skill-curation): the ephemeral cadence counter (in-process,
 * resets on restart, only TRIGGERS cadence) and the durable WATERMARK (which
 * messages were already skill-curated, bounds the delta the curador reads) are
 * SEPARATE concerns and must not be conflated. This module owns the skill
 * watermark ONLY — it is intentionally distinct from the memory watermark
 * (`memoryCuration` key) so the two curators advance independently and never
 * clobber each other, even though both live in the same `runtime_session_json`
 * JSON column (no schema change — a new key in an existing JSON document).
 *
 * The counter lives elsewhere (skill-curation-runtime's in-process Map). Here we
 * only READ the watermark to bound the delta and ADVANCE it when the
 * curador-skills task completes (skill-watermark-commit).
 */

import type { SessionEntry } from "../router/index.js";

export interface SkillCurationSessionState {
  /** messages.id already covered by the last skill-curation cycle for this session. */
  lastCuratedMessageId: number;
}

const STATE_KEY = "skillCuration";
const MAX_SANE = 10_000_000;

/** Read the skill watermark from a session's params. Absent → zero (cold-start). */
export function readSkillCurationState(session: Pick<SessionEntry, "runtimeSessionParams">): SkillCurationSessionState {
  const container = (session.runtimeSessionParams ?? {}) as Record<string, unknown>;
  const raw = container[STATE_KEY] as { lastCuratedMessageId?: unknown } | undefined;
  return { lastCuratedMessageId: toNonNegInt(raw?.lastCuratedMessageId, 0) };
}

/**
 * Compose the next params with an advanced skill watermark. Preserves every
 * other key (memoryCuration, skillVisibility, sessionId, …) so a skill-watermark
 * write never drops the memory watermark or provider-authoritative state.
 */
export function markSkillMessageProcessed(
  session: Pick<SessionEntry, "runtimeSessionParams">,
  processedThroughMessageId: number,
): Record<string, unknown> {
  const base = { ...(session.runtimeSessionParams ?? {}) } as Record<string, unknown>;
  const current = readSkillCurationState(session);
  base[STATE_KEY] = {
    lastCuratedMessageId: Math.max(current.lastCuratedMessageId, Math.floor(processedThroughMessageId)),
  };
  return base;
}

/**
 * Carry the durable `skillCuration` watermark forward when the RUNTIME rewrites
 * runtimeSessionParams on its per-turn persist (full-column replace of
 * provider-authoritative params). Mirror of preserveMemoryCurationState: without
 * this the main session's turn.complete write clobbers the watermark the skill
 * curador committed out-of-band, so it resets to 0 and the next cycle re-reads
 * the whole history (M2). Provider params never carry `skillCuration`, so this
 * only ever preserves the curador's state — it never overwrites provider data.
 */
export function preserveSkillCurationState(
  existingParams: Record<string, unknown> | undefined | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const curation = existingParams?.[STATE_KEY];
  if (curation === undefined || curation === null) {
    return incoming;
  }
  return { ...(incoming ?? {}), [STATE_KEY]: curation };
}

function toNonNegInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const floored = Math.floor(value);
    return floored > MAX_SANE ? fallback : floored;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed > MAX_SANE ? fallback : parsed;
    }
  }
  return fallback;
}
