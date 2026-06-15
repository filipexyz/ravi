/**
 * Legacy relation-ledger adapter.
 *
 * This module is intentionally not part of the default provider-runtime chain.
 * It remains only for legacy CLI, doctor, explain and migration flows that need
 * to inspect or clean relation-backed grants while Ravi authorization moves to
 * explicit providers and context capability snapshots.
 */

import { getContext } from "../cli/context.js";
import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextRecord } from "../router/router-db.js";
import {
  canWithCapabilities,
  canWithCapabilityContext as canWithSnapshotCapabilityContext,
  isDelegatedAuthorityContext,
  objectIdMatches,
  parseContextCapabilities,
} from "./capability-context.js";
import { materializeDelegatedAuthority, parseAuthorityPrincipal } from "./delegation.js";
import { snapshotSubjectCapabilities, snapshotSubjectDelegationOverrides } from "./local-grants-capabilities.js";
import { revalidatePolicyMaterializationsBeforeAuthorization } from "./policies.js";
import { hasRelation, listRelations } from "./relations.js";
import type { PermissionProvider, PermissionProviderDecision, PermissionProviderRequest } from "./provider-types.js";

export const localGrantsProvider: PermissionProvider = {
  id: "local-grants",
  version: "relation-store/v1",
  required: true,
  supports(request) {
    return Boolean(request.context || request.subject?.id || request.capabilities);
  },
  authorize(request) {
    return authorizeLocalGrantsProvider(request);
  },
  materializeCapabilities(subject, options) {
    return snapshotSubjectCapabilities(subject.type, subject.id, options);
  },
  materializeDelegationOverrides(subject, options) {
    return snapshotSubjectDelegationOverrides(subject.type, subject.id, options);
  },
};

export function authorizeLocalGrantsProvider(request: PermissionProviderRequest): PermissionProviderDecision {
  revalidatePolicyMaterializationsBeforeAuthorization();

  const context = request.context ?? undefined;
  if (context) {
    const allowed = canWithCapabilityContext(context, request.permission, request.objectType, request.objectId);
    return buildLocalGrantsDecision(request, allowed, {
      reasonCode: allowed ? "local_grants_context_allow" : "local_grants_context_deny",
      contextId: contextIdFrom(context),
    });
  }

  const capabilities = request.capabilities ?? undefined;
  if (capabilities) {
    const allowed = canWithCapabilities(capabilities, request.permission, request.objectType, request.objectId);
    return buildLocalGrantsDecision(request, allowed, {
      reasonCode: allowed ? "local_grants_capabilities_allow" : "local_grants_capabilities_deny",
    });
  }

  const subject = request.subject ?? undefined;
  if (!subject?.id) {
    return buildLocalGrantsDecision(request, false, {
      reasonCode: "local_grants_subject_missing",
    });
  }

  const allowed =
    subject.type === "agent"
      ? agentCanWithLocalGrants(subject.id, request.permission, request.objectType, request.objectId)
      : canSubjectWithLocalGrants(subject.type, subject.id, request.permission, request.objectType, request.objectId);

  return buildLocalGrantsDecision(request, allowed, {
    reasonCode: allowed ? "local_grants_subject_allow" : "local_grants_subject_deny",
    subject,
  });
}

export function canSubjectWithLocalGrants(
  subjectType: string,
  subjectId: string,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  revalidatePolicyMaterializationsBeforeAuthorization();
  return canSubjectInternal(subjectType, subjectId, permission, objectType, objectId, new Set());
}

export function agentCanWithLocalGrants(
  agentId: string | undefined,
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  if (!agentId) return false;

  const scopedContext = getScopedContext(agentId);
  if (scopedContext) {
    return canWithCapabilityContext(
      { ...scopedContext, agentId: scopedContext.agentId ?? agentId },
      permission,
      objectType,
      objectId,
    );
  }

  if (isAgentSuperadmin(agentId)) return true;

  return canSubjectWithLocalGrants("agent", agentId, permission, objectType, objectId);
}

function isSuperadmin(subjectType: string, subjectId: string): boolean {
  return hasRelation(subjectType, subjectId, "admin", "system", "*");
}

function isAgentSuperadmin(agentId: string | undefined): boolean {
  return Boolean(agentId && isSuperadmin("agent", agentId));
}

export function canWithCapabilityContext(
  context: Parameters<typeof canWithSnapshotCapabilityContext>[0],
  permission: string,
  objectType: string,
  objectId: string,
): boolean {
  revalidatePolicyMaterializationsBeforeAuthorization();
  const liveDelegatedDecision = canWithLiveDelegatedAuthorityContext(context, permission, objectType, objectId);
  if (liveDelegatedDecision !== null) {
    return liveDelegatedDecision;
  }

  if (context.agentId && !isDelegatedAuthorityContext(context) && isAgentSuperadmin(context.agentId)) {
    return true;
  }

  if (canWithSnapshotCapabilityContext(context, permission, objectType, objectId)) {
    return true;
  }

  if (context.kind === "agent-runtime" && context.agentId && !isDelegatedAuthorityContext(context)) {
    return canSubjectWithLocalGrants("agent", context.agentId, permission, objectType, objectId);
  }

  return false;
}

function canSubjectInternal(
  subjectType: string,
  subjectId: string,
  permission: string,
  objectType: string,
  objectId: string,
  visitedRoles: Set<string>,
): boolean {
  if (isSuperadmin(subjectType, subjectId)) {
    return true;
  }

  if (hasRelation(subjectType, subjectId, permission, objectType, objectId)) {
    return true;
  }

  const candidateRelations = listRelations({
    subjectType,
    subjectId,
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
      subjectType,
      subjectId,
      relation: "use",
      objectType: "toolgroup",
    });
    for (const relation of groupRelations) {
      const members = resolveToolGroup(relation.objectId);
      if (members?.includes(objectId)) return true;
    }
  }

  const roleMemberships = listRelations({
    subjectType,
    subjectId,
    relation: "member",
    objectType: "role",
  });
  for (const membership of roleMemberships) {
    const roleId = membership.objectId;
    if (visitedRoles.has(roleId)) continue;
    visitedRoles.add(roleId);
    if (canSubjectInternal("role", roleId, permission, objectType, objectId, visitedRoles)) {
      return true;
    }
  }

  return false;
}

function getScopedContext(agentId: string): ContextRecord | undefined {
  const ctx = getContext();
  if (!ctx?.context) return undefined;
  if (ctx.agentId && ctx.agentId !== agentId) return undefined;
  return ctx.context;
}

function canWithLiveDelegatedAuthorityContext(
  context: Parameters<typeof canWithSnapshotCapabilityContext>[0],
  permission: string,
  objectType: string,
  objectId: string,
): boolean | null {
  if (!isDelegatedAuthorityContext(context)) return null;

  const snapshotAllowed = canWithSnapshotCapabilityContext(context, permission, objectType, objectId);
  const metadata = context.metadata ?? {};
  const executorAgentId = stringValue(metadata.executorAgentId) ?? context.agentId ?? null;
  const actorPrincipal = parseAuthorityPrincipal(metadata.actorPrincipal);
  if (!executorAgentId || !actorPrincipal) {
    return null;
  }

  const surfacePrincipal = parseAuthorityPrincipal(metadata.surfacePrincipal);
  const turnCapabilities = parseContextCapabilities(metadata.turnCapabilities);
  const materialized = materializeDelegatedAuthority({
    agentPrincipal: { subjectType: "agent", subjectId: executorAgentId },
    actorPrincipal,
    surfacePrincipal,
    agentCapabilities: snapshotSubjectCapabilities("agent", executorAgentId),
    actorCapabilities: snapshotSubjectCapabilities(actorPrincipal.subjectType, actorPrincipal.subjectId),
    surfaceCapabilities: surfacePrincipal
      ? snapshotSubjectCapabilities(surfacePrincipal.subjectType, surfacePrincipal.subjectId, { includeRoles: false })
      : [],
    agentDelegationOverrides: snapshotSubjectDelegationOverrides("agent", executorAgentId, { includeRoles: false }),
    surfaceDelegationOverrides: surfacePrincipal
      ? snapshotSubjectDelegationOverrides(surfacePrincipal.subjectType, surfacePrincipal.subjectId, {
          includeRoles: false,
        })
      : [],
    agentCapabilityAdditions: turnCapabilities,
    turnCapabilities: turnCapabilities.length > 0 ? turnCapabilities : undefined,
  });
  const liveAllowed = canWithCapabilities(materialized.effectiveCapabilities, permission, objectType, objectId);

  if (turnCapabilities.length > 0) {
    return liveAllowed;
  }
  const turnCapabilityCount = numberValue(metadata.turnCapabilityCount) ?? 0;
  if (turnCapabilityCount > 0) {
    return snapshotAllowed && liveAllowed;
  }

  return liveAllowed;
}

function buildLocalGrantsDecision(
  request: PermissionProviderRequest,
  allowed: boolean,
  details: Partial<Pick<PermissionProviderDecision, "subject" | "contextId">> & { reasonCode: string },
): PermissionProviderDecision {
  return {
    decision: allowed ? "allow" : "deny",
    allowed,
    providerId: localGrantsProvider.id,
    providerVersion: localGrantsProvider.version,
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    ...details,
  };
}

function contextIdFrom(context: PermissionProviderRequest["context"]): string | undefined {
  const value = (context as { contextId?: unknown } | null | undefined)?.contextId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export {
  DEFAULT_MANUAL_GRANT_TTL_MS,
  clearRelations,
  grantRelation,
  grantRelationIfAbsentOrOwned,
  hasRelation,
  listRelations,
  pruneRevokedRelations,
  restoreRelationsRevocationBatch,
  restoreRelationsRevokedAt,
  revokeRelation,
  revokeRelationIfSource,
  syncRelationsFromConfig,
  type GrantRelationIfAbsentOrOwnedResult,
  type GrantRelationOptions,
  type GrantMode,
  type OwnedGrantStatus,
  type Relation,
  type RelationFilter,
  type RestoreRelationsResult,
  type RevokeRelationOptions,
} from "./relations.js";
