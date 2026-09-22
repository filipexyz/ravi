import { listGroupSkillRules } from "../cli/skill-gates.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { dbListSkillGrantsForAgent, type ContextCapability } from "../router/router-db.js";
import { skillIdentifiersMatch } from "./skill-visibility.js";

/**
 * Per-agent skill visibility — provider-agnostic core.
 *
 * spec: skills/scoping/per-agent-visibility
 *
 * Produces a per-agent allowlist from the operational baseline plus:
 *   1. explicit grants (`ravi skills grant`);
 *   2. system skills derived from command capabilities.
 *
 * Grants stay authoritative against a generic `execute:group:*` dump.
 * `admin:system:*` and specific `read|mutate:<resource>:<action>` /
 * `execute:group:<group>` capabilities still surface their system skills.
 *
 * The enforcement layer (claude-provider / codex adapter) is responsible for
 * applying the allowlist to its runtime (Invariant N). Nothing in this module
 * branches on provider.
 */

/**
 * Kit essencial que todo agente recebe automaticamente (Invariant B).
 * Nomes usam o slug flat da tabela DEFAULT_RAVI_GROUP_SKILL_RULES; a
 * conversão para nome aceito por cada provider é feita em `expandSkillNames`.
 */
export const BASELINE_SYSTEM_SKILL_SLUGS: readonly string[] = [
  "ravi-system-sessions",
  "ravi-system-tasks",
  "ravi-system-specs",
  "ravi-system-skill-creator",
];

export interface ResolvedAgentSkills {
  /**
   * True quando resolveAgentSkills conseguiu materializar alguma configuração
   * (capabilities de grupo, admin superadmin, ou grant explícito). Quando
   * `false`, o adapter DEVE cair no comportamento sem filtro (Invariant F —
   * grandfather / no-break).
   */
  hasConfiguration: boolean;
  /** Nomes canônicos de skill visíveis (baseline ∪ derivadas ∪ grants). */
  allowlist: string[];
  provenance: {
    baseline: string[];
    fromCapabilities: string[];
    fromGrants: string[];
  };
}

const PLUGIN_PREFIXES: readonly string[] = ["ravi-system-", "ravi-dev-", "ravi-user-skills-"];

/**
 * Codex materializa skills com slug plano `ravi-system-cron-manager`; Claude
 * SDK reconhece `Options.skills` por SKILL.md name / directory name / forma
 * `plugin:name`. Emitimos as duas variantes por segurança do matcher e para
 * manter a lista provider-agnostic.
 */
function expandSkillNames(slug: string): string[] {
  const variants = new Set<string>([slug]);
  for (const prefix of PLUGIN_PREFIXES) {
    if (slug.startsWith(prefix)) {
      const bare = slug.slice(prefix.length);
      const plugin = prefix.slice(0, -1);
      variants.add(bare);
      variants.add(`${plugin}:${bare}`);
      break;
    }
  }
  return [...variants];
}

function isAdminAll(capabilities: ContextCapability[]): boolean {
  return capabilities.some((cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*");
}

function selectGroupCaps(capabilities: ContextCapability[]): ContextCapability[] {
  return capabilities.filter((cap) => cap.permission === "execute" && cap.objectType === "group");
}

function isSemanticCommandCapability(capability: ContextCapability): boolean {
  return capability.permission === "read" || capability.permission === "mutate";
}

function capabilityMatchesGroupRule(capability: ContextCapability, pattern: RegExp): boolean {
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
export function specificSkillsFromCapabilities(capabilities: ContextCapability[]): string[] {
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
  capabilities: ContextCapability[],
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

/**
 * Resolve a allowlist de skills visíveis para `agentId`, provider-agnostic.
 *
 * @param options.capabilitiesOverride — effective identity snapshot when the
 * caller already materialized one (turn context). Tests also use it to inject
 * caps. When omitted, the module reads `materializeSubjectCapabilities`.
 */
export function resolveAgentSkills(
  agentId: string,
  options: { capabilitiesOverride?: ContextCapability[] } = {},
): ResolvedAgentSkills {
  const trimmed = agentId?.trim();
  if (!trimmed) {
    return {
      hasConfiguration: false,
      allowlist: [],
      provenance: { baseline: [], fromCapabilities: [], fromGrants: [] },
    };
  }

  const baselineNames = BASELINE_SYSTEM_SKILL_SLUGS.flatMap(expandSkillNames);

  const capabilities = options.capabilitiesOverride ?? materializeSubjectCapabilities("agent", trimmed);
  const groupCaps = selectGroupCaps(capabilities);
  const wildcardGroup = groupCaps.some((cap) => cap.objectId === "*");
  const adminAll = isAdminAll(capabilities);

  const derivedSlugs = new Set<string>();
  for (const rule of listGroupSkillRules()) {
    if (adminAll || wildcardGroup) {
      derivedSlugs.add(rule.skill);
      continue;
    }
    if (capabilities.some((capability) => capabilityMatchesGroupRule(capability, rule.pattern))) {
      derivedSlugs.add(rule.skill);
    }
  }
  const derivedNames = [...derivedSlugs].flatMap(expandSkillNames);

  const grants = dbListSkillGrantsForAgent(trimmed);
  const grantNames = grants.flatMap((grant) => expandSkillNames(grant.skillName));
  // Grants remain authoritative against a generic `execute:group:*` dump.
  // Admin break-glass and specific command capabilities still surface their
  // system skills: visibility follows authority, never the other way around.
  const effectiveDerivedNames =
    grants.length > 0
      ? adminAll
        ? derivedNames
        : specificSkillsFromCapabilities(capabilities).flatMap(expandSkillNames)
      : derivedNames;

  const hasSpecificCommandCaps = specificSkillsFromCapabilities(capabilities).length > 0;
  const hasConfiguration = adminAll || groupCaps.length > 0 || grants.length > 0 || hasSpecificCommandCaps;
  const allowlist = [...new Set([...baselineNames, ...effectiveDerivedNames, ...grantNames])];

  return {
    hasConfiguration,
    allowlist,
    provenance: {
      baseline: baselineNames,
      fromCapabilities: effectiveDerivedNames,
      fromGrants: grantNames,
    },
  };
}
