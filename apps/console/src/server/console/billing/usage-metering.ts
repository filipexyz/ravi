import { createHash } from "node:crypto";

import type { JsonRecord } from "@/server/db/schema";

export const usageMetricKeys = {
  pagesAssetBytesStored: "pages.asset.bytes_stored",
  pagesBytesServed: "pages.bytes_served",
  pagesEdgeErrors: "pages.edge.errors",
  pagesManifestBytesStored: "pages.manifest.bytes_stored",
  pagesPrivateAuthChecks: "pages.private_auth_checks",
  pagesRequestsPrivate: "pages.requests.private",
  pagesRequestsPublic: "pages.requests.public",
  pagesReleaseActivations: "pages.release.activations",
  pagesResolveFallbacks: "pages.resolve.fallbacks",
  pagesChatSessions: "pages.chat.sessions",
  pagesChatVoiceSeconds: "pages.chat.voice_seconds",
  pagesChatModelInputTokens: "pages.chat.model_input_tokens",
  pagesChatModelCachedInputTokens: "pages.chat.model_cached_input_tokens",
  pagesChatModelOutputTokens: "pages.chat.model_output_tokens",
  pagesChatToolCalls: "pages.chat.tool_calls",
  pagesChatTextTurns: "pages.chat.text_turns",
  meetingsBots: "meetings.bots",
  meetingsRecordingSeconds: "meetings.recording_seconds",
  knowledgeSearches: "knowledge.searches",
  knowledgeChunksStored: "knowledge.chunks_stored",
  knowledgePageChatSearches: "knowledge.page_chat_searches",
} as const;

export const usageEventTypes = {
  pagesAssetStored: "pages.asset_stored",
  pagesBytesServed: "pages.bytes_served",
  pagesEdgeError: "pages.edge_error",
  pagesManifestStored: "pages.manifest_stored",
  pagesPrivateAuthCheck: "pages.private_auth_check",
  pagesRequestServed: "pages.request_served",
  pagesReleaseActivated: "pages.release_activated",
  pagesResolveFallback: "pages.resolve_fallback",
  pagesChatSessionStarted: "pages.chat.session_started",
  pagesChatSessionClosed: "pages.chat.session_closed",
  pagesChatToolCalled: "pages.chat.tool_called",
  pagesChatTextTurnCompleted: "pages.chat.text_turn_completed",
  meetingsRecordingClosed: "meetings.recording_closed",
  knowledgeSearchCompleted: "knowledge.search_completed",
  knowledgeDocumentIngested: "knowledge.document_ingested",
  knowledgePageChatSearch: "knowledge.page_chat_search",
} as const;

export type UsageEventRecordInput = {
  organizationId: string;
  projectId?: string | null;
  siteId?: string | null;
  releaseId?: string | null;
  routeId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  assetId?: string | null;
  publishId?: string | null;
  source: string;
  eventType: string;
  metricKey: string;
  quantity: string;
  unit: string;
  dimensionsJson: JsonRecord;
  measurementsJson: JsonRecord;
  evidenceJson: JsonRecord;
  metadataJson: JsonRecord;
  idempotencyKey?: string | null;
  requestId?: string | null;
  occurredAt?: Date;
};

export type UsageDimensionInput = {
  organizationId: string;
  projectId?: string | null;
  siteId?: string | null;
  releaseId?: string | null;
  routeId?: string | null;
  artifactId?: string | null;
  artifactVersionId?: string | null;
  assetId?: string | null;
  publishId?: string | null;
};

export type PagesAssetStoredUsageInput = UsageDimensionInput & {
  assetPath: string;
  cache: string;
  contentType: string;
  requestId: string;
  sha256?: string | null;
  sizeBytes: number;
  storageKey?: string | null;
  visibility: string;
};

export type PagesManifestStoredUsageInput = UsageDimensionInput & {
  byteLength: number;
  manifestHash: string;
  manifestKind: "artifact_version" | "site_release";
  requestId: string;
  storageKey?: string | null;
};

export type PagesReleaseActivatedUsageInput = UsageDimensionInput & {
  requestId: string;
  releaseNumber: number;
  routeCount: number;
  visibility: string;
};

export function buildPagesAssetStoredUsageEvent(input: PagesAssetStoredUsageInput): UsageEventRecordInput {
  const dimensionsJson = compactJson({
    service: "pages",
    object: "asset",
    assetPath: input.assetPath,
    cache: input.cache,
    contentType: input.contentType,
    visibility: input.visibility,
  });

  return {
    ...usageDimensions(input),
    source: "pages_publish",
    eventType: usageEventTypes.pagesAssetStored,
    metricKey: usageMetricKeys.pagesAssetBytesStored,
    quantity: decimalQuantity(input.sizeBytes),
    unit: "bytes",
    dimensionsJson,
    measurementsJson: compactJson({
      bytesStored: input.sizeBytes,
      objectsStored: 1,
      writeOperations: 1,
    }),
    evidenceJson: compactJson({
      storageBackend: "object_storage",
      storageKeyHash: input.storageKey ? stableHash(input.storageKey) : null,
    }),
    metadataJson: compactJson({
      sha256: input.sha256,
    }),
    idempotencyKey: usageIdempotencyKey("pages.asset_stored", input.publishId, input.assetId ?? input.assetPath),
    requestId: input.requestId,
  };
}

export function buildPagesManifestStoredUsageEvent(input: PagesManifestStoredUsageInput): UsageEventRecordInput {
  const dimensionsJson = compactJson({
    service: "pages",
    object: "manifest",
    manifestKind: input.manifestKind,
  });

  return {
    ...usageDimensions(input),
    source: "pages_publish",
    eventType: usageEventTypes.pagesManifestStored,
    metricKey: usageMetricKeys.pagesManifestBytesStored,
    quantity: decimalQuantity(input.byteLength),
    unit: "bytes",
    dimensionsJson,
    measurementsJson: compactJson({
      bytesStored: input.byteLength,
      objectsStored: 1,
      writeOperations: 1,
    }),
    evidenceJson: compactJson({
      storageBackend: "object_storage",
      storageKeyHash: input.storageKey ? stableHash(input.storageKey) : null,
    }),
    metadataJson: compactJson({
      manifestHash: input.manifestHash,
    }),
    idempotencyKey: usageIdempotencyKey("pages.manifest_stored", input.publishId, input.manifestKind),
    requestId: input.requestId,
  };
}

export function buildPagesReleaseActivatedUsageEvent(input: PagesReleaseActivatedUsageInput): UsageEventRecordInput {
  return {
    ...usageDimensions(input),
    source: "pages_publish",
    eventType: usageEventTypes.pagesReleaseActivated,
    metricKey: usageMetricKeys.pagesReleaseActivations,
    quantity: "1",
    unit: "count",
    dimensionsJson: compactJson({
      service: "pages",
      object: "site_release",
      releaseNumber: input.releaseNumber,
      routeCount: input.routeCount,
      visibility: input.visibility,
    }),
    measurementsJson: compactJson({
      releasesActivated: 1,
      routeBindings: input.routeCount,
    }),
    evidenceJson: compactJson({}),
    metadataJson: compactJson({}),
    idempotencyKey: usageIdempotencyKey("pages.release_activated", input.releaseId, input.publishId ?? input.requestId),
    requestId: input.requestId,
  };
}

export function usageDimensionHash(input: UsageDimensionInput & { metricKey: string }): string {
  return stableHash(compactJson({
    organizationId: input.organizationId,
    projectId: input.projectId,
    siteId: input.siteId,
    releaseId: input.releaseId,
    routeId: input.routeId,
    artifactId: input.artifactId,
    artifactVersionId: input.artifactVersionId,
    assetId: input.assetId,
    publishId: input.publishId,
    metricKey: input.metricKey,
  }));
}

function usageDimensions(input: UsageDimensionInput) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    siteId: input.siteId ?? null,
    releaseId: input.releaseId ?? null,
    routeId: input.routeId ?? null,
    artifactId: input.artifactId ?? null,
    artifactVersionId: input.artifactVersionId ?? null,
    assetId: input.assetId ?? null,
    publishId: input.publishId ?? null,
  };
}

function usageIdempotencyKey(eventType: string, ...parts: Array<string | null | undefined>) {
  return [eventType, ...parts.map((part) => part ?? "none")].join(":");
}

function decimalQuantity(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0";
  return String(Math.trunc(value));
}

function compactJson(input: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  );
}

function stableHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
