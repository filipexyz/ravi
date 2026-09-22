import { listGroupSkillRules } from "../cli/skill-gates.js";
import type { ContextCapability } from "../router/router-db.js";
import { skillIdentifiersMatch } from "./skill-visibility.js";

/**
 * Capability → official system skill implication.
 *
 * Kept out of `allowed-skills` so authorization can consult identity
 * capabilities without loading the skill-grant table (and `router-db`)
 * during CLI module init. Provider-registry → Pi → this path is imported
 * by command tests that mock a partial `router-db`.
 */

export function isAdminAll(capabilities: readonly ContextCapability[]): boolean {
  return capabilities.some((cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*");
}

export function selectGroupCaps(capabilities: readonly ContextCapability[]): ContextCapability[] {
  return capabilities.filter((cap) => cap.permission === "execute" && cap.objectType === "group");
}

function isSemanticCommandCapability(capability: ContextCapability): boolean {
  return capability.permission === "read" || capability.permission === "mutate";
}

export function capabilityMatchesGroupRule(capability: ContextCapability, pattern: RegExp): boolean {
  if (capability.permission === "execute" && capability.objectType === "group") {
    return capability.objectId !== "*" && pattern.test(capability.objectId);
  }
  return isSemanticCommandCapability(capability) && pattern.test(capability.objectType);
}

/**
 * System skills implied by specific command capabilities (not generic
 * `execute:group:*` or `admin:system:*`). Used when explicit grants would
 * otherwise hide a skill the identity is already authorized to run.
 */
export function specificSkillsFromCapabilities(capabilities: readonly ContextCapability[]): string[] {
  const slugs = new Set<string>();
  for (const rule of listGroupSkillRules()) {
    if (capabilities.some((capability) => capabilityMatchesGroupRule(capability, rule.pattern))) {
      slugs.add(rule.skill);
    }
  }
  return [...slugs];
}

/**
 * Whether an official gated system skill is implied by the identity's
 * capabilities. Custom/personal skills are never implied here — those stay
 * grant-only so skill visibility cannot mint effect authority.
 */
export function officialSkillImpliedByCapabilities(
  capabilities: readonly ContextCapability[],
  skillName: string,
): boolean {
  const rules = listGroupSkillRules().filter((rule) => skillIdentifiersMatch(rule.skill, skillName));
  if (rules.length === 0) {
    return false;
  }
  if (isAdminAll(capabilities) || selectGroupCaps(capabilities).some((cap) => cap.objectId === "*")) {
    return true;
  }
  return rules.some((rule) => capabilities.some((capability) => capabilityMatchesGroupRule(capability, rule.pattern)));
}
