import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { hasRelation, listRelations } from "./relations.js";

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
  return capabilitiesAllow(capabilities, permission, objectType, objectId);
}

function capabilitiesAllow(
  capabilities: ContextCapability[],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (capabilities.some((cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*")) {
    return true;
  }

  if (
    capabilities.some(
      (cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === objectId,
    )
  ) {
    return true;
  }

  if (
    objectId !== "*" &&
    capabilities.some((cap) => cap.permission === permission && cap.objectType === objectType && cap.objectId === "*")
  ) {
    return true;
  }

  if (objectId !== "*") {
    for (const cap of capabilities) {
      if (cap.permission !== permission || cap.objectType !== objectType) continue;
      if (cap.objectId.includes("*") && matchPattern(cap.objectId, objectId)) {
        return true;
      }
    }
  }

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
  context: { agentId?: string | null; kind?: string | null; capabilities: ContextCapability[] },
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (context.agentId && isAgentSuperadmin(context.agentId)) {
    return true;
  }

  if (capabilitiesAllow(context.capabilities, permission, objectType, objectId)) {
    return true;
  }

  // Agent runtime contexts are long-lived roots for an agent session. Operator
  // grants must take effect there without requiring a daemon/runtime restart.
  // Derived contexts remain snapshot-based for least privilege.
  if (context.kind === "agent-runtime" && context.agentId) {
    return liveAgentCan(context.agentId, permission, objectType, objectId);
  }

  return false;
}

export function isSuperadmin(subjectType: string, subjectId: string): boolean {
  return hasRelation(subjectType, subjectId, "admin", "system", "*");
}

export function isAgentSuperadmin(agentId: string | undefined): boolean {
  return Boolean(agentId && isSuperadmin("agent", agentId));
}

function liveAgentCan(agentId: string, permission: string, objectType: string, objectId: string): boolean {
  if (hasRelation("agent", agentId, permission, objectType, objectId)) {
    return true;
  }

  if (objectId !== "*" && hasRelation("agent", agentId, permission, objectType, "*")) {
    return true;
  }

  if (objectId !== "*") {
    const patternRelations = listRelations({
      subjectType: "agent",
      subjectId: agentId,
      relation: permission,
      objectType,
    });

    for (const relation of patternRelations) {
      if (relation.objectId.includes("*") && matchPattern(relation.objectId, objectId)) {
        return true;
      }
    }
  }

  if (permission === "use" && objectType === "tool" && objectId !== "*") {
    const groupRelations = listRelations({
      subjectType: "agent",
      subjectId: agentId,
      relation: "use",
      objectType: "toolgroup",
    });
    for (const relation of groupRelations) {
      const members = resolveToolGroup(relation.objectId);
      if (members?.includes(objectId)) return true;
    }
  }

  return false;
}

/**
 * Match a pattern with wildcard suffix against a value.
 * e.g., "dev-*" matches "dev-grupo1"
 */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === value) return true;

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  return false;
}
