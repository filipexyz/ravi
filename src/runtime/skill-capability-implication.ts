import { basename } from "node:path";
import { listGroupSkillRules } from "../cli/skill-gates.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { ContextCapability } from "../router/router-db.js";
import {
  findSkillByName,
  listCatalogSkills,
  listInstalledSkills,
  slugifySkillName,
  type RaviSkill,
} from "../skills/manager.js";
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
 * Whether an official gated system skill is implied by the identity's command
 * capabilities. Custom/personal skills are never implied by command
 * capabilities: they need a grant or an explicit `use:skill:<id>` capability
 * ({@link skillCoveredBySkillCapability}). Visibility never mints effect
 * authority.
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

/** Object type of `use:skill:<id>` capabilities. */
export const SKILL_CAPABILITY_OBJECT_TYPE = "skill";

function isSkillUseCapability(capability: ContextCapability): boolean {
  return capability.permission === "use" && capability.objectType === SKILL_CAPABILITY_OBJECT_TYPE;
}

/**
 * A skill Ravi itself knows: a catalog skill shipped with Ravi, or a skill an
 * operator installed (`ravi skills install`). Resolution matches `ravi skills
 * grant`. Skills that only exist on disk resolve to null.
 */
export function resolveKnownRaviSkill(skillName: string): RaviSkill | null {
  const name = skillName.trim();
  if (!name) return null;
  return (
    findSkillByName(listCatalogSkills(), name) ?? findSkillByName(listInstalledSkills({ includeCodex: false }), name)
  );
}

/** Capability ids that name `skill`: its name, its directory and plugin-qualified aliases. */
function skillCapabilityIds(skill: RaviSkill): string[] {
  const ids = new Set<string>([slugifySkillName(skill.name), slugifySkillName(basename(skill.path))]);
  if (skill.pluginName) {
    ids.add(slugifySkillName(`${skill.pluginName}-${skill.name}`));
    ids.add(slugifySkillName(`${skill.pluginName}-${basename(skill.path)}`));
  }
  return [...ids];
}

/** `ravi-system:bases` → `ravi-system-bases`; wildcards keep their `*`. */
function normalizeSkillCapabilityId(objectId: string): string {
  const trimmed = objectId.trim().toLowerCase();
  if (!trimmed.includes("*")) return slugifySkillName(trimmed);
  return trimmed.replace(/[^a-z0-9._*]+/g, "-");
}

/**
 * Whether a `use:skill:<id>` capability (or the `admin:system:*` break-glass)
 * covers `skillName`. Uses the same matcher as tool and group capabilities:
 * exact id, trailing glob (`use:skill:ravi-system-*`), `use:skill:*`, and the
 * admin short-circuit.
 *
 * Only skills Ravi knows are covered (catalog or installed). A skill that only
 * exists on disk must be installed before any capability or grant reaches it.
 */
export function skillCoveredBySkillCapability(capabilities: readonly ContextCapability[], skillName: string): boolean {
  const skillCapabilities = capabilities.filter(isSkillUseCapability);
  const adminAll = isAdminAll(capabilities);
  if (!adminAll && skillCapabilities.length === 0) return false;

  const skill = resolveKnownRaviSkill(skillName);
  if (!skill) return false;
  if (adminAll) return true;

  const normalized = skillCapabilities.map((capability) => ({
    ...capability,
    objectId: normalizeSkillCapabilityId(capability.objectId),
  }));
  return skillCapabilityIds(skill).some((id) =>
    canWithCapabilities(normalized, "use", SKILL_CAPABILITY_OBJECT_TYPE, id),
  );
}

/**
 * Canonical names of the skills that concrete `use:skill:<id>` capabilities
 * name. They join the announced catalog like grants do. Wildcards
 * (`use:skill:*`, `use:skill:ravi-system-*`) and admin authorize reads but never
 * widen the catalog.
 */
export function skillNamesFromSkillCapabilities(capabilities: readonly ContextCapability[]): string[] {
  const names = new Set<string>();
  for (const capability of capabilities) {
    if (!isSkillUseCapability(capability) || capability.objectId.includes("*")) continue;
    const skill = resolveKnownRaviSkill(capability.objectId);
    if (skill) names.add(skill.name);
  }
  return [...names];
}
