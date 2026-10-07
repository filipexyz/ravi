import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import type { ContextCapability } from "../router/router-db.js";
import {
  officialSkillImpliedByCapabilities,
  resolveKnownRaviSkill,
  skillCoveredBySkillCapability,
} from "./skill-capability-implication.js";
import { isSkillNameAuthorizedOnAllowlist } from "./skill-visibility.js";

function resolveConfiguredAgentSkills(agentId: string) {
  // Lazy: `allowed-skills` reads the grant table from `router-db`. Provider
  // registry → Pi authorization imports this module at CLI load time, and
  // command tests mock a partial `router-db` that does not export grants.
  const { resolveAgentSkills } = require("./allowed-skills.js") as typeof import("./allowed-skills.js");
  return resolveAgentSkills(agentId);
}

export const SKILL_NOT_AUTHORIZED = "SKILL_NOT_AUTHORIZED";

export interface SkillNotAuthorizedCopy {
  message: string;
  suggestedAction: string;
}

export interface SkillNotAuthorizedCopyOptions {
  /**
   * The denied shell line also runs the remediation (`ravi skills grant` and
   * friends). The gate rejects a line as a whole, so the grant never ran.
   */
  lineAlsoRemediates?: boolean;
}

/**
 * Denial copy shared by every skill gate (Pi extension, host Bash/tool gate,
 * `ravi skills show`). The skill is the subject and the agent the object. The
 * remediation depends on where the skill comes from: a skill shipped with Ravi
 * or already installed only needs a grant (or a `use:skill:<name>`
 * capability); a skill that only exists on disk must be installed first.
 * Visibility of a skill directory on disk never authorizes it.
 */
export function skillNotAuthorizedCopy(
  skillName: string,
  agentId?: string,
  options: SkillNotAuthorizedCopyOptions = {},
): SkillNotAuthorizedCopy {
  const skill = skillName.trim() || "<skill>";
  const agent = agentId?.trim();
  const known = skillName.trim() ? resolveKnownRaviSkill(skill) : null;
  const target = known?.name ?? skill;
  const grant = `'ravi skills grant ${agent || "<agent>"} ${target}'`;
  const remediation = !known
    ? `It is not in the Ravi catalog or installed: install it ('ravi skills install --source <skill-dir>'), then grant it (${grant}). Installing and granting need mutate:skills:install and mutate:skills:grant; if this agent cannot run them, ask an operator.`
    : `${known.source.startsWith("catalog:") ? "It ships with Ravi, so there is nothing to install" : "It is already installed in Ravi"}: grant it (${grant}) or give the agent the 'use:skill:${target}' capability. Granting needs mutate:skills:grant; if this agent cannot run it, ask an operator.`;
  const lineNote = options.lineAlsoRemediates
    ? " This shell line also reads the skill, so it was rejected as a whole and the grant did not run: run the grant as its own command first."
    : "";
  return {
    message: agent
      ? `Skill '${skill}' is not authorized for agent '${agent}'.`
      : `Skill '${skill}' is not authorized for this agent.`,
    suggestedAction: `${remediation}${lineNote}`,
  };
}

/** Single-line denial reason for tool/command gates: `SKILL_NOT_AUTHORIZED: <message> <action>`. */
export function formatSkillNotAuthorizedReason(
  skillName: string,
  agentId?: string,
  options: SkillNotAuthorizedCopyOptions = {},
): string {
  const copy = skillNotAuthorizedCopy(skillName, agentId, options);
  return `${SKILL_NOT_AUTHORIZED}: ${copy.message} ${copy.suggestedAction}`;
}

export interface SkillAuthorizationOptions {
  /**
   * Effective identity capabilities for this turn (session/agent_identity).
   * When supplied they are the ceiling: a narrowed turn (contact chat overlay,
   * observation grants) never falls back to the agent's broader capabilities.
   * When omitted, authorization uses the agent's materialized subject
   * capabilities. Visibility still follows these capabilities — a visible
   * skill never grants effect authority by itself.
   */
  capabilities?: readonly ContextCapability[];
  /**
   * Directory of the skill being read, when the caller selected one (e.g.
   * `ravi skills show --source`). Capability coverage then applies only when
   * that directory is the Ravi skill the name resolves to, so a capability for
   * a catalog name never authorizes same-named content from another source.
   */
  skillPath?: string;
}

function skillAuthorizedByCapabilities(
  capabilities: readonly ContextCapability[],
  skillName: string,
  skillPath: string | undefined,
): boolean {
  return (
    officialSkillImpliedByCapabilities(capabilities, skillName) ||
    skillCoveredBySkillCapability(capabilities, skillName, { skillPath })
  );
}

/**
 * Hard allowlist gate (Invariant G). Agents without configuration stay
 * grandfathered (Invariant F).
 *
 * Beyond the allowlist, a skill stays authorized when the identity's
 * capabilities reach it:
 * - official gated system skills, when the identity can already run the
 *   matching command (`admin:system:*`, `execute:group:<group>`, or a semantic
 *   `read|mutate:<resource>:<action>`). Grants may hide those skills from the
 *   advertised catalog, but they must not block an authorized
 *   `ravi permissions` / `ravi pages` call with `RAVI_SKILL_GATE_CONFIG_ERROR`;
 * - any skill Ravi knows (catalog or installed) named by a `use:skill:<id>`
 *   capability, including `use:skill:*` and the `admin:system:*` break-glass
 *   that `full-access` materializes.
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

  const capabilities = options.capabilities ?? materializeSubjectCapabilities("agent", agentId);
  return skillAuthorizedByCapabilities(capabilities, skillName, options.skillPath);
}
