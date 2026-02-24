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
  objectId: string
): boolean {
  // 1. Superadmin check: (subject, admin, system, *)
  if (hasRelation(subjectType, subjectId, "admin", "system", "*")) {
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
  objectId: string
): boolean {
  // No agent context → always allowed (CLI direct)
  if (!agentId) return true;

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
