import type { ContextCapability } from "../router/router-db.js";
import { AGENT_IDENTITY_AUTHORITY_MODE } from "./agent-identity-permissions-provider.js";
export { canWithCapabilities, matchPattern, objectIdMatches } from "./capability-snapshot.js";
import { canWithCapabilities } from "./capability-snapshot.js";

export interface CapabilityContextLike {
  agentId?: string | null;
  kind?: string | null;
  capabilities: ContextCapability[];
  metadata?: Record<string, unknown> | null;
}

export function canWithCapabilityContext(
  context: CapabilityContextLike,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  return canWithCapabilities(context.capabilities, permission, objectType, objectId);
}

export function isDelegatedAuthorityContext(context: Pick<CapabilityContextLike, "kind" | "metadata">): boolean {
  if (context.kind === "turn-runtime" || context.kind === "invocation-runtime") {
    return true;
  }
  return (
    context.metadata?.authorityMode === "delegated" || context.metadata?.authorityMode === AGENT_IDENTITY_AUTHORITY_MODE
  );
}

/**
 * Parse a `ContextCapability[]` out of untyped context metadata (e.g. serialized
 * `turnCapabilities`). Shared by provider adapters and explain so they read context
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
