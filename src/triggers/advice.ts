/**
 * Advice the triggers CLI gives about a trigger: where it wakes and whether anyone
 * still needs it. Pure, so the CLI and its tests share one definition.
 */

import type { Trigger } from "./types.js";

/**
 * A trigger left on the default session, created from a conversation (a session
 * with a chat), wakes that conversation on every fire. Shell triggers wake no one.
 */
export function triggerDefaultsToConversationalSession(input: {
  session?: string;
  thread?: boolean;
  isShellTrigger: boolean;
  currentSession?: string;
  callerChatId?: string;
}): boolean {
  if (input.session !== undefined || input.thread || input.isShellTrigger) return false;
  return Boolean(input.currentSession && input.callerChatId);
}

/** A trigger that has not fired for this long is reported as dormant. */
export const TRIGGER_DORMANT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Enabled, never fired or last fired more than 30 days ago, counting from creation when it never fired. */
export function isTriggerDormant(
  trigger: Pick<Trigger, "enabled" | "lastFiredAt" | "createdAt">,
  now = Date.now(),
): boolean {
  if (!trigger.enabled) return false;
  const since = trigger.lastFiredAt ?? trigger.createdAt;
  return now - since > TRIGGER_DORMANT_AFTER_MS;
}
