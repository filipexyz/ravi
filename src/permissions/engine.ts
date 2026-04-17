/**
 * REBAC — Permission Engine
 *
 * Resolves permission checks against the relation store.
 *
 * Resolution order:
 *   1. No agent context (CLI direct) → always allowed
 *   2. Superadmin? → check (agent, <id>, admin, system, *)
 *   3. Direct relation? → check (agent, <id>, <permission>, <objectType>, <objectId>)
 *   4. Wildcard? → check (agent, <id>, <permission>, <objectType>, *)
 *   5. Pattern match? → check relations with glob patterns (e.g., dev-*)
 *   6. Tool group? → check if tool belongs to a granted toolgroup
 */

import { hasRelation, listRelations } from "./relations.js";
import { resolveToolGroup } from "../cli/tool-registry.js";
import { getContext } from "../cli/context.js";
import type { ContextCapability } from "../router/router-db.js";

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

  return false;
}

/**
 * Check if a runtime context capability snapshot allows an action.
 * This makes context leases the source of truth once a session is running.
 */
export function canWithCapabilities(
  capabilities: ContextCapability[],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  // 1. Superadmin capability
  if (capabilities.some((cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*")) {
    return true;
  }

  // 2. Direct relation
  if (
    capabilities.some(
      (cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === objectId,
    )
  ) {
    return true;
  }

  // 3. Wildcard on object_id
  if (
    objectId !== "*" &&
    capabilities.some((cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === "*")
  ) {
    return true;
  }

  // 4. Pattern match
  if (objectId !== "*") {
    for (const cap of capabilities) {
      if (cap.permission !== permission || cap.objectType !== objectType) continue;
      if (cap.objectId.includes("*") && matchPattern(cap.objectId, objectId)) {
        return true;
      }
    }
  }

  // 5. Tool group resolution
  if (permission === "use" && objectType === "tool" && objectId !== "*") {
    for (const cap of capabilities) {
      if (cap.permission !== "use" || cap.objectType !== "toolgroup") continue;
      const members = resolveToolGroup(cap.objectId);
      if (members?.includes(objectId)) return true;
    }
  }

  return false;
}

/**
 * Check a runtime capability snapshot, but let a live superadmin grant win.
 *
 * Runtime contexts are intentionally snapshot-based for least privilege, but
 * `admin system:*` is the break-glass grant. If it is added after a context was
 * issued, stale snapshots must not keep denying tools, executables, sessions or
 * CLI groups.
 */
export function canWithCapabilityContext(
  context: { agentId?: string | null; capabilities: ContextCapability[] },
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (context.agentId && isAgentSuperadmin(context.agentId)) {
    return true;
  }

  return canWithCapabilities(context.capabilities, permission, objectType, objectId);
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

  // Live superadmin always wins, even when a running context has stale caps.
  if (isAgentSuperadmin(agentId)) return true;

  const scopedCapabilities = getScopedCapabilities(agentId);
  if (scopedCapabilities) {
    return canWithCapabilities(scopedCapabilities, permission, objectType, objectId);
  }

  return can("agent", agentId, permission, objectType, objectId);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Match a pattern with wildcard suffix against a value.
 * e.g., "dev-*" matches "dev-grupo1"
 */
function matchPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true;

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  return false;
}

export function isSuperadmin(subjectType: string, subjectId: string): boolean {
  return hasRelation(subjectType, subjectId, "admin", "system", "*");
}

export function isAgentSuperadmin(agentId: string | undefined): boolean {
  return Boolean(agentId && isSuperadmin("agent", agentId));
}

function getScopedCapabilities(agentId: string): ContextCapability[] | undefined {
  const ctx = getContext();
  if (!ctx?.context) return undefined;
  if (ctx.agentId && ctx.agentId !== agentId) return undefined;
  return ctx.context.capabilities;
}
