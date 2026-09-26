/**
 * Trigger activation state
 *
 * Single source of truth for whether the runner activates a trigger. The
 * runner uses it to decide subscriptions; the CLI uses it to show operators
 * the same verdict without asking the daemon.
 */

import { compileFilter, type CompiledFilter } from "./filter.js";
import { getBlockedTriggerTopicReason } from "./topic-policy.js";
import type { Trigger } from "./types.js";

export type TriggerRuntimeState = "active" | "disabled" | "invalid_filter" | "blocked_topic";
export type TriggerFilterStatus = "none" | "valid" | "invalid";

export interface TriggerActivation {
  state: TriggerRuntimeState;
  filterStatus: TriggerFilterStatus;
  filter: CompiledFilter;
  reason?: string;
}

/**
 * Configuration problems win over `enabled` so operators learn that
 * re-enabling a trigger will not bring it back until the problem is fixed.
 */
export function resolveTriggerActivation(trigger: Pick<Trigger, "enabled" | "topic" | "filter">): TriggerActivation {
  const filter = compileFilter(trigger.filter);
  if (!filter.valid) {
    return {
      state: "invalid_filter",
      filterStatus: "invalid",
      filter,
      reason: `Invalid filter (${filter.error ?? "unknown error"}); the runtime will not activate this trigger until the filter is fixed or cleared.`,
    };
  }

  const filterStatus: TriggerFilterStatus = filter.expression ? "valid" : "none";
  const blockedReason = getBlockedTriggerTopicReason(trigger.topic);
  if (blockedReason) {
    return { state: "blocked_topic", filterStatus, filter, reason: blockedReason };
  }
  if (!trigger.enabled) {
    return { state: "disabled", filterStatus, filter };
  }
  return { state: "active", filterStatus, filter };
}
