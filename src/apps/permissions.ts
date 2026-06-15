import { getContext } from "../cli/context.js";
import { agentCan, canWithCapabilityContext, localOperatorCan } from "../permissions/provider-runtime.js";
import { normalizeAppId } from "./service.js";
import type { RaviAppCheckResult, RaviAppManifestRecord } from "./types.js";

export function canUseApp(appId: string): boolean {
  return canAccessApp(appId, "use");
}

export function canExecuteApp(appId: string): boolean {
  return canAccessApp(appId, "execute");
}

export function canAccessApp(appId: string, relation: "use" | "execute"): boolean {
  const normalizedAppId = normalizeAppId(appId);
  const ctx = getContext();
  if (!ctx?.agentId) return localOperatorCan(relation, "app", normalizedAppId);

  return ctx.context
    ? canWithCapabilityContext(
        { ...ctx.context, agentId: ctx.context.agentId ?? ctx.agentId },
        relation,
        "app",
        normalizedAppId,
      )
    : agentCan(ctx.agentId, relation, "app", normalizedAppId);
}

export function filterVisibleAppManifests<T extends RaviAppManifestRecord>(records: T[]): T[] {
  return records.filter((record) => canUseApp(record.manifest?.id ?? record.id));
}

export function filterVisibleAppChecks<T extends RaviAppCheckResult>(records: T[]): T[] {
  return records.filter((record) => canUseApp(record.id));
}

export function assertCanUseApp(appId: string): void {
  const normalizedAppId = normalizeAppId(appId);
  if (canUseApp(normalizedAppId)) return;
  throw new Error(`App not found: ${normalizedAppId}`);
}

export function assertCanRunAppOperation(appId: string, operationId: string, mutating: boolean): void {
  const normalizedAppId = normalizeAppId(appId);
  const relation = mutating ? "execute" : "use";
  if (canAccessApp(normalizedAppId, relation)) return;

  const ctx = getContext();
  throw new Error(
    `Permission denied: agent:${ctx?.agentId ?? "unknown"} requires ${relation} on app:${normalizedAppId} for ${operationId}`,
  );
}
