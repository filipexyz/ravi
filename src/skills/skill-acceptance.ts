import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { getAgent } from "../router/index.js";
import {
  dbDeleteSkillGrant,
  dbListSkillGrantsForAgent,
  dbUpsertSkillGrant,
  type DbSkillGrant,
} from "../router/router-db.js";
import { resolveAgentSkills } from "../runtime/allowed-skills.js";
import { slugifySkillName } from "./manager.js";
import {
  agentCreatedSkillOwner,
  applySkillGuard,
  isAgentCreatedSkillContent,
  resolveEditableSkillPath,
  type SkillGuardDecision,
  type SkillGuardInput,
} from "./skill-guard.js";

export type AcceptedSkillCreateDecision = SkillGuardDecision & {
  grant?: DbSkillGrant;
  visibleToAgent?: boolean;
  idempotent?: boolean;
};

interface SkillAcceptanceDependencies {
  agentExists(agentId: string): boolean;
  listGrants(agentId: string): DbSkillGrant[];
  upsertGrant(input: { agentId: string; skillName: string; note?: string }): DbSkillGrant;
  deleteGrant(agentId: string, skillName: string): boolean;
  isVisible(agentId: string, skillName: string): boolean;
  applyGuard(input: SkillGuardInput): SkillGuardDecision;
  rollbackFile(path: string): void;
}

const defaultDependencies: SkillAcceptanceDependencies = {
  agentExists: (agentId) => Boolean(getAgent(agentId)),
  listGrants: dbListSkillGrantsForAgent,
  upsertGrant: dbUpsertSkillGrant,
  deleteGrant: dbDeleteSkillGrant,
  isVisible: (agentId, skillName) => resolveAgentSkills(agentId).allowlist.includes(skillName),
  applyGuard: applySkillGuard,
  rollbackFile: (path) => rmSync(dirname(path), { recursive: true, force: true }),
};

/**
 * Complete the reviewed create -> grant -> visible transition. The file is the
 * prepared artifact and the per-agent grant is the publication point. Any
 * failure before visibility compensates both sides before surfacing an error.
 */
export function acceptSkillCreate(
  input: SkillGuardInput & { op: "create" },
  dependencies: Partial<SkillAcceptanceDependencies> = {},
): AcceptedSkillCreateDecision {
  const deps = { ...defaultDependencies, ...dependencies };
  const canonicalSkillName = slugifySkillName(input.skillName);
  const skillPath = resolveEditableSkillPath(canonicalSkillName, input.homeDir);
  const existingGrant = deps.listGrants(input.agentId).find((grant) => grant.skillName === canonicalSkillName);

  if (!deps.agentExists(input.agentId)) {
    return {
      outcome: "rejected",
      reason: "invalid-name",
      detail: `origin agent not found: ${input.agentId}`,
    };
  }

  if (existsSync(skillPath) && existingGrant) {
    const content = readFileSync(skillPath, "utf-8");
    if (isAgentCreatedSkillContent(content) && agentCreatedSkillOwner(content) === input.agentId) {
      return {
        outcome: "written",
        op: "create",
        path: skillPath,
        finalChars: content.length,
        grant: existingGrant,
        visibleToAgent: deps.isVisible(input.agentId, canonicalSkillName),
        idempotent: true,
      };
    }
  }

  if (existingGrant) {
    return {
      outcome: "rejected",
      reason: "exists",
      detail: `skill grant already exists without a matching agent-created artifact for ${input.agentId}`,
    };
  }

  const write = deps.applyGuard(input);
  if (write.outcome !== "written" || input.dryRun) {
    return write;
  }

  try {
    const grant = deps.upsertGrant({
      agentId: input.agentId,
      skillName: canonicalSkillName,
      note: buildAcceptanceAuditNote(input),
    });
    if (!deps.isVisible(input.agentId, canonicalSkillName)) {
      throw new Error(`created skill is not visible to origin agent ${input.agentId}`);
    }
    return {
      ...write,
      grant,
      visibleToAgent: true,
      idempotent: false,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      deps.deleteGrant(input.agentId, canonicalSkillName);
    } catch (rollbackError) {
      rollbackErrors.push(`grant rollback: ${errorText(rollbackError)}`);
    }
    try {
      deps.rollbackFile(write.path);
    } catch (rollbackError) {
      rollbackErrors.push(`file rollback: ${errorText(rollbackError)}`);
    }
    const suffix = rollbackErrors.length > 0 ? `; ${rollbackErrors.join("; ")}` : "";
    throw new Error(`skill create publication failed and was rolled back: ${errorText(error)}${suffix}`);
  }
}

function buildAcceptanceAuditNote(input: SkillGuardInput): string {
  const provenance = input.provenance ?? {};
  return [
    "learning-loop:create",
    provenance.taskId ? `task=${provenance.taskId}` : null,
    provenance.sessionKey ? `session=${provenance.sessionKey}` : null,
    provenance.cadenceTurn ? `turn=${provenance.cadenceTurn}` : null,
  ]
    .filter(Boolean)
    .join(";");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
