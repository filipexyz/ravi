// Audit events for base, property, view, chart, subscription, and row purge
// mutations. Metadata carries ids, keys, types, and versions only; never row
// values.

import { schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { basesCallerAgent, type BasesCaller } from "./context";
import type { BasesExecutor } from "./repository";
import { basesServiceIdentity } from "./service-principal";

export type BasesAuditTargetType = "base" | "base_property" | "base_view" | "base_chart" | "base_subscription" | "base_row";

export type BasesAuditInput = {
  caller: BasesCaller;
  organizationId: string;
  projectId: string;
  targetType: BasesAuditTargetType;
  targetId: string;
  /** `bases.<entity>.<verb>`. */
  action: string;
  metadata?: JsonRecord;
};

export function buildBasesAuditEvent(input: BasesAuditInput): typeof schema.auditEvents.$inferInsert {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorType: input.caller.actorType,
    actorId: input.caller.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    requestId: input.caller.requestId,
    metadataJson: {
      surface: input.caller.surface,
      sourceKind: input.caller.source.kind,
      ...(basesServiceIdentity(input.caller) ? { service: basesServiceIdentity(input.caller) } : {}),
      ...(input.caller.localInstallationId ? { localInstallationId: input.caller.localInstallationId } : {}),
      ...(input.caller.pageSiteId ? { pageSiteId: input.caller.pageSiteId } : {}),
      ...(basesCallerAgent(input.caller) ? { agentId: basesCallerAgent(input.caller)!.id } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

export async function insertBasesAudit(executor: BasesExecutor, input: BasesAuditInput) {
  await executor.insert(schema.auditEvents).values(buildBasesAuditEvent(input));
}
