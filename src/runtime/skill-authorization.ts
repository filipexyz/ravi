import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import type { ContextCapability } from "../router/router-db.js";
import { officialSkillImpliedByCapabilities, resolveAgentSkills } from "./allowed-skills.js";
import { isSkillNameAuthorizedOnAllowlist } from "./skill-visibility.js";

export interface SkillAuthorizationOptions {
  /**
   * Effective identity capabilities for this turn (session/agent_identity).
   * When omitted, authorization falls back to the agent's materialized
   * subject capabilities. Visibility still follows these capabilities —
   * a visible skill never grants effect authority by itself.
   */
  capabilities?: readonly ContextCapability[];
}

/**
 * Hard allowlist gate (Invariant G). Agents without configuration stay
 * grandfathered (Invariant F).
 *
 * Official gated system skills stay authorized when the identity can already
 * run the matching command (`admin:system:*`, `execute:group:<group>`, or a
 * semantic `read|mutate:<resource>:<action>`). Grants may hide those skills
 * from the advertised catalog, but they must not block an authorized
 * `ravi permissions` / `ravi pages` call with `RAVI_SKILL_GATE_CONFIG_ERROR`.
 *
 * Kept out of `allowed-skills` and `skill-visibility` so catalog/manager
 * imports cannot cycle through `router-db` during CLI module load.
 */
export function isSkillAuthorizedForAgent(
  agentId: string | undefined,
  skillName: string,
  options: SkillAuthorizationOptions = {},
): boolean {
  if (!agentId?.trim()) return true;
  const resolved = resolveAgentSkills(agentId);
  if (!resolved.hasConfiguration) return true;
  if (isSkillNameAuthorizedOnAllowlist(skillName, resolved.allowlist)) {
    return true;
  }

  if (options.capabilities && officialSkillImpliedByCapabilities(options.capabilities, skillName)) {
    return true;
  }

  const agentCapabilities = materializeSubjectCapabilities("agent", agentId);
  return officialSkillImpliedByCapabilities(agentCapabilities, skillName);
}
