/**
 * Trigger activation state
 *
 * Single source of truth for whether the runner activates a trigger. The
 * runner uses it to decide subscriptions; the CLI uses it to show operators
 * the same verdict without asking the daemon.
 */

import { getAgent } from "../router/config.js";
import { compileFilter, type CompiledFilter } from "./filter.js";
import { getBlockedTriggerTopicReason } from "./topic-policy.js";
import type { Trigger } from "./types.js";

export type TriggerRuntimeState = "active" | "disabled" | "invalid_filter" | "blocked_topic" | "unbound_agent";
export type TriggerFilterStatus = "none" | "valid" | "invalid";

export interface TriggerActivation {
  state: TriggerRuntimeState;
  filterStatus: TriggerFilterStatus;
  filter: CompiledFilter;
  reason?: string;
}

export interface TriggerActivationDeps {
  agentExists?: (agentId: string) => boolean;
}

/**
 * Configuration problems win over `enabled` so operators learn that
 * re-enabling a trigger will not bring it back until the problem is fixed.
 */
export function resolveTriggerActivation(
  trigger: Pick<Trigger, "enabled" | "topic" | "filter" | "agentId">,
  deps: TriggerActivationDeps = {},
): TriggerActivation {
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

  const agentId = trigger.agentId?.trim();
  if (agentId && !agentIsPresent(agentId, deps)) {
    return {
      state: "unbound_agent",
      filterStatus,
      filter,
      reason: `Bound agent "${agentId}" does not exist (unbound_agent). The runtime will not activate this trigger or create a session.`,
    };
  }

  if (!trigger.enabled) {
    return { state: "disabled", filterStatus, filter };
  }
  return { state: "active", filterStatus, filter };
}

function agentIsPresent(agentId: string, deps: TriggerActivationDeps): boolean {
  if (deps.agentExists) return deps.agentExists(agentId);
  return getAgent(agentId) != null;
}
