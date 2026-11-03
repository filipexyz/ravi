import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  usageEventTypes,
  usageMetricKeys,
  type UsageEventRecordInput,
} from "@/server/console/billing/usage-metering";

// Meter-only Knowledge usage (no billing). Each event's idempotency key is
// `<eventType>:<id>:<metricKey>`, so recording twice inserts one row.

export type KnowledgeMetricKey =
  | typeof usageMetricKeys.knowledgeSearches
  | typeof usageMetricKeys.knowledgeChunksStored
  | typeof usageMetricKeys.knowledgePageChatSearches;

export type KnowledgeUsageEventType =
  | typeof usageEventTypes.knowledgeSearchCompleted
  | typeof usageEventTypes.knowledgeDocumentIngested
  | typeof usageEventTypes.knowledgePageChatSearch;

export function buildKnowledgeUsageEvent(input: {
  organizationId: string;
  projectId: string | null;
  metricKey: KnowledgeMetricKey;
  eventType: KnowledgeUsageEventType;
  id: string;
  quantity: number;
  requestId: string;
  dimensions?: JsonRecord;
}): UsageEventRecordInput {
  const quantity = Number.isFinite(input.quantity) && input.quantity > 0 ? Math.trunc(input.quantity) : 0;
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    source: "knowledge",
    eventType: input.eventType,
    metricKey: input.metricKey,
    quantity: String(quantity),
    unit: "count",
    dimensionsJson: compactJson({ ...input.dimensions, service: "knowledge" }),
    measurementsJson: { count: quantity },
    evidenceJson: { id: input.id },
    metadataJson: {},
    idempotencyKey: `${input.eventType}:${input.id}:${input.metricKey}`,
    requestId: input.requestId,
  };
}

export async function recordKnowledgeUsage(
  events: UsageEventRecordInput[],
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  if (events.length === 0) return;
  await executor.insert(schema.usageEvents).values(events).onConflictDoNothing();
}

function compactJson(input: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}
