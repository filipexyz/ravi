/**
 * REBAC — Permission Engine
 *
 * Resolves permission checks against the relation store.
 *
 * Resolution order:
 *   1. No agent context (CLI direct) → always allowed
 *   2. Scoped runtime context? → check its capability lease
 *   3. Superadmin? → check (agent, <id>, admin, system, *)
 *   4. Direct relation? → check (agent, <id>, <permission>, <objectType>, <objectId>)
 *   5. Wildcard? → check (agent, <id>, <permission>, <objectType>, *)
 *   6. Pattern match? → check relations with glob patterns (e.g., dev-*)
 *   7. Tool group? → check if tool belongs to a granted toolgroup
 */

import { hasRelation, listRelations } from "./relations.js";
import { resolveToolGroup } from "../cli/tool-registry.js";
import { getContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import {
  canWithCapabilities,
  canWithCapabilityContext as canWithSnapshotCapabilityContext,
  isAgentSuperadmin,
  isDelegatedAuthorityContext,
  isSuperadmin,
  matchPattern,
} from "./capability-context.js";
import { materializeDelegatedAuthority, parseAuthorityPrincipal } from "./delegation.js";
import { revalidatePolicyMaterializationsBeforeAuthorization } from "./policies.js";

export { canWithCapabilities, isAgentSuperadmin, isSuperadmin } from "./capability-context.js";

export function canWithCapabilityContext(
  context: Parameters<typeof canWithSnapshotCapabilityContext>[0],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  revalidatePolicyMaterializationsBeforeAuthorization();
  const liveDelegatedDecision = canWithLiveDelegatedAuthorityContext(context, permission, objectType, objectId);
  if (liveDelegatedDecision !== null) {
    return liveDelegatedDecision;
  }
  return canWithSnapshotCapabilityContext(context, permission, objectType, objectId);
}

// ============================================================================
// Core Engine
// ============================================================================

/**
 * Check if a subject has a permission on an object.
 *
 * @param subjectType - e.g., "agent"
 * @param subjectId - e.g., "dev"
 * @param permission - e.g., "execute", "access", "admin"
 * @param objectType - e.g., "group", "session", "system"
 * @param objectId - e.g., "contacts", "dev-grupo1", "*"
 */
export function can(
  subjectType: string,
  subjectId: string,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  revalidatePolicyMaterializationsBeforeAuthorization();
  return canInternal(subjectType, subjectId, permission, objectType, objectId, new Set());
}

function canInternal(
  subjectType: string,
  subjectId: string,
  permission: string,
  objectType: string,
  objectId: string,
  visitedRoles: Set<string>,
): boolean {
  // 1. Superadmin check: (subject, admin, system, *)
  if (isSuperadmin(subjectType, subjectId)) {
    return true;
  }

  // 2. Direct relation
  if (hasRelation(subjectType, subjectId, permission, objectType, objectId)) {
    return true;
  }

  // 3. Wildcard on object_id
  if (objectId !== "*" && hasRelation(subjectType, subjectId, permission, objectType, "*")) {
    return true;
  }

  // 4. Pattern match — check if any relation with glob patterns matches
  //    e.g., relation (agent, dev, access, session, dev-*) should match objectId "dev-grupo1"
  if (objectId !== "*") {
    const patternRelations = listRelations({
      subjectType,
      subjectId,
      relation: permission,
      objectType,
    });

    for (const rel of patternRelations) {
      if (rel.objectId.includes("*") && matchPattern(rel.objectId, objectId)) {
        return true;
      }
    }
  }

  // 5. Tool group resolution: check if tool belongs to a granted group
  if (permission === "use" && objectType === "tool" && objectId !== "*") {
    const groupRelations = listRelations({
      subjectType,
      subjectId,
      relation: "use",
      objectType: "toolgroup",
    });
    for (const gr of groupRelations) {
      const members = resolveToolGroup(gr.objectId);
      if (members?.includes(objectId)) return true;
    }
  }

  // 6. Role membership: subject --member--> role:<id>, then evaluate the role.
  const roleMemberships = listRelations({
    subjectType,
    subjectId,
    relation: "member",
    objectType: "role",
  });
  for (const membership of roleMemberships) {
    const roleId = membership.objectId;
    if (visitedRoles.has(roleId)) continue;
    visitedRoles.add(roleId);
    if (canInternal("role", roleId, permission, objectType, objectId, visitedRoles)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Scope Integration
// ============================================================================

/**
 * Check if an agent can perform an action, considering the no-agent-context case.
 * Returns true when:
 *   - No agentId (CLI direct, no enforcement)
 *   - Engine says yes
 */
export function agentCan(
  agentId: string | undefined,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  // No agent context → always allowed (CLI direct)
  if (!agentId) return true;

  const scopedContext = getScopedContext(agentId);
  if (scopedContext) {
    return canWithCapabilityContext(
      { ...scopedContext, agentId: scopedContext.agentId ?? agentId },
      permission,
      objectType,
      objectId,
    );
  }

  // Live superadmin wins when no scoped context is constraining the call.
  if (isAgentSuperadmin(agentId)) return true;

  return can("agent", agentId, permission, objectType, objectId);
}

// ============================================================================
// Helpers
// ============================================================================

function getScopedContext(agentId: string): ContextRecord | undefined {
  const ctx = getContext();
  if (!ctx?.context) return undefined;
  if (ctx.agentId && ctx.agentId !== agentId) return undefined;
  return ctx.context;
}

function canWithLiveDelegatedAuthorityContext(
  context: Parameters<typeof canWithSnapshotCapabilityContext>[0],
  permission: string,
  objectType: string,
  objectId: string,
): boolean | null {
  if (!isDelegatedAuthorityContext(context)) return null;

  const snapshotAllowed = canWithSnapshotCapabilityContext(context, permission, objectType, objectId);
  const metadata = context.metadata ?? {};
  const executorAgentId = stringValue(metadata.executorAgentId) ?? context.agentId ?? null;
  const actorPrincipal = parseAuthorityPrincipal(metadata.actorPrincipal);
  if (!executorAgentId || !actorPrincipal) {
    return null;
  }

  const surfacePrincipal = parseAuthorityPrincipal(metadata.surfacePrincipal);
  const turnCapabilities = capabilityArrayValue(metadata.turnCapabilities);
  const materialized = materializeDelegatedAuthority({
    agentPrincipal: { subjectType: "agent", subjectId: executorAgentId },
    actorPrincipal,
    surfacePrincipal,
    agentCapabilityAdditions: turnCapabilities,
    turnCapabilities: turnCapabilities.length > 0 ? turnCapabilities : undefined,
  });
  const liveAllowed = canWithCapabilities(materialized.effectiveCapabilities, permission, objectType, objectId);

  // Turn-scoped observation grants are one-turn caps not recoverable from the
  // relation graph. When the context carries the serialized turn capabilities,
  // they are already included in the live materialization above as the upper
  // bound, so stale context snapshots must not keep denying newly granted actor
  // authority. Older contexts only carried a count; for those, keep the
  // snapshot as the only safe bound we have.
  if (turnCapabilities.length > 0) {
    return liveAllowed;
  }
  const turnCapabilityCount = numberValue(metadata.turnCapabilityCount) ?? 0;
  if (turnCapabilityCount > 0) {
    return snapshotAllowed && liveAllowed;
  }

  return liveAllowed;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capabilityArrayValue(value: unknown): ContextCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: ContextCapability[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const permission = stringValue(record.permission);
    const objectType = stringValue(record.objectType);
    const objectId = stringValue(record.objectId);
    if (!permission || !objectType || !objectId) continue;
    const source = stringValue(record.source);
    capabilities.push({
      permission,
      objectType,
      objectId,
      ...(source ? { source } : {}),
    });
  }
  return capabilities;
}
