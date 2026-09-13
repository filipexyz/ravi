import { resolveAgentSkills } from "./allowed-skills.js";
import { isSkillNameAuthorizedOnAllowlist } from "./skill-visibility.js";

/**
 * Hard allowlist gate (Invariant G). Agents without configuration stay
 * grandfathered (Invariant F).
 *
 * Kept out of `allowed-skills` and `skill-visibility` so catalog/manager
 * imports cannot cycle through `router-db` during CLI module load.
 */
export function isSkillAuthorizedForAgent(agentId: string | undefined, skillName: string): boolean {
  if (!agentId?.trim()) return true;
  const resolved = resolveAgentSkills(agentId);
  if (!resolved.hasConfiguration) return true;
  return isSkillNameAuthorizedOnAllowlist(skillName, resolved.allowlist);
}
