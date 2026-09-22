import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import type { ContextCapability } from "../router/router-db.js";
import { officialSkillImpliedByCapabilities } from "./skill-capability-implication.js";
import { isSkillNameAuthorizedOnAllowlist } from "./skill-visibility.js";

function resolveConfiguredAgentSkills(agentId: string) {
  // Lazy: `allowed-skills` reads the grant table from `router-db`. Provider
  // registry → Pi authorization imports this module at CLI load time, and
  // command tests mock a partial `router-db` that does not export grants.
  const { resolveAgentSkills } = require("./allowed-skills.js") as typeof import("./allowed-skills.js");
  return resolveAgentSkills(agentId);
}

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
  const resolved = resolveConfiguredAgentSkills(agentId);
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
