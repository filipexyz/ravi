import { listGroupSkillRules } from "../cli/skill-gates.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { dbListSkillGrantsForAgent } from "../router/router-db.js";
import type { ContextCapability } from "../router/router-db.js";

/**
 * Per-agent skill visibility — provider-agnostic core.
 *
 * spec: skills/scoping/per-agent-visibility
 *
 * Produces a per-agent allowlist derived from three sources (Invariant R):
 *   1. BASELINE — kit essencial (Invariant B), sempre presente.
 *   2. System skills DERIVED FROM PERMISSION (Invariant D). No manual mapping.
 *   3. Custom grants (`ravi skills grant`).
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
  "ravi-system-agents-manager",
  "ravi-system-sessions",
  "ravi-system-tasks",
  "ravi-system-permissions-manager",
  "ravi-system-skill-creator",
  "ravi-system-specs",
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

/**
 * Resolve a allowlist de skills visíveis para `agentId`, provider-agnostic.
 *
 * @param options.capabilitiesOverride — usado por testes para injetar caps
 * materializadas; produção sempre passa `undefined` e o módulo consulta
 * `materializeSubjectCapabilities` diretamente.
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
    for (const cap of groupCaps) {
      if (rule.pattern.test(cap.objectId)) {
        derivedSlugs.add(rule.skill);
        break;
      }
    }
  }
  const derivedNames = [...derivedSlugs].flatMap(expandSkillNames);

  const grants = dbListSkillGrantsForAgent(trimmed);
  const grantNames = grants.flatMap((grant) => expandSkillNames(grant.skillName));

  const hasConfiguration = adminAll || groupCaps.length > 0 || grants.length > 0;
  const allowlist = [...new Set([...baselineNames, ...derivedNames, ...grantNames])];

  return {
    hasConfiguration,
    allowlist,
    provenance: {
      baseline: baselineNames,
      fromCapabilities: derivedNames,
      fromGrants: grantNames,
    },
  };
}
