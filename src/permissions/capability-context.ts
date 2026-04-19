import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { hasRelation } from "./relations.js";

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
  context: { agentId?: string | null; capabilities: ContextCapability[] },
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (context.agentId && isAgentSuperadmin(context.agentId)) {
    return true;
  }

  return capabilitiesAllow(context.capabilities, permission, objectType, objectId);
}

export function isSuperadmin(subjectType: string, subjectId: string): boolean {
  return hasRelation(subjectType, subjectId, "admin", "system", "*");
}

export function isAgentSuperadmin(agentId: string | undefined): boolean {
  return Boolean(agentId && isSuperadmin("agent", agentId));
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
