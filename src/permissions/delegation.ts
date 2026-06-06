import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities } from "./capability-context.js";
import { listRelations } from "./relations.js";

export const DELEGATED_AUTHORITY_MODE = "delegated";
export const TURN_SCOPED_AUTHORITY_KIND = "turn-runtime";
export const ROLE_MEMBERSHIP_RELATION = "member";
export const ROLE_OBJECT_TYPE = "role";

export interface AuthorityPrincipal {
  subjectType: string;
  subjectId: string;
}

export interface EffectiveCapabilitiesInput {
  agentCapabilities: ContextCapability[];
  actorCapabilities: ContextCapability[];
  surfaceCapabilities?: ContextCapability[];
  turnCapabilities?: ContextCapability[];
}

export function snapshotSubjectCapabilities(
  subjectType: string,
  subjectId: string,
  options: { includeRoles?: boolean } = {},
): ContextCapability[] {
  const directRelations = listRelations({ subjectType, subjectId });
  const directCapabilities = relationCapabilities(directRelations).filter(
    (capability) => !isRoleMembership(capability),
  );
  if (options.includeRoles === false) {
    return dedupeContextCapabilities(directCapabilities);
  }

  const roleCapabilities = directRelations
    .filter((relation) => relation.relation === ROLE_MEMBERSHIP_RELATION && relation.objectType === ROLE_OBJECT_TYPE)
    .flatMap((relation) =>
      relationCapabilities(listRelations({ subjectType: ROLE_OBJECT_TYPE, subjectId: relation.objectId }))
        .filter((capability) => !isRoleMembership(capability))
        .map((capability) => ({
          ...capability,
          source: capability.source ? `role:${relation.objectId}/${capability.source}` : `role:${relation.objectId}`,
        })),
    );

  return dedupeContextCapabilities([...directCapabilities, ...roleCapabilities]);
}

export function buildEffectiveCapabilities(input: EffectiveCapabilitiesInput): ContextCapability[] {
  const constraints = [
    input.agentCapabilities,
    input.actorCapabilities,
    ...(input.surfaceCapabilities ? [input.surfaceCapabilities] : []),
    ...(input.turnCapabilities ? [input.turnCapabilities] : []),
  ];
  const candidates = dedupeContextCapabilities(constraints.flat()).filter(
    (capability) => !isRoleMembership(capability),
  );

  return dedupeContextCapabilities(
    candidates
      .filter((candidate) => constraints.every((capabilities) => capabilitySetAllows(capabilities, candidate)))
      .map((capability) => ({
        permission: capability.permission,
        objectType: capability.objectType,
        objectId: capability.objectId,
        source: "effective",
      })),
  );
}

export function hasAnyCapability(capabilities: ContextCapability[] | undefined): capabilities is ContextCapability[] {
  return Boolean(capabilities && capabilities.length > 0);
}

function relationCapabilities(
  relations: Array<{
    relation: string;
    objectType: string;
    objectId: string;
    source?: string;
  }>,
): ContextCapability[] {
  return relations.map((relation) => ({
    permission: relation.relation,
    objectType: relation.objectType,
    objectId: relation.objectId,
    source: relation.source,
  }));
}

function capabilitySetAllows(capabilities: ContextCapability[], candidate: ContextCapability): boolean {
  if (canWithCapabilities(capabilities, candidate.permission, candidate.objectType, candidate.objectId)) {
    return true;
  }

  if (candidate.permission === "use" && candidate.objectType === "toolgroup" && candidate.objectId !== "*") {
    const members = resolveToolGroup(candidate.objectId);
    return Boolean(
      members?.length && members.every((toolName) => canWithCapabilities(capabilities, "use", "tool", toolName)),
    );
  }

  return false;
}

function isRoleMembership(capability: ContextCapability): boolean {
  return capability.permission === ROLE_MEMBERSHIP_RELATION && capability.objectType === ROLE_OBJECT_TYPE;
}

function dedupeContextCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}
