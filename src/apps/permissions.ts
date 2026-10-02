import { getContext } from "../cli/context.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
import { authorizationAgentId, authorizationContext } from "../permissions/authorization-agent.js";
import { agentCan, canWithCapabilityContext, localOperatorCan } from "../permissions/provider-runtime.js";
import { isLocalOperatorScope } from "../permissions/scope.js";
import { normalizeAppId } from "./service.js";
import { RaviAppError, type RaviAppCheckResult, type RaviAppManifestRecord } from "./types.js";

export class RaviAppPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaviAppPermissionDeniedError";
  }
}

export function canUseApp(appId: string): boolean {
  return canAccessApp(appId, "use");
}

export function canExecuteApp(appId: string): boolean {
  return canAccessApp(appId, "execute");
}

export function canAccessApp(appId: string, relation: "use" | "execute"): boolean {
  const normalizedAppId = normalizeAppId(appId);
  const ctx = getContext();
  if (isLocalOperatorScope(ctx)) return localOperatorCan(relation, "app", normalizedAppId);

  return ctx?.context
    ? canWithCapabilityContext(authorizationContext(ctx.context, ctx.agentId), relation, "app", normalizedAppId)
    : agentCan(authorizationAgentId(ctx?.agentId), relation, "app", normalizedAppId);
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
  throw new RaviAppError("not_found", `App not found: ${normalizedAppId}`);
}

export function assertCanRunAppOperation(appId: string, operationId: string, mutating: boolean): void {
  const normalizedAppId = normalizeAppId(appId);
  const relation = mutating ? "execute" : "use";
  if (canAccessApp(normalizedAppId, relation)) return;

  const ctx = getContext();
  const reason = `Permission denied: agent:${ctx?.agentId ?? "unknown"} requires ${relation} on app:${normalizedAppId} for ${operationId}`;
  recordAppPermissionDenial(normalizedAppId, relation, reason, operationId);
  throw new RaviAppPermissionDeniedError(reason);
}

function recordAppPermissionDenial(
  appId: string,
  relation: "use" | "execute",
  reason: string,
  operationId?: string,
): void {
  const ctx = getContext();
  // Denials are recorded against a real agent; an audit-only label is not one.
  const agentId = authorizationAgentId(ctx?.agentId);
  if (!ctx || !agentId) return;
  const context = ctx.context ? authorizationContext(ctx.context, agentId) : undefined;
  const provenance = buildAuditContextProvenance(context ? { context } : { agentId });

  recordAndEmitPermissionDenial({
    subjectType: "agent",
    subjectId: agentId,
    agentId,
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
      agentId,
      denied: `app:${appId}`,
      reason,
      blockType: "app_permission_missing_grant",
      ...(operationId ? { command: `apps.run ${operationId}` } : {}),
      ...(provenance ? { context: provenance } : {}),
    },
  });
}
