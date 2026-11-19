/**
 * A trigger change the running trigger runner has not been told about.
 *
 * The runner reloads its triggers on a `ravi.triggers.refresh` event. A change made together with a
 * lifecycle transaction (a closing thread handing its PR follows to its parent) cannot be undone when
 * that event is lost, and the runner keeps delivering to the recipient it loaded. So the intent to
 * refresh is saved with the change, and whoever publishes the event clears it; the follow maintenance
 * sweep publishes it again while it is still set.
 */

import { dbDeleteSetting, dbGetSetting, dbSetSetting } from "../router/router-db.js";

const TRIGGERS_REFRESH_PENDING_SETTING = "triggers.refresh_pending";

/** Saved inside the transaction that changed the triggers. */
export function markTriggersRefreshPending(now = Date.now()): void {
  dbSetSetting(TRIGGERS_REFRESH_PENDING_SETTING, String(now));
}

export function triggersRefreshPending(): boolean {
  return dbGetSetting(TRIGGERS_REFRESH_PENDING_SETTING) !== null;
}

/** Cleared only after the refresh event was published. */
export function clearTriggersRefreshPending(): void {
  dbDeleteSetting(TRIGGERS_REFRESH_PENDING_SETTING);
}
