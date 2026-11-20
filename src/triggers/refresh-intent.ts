/**
 * A trigger change the running trigger runner has not been told about.
 *
 * The runner reloads its triggers on a `ravi.triggers.refresh` event. A change made together with a
 * lifecycle transaction (a closing thread handing its PR follows to its parent) cannot be undone when
 * that event is lost, and the runner keeps delivering to the recipient it loaded. So the intent to
 * refresh is saved with the change, and whoever publishes the event clears it; the follow maintenance
 * sweep publishes it again while it is still set.
 *
 * Every intent carries its own token, and a publisher clears only the token it read before it
 * published. A close that saved a new intent while that publish was in flight keeps its own: clearing
 * the setting whatever it holds would erase it, and nobody would publish it again if its own publish
 * failed.
 */

import { randomUUID } from "node:crypto";
import { dbDeleteSettingIfValue, dbGetSetting, dbSetSetting } from "../router/router-db.js";

const TRIGGERS_REFRESH_PENDING_SETTING = "triggers.refresh_pending";

/** Saved inside the transaction that changed the triggers. Returns the token of this intent. */
export function markTriggersRefreshPending(now = Date.now()): string {
  const token = `${now}:${randomUUID()}`;
  dbSetSetting(TRIGGERS_REFRESH_PENDING_SETTING, token);
  return token;
}

/** The token of the intent that is set now, read before publishing it; `null` when nothing is pending. */
export function readTriggersRefreshPending(): string | null {
  return dbGetSetting(TRIGGERS_REFRESH_PENDING_SETTING);
}

export function triggersRefreshPending(): boolean {
  return readTriggersRefreshPending() !== null;
}

/**
 * Cleared only after the refresh event was published, and only when the stored intent is still the
 * one that publish covered. Returns whether it was cleared.
 */
export function clearTriggersRefreshPending(covered: string): boolean {
  return dbDeleteSettingIfValue(TRIGGERS_REFRESH_PENDING_SETTING, covered);
}
