import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  KnowledgeDocumentSummary,
  KnowledgeIngestionJobSummary,
  KnowledgeIngestionResult,
} from "@/features/console/types";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import { assertProjectAccess, findAccessibleProjectRecord } from "../project-access";
import { archiveOtherDocuments, insertPolicySnapshotV2, knowledgeChunkKey, nextDocumentVersion } from "./producer";
import {
  createKnowledgeRawSourceObjectStoreFromEnv,
  failedKnowledgeRawSourceRef,
  knowledgeRawSourceSafeMetadata,
  pendingKnowledgeRawSourceRef,
  putKnowledgeRawSourceObject,
  type KnowledgeRawSourceObjectStore,
  type KnowledgeRawSourcePrivateRef,
} from "./raw-source-storage";
import { knowledgeSearchVectorSql } from "./search-vector";
import { foldKnowledgeText, neutralizeKnowledgeText, sanitizeSpeakerName } from "./text";
import { buildKnowledgeUsageEvent, recordKnowledgeUsage } from "./usage";

const MAX_INGEST_BODY_BYTES = 512 * 1024;
const MAX_TEXT_CONTENT_BYTES = 256 * 1024;
const MAX_CHUNK_CHARS = 1200;
const TEXT_PARSER_VERSION = "knowledge-text-v1";
const MEETING_TRANSCRIPT_PARSER_VERSION = "knowledge-meeting-transcript-v1";
const SOURCE = "console.knowledge.ingestion";

type KnowledgeWorkspace = {
  mode: import("@/lib/auth/session").ConsoleAuthState["mode"];
  user: { id: string };
  organization: { id: string };
  membership: { role: string };
};

type KnowledgeSourceRecord = typeof schema.knowledgeSources.$inferSelect;
type KnowledgeDocumentRecord = typeof schema.knowledgeDocuments.$inferSelect;
type KnowledgeIngestionJobRecord = typeof schema.knowledgeIngestionJobs.$inferSelect;

type MeetingTranscriptSegmentDraft = {
  charEnd: number;
  charStart: number;
  ordinal: number;
  speaker: string;
  textLines: string[];
  timestamp: string;
};

type TextLineWithOffset = {
  end: number;
  start: number;
  text: string;
};

export type IngestKnowledgeSourceInput = {
  content: string;
  filename: string | null;
  idempotencyKey: string | null;
  language: string | null;
  metadata: Record<string, unknown>;
  mimeType: string;
  title: string | null;
};

export type KnowledgeTextChunk = {
  charEnd: number;
  charStart: number;
  location?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ordinal: number;
  text: string;
  textHash: string;
  tokenCount: number;
};

const ingestionBodySchema = z.object({
  content: z.string().max(MAX_TEXT_CONTENT_BYTES).refine((value) => value.trim().length > 0, "Content is required."),
  title: z.string().trim().max(240).nullable().optional(),
  mimeType: z.string().trim().max(120).nullable().optional(),
  language: z.string().trim().max(40).nullable().optional(),
  filename: z.string().trim().max(240).nullable().optional(),
  idempotencyKey: z.string().trim().max(160).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function ingestKnowledgeSource({
  body,
  projectRef,
  rawStore = createKnowledgeRawSourceObjectStoreFromEnv(),
  requestId,
  sourceId,
  workspace,
}: {
  body: unknown;
  projectRef: string;
  rawStore?: KnowledgeRawSourceObjectStore | null;
  requestId: string;
  sourceId: string;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeIngestionResult> {
  const parsed = parseIngestKnowledgeSourceBody(body);
  const project = await findAccessibleProjectRecord(workspace, projectRef, "write");
  if (!project) throw new ConsoleApiError(404, { error: "project_not_found" });
  await assertProjectAccess(workspace, project.id, "write");

  const source = await getActiveSource({
    organizationId: workspace.organization.id,
    projectId: project.id,
    sourceId,
  });
  if (!source) throw new ConsoleApiError(404, { error: "knowledge_source_not_found" });

  // Fix 1: a replayed idempotency key answers the first result, before any write.
  if (parsed.idempotencyKey) {
    const replay = await replayIngestionByIdempotencyKey(workspace.organization.id, parsed.idempotencyKey);
    if (replay) return replay;
  }

  const documentId = randomUUID();
  const normalizedContent = normalizeTextContent(parsed.content);
  const contentBytes = new TextEncoder().encode(normalizedContent);
  const contentHash = createHash("sha256").update(contentBytes).digest("hex");
  const parserVersion = parserVersionForSource(source.sourceType);
  const chunks = chunkKnowledgeSourceText(normalizedContent, { sourceType: source.sourceType });
  const now = new Date();
  const actorType = actorTypeForWorkspace(workspace);

  let outcome: { result: KnowledgeIngestionResult; jobId: string; ingested: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      // Fix 2: one writer per source at a time, before the version is chosen.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge_source:${source.id}`}))`);

      const [job] = await tx
        .insert(schema.knowledgeIngestionJobs)
        .values({
          organizationId: workspace.organization.id,
          projectId: project.id,
          sourceId: source.id,
          status: "running",
          triggerType: "manual",
          idempotencyKey: parsed.idempotencyKey,
          requestId,
          attempts: 1,
          inputJson: {
            schemaVersion: 1,
            source: SOURCE,
            contentHash,
            mimeType: parsed.mimeType,
          },
          requestedByActorType: actorType,
          requestedByActorId: workspace.user.id,
          startedAt: now,
        })
        .returning();
      if (!job) throw new Error("Failed to create knowledge ingestion job.");

      // Fix 4: the same content as the current version is not a new version.
      const [current] = await tx
        .select()
        .from(schema.knowledgeDocuments)
        .where(
          and(
            eq(schema.knowledgeDocuments.sourceId, source.id),
            inArray(schema.knowledgeDocuments.status, ["chunked", "indexed"]),
          ),
        )
        .orderBy(desc(schema.knowledgeDocuments.versionNumber))
        .limit(1);
      if (current && current.contentHash === contentHash) {
        const [counted] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.knowledgeChunks)
          .where(eq(schema.knowledgeChunks.documentId, current.id));
        const chunkCount = counted?.count ?? 0;
        const raw = knowledgeRawSourceSafeMetadata(record(current.sourceLocationJson).rawRef);
        const completedJob = await completeIngestionJob(tx, job.id, {
          documentId: current.id,
          now,
          resultJson: { schemaVersion: 1, documentId: current.id, chunkCount, contentHash, raw, unchanged: true },
        });
        return {
          jobId: job.id,
          ingested: false,
          result: {
            job: ingestionJobSummaryFromRecord(completedJob),
            document: documentSummaryFromRecord(current),
            chunkCount,
            raw,
          },
        };
      }

      const versionNumber = await nextDocumentVersion(tx, source.id);
      const [document] = await tx
        .insert(schema.knowledgeDocuments)
        .values({
          id: documentId,
          organizationId: workspace.organization.id,
          projectId: project.id,
          sourceId: source.id,
          versionNumber,
          title: parsed.title ?? source.title,
          status: "chunked",
          contentHash,
          mimeType: parsed.mimeType,
          language: parsed.language,
          parserVersion,
          sizeBytes: contentBytes.byteLength,
          sourceLocationJson: {
            schemaVersion: 1,
            rawRef: pendingKnowledgeRawSourceRef(),
            source: SOURCE,
          },
          safeMetadataJson: parsed.metadata,
          parsedAt: now,
        })
        .returning();
      if (!document) throw new Error("Failed to create knowledge document.");

      // Fix 6: the v2 snapshot is audit only.
      const snapshotId = await insertPolicySnapshotV2(tx, {
        organizationId: workspace.organization.id,
        projectId: project.id,
        sourceId: source.id,
        documentId: document.id,
        trustTier: source.trustTier,
        sensitivity: source.sensitivity,
        retainUntil: source.retainUntil,
        actor: { type: actorType, id: workspace.user.id },
        now,
      });

      // Fix 5: stable keys, trust tier and both search vectors on every chunk.
      if (chunks.length > 0) {
        const rows = chunks.map((chunk) => {
          const text = neutralizeKnowledgeText(chunk.text);
          const textHash = createHash("sha256").update(text).digest("hex");
          const stableKey = `o${chunk.ordinal}`;
          const speakerName = typeof chunk.metadata?.speakerName === "string" ? chunk.metadata.speakerName : null;
          const speakers = speakerName ? [sanitizeSpeakerName(speakerName)] : [];
          const vectors = knowledgeSearchVectorSql({ title: source.title, heading: null, text, speakers });
          return {
            organizationId: workspace.organization.id,
            projectId: project.id,
            sourceId: source.id,
            documentId: document.id,
            permissionSnapshotId: snapshotId,
            chunkOrdinal: chunk.ordinal,
            chunkKey: knowledgeChunkKey(stableKey, chunk.ordinal, textHash),
            stableKey,
            trustTier: source.trustTier,
            searchVector: vectors.searchVector,
            searchVectorStem: vectors.searchVectorStem,
            text,
            textHash,
            tokenCount: chunk.tokenCount,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            status: "active" as const,
            locationJson: {
              charStart: chunk.charStart,
              charEnd: chunk.charEnd,
              ...chunk.location,
            },
            safeMetadataJson: {
              parserVersion,
              ...chunk.metadata,
              ...(speakers.length > 0 ? { speakersFolded: speakers.map((speaker) => foldKnowledgeText(speaker)) } : {}),
            },
          };
        });
        for (let start = 0; start < rows.length; start += 200) {
          await tx.insert(schema.knowledgeChunks).values(rows.slice(start, start + 200));
        }
      }

      // Fix 4: the previous current version is archived in the same transaction.
      await archiveOtherDocuments(tx, source.id, document.id, now);

      const raw = knowledgeRawSourceSafeMetadata(pendingKnowledgeRawSourceRef());
      const completedJob = await completeIngestionJob(tx, job.id, {
        documentId: document.id,
        now,
        resultJson: { schemaVersion: 1, documentId: document.id, chunkCount: chunks.length, contentHash, raw },
      });

      await tx
        .update(schema.knowledgeSources)
        .set({ rawRefJson: pendingKnowledgeRawSourceRef(), updatedAt: now })
        .where(eq(schema.knowledgeSources.id, source.id));

      // Fix 7: ids, counts and hashes only.
      await tx.insert(schema.auditEvents).values({
        organizationId: workspace.organization.id,
        projectId: project.id,
        actorType,
        actorId: workspace.user.id,
        targetType: "knowledge_source",
        targetId: source.id,
        action: "knowledge_source.ingested",
        requestId,
        metadataJson: {
          source: SOURCE,
          documentId: document.id,
          ingestionJobId: completedJob.id,
          versionNumber,
          chunkCount: chunks.length,
          contentHash,
          parserVersion,
        },
      });

      await recordKnowledgeUsage(
        [
          buildKnowledgeUsageEvent({
            organizationId: workspace.organization.id,
            projectId: project.id,
            metricKey: "knowledge.chunks_stored",
            eventType: "knowledge.document_ingested",
            id: document.id,
            quantity: chunks.length,
            requestId,
            dimensions: { kind: "manual" },
          }),
        ],
        tx,
      );

      return {
        jobId: job.id,
        ingested: true,
        result: {
          job: ingestionJobSummaryFromRecord(completedJob),
          document: documentSummaryFromRecord(document),
          chunkCount: chunks.length,
          raw,
        },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" });
    throw error;
  }

  if (!outcome.ingested || !rawStore) return outcome.result;

  // Fix 3: the raw vault is written after the chunks committed; a failure never fails the ingest.
  let rawRef: KnowledgeRawSourcePrivateRef | ReturnType<typeof failedKnowledgeRawSourceRef>;
  try {
    rawRef = await storeRawContent({
      content: normalizedContent,
      documentId,
      input: parsed,
      projectId: project.id,
      rawStore,
      source,
      workspace,
    });
  } catch {
    rawRef = failedKnowledgeRawSourceRef();
  }
  const raw = knowledgeRawSourceSafeMetadata(rawRef);
  try {
    await db
      .update(schema.knowledgeDocuments)
      .set({
        sourceLocationJson: sql`jsonb_set(${schema.knowledgeDocuments.sourceLocationJson}, '{rawRef}', ${JSON.stringify(rawRef)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(schema.knowledgeDocuments.id, documentId));
    await db
      .update(schema.knowledgeSources)
      .set({ rawRefJson: rawRef, updatedAt: new Date() })
      .where(eq(schema.knowledgeSources.id, source.id));
    await db
      .update(schema.knowledgeIngestionJobs)
      .set({ resultJson: sql`jsonb_set(${schema.knowledgeIngestionJobs.resultJson}, '{raw}', ${JSON.stringify(raw)}::jsonb)` })
      .where(eq(schema.knowledgeIngestionJobs.id, outcome.jobId));
  } catch {
    return outcome.result;
  }
  return { ...outcome.result, raw };
}

/**
 * The first call's `{job, document, chunkCount, raw}` for a completed job with
 * this key; 409 while it is still queued or running. Null when no job has it.
 */
export async function replayIngestionByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
  database: Pick<typeof db, "select"> = db,
): Promise<KnowledgeIngestionResult | null> {
  const [job] = await database
    .select()
    .from(schema.knowledgeIngestionJobs)
    .where(
      and(
        eq(schema.knowledgeIngestionJobs.organizationId, organizationId),
        eq(schema.knowledgeIngestionJobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!job) return null;
  if (job.status !== "completed") throw new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" });
  if (!job.documentId) throw new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" });

  const [document] = await database
    .select()
    .from(schema.knowledgeDocuments)
    .where(eq(schema.knowledgeDocuments.id, job.documentId))
    .limit(1);
  if (!document) throw new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" });
  const result = record(job.resultJson);
  return {
    job: ingestionJobSummaryFromRecord(job),
    document: documentSummaryFromRecord(document),
    chunkCount: typeof result.chunkCount === "number" ? result.chunkCount : 0,
    raw: knowledgeRawSourceSafeMetadata(rawRefFromSafeMetadata(result.raw)),
  };
}

export function parseIngestKnowledgeSourceBody(body: unknown): IngestKnowledgeSourceInput {
  const approxBytes = JSON.stringify(body ?? {}).length;
  if (approxBytes > MAX_INGEST_BODY_BYTES) {
    throw new ConsoleApiError(413, { error: "payload_too_large" });
  }

  const result = ingestionBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: firstFieldErrors(result.error.flatten().fieldErrors),
    });
  }

  return {
    content: result.data.content,
    title: nullableText(result.data.title),
    mimeType: normalizeMimeType(result.data.mimeType),
    language: nullableText(result.data.language),
    filename: nullableText(result.data.filename),
    idempotencyKey: nullableText(result.data.idempotencyKey),
    metadata: result.data.metadata ?? {},
  };
}

export function chunkKnowledgeText(content: string, options: { maxChars?: number } = {}): KnowledgeTextChunk[] {
  const maxChars = Math.max(1, options.maxChars ?? MAX_CHUNK_CHARS);
  const normalized = normalizeTextContent(content);
  const chunks: KnowledgeTextChunk[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const hardEnd = Math.min(cursor + maxChars, normalized.length);
    const end = hardEnd < normalized.length ? bestChunkBoundary(normalized, cursor, hardEnd) : hardEnd;
    const raw = normalized.slice(cursor, end);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) {
      const charStart = cursor + leadingWhitespace;
      chunks.push({
        ordinal: chunks.length,
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
        tokenCount: estimateTokenCount(text),
        charStart,
        charEnd: charStart + text.length,
      });
    }
    cursor = Math.max(end, cursor + 1);
  }

  return chunks;
}

export function chunkKnowledgeSourceText(
  content: string,
  options: { maxChars?: number; sourceType?: string } = {},
): KnowledgeTextChunk[] {
  if (options.sourceType === "meeting") {
    const meetingChunks = chunkMeetingTranscriptText(content);
    if (meetingChunks.length > 0) return meetingChunks;
  }
  return chunkKnowledgeText(content, { maxChars: options.maxChars });
}

export function chunkMeetingTranscriptText(content: string): KnowledgeTextChunk[] {
  const normalized = normalizeTextContent(content);
  const lines = splitLinesWithOffsets(normalized);
  const segments: MeetingTranscriptSegmentDraft[] = [];
  let current: MeetingTranscriptSegmentDraft | null = null;

  for (const line of lines) {
    const header = parseMeetingTranscriptHeader(line.text);
    if (header) {
      if (current) segments.push(current);
      current = {
        charEnd: line.end,
        charStart: line.start,
        ordinal: segments.length,
        speaker: header.speaker,
        textLines: header.text ? [header.text] : [],
        timestamp: header.timestamp,
      };
      continue;
    }

    if (!current) continue;
    if (line.text.trim().startsWith("#")) {
      segments.push(current);
      current = null;
      continue;
    }

    const continuation = line.text.trim();
    if (continuation) current.textLines.push(continuation);
    current.charEnd = line.end;
  }

  if (current) segments.push(current);

  const chunks: KnowledgeTextChunk[] = [];
  for (const segment of segments) {
    const body = segment.textLines.join("\n").trim();
    if (!body) continue;
    const text = `${segment.speaker}: ${body}`;
    chunks.push({
      ordinal: chunks.length,
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      tokenCount: estimateTokenCount(text),
      charStart: segment.charStart,
      charEnd: segment.charEnd,
      location: {
        charStart: segment.charStart,
        charEnd: segment.charEnd,
        transcriptTimestamp: segment.timestamp,
      },
      metadata: {
        segmentKind: "meeting_transcript",
        speakerName: segment.speaker,
      },
    });
  }
  return chunks;
}

async function getActiveSource(input: {
  organizationId: string;
  projectId: string;
  sourceId: string;
}): Promise<KnowledgeSourceRecord | null> {
  const [source] = await db
    .select()
    .from(schema.knowledgeSources)
    .where(
      and(
        eq(schema.knowledgeSources.organizationId, input.organizationId),
        eq(schema.knowledgeSources.projectId, input.projectId),
        eq(schema.knowledgeSources.id, input.sourceId),
        eq(schema.knowledgeSources.status, "active"),
      ),
    )
    .limit(1);
  return source ?? null;
}

async function storeRawContent(input: {
  content: string;
  documentId: string;
  input: IngestKnowledgeSourceInput;
  projectId: string;
  rawStore: KnowledgeRawSourceObjectStore | null;
  source: KnowledgeSourceRecord;
  workspace: KnowledgeWorkspace;
}): Promise<KnowledgeRawSourcePrivateRef> {
  if (!input.rawStore) return pendingKnowledgeRawSourceRef();
  return putKnowledgeRawSourceObject({
    body: input.content,
    contentType: input.input.mimeType,
    documentId: input.documentId,
    filename: input.input.filename,
    organizationId: input.workspace.organization.id,
    projectId: input.projectId,
    sourceId: input.source.id,
    store: input.rawStore,
  });
}

async function completeIngestionJob(
  tx: Pick<typeof db, "update">,
  jobId: string,
  input: { documentId: string; now: Date; resultJson: Record<string, unknown> },
): Promise<KnowledgeIngestionJobRecord> {
  const [completedJob] = await tx
    .update(schema.knowledgeIngestionJobs)
    .set({
      documentId: input.documentId,
      status: "completed",
      resultJson: input.resultJson,
      finishedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(schema.knowledgeIngestionJobs.id, jobId))
    .returning();
  if (!completedJob) throw new Error("Failed to complete knowledge ingestion job.");
  return completedJob;
}

/** The stored safe metadata, turned back into a ref shape `knowledgeRawSourceSafeMetadata` reads the same way. */
function rawRefFromSafeMetadata(value: unknown) {
  const raw = record(value);
  if (raw.status === "stored" && raw.storageBackend === "object_storage") {
    return {
      schemaVersion: 1,
      status: "stored",
      visibility: "private",
      storageBackend: "object_storage",
      sha256: raw.sha256 ?? undefined,
      sizeBytes: raw.sizeBytes ?? undefined,
      contentType: raw.contentType ?? undefined,
      storedAt: typeof raw.storedAt === "number" ? new Date(raw.storedAt).toISOString() : undefined,
    };
  }
  return pendingKnowledgeRawSourceRef();
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function documentSummaryFromRecord(document: KnowledgeDocumentRecord): KnowledgeDocumentSummary {
  return {
    id: document.id,
    sourceId: document.sourceId,
    projectId: document.projectId ?? "",
    versionNumber: document.versionNumber,
    title: document.title,
    status: document.status,
    contentHash: document.contentHash,
    mimeType: document.mimeType,
    language: document.language,
    parserVersion: document.parserVersion,
    sizeBytes: document.sizeBytes,
    parsedAt: dateMsOrNull(document.parsedAt),
    createdAt: dateMs(document.createdAt),
    updatedAt: dateMs(document.updatedAt),
  };
}

function ingestionJobSummaryFromRecord(job: KnowledgeIngestionJobRecord): KnowledgeIngestionJobSummary {
  return {
    id: job.id,
    sourceId: job.sourceId,
    documentId: job.documentId,
    projectId: job.projectId ?? "",
    status: job.status,
    triggerType: job.triggerType,
    attempts: job.attempts,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    startedAt: dateMsOrNull(job.startedAt),
    finishedAt: dateMsOrNull(job.finishedAt),
    createdAt: dateMs(job.createdAt),
    updatedAt: dateMs(job.updatedAt),
  };
}

function normalizeTextContent(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function bestChunkBoundary(content: string, start: number, hardEnd: number) {
  const minimum = start + Math.floor((hardEnd - start) * 0.6);
  const newline = content.lastIndexOf("\n\n", hardEnd);
  if (newline > minimum) return newline + 2;
  const sentence = Math.max(content.lastIndexOf(". ", hardEnd), content.lastIndexOf("! ", hardEnd), content.lastIndexOf("? ", hardEnd));
  if (sentence > minimum) return sentence + 2;
  const whitespace = content.lastIndexOf(" ", hardEnd);
  if (whitespace > minimum) return whitespace + 1;
  return hardEnd;
}

function estimateTokenCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function parserVersionForSource(sourceType: string) {
  return sourceType === "meeting" ? MEETING_TRANSCRIPT_PARSER_VERSION : TEXT_PARSER_VERSION;
}

function splitLinesWithOffsets(content: string): TextLineWithOffset[] {
  const lines: TextLineWithOffset[] = [];
  let start = 0;
  for (const rawLine of content.split("\n")) {
    const end = start + rawLine.length;
    lines.push({ start, end, text: rawLine });
    start = end + 1;
  }
  return lines;
}

function parseMeetingTranscriptHeader(line: string): { speaker: string; text: string; timestamp: string } | null {
  const match = line.match(/^\s*-\s*\[([^\]]+)\]\s*([^:]+):\s*(.*)$/);
  if (!match) return null;
  const timestamp = nullableText(match[1]) ?? "unknown";
  const speaker = nullableText(match[2]) ?? "Unknown speaker";
  const text = match[3]?.trim() ?? "";
  return { speaker, text, timestamp };
}

function actorTypeForWorkspace(workspace: KnowledgeWorkspace) {
  return workspace.mode === "anonymous" ? "anonymous" : "user";
}

function normalizeMimeType(value: string | null | undefined) {
  const normalized = nullableText(value)?.toLowerCase();
  if (!normalized) return "text/markdown";
  if (normalized === "text/plain" || normalized === "text/markdown" || normalized === "text/html") return normalized;
  return "text/plain";
}

function nullableText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function firstFieldErrors(errors: Record<string, string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors)
      .map(([field, messages]) => [field, messages?.[0] ?? "Invalid value"] as const)
      .filter(([, message]) => Boolean(message)),
  );
}

function dateMs(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function dateMsOrNull(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  return dateMs(value);
}
