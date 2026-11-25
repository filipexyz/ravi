import { getToolNameEquivalents, resolveToolGroup } from "../cli/tool-registry.js";
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
  if (isWithheldByDeny(capabilities, permission, objectType, objectId)) return false;
  if (capabilities.some((cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*")) {
    return true;
  }

  const requested = requestedObjectIds(objectType, objectId);
  if (
    capabilities.some(
      (cap) =>
        cap.permission === permission &&
        cap.objectType === objectType &&
        requested.some((id) => objectIdMatches(cap.objectId, id)),
    )
  ) {
    return true;
  }

  if (permission === "use" && objectType === "tool" && objectId !== "*") {
    for (const cap of capabilities) {
      if (cap.permission !== "use" || cap.objectType !== "toolgroup") continue;
      const members = resolveToolGroup(cap.objectId);
      if (members && requested.some((id) => members.includes(id))) return true;
    }
  }

  return false;
}

/**
 * The object ids a request stands for. A tool that goes by two names (`Task` and `Agent`) is requested under both, so a
 * grant, a tool group or a `deny_*` entry under either name applies. Only a tool object is renamed: an agent or a session
 * that happens to be called `Agent` is not the subagent tool.
 */
function requestedObjectIds(objectType: string, objectId: string): readonly string[] {
  return objectType === "tool" ? getToolNameEquivalents(objectId) : [objectId];
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

/**
 * `deny_<permission>` entries in a snapshot withhold what the admin shortcut or
 * a wildcard would otherwise grant (the actor branch of a person's turn in an
 * ungoverned chat: everything of the agent except break-glass). An explicit,
 * non-wildcard capability for the exact object still allows it.
 */
const DENY_PREFIX = "deny_";

export function isWithheldByDeny(
  capabilities: ContextCapability[],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  const requested = requestedObjectIds(objectType, objectId);
  const denied = capabilities.some(
    (cap) =>
      cap.permission.startsWith(DENY_PREFIX) &&
      cap.permission.slice(DENY_PREFIX.length) === permission &&
      (cap.objectType === objectType || cap.objectType === "*") &&
      requested.some((id) => objectIdMatches(cap.objectId, id)),
  );
  if (!denied) return false;
  if (objectId === "*") return true;
  return !capabilities.some(
    (cap) =>
      cap.permission === permission &&
      cap.objectType === objectType &&
      cap.objectId !== "*" &&
      requested.includes(cap.objectId),
  );
}
