import { getContext } from "../cli/context.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
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
  recordAppPermissionDenial(normalizedAppId, "use", `Permission denied: requires use on app:${normalizedAppId}`);
  throw new Error(`App not found: ${normalizedAppId}`);
}

export function assertCanRunAppOperation(appId: string, operationId: string, mutating: boolean): void {
  const normalizedAppId = normalizeAppId(appId);
  const relation = mutating ? "execute" : "use";
  if (canAccessApp(normalizedAppId, relation)) return;

  const ctx = getContext();
  const reason = `Permission denied: agent:${ctx?.agentId ?? "unknown"} requires ${relation} on app:${normalizedAppId} for ${operationId}`;
  recordAppPermissionDenial(normalizedAppId, relation, reason, operationId);
  throw new Error(reason);
}

function recordAppPermissionDenial(
  appId: string,
  relation: "use" | "execute",
  reason: string,
  operationId?: string,
): void {
  const ctx = getContext();
  if (!ctx?.agentId) return;
  const context = ctx.context
    ? {
        ...ctx.context,
        agentId: ctx.context.agentId ?? ctx.agentId,
      }
    : undefined;
  const provenance = buildAuditContextProvenance(context ? { context } : { agentId: ctx.agentId });

  recordAndEmitPermissionDenial({
    subjectType: "agent",
    subjectId: ctx.agentId,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey ?? context?.sessionKey,
    sessionName: ctx.sessionName ?? context?.sessionName,
    contextId: ctx.contextId ?? context?.contextId,
    relation,
    objectType: "app",
    objectId: appId,
    reason,
    detail: {
      ...(operationId ? { operationId } : {}),
      ...(provenance ? { context: provenance } : {}),
    },
    audit: {
      type: "scope",
      agentId: ctx.agentId,
      denied: `app:${appId}`,
      reason,
      blockType: "app_permission_missing_grant",
      ...(operationId ? { command: `apps.run ${operationId}` } : {}),
      ...(provenance ? { context: provenance } : {}),
    },
  });
}
