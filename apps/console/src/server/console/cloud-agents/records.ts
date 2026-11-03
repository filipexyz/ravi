// Audit events, usage events and inbox notifications of cloud agents.

import { recordAgentInboxItem } from "@/server/console/agent-inbox";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

type Executor = Pick<typeof db, "insert">;

export const CLOUD_USAGE_METRICS = {
  runs: "cloud_agents.runs",
  runningSeconds: "cloud_agents.running_seconds",
  listCostUsdMicros: "cloud_agents.list_cost_usd_micros",
} as const;

export async function recordCloudAudit(
  input: {
    organizationId: string;
    projectId: string | null;
    actorType: "user" | "cli" | "system";
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    requestId: string | null;
    before?: JsonRecord | null;
    after?: JsonRecord | null;
    metadata?: JsonRecord;
  },
  executor: Executor = db,
) {
  await executor.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    projectId: input.projectId,
    actorType: input.actorType,
    actorId: input.actorId,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    requestId: input.requestId,
    beforeJson: input.before ?? null,
    afterJson: input.after ?? null,
    metadataJson: input.metadata ?? {},
  });
}

/**
 * Usage of one run as deltas since the last record (`recorded`), each with an
 * idempotency key so a retried sync never counts twice. Not billable by Ravi:
 * the organization pays the provider.
 */
export async function recordCloudRunUsage(
  input: {
    organizationId: string;
    projectId: string;
    runId: string;
    agentId: string;
    trigger: string;
    requestId: string | null;
    recorded: { runs?: number; runningSeconds?: number; costMicros?: number };
    current: { runningSeconds: number; costMicros: number };
    occurredAt: Date;
  },
  executor: Executor = db,
) {
  const next = {
    runs: 1,
    runningSeconds: Math.max(input.recorded.runningSeconds ?? 0, input.current.runningSeconds),
    costMicros: Math.max(input.recorded.costMicros ?? 0, input.current.costMicros),
  };
  const deltas: { metricKey: string; quantity: number; unit: string; total: number }[] = [
    { metricKey: CLOUD_USAGE_METRICS.runs, quantity: next.runs - (input.recorded.runs ?? 0), unit: "count", total: next.runs },
    {
      metricKey: CLOUD_USAGE_METRICS.runningSeconds,
      quantity: next.runningSeconds - (input.recorded.runningSeconds ?? 0),
      unit: "second",
      total: next.runningSeconds,
    },
    {
      metricKey: CLOUD_USAGE_METRICS.listCostUsdMicros,
      quantity: next.costMicros - (input.recorded.costMicros ?? 0),
      unit: "usd_micros",
      total: next.costMicros,
    },
  ];
  const events = deltas
    .filter((delta) => delta.quantity > 0)
    .map((delta) => ({
      organizationId: input.organizationId,
      projectId: input.projectId,
      source: "cloud_agents",
      eventType: "cloud_agents.run.usage",
      metricKey: delta.metricKey,
      quantity: String(delta.quantity),
      unit: delta.unit,
      dimensionsJson: { service: "cloud_agents", provider: "anthropic", agentId: input.agentId, trigger: input.trigger },
      measurementsJson: { delta: delta.quantity, total: delta.total },
      evidenceJson: { runId: input.runId },
      metadataJson: {},
      idempotencyKey: `${input.runId}:${delta.metricKey}:${delta.total}`,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
    }));
  if (events.length > 0) await executor.insert(schema.usageEvents).values(events).onConflictDoNothing();
  return next;
}

export async function notifyCloudActor(input: {
  organizationId: string;
  projectId: string | null;
  userId: string;
  eventType: string;
  severity: "info" | "success" | "warning" | "error" | "action_required";
  title: string;
  summary: string;
  sourceId: string;
  dedupeKey: string;
  url: string | null;
  payload: JsonRecord;
  occurredAt: Date;
}) {
  const item = await recordAgentInboxItem({
    organizationId: input.organizationId,
    projectId: input.projectId,
    sourceType: "cloud_agents",
    sourceId: input.sourceId,
    eventType: input.eventType,
    category: "cloud_agents",
    severity: input.severity,
    sensitivity: "metadata",
    title: input.title.slice(0, 200),
    summary: input.summary.slice(0, 1000),
    actorType: "system",
    actorId: null,
    targetType: "user",
    targetId: input.userId,
    dedupeKey: input.dedupeKey,
    payloadJson: input.payload,
    linksJson: input.url ? { runUrl: input.url } : {},
    occurredAt: input.occurredAt,
  });
  return item?.id ?? null;
}
