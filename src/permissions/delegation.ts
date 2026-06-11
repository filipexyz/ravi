import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities } from "./capability-context.js";
import { listRelations } from "./relations.js";

export const DELEGATED_AUTHORITY_MODE = "delegated";
export const TURN_SCOPED_AUTHORITY_KIND = "turn-runtime";
export const ROLE_MEMBERSHIP_RELATION = "member";
export const ROLE_OBJECT_TYPE = "role";
export const DELEGATION_OVERRIDE_RELATION_PREFIX = "delegate_";
export const DENY_RELATION_PREFIX = "deny_";
const BLOCKED_DELEGATION_OVERRIDE_RELATIONS = new Set(["admin"]);

export interface AuthorityPrincipal {
  subjectType: string;
  subjectId: string;
}

export interface DelegatedAuthorityMaterializationInput {
  agentPrincipal: AuthorityPrincipal;
  actorPrincipal?: AuthorityPrincipal | null;
  surfacePrincipal?: AuthorityPrincipal | null;
  agentCapabilityAdditions?: ContextCapability[];
  turnCapabilities?: ContextCapability[];
  includeSurfaceConstraint?: boolean;
  allowDelegationOverrides?: boolean;
}

export interface DelegatedAuthorityMaterialization {
  agentCapabilities: ContextCapability[];
  actorCapabilities: ContextCapability[];
  surfaceCapabilities: ContextCapability[];
  turnCapabilities: ContextCapability[];
  actorOverrideCapabilities: ContextCapability[];
  surfaceOverrideCapabilities: ContextCapability[];
  effectiveCapabilities: ContextCapability[];
}

export interface EffectiveCapabilitiesInput {
  agentCapabilities: ContextCapability[];
  actorCapabilities: ContextCapability[];
  surfaceCapabilities?: ContextCapability[];
  turnCapabilities?: ContextCapability[];
  actorOverrideCapabilities?: ContextCapability[];
  surfaceOverrideCapabilities?: ContextCapability[];
}

export function snapshotSubjectCapabilities(
  subjectType: string,
  subjectId: string,
  options: { includeRoles?: boolean; includeConstraints?: boolean } = {},
): ContextCapability[] {
  const directRelations = listRelations({ subjectType, subjectId });
  const directCapabilities = relationCapabilities(directRelations).filter(isSnapshotCapability);
  const roleCapabilities =
    options.includeRoles === false
      ? []
      : directRelations
          .filter(
            (relation) => relation.relation === ROLE_MEMBERSHIP_RELATION && relation.objectType === ROLE_OBJECT_TYPE,
          )
          .flatMap((relation) => expandRoleCapabilities(relation.objectId, new Set()));
  const constraintCapabilities =
    options.includeConstraints === false
      ? []
      : directRelations
          .filter((relation) => relation.relation === "constrain" && relation.objectType === ROLE_OBJECT_TYPE)
          .flatMap((relation) =>
            expandRoleCapabilities(relation.objectId, new Set(), `constraint:${relation.objectId}`),
          );

  return dedupeContextCapabilities([...directCapabilities, ...roleCapabilities, ...constraintCapabilities]);
}

export function snapshotSubjectDelegationOverrides(
  subjectType: string,
  subjectId: string,
  options: { includeRoles?: boolean } = {},
): ContextCapability[] {
  const directRelations = listRelations({ subjectType, subjectId });
  const directOverrides = relationCapabilities(directRelations).flatMap(normalizeDelegationOverrideCapability);
  if (options.includeRoles === false) {
    return dedupeContextCapabilities(directOverrides);
  }

  const roleOverrides = directRelations
    .filter((relation) => relation.relation === ROLE_MEMBERSHIP_RELATION && relation.objectType === ROLE_OBJECT_TYPE)
    .flatMap((relation) => expandRoleDelegationOverrides(relation.objectId, new Set()));

  return dedupeContextCapabilities([...directOverrides, ...roleOverrides]);
}

export function materializeDelegatedAuthority(
  input: DelegatedAuthorityMaterializationInput,
): DelegatedAuthorityMaterialization {
  const graphAgentCapabilities = snapshotSubjectCapabilities(
    input.agentPrincipal.subjectType,
    input.agentPrincipal.subjectId,
  );
  const agentCapabilities = dedupeContextCapabilities([
    ...graphAgentCapabilities,
    ...(input.agentCapabilityAdditions ?? []),
  ]);
  const actorCapabilities = input.actorPrincipal
    ? snapshotSubjectCapabilities(input.actorPrincipal.subjectType, input.actorPrincipal.subjectId)
    : [];
  const surfaceCapabilities = input.surfacePrincipal
    ? snapshotSubjectCapabilities(input.surfacePrincipal.subjectType, input.surfacePrincipal.subjectId, {
        includeRoles: false,
      })
    : [];
  const allowDelegationOverrides = input.allowDelegationOverrides ?? input.actorPrincipal?.subjectType === "contact";
  const agentDelegationOverrides = allowDelegationOverrides
    ? snapshotSubjectDelegationOverrides(input.agentPrincipal.subjectType, input.agentPrincipal.subjectId, {
        includeRoles: false,
      })
    : [];
  const surfaceDelegationOverrides =
    allowDelegationOverrides && input.surfacePrincipal
      ? snapshotSubjectDelegationOverrides(input.surfacePrincipal.subjectType, input.surfacePrincipal.subjectId, {
          includeRoles: false,
        })
      : [];
  const actorOverrideCapabilities = [...agentDelegationOverrides, ...surfaceDelegationOverrides];
  const surfaceOverrideCapabilities = surfaceDelegationOverrides;
  const includeSurfaceConstraint =
    input.includeSurfaceConstraint ??
    (Boolean(input.surfacePrincipal) || input.actorPrincipal?.subjectType !== "automation");
  const turnCapabilities = input.turnCapabilities ?? [];
  const effectiveCapabilities = buildEffectiveCapabilities({
    agentCapabilities,
    actorCapabilities,
    ...(includeSurfaceConstraint ? { surfaceCapabilities } : {}),
    actorOverrideCapabilities,
    surfaceOverrideCapabilities,
    turnCapabilities: hasAnyCapability(turnCapabilities) ? turnCapabilities : undefined,
  });

  return {
    agentCapabilities,
    actorCapabilities,
    surfaceCapabilities,
    turnCapabilities,
    actorOverrideCapabilities,
    surfaceOverrideCapabilities,
    effectiveCapabilities,
  };
}

export function parseAuthorityPrincipal(value: unknown): AuthorityPrincipal | null {
  if (typeof value !== "string") return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const subjectType = value.slice(0, idx).trim();
  const subjectId = value.slice(idx + 1).trim();
  if (!subjectType || !subjectId || subjectId === "<unknown>" || subjectId === "unknown") return null;
  return { subjectType, subjectId };
}

export function formatAuthorityPrincipal(principal: AuthorityPrincipal): string {
  return `${principal.subjectType}:${principal.subjectId}`;
}

export function buildEffectiveCapabilities(input: EffectiveCapabilitiesInput): ContextCapability[] {
  const agentCapabilities = regularCapabilities(input.agentCapabilities);
  const actorCapabilities = regularCapabilities(input.actorCapabilities);
  const surfaceCapabilities = input.surfaceCapabilities ? regularCapabilities(input.surfaceCapabilities) : undefined;
  const turnCapabilities = input.turnCapabilities ? regularCapabilities(input.turnCapabilities) : undefined;
  const actorOverrideCapabilities = regularCapabilities(input.actorOverrideCapabilities ?? []);
  const surfaceOverrideCapabilities = regularCapabilities(input.surfaceOverrideCapabilities ?? []);
  const agentDenyCapabilities = denyCapabilities(input.agentCapabilities);
  const actorDenyCapabilities = denyCapabilities(input.actorCapabilities);
  const surfaceDenyCapabilities = denyCapabilities(input.surfaceCapabilities ?? []);
  const turnDenyCapabilities = denyCapabilities(input.turnCapabilities ?? []);
  const surfaceConstraintCapabilities = surfaceCapabilities?.filter(isConstraintExpandedCapability) ?? [];
  const hasSurfaceConstraints = surfaceConstraintCapabilities.length > 0;
  const constraints = [
    agentCapabilities,
    actorCapabilities,
    ...(surfaceCapabilities ? [surfaceCapabilities] : []),
    ...(turnCapabilities ? [turnCapabilities] : []),
  ];
  const candidates = dedupeContextCapabilities([
    ...constraints.flat(),
    ...actorOverrideCapabilities,
    ...surfaceOverrideCapabilities,
  ]);

  return dedupeContextCapabilities(
    candidates
      .filter((candidate) => {
        if (
          capabilitySetDenies(agentDenyCapabilities, candidate) ||
          capabilitySetDenies(actorDenyCapabilities, candidate) ||
          capabilitySetDenies(surfaceDenyCapabilities, candidate) ||
          capabilitySetDenies(turnDenyCapabilities, candidate)
        ) {
          return false;
        }
        if (!capabilitySetAllows(agentCapabilities, candidate)) return false;
        if (
          !capabilitySetAllows(actorCapabilities, candidate) &&
          !capabilitySetAllows(actorOverrideCapabilities, candidate)
        ) {
          return false;
        }
        if (surfaceCapabilities) {
          if (capabilitySetAllows(surfaceOverrideCapabilities, candidate)) {
            // Explicit surface delegation overrides satisfy the surface branch.
          } else if (hasSurfaceConstraints) {
            if (!capabilitySetAllows(surfaceConstraintCapabilities, candidate)) return false;
          } else if (capabilitySetAllows(surfaceCapabilities, candidate)) {
            // Direct surface grants are explicit allows for the matching object.
          } else if (!capabilitySetAllows(actorCapabilities, candidate)) {
            // With no explicit surface decision, inherit only the actor's own effective branch.
            return false;
          }
        }
        if (turnCapabilities && !capabilitySetAllows(turnCapabilities, candidate)) return false;
        return true;
      })
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

function capabilitySetDenies(capabilities: ContextCapability[], candidate: ContextCapability): boolean {
  return capabilities.some((capability) => capabilityOverlaps(capability, candidate));
}

function capabilityOverlaps(left: ContextCapability, right: ContextCapability): boolean {
  if (capabilitySetAllows([left], right)) return true;
  if (capabilitySetAllows([right], left)) return true;

  if (left.permission !== right.permission) return false;
  if (left.objectType === right.objectType && (left.objectId === "*" || right.objectId === "*")) return true;
  if (left.permission === "use" && isToolOrToolGroup(left.objectType) && isToolOrToolGroup(right.objectType)) {
    return left.objectId === "*" || right.objectId === "*";
  }
  return false;
}

function isToolOrToolGroup(objectType: string): boolean {
  return objectType === "tool" || objectType === "toolgroup";
}

function isRoleMembership(capability: ContextCapability): boolean {
  return capability.permission === ROLE_MEMBERSHIP_RELATION && capability.objectType === ROLE_OBJECT_TYPE;
}

function isSurfaceConstraint(capability: ContextCapability): boolean {
  return capability.permission === "constrain" && capability.objectType === ROLE_OBJECT_TYPE;
}

function isDelegationOverrideCapability(capability: ContextCapability): boolean {
  return (
    capability.permission.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX) &&
    capability.permission.length > DELEGATION_OVERRIDE_RELATION_PREFIX.length
  );
}

function isDenyCapability(capability: ContextCapability): boolean {
  return (
    capability.permission.startsWith(DENY_RELATION_PREFIX) && capability.permission.length > DENY_RELATION_PREFIX.length
  );
}

function isSnapshotCapability(capability: ContextCapability): boolean {
  return (
    !isRoleMembership(capability) && !isDelegationOverrideCapability(capability) && !isSurfaceConstraint(capability)
  );
}

function isRegularCapability(capability: ContextCapability): boolean {
  return isSnapshotCapability(capability) && !isDenyCapability(capability);
}

function isConstraintExpandedCapability(capability: ContextCapability): boolean {
  return capability.source?.startsWith("constraint:") ?? false;
}

function normalizeDelegationOverrideCapability(capability: ContextCapability): ContextCapability[] {
  if (!isDelegationOverrideCapability(capability)) return [];
  const permission = capability.permission.slice(DELEGATION_OVERRIDE_RELATION_PREFIX.length);
  if (BLOCKED_DELEGATION_OVERRIDE_RELATIONS.has(permission)) return [];
  return [
    {
      permission,
      objectType: capability.objectType,
      objectId: capability.objectId,
      source: capability.source ? `delegate:${capability.source}` : "delegate",
    },
  ];
}

function normalizeDenyCapability(capability: ContextCapability): ContextCapability[] {
  if (!isDenyCapability(capability)) return [];
  return [
    {
      permission: capability.permission.slice(DENY_RELATION_PREFIX.length),
      objectType: capability.objectType,
      objectId: capability.objectId,
      source: capability.source ? `deny:${capability.source}` : "deny",
    },
  ];
}

function regularCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  return dedupeContextCapabilities(capabilities.filter(isRegularCapability));
}

function denyCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  return dedupeContextCapabilities(capabilities.flatMap(normalizeDenyCapability));
}

function expandRoleCapabilities(
  roleId: string,
  visited: Set<string>,
  sourcePrefix = `role:${roleId}`,
): ContextCapability[] {
  if (visited.has(roleId)) return [];
  visited.add(roleId);
  const relations = listRelations({ subjectType: ROLE_OBJECT_TYPE, subjectId: roleId });
  const direct = relationCapabilities(relations)
    .filter(isSnapshotCapability)
    .map((capability) => withCapabilitySourcePrefix(capability, sourcePrefix));
  const nested = relations
    .filter((relation) => relation.relation === ROLE_MEMBERSHIP_RELATION && relation.objectType === ROLE_OBJECT_TYPE)
    .flatMap((relation) =>
      expandRoleCapabilities(relation.objectId, visited, `${sourcePrefix}/role:${relation.objectId}`),
    );
  return [...direct, ...nested];
}

function expandRoleDelegationOverrides(
  roleId: string,
  visited: Set<string>,
  sourcePrefix = `role:${roleId}`,
): ContextCapability[] {
  if (visited.has(roleId)) return [];
  visited.add(roleId);
  const relations = listRelations({ subjectType: ROLE_OBJECT_TYPE, subjectId: roleId });
  const direct = relationCapabilities(relations)
    .flatMap(normalizeDelegationOverrideCapability)
    .map((capability) => withCapabilitySourcePrefix(capability, sourcePrefix));
  const nested = relations
    .filter((relation) => relation.relation === ROLE_MEMBERSHIP_RELATION && relation.objectType === ROLE_OBJECT_TYPE)
    .flatMap((relation) =>
      expandRoleDelegationOverrides(relation.objectId, visited, `${sourcePrefix}/role:${relation.objectId}`),
    );
  return [...direct, ...nested];
}

function withCapabilitySourcePrefix(capability: ContextCapability, prefix: string): ContextCapability {
  return {
    ...capability,
    source: capability.source ? `${prefix}/${capability.source}` : prefix,
  };
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
