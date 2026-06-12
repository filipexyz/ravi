import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { hasRelation, listRelations } from "./relations.js";

export interface CapabilityContextLike {
  agentId?: string | null;
  kind?: string | null;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown> | null;
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
 * Check a runtime capability snapshot, but let a live superadmin grant win
 * only for agent-owned contexts.
 *
 * Runtime contexts are intentionally snapshot-based for least privilege, but
 * `admin system:*` is the break-glass grant. If it is added after a context was
 * issued, stale snapshots must not keep denying tools, executables, sessions or
 * CLI groups.
 *
 * Delegated/turn-scoped contexts are different: the live agent is only the
 * executor. The context already represents the effective authority for the
 * actor who initiated the turn, so a live agent superadmin grant must not widen
 * it.
 */
export function canWithCapabilityContext(
  context: CapabilityContextLike,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  const delegated = isDelegatedAuthorityContext(context);

  if (!delegated && context.agentId && isAgentSuperadmin(context.agentId)) {
    return true;
  }

  if (capabilitiesAllow(context.capabilities, permission, objectType, objectId)) {
    return true;
  }

  // Agent runtime contexts are long-lived roots for an agent session. Operator
  // grants must take effect there without requiring a daemon/runtime restart.
  // Derived contexts remain snapshot-based for least privilege.
  if (!delegated && context.kind === "agent-runtime" && context.agentId) {
    return liveAgentCan(context.agentId, permission, objectType, objectId);
  }

  return false;
}

export function isDelegatedAuthorityContext(context: Pick<CapabilityContextLike, "kind" | "metadata">): boolean {
  if (context.kind === "turn-runtime" || context.kind === "invocation-runtime") {
    return true;
  }
  return context.metadata?.authorityMode === "delegated";
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

  const candidateRelations = listRelations({
    subjectType: "agent",
    subjectId: agentId,
    relation: permission,
    objectType,
  });
  for (const relation of candidateRelations) {
    if (objectIdMatches(relation.objectId, objectId)) {
      return true;
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

/**
 * Single source of truth for object-id matching across every evaluator
 * (engine, snapshot matcher, delegated materializer, explain).
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
 * Parse a `ContextCapability[]` out of untyped context metadata (e.g. serialized
 * `turnCapabilities`). Shared by the engine and explain so they read context
 * capability snapshots the same way.
 */
export function parseContextCapabilities(value: unknown): ContextCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: ContextCapability[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const permission = nonEmptyString(record.permission);
    const objectType = nonEmptyString(record.objectType);
    const objectId = nonEmptyString(record.objectId);
    if (!permission || !objectType || !objectId) continue;
    const source = nonEmptyString(record.source);
    capabilities.push({ permission, objectType, objectId, ...(source ? { source } : {}) });
  }
  return capabilities;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
