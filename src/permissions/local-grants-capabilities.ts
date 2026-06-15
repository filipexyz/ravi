import type { ContextCapability } from "../router/router-db.js";
import {
  BLOCKED_DELEGATION_OVERRIDE_RELATIONS,
  DELEGATION_OVERRIDE_RELATION_PREFIX,
  ROLE_MEMBERSHIP_RELATION,
  ROLE_OBJECT_TYPE,
} from "./delegation.js";
import { listRelations } from "./relations.js";

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

function isSnapshotCapability(capability: ContextCapability): boolean {
  return (
    !isRoleMembership(capability) && !isDelegationOverrideCapability(capability) && !isSurfaceConstraint(capability)
  );
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
