/**
 * R27 / P1 — runtime-owned advance of the incremental-read watermark.
 *
 * The watermark (`lastCuratedMessageId`) must move forward whenever a curation
 * cycle has genuinely READ a delta, NOT only when the curator managed to write
 * something. Advancing exclusively on `outcome: "written"` (the old
 * LLM-reported `--processed-through-message-id` path) means a cycle that reads
 * a non-empty delta and judges nothing worth saving (`proposto=0`) never
 * advances — so the delta re-grows every session until something is finally
 * saved. That slow re-read growth is the slow-collapse failure mode.
 *
 * Fix: the runtime advances the watermark to the highest `messages.id` it
 * materialized for the cycle when the curator task COMPLETES (done), driven by
 * `completeTask`, independent of what the curator wrote. The guard's
 * LLM-reported flag stays as a no-op-safe fallback (`Math.max` keeps the
 * watermark monotonic, so a double-advance is harmless).
 *
 * At-least-once safety: we deliberately advance only on `done`, never on
 * `fail`. A failed curator may never have processed the delta; leaving the
 * watermark put means the next cycle re-reads it (bounded, never dropped).
 */

import { getSession, updateRuntimeProviderState } from "../router/index.js";
import { markCurationMessageProcessed } from "./curation-state.js";

const CURATOR_PROFILE_ID = "curador-memoria";

/**
 * Persist the watermark for `sessionKey` up to `throughMessageId`. Monotonic
 * (never regresses — `markCurationMessageProcessed` uses `Math.max`) and
 * idempotent. Returns true when a session was found and updated, false when the
 * inputs are unusable or the session no longer exists (best-effort; callers
 * must never let a miss break their primary flow).
 */
export function commitCurationWatermark(
  sessionKey: string | undefined,
  cadenceTurns: number,
  throughMessageId: number,
): boolean {
  const key = sessionKey?.trim();
  if (!key) {
    return false;
  }
  if (!Number.isFinite(throughMessageId) || throughMessageId < 0) {
    return false;
  }
  const session = getSession(key);
  if (!session) {
    return false;
  }
  const nextParams = markCurationMessageProcessed(
    session,
    cadenceTurns > 0 ? cadenceTurns : 1,
    Math.floor(throughMessageId),
  );
  updateRuntimeProviderState(key, session.runtimeProvider, {
    runtimeSessionParams: nextParams,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(session.runtimeSessionDisplayId ? { runtimeSessionDisplayId: session.runtimeSessionDisplayId } : {}),
  });
  return true;
}

/**
 * Advance the originator session's watermark for a curador-memoria task that
 * has just completed successfully. Reads the target watermark + session from
 * the task's own profileInput (populated by the memory-curator hook dispatch),
 * so it needs nothing from the curator's LLM report. No-op for any non-curator
 * profile or when the required inputs are absent.
 */
export function advanceWatermarkForCompletedCuratorTask(task: {
  profileId?: string | null;
  profileInput?: Record<string, string> | undefined;
}): boolean {
  if (task.profileId !== CURATOR_PROFILE_ID) {
    return false;
  }
  const input = task.profileInput;
  if (!input) {
    return false;
  }
  const sessionKey = input.originator_session_key || input.originator_session;
  const throughMessageId = Number.parseInt(input.highest_message_id ?? "", 10);
  const cadence = Number.parseInt(input.cadence_turn ?? "", 10);
  if (!sessionKey || !Number.isFinite(throughMessageId)) {
    return false;
  }
  return commitCurationWatermark(sessionKey, Number.isFinite(cadence) ? cadence : 1, throughMessageId);
}
