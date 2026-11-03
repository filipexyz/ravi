import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { cliApiError } from "@/server/cli/errors";
import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export type DataPlaneWorkspace = ProjectAccessWorkspace & {
  localInstallation: {
    id: string;
    name: string;
    capabilitiesJson: string[];
  };
};

export type CloudSyncUploadResult = {
  accepted: number;
  duplicates: number;
  events: Array<{
    accepted: boolean;
    duplicate: boolean;
    eventId: string;
    sequence: number | null;
  }>;
  version: 1;
};

export type CloudSyncDownloadResult = {
  cursor: number;
  events: Array<{
    domain: string;
    entityId: string;
    entityRevision: number | null;
    entityType: string;
    eventId: string;
    eventType: string;
    evidenceRefs: JsonRecord[];
    idempotencyKey: string;
    occurredAt: string;
    originInstallationId: string | null;
    payload: JsonRecord;
    projectId: string | null;
    schemaVersion: number;
    sequence: number;
  }>;
  hasMore: boolean;
  nextCursor: number;
  serverTime: string;
  version: 1;
};

export type RuntimeTraceIngestResult = {
  accepted: {
    blobs: number;
    events: number;
    toolCalls: number;
    turns: number;
  };
  duplicates: {
    blobs: number;
    events: number;
  };
  traceSession: {
    id: string;
    externalTraceId: string;
    status: string;
  };
  version: 1;
};

export type NormalizedCloudSyncEvent = {
  domain: string;
  entityId: string;
  entityRevision: number | null;
  entityType: string;
  eventId: string;
  eventType: string;
  evidenceRefs: JsonRecord[];
  idempotencyKey: string;
  occurredAt: Date;
  occurredAtProvided: boolean;
  payload: JsonRecord;
  projectRef: string | null;
  schemaVersion: number;
};

export type NormalizedRuntimeTraceBatch = {
  blobs: NormalizedTraceBlob[];
  events: NormalizedTraceEvent[];
  session: NormalizedTraceSession;
  toolCalls: NormalizedTraceToolCall[];
  turns: NormalizedTraceTurn[];
};

type NormalizedTraceSession = {
  agentRef: string | null;
  endedAt: Date | null;
  externalTraceId: string;
  managedRuntimeInstanceId: string | null;
  managedRuntimeSessionId: string | null;
  placement: string;
  projectRef: string | null;
  runId: string | null;
  runtimeModel: string | null;
  runtimeProvider: string;
  safeMetadata: JsonRecord;
  source: NormalizedTraceSource | null;
  sessionKey: string;
  sessionName: string | null;
  startedAt: Date;
  status: string;
};

type NormalizedTraceSource = {
  accountId: string | null;
  canonicalChatId: string | null;
  channel: string | null;
  chatId: string | null;
  threadId: string | null;
};

type NormalizedTraceTurn = {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  completedAt: Date | null;
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  promptSha256: string | null;
  requestBlobSha256: string | null;
  requestBlobRef: string | null;
  responseBlobRef: string | null;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  sequence: number;
  sourceTurnId: string | null;
  startedAt: Date;
  status: string;
  systemPromptSha256: string | null;
  userPromptSha256: string | null;
};

type NormalizedTraceEvent = {
  blobRef: string | null;
  eventGroup: string;
  eventId: string;
  eventType: string;
  occurredAt: Date;
  safePayload: JsonRecord;
  safePreview: string | null;
  sequence: number;
  severity: string;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  source: NormalizedTraceSource | null;
  status: string | null;
  sourceTurnId: string | null;
};

type NormalizedTraceToolCall = {
  approval: JsonRecord;
  completedAt: Date | null;
  durationMs: number | null;
  inputBlobRef: string | null;
  inputPreview: string | null;
  outputBlobRef: string | null;
  outputPreview: string | null;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  sourceTurnId: string | null;
  startedAt: Date;
  status: string;
  toolCallId: string | null;
  toolName: string;
};

type NormalizedTraceBlob = {
  encryption: JsonRecord;
  kind: string;
  r2Key: string;
  retentionClass: string;
  runtimeLeaseId: string | null;
  sandboxId: string | null;
  sensitivity: string;
  sha256: string;
  sizeBytes: number;
  sourceTurnId: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const MAX_SYNC_EVENTS_PER_BATCH = 100;
const MAX_TRACE_EVENTS_PER_BATCH = 500;
const MAX_TRACE_TURNS_PER_BATCH = 100;
const MAX_TRACE_TOOL_CALLS_PER_BATCH = 200;
const MAX_TRACE_BLOBS_PER_BATCH = 200;
const MAX_JSON_FIELD_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 512;
const MAX_PREVIEW_LENGTH = 2_000;
const MAX_TRACE_TIMESTAMP_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRACE_TIMESTAMP_FUTURE_MS = 10 * 60 * 1000;
const MAX_SAFE_JSON_DEPTH = 32;
const FORBIDDEN_JSON_KEYS = new Set([
  "accesskey",
  "accesskeyid",
  "apikey",
  "api_key",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "private_key",
  "refresh",
  "refresh_token",
  "secret",
  "secretaccesskey",
  "signedurl",
  "token",
  "webhooksecret",
]);
const RAW_OUTPUT_KEY_RE = /(raw.*output|tool.*output.*raw|provider.*raw|full.*prompt|env|environment)/i;

export async function uploadCloudSyncEvents(input: {
  body: unknown;
  requestId: string;
  workspace: DataPlaneWorkspace;
}): Promise<CloudSyncUploadResult> {
  const events = normalizeCloudSyncEvents(input.body);
  const results: CloudSyncUploadResult["events"] = [];

  for (const event of events) {
    const projectId = await resolveOptionalProjectId(input.workspace, event.projectRef, "write");
    const sourceKind = "local_installation";
    const sourceId = input.workspace.localInstallation.id;
    const requestHash = cloudSyncRequestHash(event, projectId);
    const [inserted] = await db
      .insert(schema.cloudSyncEvents)
      .values({
        organizationId: input.workspace.organization.id,
        projectId,
        originInstallationId: input.workspace.localInstallation.id,
        sourceKind,
        sourceId,
        sourceEventId: event.eventId,
        domain: event.domain,
        eventType: event.eventType,
        entityType: event.entityType,
        entityId: event.entityId,
        entityRevision: event.entityRevision,
        idempotencyKey: event.idempotencyKey,
        requestHash,
        payloadJson: event.payload,
        evidenceJson: event.evidenceRefs,
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing()
      .returning({
        sequence: schema.cloudSyncEvents.sequence,
      });

    if (inserted) {
      results.push({
        accepted: true,
        duplicate: false,
        eventId: event.eventId,
        sequence: inserted.sequence,
      });
      continue;
    }

    const [existing] = await db
      .select({
        requestHash: schema.cloudSyncEvents.requestHash,
        sequence: schema.cloudSyncEvents.sequence,
      })
      .from(schema.cloudSyncEvents)
      .where(
        and(
          eq(schema.cloudSyncEvents.organizationId, input.workspace.organization.id),
          eq(schema.cloudSyncEvents.sourceKind, sourceKind),
          eq(schema.cloudSyncEvents.sourceId, sourceId),
          or(
            eq(schema.cloudSyncEvents.sourceEventId, event.eventId),
            eq(schema.cloudSyncEvents.idempotencyKey, event.idempotencyKey),
          ),
        ),
      )
      .limit(1);

    if (!existing) {
      throw cliApiError(409, "PAYLOAD_INVALID", "Sync event conflict.");
    }

    if (existing.requestHash !== requestHash) {
      throw cliApiError(409, "PAYLOAD_INVALID", "Sync event idempotency conflict.");
    }

    results.push({
      accepted: false,
      duplicate: true,
      eventId: event.eventId,
      sequence: existing.sequence,
    });
  }

  return {
    accepted: results.filter((event) => event.accepted).length,
    duplicates: results.filter((event) => event.duplicate).length,
    events: results,
    version: 1,
  };
}

export async function downloadCloudSyncEvents(input: {
  cursor: number;
  domain: string;
  limit?: number;
  projectRef?: string | null;
  scope?: string | null;
  workspace: DataPlaneWorkspace;
}): Promise<CloudSyncDownloadResult> {
  const domain = cleanText(input.domain, "domain");
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const projectId = await resolveSyncProjectId(input.workspace, input.projectRef ?? null, input.scope ?? null, "read");
  const predicates = [
    eq(schema.cloudSyncEvents.organizationId, input.workspace.organization.id),
    eq(schema.cloudSyncEvents.domain, domain),
    gt(schema.cloudSyncEvents.sequence, input.cursor),
    or(
      isNull(schema.cloudSyncEvents.originInstallationId),
      ne(schema.cloudSyncEvents.originInstallationId, input.workspace.localInstallation.id),
    ),
  ];

  if (projectId) predicates.push(eq(schema.cloudSyncEvents.projectId, projectId));

  const rows = await db
    .select()
    .from(schema.cloudSyncEvents)
    .where(and(...predicates))
    .orderBy(asc(schema.cloudSyncEvents.sequence))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const nextCursor = page.at(-1)?.sequence ?? input.cursor;

  await upsertCloudSyncCursor({
    domain,
    lastDeliveredSequence: nextCursor,
    projectId,
    workspace: input.workspace,
  });

  return {
    cursor: input.cursor,
    events: page.map((event) => ({
      domain: event.domain,
      entityId: event.entityId,
      entityRevision: event.entityRevision,
      entityType: event.entityType,
      eventId: event.sourceEventId,
      eventType: event.eventType,
      evidenceRefs: event.evidenceJson,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt.toISOString(),
      originInstallationId: event.originInstallationId,
      payload: event.payloadJson,
      projectId: event.projectId,
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
    })),
    hasMore,
    nextCursor,
    serverTime: new Date().toISOString(),
    version: 1,
  };
}

export async function ackCloudSyncEvents(input: {
  body: unknown;
  workspace: DataPlaneWorkspace;
}) {
  const record = input.body && typeof input.body === "object" && !Array.isArray(input.body)
    ? input.body as Record<string, unknown>
    : null;
  if (!record) throw cliApiError(400, "PAYLOAD_INVALID");

  const domain = cleanText(record.domain, "domain");
  const sequence = positiveInteger(record.sequence ?? record.cursor ?? record.lastAckedSequence, "sequence");
  const projectRef = optionalText(record.projectId ?? record.projectRef, "projectRef");
  const scope = optionalText(record.scope, "scope");
  const projectId = await resolveSyncProjectId(input.workspace, projectRef, scope, "read");
  const cursor = await upsertCloudSyncCursor({
    domain,
    lastAckedSequence: sequence,
    projectId,
    workspace: input.workspace,
  });

  return {
    version: 1 as const,
    cursor: {
      domain: cursor.domain,
      lastAckedSequence: cursor.lastAckedSequence,
      lastDeliveredSequence: cursor.lastDeliveredSequence,
      projectId: cursor.projectId,
      updatedAt: cursor.updatedAt.toISOString(),
    },
  };
}

export async function ingestRuntimeTraceBatch(input: {
  body: unknown;
  requestId: string;
  workspace: DataPlaneWorkspace;
}): Promise<RuntimeTraceIngestResult> {
  const normalized = normalizeRuntimeTraceBatch(input.body, input.requestId);
  const projectId = await resolveOptionalProjectId(input.workspace, normalized.session.projectRef, "write");
  const now = new Date();

  const [traceSession] = await db
    .insert(schema.runtimeTraceSessions)
    .values({
      organizationId: input.workspace.organization.id,
      projectId,
      localInstallationId: input.workspace.localInstallation.id,
      externalTraceId: normalized.session.externalTraceId,
      sessionKey: normalized.session.sessionKey,
      sessionName: normalized.session.sessionName,
      runId: normalized.session.runId,
      agentRef: normalized.session.agentRef,
      sourceChannel: normalized.session.source?.channel,
      sourceAccountId: normalized.session.source?.accountId,
      sourceChatId: normalized.session.source?.chatId,
      sourceThreadId: normalized.session.source?.threadId,
      canonicalChatId: normalized.session.source?.canonicalChatId,
      managedRuntimeInstanceId: normalized.session.managedRuntimeInstanceId,
      managedRuntimeSessionId: normalized.session.managedRuntimeSessionId,
      placement: normalized.session.placement,
      runtimeProvider: normalized.session.runtimeProvider,
      runtimeModel: normalized.session.runtimeModel,
      status: normalized.session.status,
      startedAt: normalized.session.startedAt,
      endedAt: normalized.session.endedAt,
      safeMetadataJson: normalized.session.safeMetadata,
    })
    .onConflictDoUpdate({
      target: [
        schema.runtimeTraceSessions.organizationId,
        schema.runtimeTraceSessions.localInstallationId,
        schema.runtimeTraceSessions.externalTraceId,
      ],
      set: {
        projectId,
        localInstallationId: input.workspace.localInstallation.id,
        sessionKey: normalized.session.sessionKey,
        sessionName: normalized.session.sessionName,
        runId: normalized.session.runId,
        agentRef: normalized.session.agentRef,
        sourceChannel: sql<string | null>`COALESCE(${normalized.session.source?.channel ?? null}, ${schema.runtimeTraceSessions.sourceChannel})`,
        sourceAccountId: sql<string | null>`COALESCE(${normalized.session.source?.accountId ?? null}, ${schema.runtimeTraceSessions.sourceAccountId})`,
        sourceChatId: sql<string | null>`COALESCE(${normalized.session.source?.chatId ?? null}, ${schema.runtimeTraceSessions.sourceChatId})`,
        sourceThreadId: sql<string | null>`COALESCE(${normalized.session.source?.threadId ?? null}, ${schema.runtimeTraceSessions.sourceThreadId})`,
        canonicalChatId: sql<string | null>`COALESCE(${normalized.session.source?.canonicalChatId ?? null}, ${schema.runtimeTraceSessions.canonicalChatId})`,
        managedRuntimeInstanceId: normalized.session.managedRuntimeInstanceId,
        managedRuntimeSessionId: normalized.session.managedRuntimeSessionId,
        placement: normalized.session.placement,
        runtimeProvider: normalized.session.runtimeProvider,
        runtimeModel: normalized.session.runtimeModel,
        status: normalized.session.status,
        endedAt: normalized.session.endedAt,
        safeMetadataJson: normalized.session.safeMetadata,
        updatedAt: now,
      },
    })
    .returning();

  if (!traceSession) throw cliApiError(503, "SERVER_UNAVAILABLE");

  const turnIdBySource = new Map<string, string>();
  let acceptedTurns = 0;

  for (const turn of normalized.turns) {
    const [row] = await db
      .insert(schema.runtimeTraceTurns)
      .values({
        traceSessionId: traceSession.id,
        organizationId: input.workspace.organization.id,
        projectId,
        sourceTurnId: turn.sourceTurnId,
        runtimeLeaseId: turn.runtimeLeaseId,
        sandboxId: turn.sandboxId,
        sequence: turn.sequence,
        status: turn.status,
        promptSha256: turn.promptSha256,
        userPromptSha256: turn.userPromptSha256,
        systemPromptSha256: turn.systemPromptSha256,
        requestBlobSha256: turn.requestBlobSha256,
        requestBlobRef: turn.requestBlobRef,
        responseBlobRef: turn.responseBlobRef,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheCreationTokens: turn.cacheCreationTokens,
        costUsd: turn.costUsd,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.runtimeTraceTurns.traceSessionId,
          schema.runtimeTraceTurns.sequence,
        ],
        set: {
          status: turn.status,
          promptSha256: turn.promptSha256,
          userPromptSha256: turn.userPromptSha256,
          systemPromptSha256: turn.systemPromptSha256,
          requestBlobSha256: turn.requestBlobSha256,
          requestBlobRef: turn.requestBlobRef,
          responseBlobRef: turn.responseBlobRef,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheCreationTokens: turn.cacheCreationTokens,
          costUsd: turn.costUsd,
          completedAt: turn.completedAt,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) continue;
    acceptedTurns += 1;
    if (row.sourceTurnId) turnIdBySource.set(row.sourceTurnId, row.id);
  }

  await hydrateExistingTraceTurns({
    blobs: normalized.blobs,
    events: normalized.events,
    toolCalls: normalized.toolCalls,
    traceSessionId: traceSession.id,
    turnIdBySource,
  });

  let acceptedEvents = 0;
  let duplicateEvents = 0;
  for (const event of normalized.events) {
    const [row] = await db
      .insert(schema.runtimeTraceEvents)
      .values({
        traceSessionId: traceSession.id,
        turnId: event.sourceTurnId ? turnIdBySource.get(event.sourceTurnId) ?? null : null,
        organizationId: input.workspace.organization.id,
        sourceEventId: event.eventId,
        runtimeLeaseId: event.runtimeLeaseId,
        sandboxId: event.sandboxId,
        sequence: event.sequence,
        eventType: event.eventType,
        eventGroup: event.eventGroup,
        severity: event.severity,
        status: event.status,
        safePreview: event.safePreview,
        safePayloadJson: event.safePayload,
        blobRef: event.blobRef,
        occurredAt: event.occurredAt,
      })
      .onConflictDoNothing({
        target: [
          schema.runtimeTraceEvents.traceSessionId,
          schema.runtimeTraceEvents.sourceEventId,
        ],
      })
      .returning({ id: schema.runtimeTraceEvents.id });
    if (row) acceptedEvents += 1;
    else duplicateEvents += 1;
  }

  let acceptedToolCalls = 0;
  for (const toolCall of normalized.toolCalls) {
    const turnId = toolCall.sourceTurnId ? turnIdBySource.get(toolCall.sourceTurnId) ?? null : null;
    if (toolCall.toolCallId) {
      const [existing] = await db
        .select({ id: schema.runtimeTraceToolCalls.id })
        .from(schema.runtimeTraceToolCalls)
        .where(
          and(
            eq(schema.runtimeTraceToolCalls.traceSessionId, traceSession.id),
            eq(schema.runtimeTraceToolCalls.toolCallId, toolCall.toolCallId),
          ),
        )
        .limit(1);
      if (existing) {
        await db
          .update(schema.runtimeTraceToolCalls)
          .set({
            turnId,
            status: toolCall.status,
            runtimeLeaseId: toolCall.runtimeLeaseId,
            sandboxId: toolCall.sandboxId,
            inputPreview: toolCall.inputPreview,
            outputPreview: toolCall.outputPreview,
            inputBlobRef: toolCall.inputBlobRef,
            outputBlobRef: toolCall.outputBlobRef,
            approvalJson: toolCall.approval,
            durationMs: toolCall.durationMs,
            completedAt: toolCall.completedAt,
            updatedAt: now,
          })
          .where(eq(schema.runtimeTraceToolCalls.id, existing.id));
        acceptedToolCalls += 1;
        continue;
      }
    }

    const [row] = await db
      .insert(schema.runtimeTraceToolCalls)
      .values({
        traceSessionId: traceSession.id,
        turnId,
        organizationId: input.workspace.organization.id,
        runtimeLeaseId: toolCall.runtimeLeaseId,
        sandboxId: toolCall.sandboxId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        status: toolCall.status,
        inputPreview: toolCall.inputPreview,
        outputPreview: toolCall.outputPreview,
        inputBlobRef: toolCall.inputBlobRef,
        outputBlobRef: toolCall.outputBlobRef,
        approvalJson: toolCall.approval,
        durationMs: toolCall.durationMs,
        startedAt: toolCall.startedAt,
        completedAt: toolCall.completedAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.runtimeTraceToolCalls.id });
    if (row) acceptedToolCalls += 1;
  }

  let acceptedBlobs = 0;
  let duplicateBlobs = 0;
  for (const blob of normalized.blobs) {
    const turnId = blob.sourceTurnId ? turnIdBySource.get(blob.sourceTurnId) ?? null : null;
    const [row] = await db
      .insert(schema.runtimeTraceBlobs)
      .values({
        organizationId: input.workspace.organization.id,
        traceSessionId: traceSession.id,
        turnId,
        runtimeLeaseId: blob.runtimeLeaseId,
        sandboxId: blob.sandboxId,
        kind: blob.kind,
        r2Key: blob.r2Key,
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        sensitivity: blob.sensitivity,
        encryptionJson: blob.encryption,
        retentionClass: blob.retentionClass,
      })
      .onConflictDoNothing()
      .returning({ id: schema.runtimeTraceBlobs.id });
    if (row) acceptedBlobs += 1;
    else duplicateBlobs += 1;
  }

  return {
    accepted: {
      blobs: acceptedBlobs,
      events: acceptedEvents,
      toolCalls: acceptedToolCalls,
      turns: acceptedTurns,
    },
    duplicates: {
      blobs: duplicateBlobs,
      events: duplicateEvents,
    },
    traceSession: {
      id: traceSession.id,
      externalTraceId: traceSession.externalTraceId,
      status: traceSession.status,
    },
    version: 1,
  };
}

export function normalizeCloudSyncEvents(body: unknown): NormalizedCloudSyncEvent[] {
  const record = objectRecord(body, "payload");
  const events = arrayValue(record.events ?? record.items, "events", MAX_SYNC_EVENTS_PER_BATCH);
  return events.map((event, index) => normalizeCloudSyncEvent(event, index));
}

export function normalizeRuntimeTraceBatch(body: unknown, requestId = "trace-ingest"): NormalizedRuntimeTraceBatch {
  const record = objectRecord(body, "payload");
  const sessionRecord = objectRecord(record.session ?? record.traceSession, "session");
  let session = normalizeTraceSession(sessionRecord);
  const turns = arrayValue(record.turns, "turns", MAX_TRACE_TURNS_PER_BATCH).map(normalizeTraceTurn);
  const events = coalesceAssistantDeltas(
    arrayValue(record.events ?? record.items, "events", MAX_TRACE_EVENTS_PER_BATCH).map((event, index) =>
      normalizeTraceEvent(event, index, requestId),
    ),
  );
  session = withResolvedTraceSessionSource(session, events);
  const toolCalls = arrayValue(record.toolCalls, "toolCalls", MAX_TRACE_TOOL_CALLS_PER_BATCH).map(normalizeTraceToolCall);
  const blobs = arrayValue(record.blobs, "blobs", MAX_TRACE_BLOBS_PER_BATCH).map(normalizeTraceBlob);
  if (turns.length === 0 && events.length === 0 && toolCalls.length === 0 && blobs.length === 0) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }

  return { blobs, events, session, toolCalls, turns };
}

function normalizeCloudSyncEvent(value: unknown, index: number): NormalizedCloudSyncEvent {
  const record = objectRecord(value, `events.${index}`);
  const eventId = cleanText(record.eventId ?? record.localEventId ?? record.id, "eventId");
  const occurredAtValue = record.occurredAt;
  return {
    domain: cleanText(record.domain, "domain"),
    entityId: cleanText(record.entityId, "entityId"),
    entityRevision: optionalInteger(record.entityRevision, "entityRevision"),
    entityType: cleanText(record.entityType, "entityType"),
    eventId,
    eventType: cleanText(record.eventType, "eventType"),
    evidenceRefs: jsonRecordArray(record.evidenceRefs ?? record.evidenceJson, "evidenceRefs"),
    idempotencyKey: optionalText(record.idempotencyKey, "idempotencyKey") ?? eventId,
    occurredAt: optionalDate(occurredAtValue, "occurredAt") ?? new Date(),
    occurredAtProvided: occurredAtValue !== undefined && occurredAtValue !== null && occurredAtValue !== "",
    payload: safeJsonRecord(record.payload ?? record.payloadJson, "payload"),
    projectRef: optionalText(record.projectId ?? record.projectRef, "projectRef"),
    schemaVersion: optionalInteger(record.schemaVersion, "schemaVersion") ?? 1,
  };
}

function normalizeTraceSession(record: Record<string, unknown>): NormalizedTraceSession {
  const runId = optionalText(record.runId, "runId");
  const sessionKey = cleanText(record.sessionKey, "sessionKey");
  const source = normalizeTraceSource(record.source, "session.source");
  return {
    agentRef: optionalText(record.agentRef ?? record.agentId, "agentRef"),
    endedAt: optionalTraceDate(record.endedAt, "endedAt"),
    externalTraceId:
      optionalText(record.externalTraceId ?? record.traceSessionId ?? record.id, "externalTraceId") ??
      stableTraceId(sessionKey),
    managedRuntimeInstanceId: optionalUuid(record.managedRuntimeInstanceId, "managedRuntimeInstanceId"),
    managedRuntimeSessionId: optionalText(record.managedRuntimeSessionId, "managedRuntimeSessionId"),
    placement: optionalText(record.placement, "placement") ?? "local",
    projectRef: optionalText(record.projectId ?? record.projectRef, "projectRef"),
    runId,
    runtimeModel: optionalText(record.runtimeModel ?? record.model, "runtimeModel"),
    runtimeProvider: cleanText(record.runtimeProvider ?? record.provider, "runtimeProvider"),
    safeMetadata: attachTraceSourceMetadata(
      safeJsonRecord(record.safeMetadata ?? record.safeMetadataJson ?? record.metadata, "safeMetadata"),
      source,
    ),
    source,
    sessionKey,
    sessionName: optionalTraceDisplayName(record.sessionName, "sessionName"),
    startedAt: optionalTraceDate(record.startedAt, "startedAt") ?? new Date(),
    status: optionalText(record.status, "status") ?? "active",
  };
}

function optionalTraceDisplayName(value: unknown, field: string): string | null {
  const text = optionalText(value, field);
  if (!text || text.toLowerCase() === "generic") return null;
  return text;
}

function normalizeTraceTurn(value: unknown): NormalizedTraceTurn {
  const record = objectRecord(value, "turn");
  return {
    cacheCreationTokens: nonNegativeInteger(record.cacheCreationTokens, "cacheCreationTokens") ?? 0,
    cacheReadTokens: nonNegativeInteger(record.cacheReadTokens, "cacheReadTokens") ?? 0,
    completedAt: optionalTraceDate(record.completedAt, "completedAt"),
    costUsd: optionalDecimal(record.costUsd, "costUsd"),
    inputTokens: nonNegativeInteger(record.inputTokens, "inputTokens") ?? 0,
    outputTokens: nonNegativeInteger(record.outputTokens, "outputTokens") ?? 0,
    promptSha256: optionalHash(record.promptSha256 ?? record.userPromptSha256, "promptSha256"),
    requestBlobSha256: optionalHash(record.requestBlobSha256, "requestBlobSha256"),
    requestBlobRef: optionalText(record.requestBlobRef, "requestBlobRef"),
    responseBlobRef: optionalText(record.responseBlobRef, "responseBlobRef"),
    runtimeLeaseId: optionalUuid(record.runtimeLeaseId ?? record.leaseId, "runtimeLeaseId"),
    sandboxId: optionalText(record.sandboxId, "sandboxId"),
    sequence: positiveInteger(record.sequence, "sequence"),
    sourceTurnId: optionalText(record.sourceTurnId ?? record.turnId, "sourceTurnId"),
    startedAt: optionalTraceDate(record.startedAt, "startedAt") ?? new Date(),
    status: optionalText(record.status, "status") ?? "running",
    systemPromptSha256: optionalHash(record.systemPromptSha256, "systemPromptSha256"),
    userPromptSha256: optionalHash(record.userPromptSha256 ?? record.promptSha256, "userPromptSha256"),
  };
}

function normalizeTraceEvent(value: unknown, index: number, requestId: string): NormalizedTraceEvent {
  const record = objectRecord(value, `events.${index}`);
  const eventType = cleanText(record.eventType ?? record.type, "eventType");
  const source = normalizeTraceSource(record.source, `events.${index}.source`);
  const safePayload = safeJsonRecord(record.safePayload ?? record.safePayloadJson ?? record.payload, "safePayload");
  return {
    blobRef: optionalText(record.blobRef, "blobRef"),
    eventGroup: optionalText(record.eventGroup, "eventGroup") ?? eventType.split(".")[0] ?? "runtime",
    eventId:
      optionalText(record.eventId ?? record.localEventId ?? record.id, "eventId") ??
      `${requestId}:event:${index}`,
    eventType,
    occurredAt: optionalTraceDate(record.occurredAt, "occurredAt") ?? new Date(),
    safePayload: attachTraceSourceMetadata(safePayload, source),
    safePreview: optionalPreview(record.safePreview ?? record.preview, "safePreview"),
    sequence: positiveInteger(record.sequence ?? index + 1, "sequence"),
    severity: optionalText(record.severity, "severity") ?? "info",
    runtimeLeaseId: optionalUuid(record.runtimeLeaseId ?? record.leaseId, "runtimeLeaseId"),
    sandboxId: optionalText(record.sandboxId, "sandboxId"),
    source,
    status: optionalText(record.status, "status"),
    sourceTurnId: optionalText(record.sourceTurnId ?? record.turnId, "sourceTurnId"),
  };
}

function withResolvedTraceSessionSource(
  session: NormalizedTraceSession,
  events: NormalizedTraceEvent[],
): NormalizedTraceSession {
  const source = mergeTraceSources(session.source, firstTraceEventSource(events), sourceFromSessionKey(session.sessionKey));
  if (!source) return session;
  return {
    ...session,
    safeMetadata: attachTraceSourceMetadata(session.safeMetadata, source),
    source,
  };
}

function firstTraceEventSource(events: NormalizedTraceEvent[]): NormalizedTraceSource | null {
  for (const event of events) {
    if (event.source) return event.source;
  }
  return null;
}

function mergeTraceSources(...sources: Array<NormalizedTraceSource | null>): NormalizedTraceSource | null {
  const merged: NormalizedTraceSource = {
    accountId: null,
    canonicalChatId: null,
    channel: null,
    chatId: null,
    threadId: null,
  };
  for (const source of sources) {
    if (!source) continue;
    merged.accountId ??= source.accountId;
    merged.canonicalChatId ??= source.canonicalChatId;
    merged.channel ??= source.channel;
    merged.chatId ??= source.chatId;
    merged.threadId ??= source.threadId;
  }
  return Object.values(merged).some(Boolean) ? merged : null;
}

function sourceFromSessionKey(sessionKey: string): NormalizedTraceSource | null {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 6) return null;
  const channel = optionalSourceText(parts[2]);
  const accountId = optionalSourceText(parts[3]);
  const chatKind = optionalSourceText(parts[4]);
  const rawChatId = optionalSourceText(parts.slice(5).join(":"));
  const chatId = normalizeStructuredSessionChatId(chatKind, rawChatId);
  const source: NormalizedTraceSource = {
    accountId,
    canonicalChatId: null,
    channel,
    chatId,
    threadId: null,
  };
  return Object.values(source).some(Boolean) ? source : null;
}

function normalizeStructuredSessionChatId(chatKind: string | null, chatId: string | null): string | null {
  if (!chatId) return null;
  if (chatId.includes("@") || !chatKind) return chatId;
  if (chatKind === "group") return `${chatId}@g.us`;
  return chatId;
}

function optionalSourceText(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text || text.toLowerCase() === "generic") return null;
  return text;
}

function normalizeTraceSource(value: unknown, field: string): NormalizedTraceSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source: NormalizedTraceSource = {
    accountId: optionalText(record.accountId ?? record.sourceAccountId, `${field}.accountId`),
    canonicalChatId: optionalText(record.canonicalChatId, `${field}.canonicalChatId`),
    channel: optionalText(record.channel ?? record.sourceChannel ?? record.channelId, `${field}.channel`),
    chatId: optionalText(record.chatId ?? record.sourceChatId, `${field}.chatId`),
    threadId: optionalText(record.threadId ?? record.sourceThreadId, `${field}.threadId`),
  };
  return Object.values(source).some(Boolean) ? source : null;
}

function attachTraceSourceMetadata(metadata: JsonRecord, source: NormalizedTraceSource | null): JsonRecord {
  if (!source) return metadata;
  return {
    ...metadata,
    source: {
      accountId: source.accountId,
      canonicalChatId: source.canonicalChatId,
      channel: source.channel,
      chatId: source.chatId,
      threadId: source.threadId,
    },
  };
}

function normalizeTraceToolCall(value: unknown): NormalizedTraceToolCall {
  const record = objectRecord(value, "toolCall");
  return {
    approval: safeJsonRecord(record.approval ?? record.approvalJson, "approval"),
    completedAt: optionalTraceDate(record.completedAt, "completedAt"),
    durationMs: nonNegativeInteger(record.durationMs, "durationMs"),
    inputBlobRef: optionalText(record.inputBlobRef, "inputBlobRef"),
    inputPreview: optionalPreview(record.inputPreview, "inputPreview"),
    outputBlobRef: optionalText(record.outputBlobRef, "outputBlobRef"),
    outputPreview: optionalPreview(record.outputPreview, "outputPreview"),
    runtimeLeaseId: optionalUuid(record.runtimeLeaseId ?? record.leaseId, "runtimeLeaseId"),
    sandboxId: optionalText(record.sandboxId, "sandboxId"),
    sourceTurnId: optionalText(record.sourceTurnId ?? record.turnId, "sourceTurnId"),
    startedAt: optionalTraceDate(record.startedAt, "startedAt") ?? new Date(),
    status: optionalText(record.status, "status") ?? "started",
    toolCallId: optionalText(record.toolCallId ?? record.id, "toolCallId"),
    toolName: cleanText(record.toolName ?? record.name, "toolName"),
  };
}

function normalizeTraceBlob(value: unknown): NormalizedTraceBlob {
  const record = objectRecord(value, "blob");
  return {
    encryption: safeJsonRecord(record.encryption ?? record.encryptionJson, "encryption"),
    kind: cleanText(record.kind, "kind"),
    r2Key: cleanText(record.r2Key ?? record.blobRef, "r2Key"),
    retentionClass: optionalText(record.retentionClass, "retentionClass") ?? "default",
    runtimeLeaseId: optionalUuid(record.runtimeLeaseId ?? record.leaseId, "runtimeLeaseId"),
    sandboxId: optionalText(record.sandboxId, "sandboxId"),
    sensitivity: optionalText(record.sensitivity, "sensitivity") ?? "content",
    sha256: optionalHash(record.sha256, "sha256") ?? cleanText(record.sha256, "sha256"),
    sizeBytes: positiveInteger(record.sizeBytes, "sizeBytes"),
    sourceTurnId: optionalText(record.sourceTurnId ?? record.turnId, "sourceTurnId"),
  };
}

function coalesceAssistantDeltas(events: NormalizedTraceEvent[]): NormalizedTraceEvent[] {
  const output: NormalizedTraceEvent[] = [];
  let pending: NormalizedTraceEvent | null = null;

  for (const event of events) {
    if (event.eventType !== "assistant.delta") {
      if (pending) output.push(pending);
      pending = null;
      output.push(event);
      continue;
    }

    if (!pending || pending.sourceTurnId !== event.sourceTurnId) {
      if (pending) output.push(pending);
      pending = {
        ...event,
        eventId: `${event.eventId}:coalesced`,
        eventType: "assistant.delta.coalesced",
        safePayload: {
          coalesced: true,
          count: 1,
        },
      };
      continue;
    }

    pending.safePreview = trimText(`${pending.safePreview ?? ""}${event.safePreview ?? ""}`, MAX_PREVIEW_LENGTH);
    pending.safePayload = {
      coalesced: true,
      count: ((pending.safePayload.count as number | undefined) ?? 1) + 1,
      firstEventId: pending.eventId,
      lastEventId: event.eventId,
    };
  }

  if (pending) output.push(pending);
  return output;
}

async function upsertCloudSyncCursor(input: {
  domain: string;
  lastAckedSequence?: number;
  lastDeliveredSequence?: number;
  projectId: string | null;
  workspace: DataPlaneWorkspace;
}) {
  const now = new Date();
  const projectScope = input.projectId ?? "*";
  const lastDeliveredSequence = input.lastDeliveredSequence ?? 0;
  const lastAckedSequence = input.lastAckedSequence ?? 0;
  const [cursor] = await db
    .insert(schema.cloudSyncCursors)
    .values({
      organizationId: input.workspace.organization.id,
      localInstallationId: input.workspace.localInstallation.id,
      projectId: input.projectId,
      projectScope,
      domain: input.domain,
      lastDeliveredSequence,
      lastAckedSequence,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.cloudSyncCursors.organizationId,
        schema.cloudSyncCursors.localInstallationId,
        schema.cloudSyncCursors.projectScope,
        schema.cloudSyncCursors.domain,
      ],
      set: {
        lastDeliveredSequence: input.lastDeliveredSequence !== undefined
          ? sql`GREATEST(${schema.cloudSyncCursors.lastDeliveredSequence}, ${input.lastDeliveredSequence})`
          : sql`${schema.cloudSyncCursors.lastDeliveredSequence}`,
        lastAckedSequence: input.lastAckedSequence !== undefined
          ? sql`GREATEST(${schema.cloudSyncCursors.lastAckedSequence}, ${input.lastAckedSequence})`
          : sql`${schema.cloudSyncCursors.lastAckedSequence}`,
        updatedAt: now,
      },
    })
    .returning();

  if (!cursor) throw cliApiError(503, "SERVER_UNAVAILABLE");
  return cursor;
}

export function cloudSyncRequestHash(event: NormalizedCloudSyncEvent, projectId: string | null): string {
  return createHash("sha256")
    .update(stableJson({
      domain: event.domain,
      entityId: event.entityId,
      entityRevision: event.entityRevision,
      entityType: event.entityType,
      eventId: event.eventId,
      eventType: event.eventType,
      evidenceRefs: event.evidenceRefs,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAtProvided ? event.occurredAt.toISOString() : null,
      payload: event.payload,
      projectId,
      schemaVersion: event.schemaVersion,
    }))
    .digest("hex");
}

export function collectTraceSourceTurnIds(input: {
  blobs: Array<{ sourceTurnId: string | null }>;
  events: Array<{ sourceTurnId: string | null }>;
  toolCalls: Array<{ sourceTurnId: string | null }>;
  turnIdBySource: Map<string, string>;
}): string[] {
  const sourceTurnIds = new Set<string>();
  for (const event of input.events) {
    if (event.sourceTurnId && !input.turnIdBySource.has(event.sourceTurnId)) sourceTurnIds.add(event.sourceTurnId);
  }
  for (const toolCall of input.toolCalls) {
    if (toolCall.sourceTurnId && !input.turnIdBySource.has(toolCall.sourceTurnId)) sourceTurnIds.add(toolCall.sourceTurnId);
  }
  for (const blob of input.blobs) {
    if (blob.sourceTurnId && !input.turnIdBySource.has(blob.sourceTurnId)) sourceTurnIds.add(blob.sourceTurnId);
  }
  return [...sourceTurnIds].sort();
}

async function hydrateExistingTraceTurns(input: {
  blobs: NormalizedTraceBlob[];
  events: NormalizedTraceEvent[];
  toolCalls: NormalizedTraceToolCall[];
  traceSessionId: string;
  turnIdBySource: Map<string, string>;
}) {
  const sourceTurnIds = collectTraceSourceTurnIds(input);
  if (sourceTurnIds.length === 0) return;

  const rows = await db
    .select({
      id: schema.runtimeTraceTurns.id,
      sourceTurnId: schema.runtimeTraceTurns.sourceTurnId,
    })
    .from(schema.runtimeTraceTurns)
    .where(
      and(
        eq(schema.runtimeTraceTurns.traceSessionId, input.traceSessionId),
        inArray(schema.runtimeTraceTurns.sourceTurnId, sourceTurnIds),
      ),
    );

  for (const row of rows) {
    if (row.sourceTurnId) input.turnIdBySource.set(row.sourceTurnId, row.id);
  }
}

async function resolveSyncProjectId(
  workspace: DataPlaneWorkspace,
  projectRef: string | null,
  scope: string | null,
  action: "read" | "write",
) {
  if (!projectRef && scope !== "organization") {
    throw cliApiError(400, "PAYLOAD_INVALID", "Sync requires projectRef or scope=organization.");
  }
  return resolveOptionalProjectId(workspace, projectRef, action);
}

async function resolveOptionalProjectId(
  workspace: DataPlaneWorkspace,
  projectRef: string | null,
  action: "read" | "write",
) {
  if (!projectRef) return null;
  const project = await findAccessibleProjectRecord(workspace, projectRef, action);
  if (!project) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return project.id;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  if (value.length > max) throw cliApiError(413, "PAYLOAD_INVALID", `${field} batch is too large.`);
  return value;
}

function cleanText(value: unknown, field: string): string {
  const text = optionalText(value, field);
  if (!text) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return text;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (text.length > MAX_TEXT_LENGTH) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return text || null;
}

function optionalPreview(value: unknown, field: string): string | null {
  const text = optionalText(value, field);
  return text ? redactInlineSecrets(trimText(text, MAX_PREVIEW_LENGTH)) : null;
}

function optionalHash(value: unknown, field: string): string | null {
  const text = optionalText(value, field);
  if (!text) return null;
  if (!/^[a-f0-9]{64}$/i.test(text)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return text.toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  const text = optionalText(value, field);
  if (!text) return null;
  if (!UUID_PATTERN.test(text)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return text;
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return number;
}

function nonNegativeInteger(value: unknown, field: string): number | null {
  const number = optionalInteger(value, field);
  if (number !== null && number < 0) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return number;
}

function positiveInteger(value: unknown, field: string): number {
  const number = optionalInteger(value, field);
  if (number === null || number <= 0) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return number;
}

function optionalDecimal(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return String(number);
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  return date;
}

function optionalTraceDate(value: unknown, field: string): Date | null {
  const date = optionalDate(value, field);
  if (!date) return null;
  const timestamp = date.getTime();
  const now = Date.now();
  if (timestamp < now - MAX_TRACE_TIMESTAMP_PAST_MS || timestamp > now + MAX_TRACE_TIMESTAMP_FUTURE_MS) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  }
  return date;
}

function safeJsonRecord(value: unknown, field: string): JsonRecord {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  }

  assertSafeJson(value, field);
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_JSON_FIELD_BYTES) {
    throw cliApiError(413, "PAYLOAD_INVALID", `${field} is too large.`);
  }
  return sanitizeSafeJson(value) as JsonRecord;
}

function jsonRecordArray(value: unknown, field: string): JsonRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  if (value.length > 100) throw cliApiError(413, "PAYLOAD_INVALID", `${field} is too large.`);
  return value.map((item, index) => {
    if (typeof item === "string") return { ref: trimText(item, MAX_TEXT_LENGTH) };
    return safeJsonRecord(item, `${field}.${index}`);
  });
}

function assertSafeJson(value: unknown, field: string, depth = 0): void {
  if (!value || typeof value !== "object") return;
  if (depth > MAX_SAFE_JSON_DEPTH) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, field, depth + 1);
    return;
  }

  for (const [key, item] of Object.entries(value as JsonRecord)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_JSON_KEYS.has(normalized)) {
      throw cliApiError(400, "PAYLOAD_INVALID", `Invalid ${field}.`);
    }
    assertSafeJson(item, field, depth + 1);
  }
}

function sanitizeSafeJson(value: unknown): unknown {
  if (typeof value === "string") return redactInlineSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeSafeJson);
  if (!value || typeof value !== "object") return value;

  const output: JsonRecord = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    output[key] = shouldRedactJsonValue(key, item) ? "[REDACTED]" : sanitizeSafeJson(item);
  }
  return output;
}

function shouldRedactJsonValue(key: string, value: unknown): boolean {
  if (RAW_OUTPUT_KEY_RE.test(key)) return true;
  if (typeof value !== "string") return false;
  if (keySuggestsPrivatePath(key) && looksLikePrivatePath(value)) return true;
  return false;
}

function keySuggestsPrivatePath(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "cwd" ||
    normalized === "home" ||
    normalized === "path" ||
    normalized.endsWith("path") ||
    normalized.endsWith("file") ||
    normalized.includes("workspace")
  );
}

function looksLikePrivatePath(value: string): boolean {
  return value.startsWith("/Users/") || value.startsWith("/home/") || value.startsWith("~");
}

function stableTraceId(sessionKey: string) {
  return createHash("sha256")
    .update(`local-session:${sessionKey}`)
    .digest("hex")
    .slice(0, 40);
}

function trimText(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max);
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bravi_(?:crt|cat|pat)_[A-Za-z0-9_-]{12,}\b/g, "ravi_[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh_[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(
      /(accessToken|refreshToken|apiKey|secret|password|token)["'=:\s]+[A-Za-z0-9._~+/=-]{8,}/gi,
      "$1=[REDACTED]",
    );
}
