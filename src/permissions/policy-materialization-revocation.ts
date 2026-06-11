import {
  dbListContexts,
  dbRevokeContextCascade,
  getDb,
  type ContextCapability,
  type ContextRecord,
} from "../router/router-db.js";
import { revokeRelationIfSource } from "./relations.js";

const POLICY_SOURCE_PREFIX = "policy:";

interface PolicyMaterializationRevocationRow {
  id: string;
  policy_id: string;
  subject_type: string;
  subject_id: string;
  relation: string;
  object_type: string;
  object_id: string;
}

export interface PolicyMaterializationRevocationTuple {
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
}

function policySource(policyId: string): string {
  return `${POLICY_SOURCE_PREFIX}${policyId}`;
}

function revokeMaterializationRows(rows: PolicyMaterializationRevocationRow[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const now = Date.now();
  let revoked = 0;
  const revokedTuples: PolicyMaterializationRevocationTuple[] = [];

  for (const row of rows) {
    revokeRelationIfSource(
      row.subject_type,
      row.subject_id,
      row.relation,
      row.object_type,
      row.object_id,
      policySource(row.policy_id),
    );
    const result = db
      .prepare(
        `
        UPDATE permission_policy_materializations
        SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `,
      )
      .run(now, now, row.id);
    if (result.changes > 0) {
      revoked++;
      revokedTuples.push({
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        relation: row.relation,
        objectType: row.object_type,
        objectId: row.object_id,
      });
    }
  }

  revokeRuntimeContextsForPolicyMaterializations(revokedTuples);

  return revoked;
}

export function revokeRuntimeContextsForPolicyMaterializations(tuples: PolicyMaterializationRevocationTuple[]): number {
  if (tuples.length === 0) return 0;
  const liveContexts = dbListContexts({ includeInactive: false });
  const revokedContextIds = new Set<string>();

  for (const tuple of tuples) {
    for (const context of liveContexts) {
      if (revokedContextIds.has(context.contextId)) continue;
      if (!contextDependsOnPolicyTuple(context, tuple)) continue;
      const result = dbRevokeContextCascade(context.contextId, {
        reason: "policy_materialization_revoked",
      });
      revokedContextIds.add(result.context.contextId);
      for (const cascaded of result.cascaded) {
        revokedContextIds.add(cascaded.contextId);
      }
    }
  }

  return revokedContextIds.size;
}

function contextDependsOnPolicyTuple(context: ContextRecord, tuple: PolicyMaterializationRevocationTuple): boolean {
  if (contextPrincipalMatches(context, tuple.subjectType, tuple.subjectId)) return true;
  if (context.capabilities.some((capability) => capabilityMatchesTuple(capability, tuple))) return true;
  if (tuple.objectType === "role" && (tuple.relation === "member" || tuple.relation === "constrain")) {
    return context.capabilities.some((capability) => capabilitySourceIncludesRole(capability, tuple.objectId));
  }
  return false;
}

function contextPrincipalMatches(context: ContextRecord, subjectType: string, subjectId: string): boolean {
  const principal = `${subjectType}:${subjectId}`;
  if (context.metadata?.actorPrincipal === principal) return true;
  if (context.metadata?.surfacePrincipal === principal) return true;
  if (context.metadata?.executorAgentId === subjectId && subjectType === "agent") return true;
  if (context.agentId === subjectId && subjectType === "agent") return true;
  if ((context.sessionKey === subjectId || context.sessionName === subjectId) && subjectType === "session") return true;
  return false;
}

function capabilityMatchesTuple(capability: ContextCapability, tuple: PolicyMaterializationRevocationTuple): boolean {
  if (capability.permission !== tuple.relation || capability.objectType !== tuple.objectType) return false;
  if (capability.objectId === tuple.objectId) return true;
  if (capability.objectId === "*" || tuple.objectId === "*") return true;
  if (capability.objectId.endsWith("*") && tuple.objectId.startsWith(capability.objectId.slice(0, -1))) return true;
  if (tuple.objectId.endsWith("*") && capability.objectId.startsWith(tuple.objectId.slice(0, -1))) return true;
  return false;
}

function capabilitySourceIncludesRole(capability: ContextCapability, roleId: string): boolean {
  return typeof capability.source === "string" && capability.source.split("/").includes(`role:${roleId}`);
}

export function revokePolicyMaterializationsForSelector(input: {
  assetType: string;
  assetId: string;
  tagSlug: string;
}): number {
  const rows = getDb()
    .prepare(
      `
      SELECT id, policy_id, subject_type, subject_id, relation, object_type, object_id
      FROM permission_policy_materializations
      WHERE selector_asset_type = ?
        AND selector_asset_id = ?
        AND tag_slug = ?
        AND revoked_at IS NULL
    `,
    )
    .all(input.assetType, input.assetId, input.tagSlug) as PolicyMaterializationRevocationRow[];

  return revokeMaterializationRows(rows);
}
