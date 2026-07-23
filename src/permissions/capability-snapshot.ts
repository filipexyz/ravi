import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";

/**
 * Pure capability snapshot matcher.
 *
 * This module is intentionally independent from relation/grant storage. It is
 * safe for provider-runtime providers that authorize only from an already
 * materialized runtime context.
 */
export function canWithCapabilities(
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
      (cap) =>
        cap.permission === permission && cap.objectType === objectType && objectIdMatches(cap.objectId, objectId),
    )
  ) {
    return true;
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

/**
 * Single source of truth for object-id matching across snapshot evaluators.
 *
 * A granted object id covers a requested object id when they are equal, when
 * the grant is the full `*` wildcard, or when the grant is a trailing pattern
 * that matches. A specific grant never satisfies a `*` request.
 */
export function objectIdMatches(grantObjectId: string, requestedObjectId: string): boolean {
  if (grantObjectId === requestedObjectId) return true;
  if (requestedObjectId === "*") return false;
  if (grantObjectId === "*") return true;
  if (grantObjectId.includes("*")) return matchPattern(grantObjectId, requestedObjectId);
  return false;
}
