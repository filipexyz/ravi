/**
 * prox.city Calls — Rules Evaluation
 *
 * Evaluates call_rules before dialing: quiet hours, max attempts,
 * cooldown, snooze, and cancel_on_inbound_reply (persisted policy).
 */

import type { CallRules, RulesEvaluationResult } from "./types.js";
import { countCallRunsForRequest, getLastCallRunEndedAt } from "./calls-db.js";

/**
 * Check if the current time falls within quiet hours.
 */
function isInQuietHours(rules: CallRules, now: Date): boolean {
  const qh = rules.quiet_hours_json;
  if (!qh) return false;

  const tz = qh.timezone || "UTC";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const currentMinutes = hour * 60 + minute;

  const [startH, startM] = qh.start.split(":").map(Number);
  const [endH, endM] = qh.end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wraps midnight (e.g. 22:00–08:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Check if a request has exhausted max attempts.
 */
function isMaxAttemptsReached(rules: CallRules, requestId: string): boolean {
  if (rules.max_attempts <= 0) return false;
  const count = countCallRunsForRequest(requestId);
  return count >= rules.max_attempts;
}

/**
 * Check if the cooldown period has not elapsed since the last run for this person.
 */
function isCooldownActive(rules: CallRules, personId: string, nowMs: number): boolean {
  if (rules.cooldown_seconds <= 0) return false;
  const lastEnded = getLastCallRunEndedAt(personId);
  if (lastEnded === null) return false;
  const cooldownMs = rules.cooldown_seconds * 1000;
  return nowMs - lastEnded < cooldownMs;
}

/**
 * Check if the request is snoozed.
 */
function isSnoozed(rules: CallRules, nowMs: number): boolean {
  if (!rules.snooze_until) return false;
  return nowMs < rules.snooze_until;
}

/**
 * Evaluate all rules for a call request. Returns the first blocking verdict
 * or "allow" if none apply.
 */
export function evaluateCallRules(
  rules: CallRules,
  requestId: string,
  personId: string,
  options?: { now?: Date },
): RulesEvaluationResult {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();

  if (isSnoozed(rules, nowMs)) {
    return {
      verdict: "block_snoozed",
      rule: rules,
      reason: `Snoozed until ${new Date(rules.snooze_until!).toISOString()}`,
      evaluated_at: nowMs,
    };
  }

  if (isInQuietHours(rules, now)) {
    const qh = rules.quiet_hours_json!;
    return {
      verdict: "block_quiet_hours",
      rule: rules,
      reason: `Quiet hours active (${qh.start}–${qh.end} ${qh.timezone})`,
      evaluated_at: nowMs,
    };
  }

  if (isMaxAttemptsReached(rules, requestId)) {
    return {
      verdict: "block_max_attempts",
      rule: rules,
      reason: `Max attempts reached (${rules.max_attempts})`,
      evaluated_at: nowMs,
    };
  }

  if (isCooldownActive(rules, personId, nowMs)) {
    return {
      verdict: "block_cooldown",
      rule: rules,
      reason: `Cooldown active (${rules.cooldown_seconds}s)`,
      evaluated_at: nowMs,
    };
  }

  return {
    verdict: "allow",
    rule: rules,
    reason: "All rules passed",
    evaluated_at: nowMs,
  };
}
