/**
 * Runtime-owned advance of the skill-curation watermark (I16 durability).
 *
 * Mirrors memory's `advanceWatermarkForCompletedCuratorTask`, but for the
 * `curador-skills` profile and the `skillCuration` state key. The watermark
 * moves forward when the skill-curador task COMPLETES (done), independent of
 * whether the curador wrote any skill — a cycle that reads a non-empty delta and
 * judges nothing worth saving still advances, so the delta never re-grows into a
 * slow-collapse. Advance only on `done`, never on `fail` (at-least-once: a failed
 * curador may not have processed the delta; leave the watermark so the next
 * cycle re-reads it, bounded, never dropped).
 */

import { getSession, updateRuntimeProviderState } from "../router/index.js";
import { markSkillMessageProcessed } from "./skill-curation-state.js";

const SKILL_CURATOR_PROFILE_ID = "curador-skills";

/** Persist the skill watermark for `sessionKey` up to `throughMessageId`. Monotonic, idempotent, best-effort. */
export function commitSkillCurationWatermark(sessionKey: string | undefined, throughMessageId: number): boolean {
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
  const nextParams = markSkillMessageProcessed(session, Math.floor(throughMessageId));
  updateRuntimeProviderState(key, session.runtimeProvider, {
    runtimeSessionParams: nextParams,
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(session.runtimeSessionDisplayId ? { runtimeSessionDisplayId: session.runtimeSessionDisplayId } : {}),
  });
  return true;
}

/**
 * Advance the originator session's skill watermark for a curador-skills task
 * that just completed. Reads target session + highest message id from the task's
 * own profileInput (populated by the skill-nudge dispatch); needs nothing from
 * the curator's report. No-op for any non-skill-curator profile.
 */
export function advanceSkillWatermarkForCompletedCuratorTask(task: {
  profileId?: string | null;
  profileInput?: Record<string, string> | undefined;
}): boolean {
  if (task.profileId !== SKILL_CURATOR_PROFILE_ID) {
    return false;
  }
  const input = task.profileInput;
  if (!input) {
    return false;
  }
  // getSession() keys by sessionKey, so use originator_session_key (the real
  // key); originator_session is the display name and would no-op here (M2 fix).
  const sessionKey = input.originator_session_key || input.originator_session;
  const throughMessageId = Number.parseInt(input.highest_message_id ?? "", 10);
  if (!sessionKey || !Number.isFinite(throughMessageId)) {
    return false;
  }
  return commitSkillCurationWatermark(sessionKey, throughMessageId);
}
