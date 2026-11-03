import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import {
  usageEventTypes,
  usageMetricKeys,
  type UsageEventRecordInput,
} from "./usage-metering";

const MAX_USAGE_EVENTS_PER_BATCH = 50;
const MAX_JSON_FIELD_BYTES = 8_192;
const MAX_TEXT_LENGTH = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SOURCES = new Set(["pages_worker"]);
const ALLOWED_EVENT_TYPES: Set<string> = new Set([
  usageEventTypes.pagesBytesServed,
  usageEventTypes.pagesEdgeError,
  usageEventTypes.pagesPrivateAuthCheck,
  usageEventTypes.pagesRequestServed,
  usageEventTypes.pagesResolveFallback,
]);
const ALLOWED_METRIC_KEYS: Set<string> = new Set([
  usageMetricKeys.pagesBytesServed,
  usageMetricKeys.pagesEdgeErrors,
  usageMetricKeys.pagesPrivateAuthChecks,
  usageMetricKeys.pagesRequestsPrivate,
  usageMetricKeys.pagesRequestsPublic,
  usageMetricKeys.pagesResolveFallbacks,
]);
const FORBIDDEN_JSON_KEYS = new Set([
  "accesskey",
  "accesskeyid",
  "authorization",
  "bucket",
  "cookie",
  "credential",
  "credentials",
  "endpoint",
  "objectkey",
  "providerrequestid",
  "r2key",
  "rawobjectkey",
  "secret",
  "secretaccesskey",
  "signedurl",
  "storagekey",
  "token",
  "url",
]);

export type UsageIngestPayload = {
  events?: unknown;
};

export type UsageIngestResult = {
  accepted: number;
};

export class UsageIngestValidationError extends Error {
  constructor(message = "invalid_usage_events") {
    super(message);
    this.name = "UsageIngestValidationError";
  }
}

export async function ingestUsageEvents(input: {
  payload: UsageIngestPayload;
  requestId: string;
}): Promise<UsageIngestResult> {
  const events = normalizeUsageEvents(input.payload, input.requestId);
  if (events.length === 0) return { accepted: 0 };

  await db.insert(schema.usageEvents).values(events).onConflictDoNothing();
  return { accepted: events.length };
}

export function normalizeUsageEvents(payload: UsageIngestPayload, requestId: string): UsageEventRecordInput[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new UsageIngestValidationError();
  }

  if (!Array.isArray(payload.events)) {
    throw new UsageIngestValidationError();
  }

  if (payload.events.length > MAX_USAGE_EVENTS_PER_BATCH) {
    throw new UsageIngestValidationError();
  }

  return payload.events.map((event, index) => normalizeUsageEvent(event, requestId, index));
}

function normalizeUsageEvent(event: unknown, fallbackRequestId: string, index: number): UsageEventRecordInput {
  const record = usageRecord(event);
  const source = requiredText(record.source, "source");
  const eventType = requiredText(record.eventType, "eventType");
  const metricKey = requiredText(record.metricKey, "metricKey");
  const unit = requiredText(record.unit, "unit");
  if (!ALLOWED_SOURCES.has(source)) throw new UsageIngestValidationError("invalid_usage_source");
  if (!ALLOWED_EVENT_TYPES.has(eventType)) throw new UsageIngestValidationError("invalid_usage_event_type");
  if (!ALLOWED_METRIC_KEYS.has(metricKey)) throw new UsageIngestValidationError("invalid_usage_metric");

  const normalized: UsageEventRecordInput = {
    organizationId: requiredUuid(record.organizationId, "organizationId"),
    projectId: optionalUuid(record.projectId, "projectId"),
    siteId: optionalUuid(record.siteId, "siteId"),
    releaseId: optionalUuid(record.releaseId, "releaseId"),
    routeId: optionalUuid(record.routeId, "routeId"),
    artifactId: optionalUuid(record.artifactId, "artifactId"),
    artifactVersionId: optionalUuid(record.artifactVersionId, "artifactVersionId"),
    assetId: optionalUuid(record.assetId, "assetId"),
    publishId: optionalUuid(record.publishId, "publishId"),
    source,
    eventType,
    metricKey,
    quantity: quantity(record.quantity),
    unit,
    dimensionsJson: safeJsonRecord(record.dimensionsJson, "dimensionsJson"),
    measurementsJson: safeJsonRecord(record.measurementsJson, "measurementsJson"),
    evidenceJson: safeJsonRecord(record.evidenceJson, "evidenceJson"),
    metadataJson: safeJsonRecord(record.metadataJson, "metadataJson"),
    idempotencyKey: optionalText(record.idempotencyKey, "idempotencyKey") ?? `${fallbackRequestId}:${index}`,
    requestId: optionalText(record.requestId, "requestId") ?? fallbackRequestId,
    occurredAt: optionalDate(record.occurredAt, "occurredAt"),
  };

  return normalized;
}

function usageRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageIngestValidationError();
  }
  return value as Record<string, unknown>;
}

function requiredUuid(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!UUID_PATTERN.test(text)) throw new UsageIngestValidationError(`invalid_${field}`);
  return text;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = requiredText(value, field);
  if (!UUID_PATTERN.test(text)) throw new UsageIngestValidationError(`invalid_${field}`);
  return text;
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value, field);
  if (!text) throw new UsageIngestValidationError(`invalid_${field}`);
  return text;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new UsageIngestValidationError(`invalid_${field}`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (text.length > MAX_TEXT_LENGTH) throw new UsageIngestValidationError(`invalid_${field}`);
  return text || null;
}

function quantity(value: unknown): string {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) throw new UsageIngestValidationError("invalid_quantity");
  return String(numeric);
}

function safeJsonRecord(value: unknown, field: string): JsonRecord {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UsageIngestValidationError(`invalid_${field}`);
  }

  const record = value as JsonRecord;
  assertNoForbiddenJsonKeys(record, field);
  if (JSON.stringify(record).length > MAX_JSON_FIELD_BYTES) {
    throw new UsageIngestValidationError(`invalid_${field}`);
  }
  return record;
}

function assertNoForbiddenJsonKeys(value: unknown, field: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenJsonKeys(item, field);
    return;
  }

  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (FORBIDDEN_JSON_KEYS.has(key.toLowerCase())) {
      throw new UsageIngestValidationError(`invalid_${field}`);
    }
    assertNoForbiddenJsonKeys(item, field);
  }
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new UsageIngestValidationError(`invalid_${field}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new UsageIngestValidationError(`invalid_${field}`);
  return date;
}
