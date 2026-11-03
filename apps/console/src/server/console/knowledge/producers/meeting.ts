import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { loadRecordingForSystem, type SystemMeetingSegment } from "@/server/console/meetings/system";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { isKnowledgeEnabledForOrganization } from "../enabled";
import { enqueueKnowledgeJob } from "../jobs";
import {
  deleteKnowledgeSourceContent,
  ingestForProducer,
  upsertKnowledgeSourceForOrigin,
  type ProducerChunkInput,
  type ProducerIngestResult,
} from "../producer";
import { scheduleKnowledgeDrain } from "../schedule";
import { foldKnowledgeText, neutralizeKnowledgeText, sanitizeSpeakerName } from "../text";

// Meeting transcripts as knowledge: windows of about a minute of the call, one
// `«Name»: text` line per thing said, never the chat, emails or who hosted.
// Captured from the webhook when a recording is ready, repaired from the read
// route and the tick, kept per project for `meetingRetentionMonths`.

export const MEETING_PARSER_VERSION = "knowledge-meeting-windows-v1";
export const MEETING_RETENTION_DEFAULT_MONTHS = 12;
export const MEETING_RETENTION_MIN_MONTHS = 1;
export const MEETING_RETENTION_MAX_MONTHS = 36;

const WINDOW_MIN_SECONDS = 60;
const WINDOW_MAX_SECONDS = 90;
const WINDOW_MAX_CHARS = 1200;
const READABLE_DOCUMENT_STATUSES = ["chunked", "indexed"] as const;

export type MeetingCaptureTrigger = "meeting_ready" | "meeting_repair" | "meeting_backfill";

type Line = {
  segment: SystemMeetingSegment;
  speaker: string;
  speakerKey: string;
  text: string;
};

/**
 * Windows a transcript into chunks: segments in part then time order, a window
 * closing at a segment boundary once it spans 60 s, or before a segment that
 * would take it past 90 s or 1200 chars. Parts never share a window, and a
 * segment over 1200 chars is cut at sentences into chunks that keep its time.
 */
export function buildMeetingTranscriptChunks(input: {
  segments: readonly SystemMeetingSegment[];
  meetingId?: string | null;
}): ProducerChunkInput[] {
  const chunks: ProducerChunkInput[] = [];
  let window: Line[] = [];
  const close = () => {
    if (window.length) chunks.push(windowChunk(window, input.meetingId ?? null));
    window = [];
  };

  for (const segment of orderSegments(input.segments)) {
    const speaker = sanitizeSpeakerName(segment.speaker);
    const speakerKey = segment.speakerId ?? sha256Hex(speaker).slice(0, 8);
    const prefix = `«${speaker}»: `;
    const text = neutralizeKnowledgeText(segment.text.replace(/\s+/g, " ").trim());
    if (!text) continue;
    if (window.length && window[0]!.segment.part !== segment.part) close();
    for (const piece of splitAtSentences(text, WINDOW_MAX_CHARS - prefix.length)) {
      const line: Line = { segment, speaker, speakerKey, text: piece };
      if (window.length && (windowChars([...window, line]) > WINDOW_MAX_CHARS || windowSpan([...window, line]) > WINDOW_MAX_SECONDS)) {
        close();
      }
      window.push(line);
      if (windowSpan(window) >= WINDOW_MIN_SECONDS) close();
    }
  }
  close();
  return chunks;
}

export async function captureMeetingForKnowledge(
  input: {
    organizationId: string;
    meetingId: string;
    requestId: string;
    trigger: MeetingCaptureTrigger;
    /** Set by the drain handler, so the producer records nothing of its own on the job table. */
    jobId?: string;
  },
  deps: {
    loader?: typeof loadRecordingForSystem;
    ingest?: typeof ingestForProducer;
    now?: () => Date;
    projectMetadata?: (input: { organizationId: string; projectId: string }) => Promise<unknown>;
  } = {},
): Promise<ProducerIngestResult | { status: "not_ready" | "no_project" | "gone" | "not_found" }> {
  const loaded = await (deps.loader ?? loadRecordingForSystem)({ organizationId: input.organizationId, meetingId: input.meetingId });
  if (loaded.status !== "ok") return { status: loaded.status };
  const now = (deps.now ?? (() => new Date()))();
  const { meeting } = loaded;

  const chunks = buildMeetingTranscriptChunks({ segments: loaded.segments, meetingId: meeting.id });
  const joined = chunks.map((chunk) => chunk.text).join("\n");
  const metadata = await (deps.projectMetadata ?? readProjectMetadata)({ organizationId: input.organizationId, projectId: meeting.projectId });
  const startedAt = meeting.startedAt ? new Date(meeting.startedAt) : null;
  const base = startedAt && Number.isFinite(startedAt.getTime()) ? startedAt : now;
  const title = meeting.title?.trim() || `Meeting ${base.toISOString().slice(0, 10)}`;

  return (deps.ingest ?? ingestForProducer)({
    organizationId: input.organizationId,
    projectId: meeting.projectId,
    originKey: meetingOriginKey(meeting.id),
    sourceType: "meeting",
    trustTier: "said",
    title,
    sourceRef: { meetingBotId: meeting.id, projectId: meeting.projectId },
    retainUntil: meetingRetainUntil(base, meetingRetentionMonths(metadata)),
    document: {
      title,
      mimeType: "text/plain",
      parserVersion: MEETING_PARSER_VERSION,
      contentHash: sha256Hex(joined),
      sizeBytes: Buffer.byteLength(joined, "utf8"),
      language: meeting.language && meeting.language !== "auto" ? meeting.language : null,
      sourceLocation: { kind: "meeting", meetingId: meeting.id, parts: loaded.recordings.length },
    },
    chunks,
    actor: { type: "system", id: null },
    triggerType: input.trigger,
    requestId: input.requestId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
  });
}

/** `projects.metadata_json.knowledge.meetingRetentionMonths`: an integer 1–36, 12 when absent. */
export function meetingRetentionMonths(projectMetadata: unknown): number {
  const knowledge = record(record(projectMetadata).knowledge);
  const months = knowledge.meetingRetentionMonths;
  return typeof months === "number" &&
    Number.isInteger(months) &&
    months >= MEETING_RETENTION_MIN_MONTHS &&
    months <= MEETING_RETENTION_MAX_MONTHS
    ? months
    : MEETING_RETENTION_DEFAULT_MONTHS;
}

/** `from` plus whole calendar months (UTC); the last day of a shorter month when the day does not exist. */
export function meetingRetainUntil(from: Date, months: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
}

export function meetingOriginKey(meetingId: string) {
  return `meeting:${meetingId}`;
}

/**
 * Upserts the meeting's source (its `source_id` is what the job row needs) and
 * enqueues one capture job keyed `<trigger>:<meetingId>`. A source a person
 * deleted is never queued again.
 */
export async function enqueueMeetingKnowledgeCapture(
  input: {
    organizationId: string;
    projectId: string;
    meetingId: string;
    title: string | null;
    trigger: MeetingCaptureTrigger;
    requestId: string;
  },
  database: typeof db = db,
): Promise<{ queued: boolean; jobId: string | null; created: boolean }> {
  return database.transaction(async (tx) => {
    const source = await upsertKnowledgeSourceForOrigin(
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        originKey: meetingOriginKey(input.meetingId),
        sourceType: "meeting",
        trustTier: "said",
        title: input.title?.trim() || "Meeting",
        sourceRef: { meetingBotId: input.meetingId, projectId: input.projectId },
        actor: { type: "system", id: null },
        requestId: input.requestId,
        allowRevive: false,
      },
      tx,
    );
    if (source.status === "deleted") return { queued: false, jobId: null, created: false };
    const job = await enqueueKnowledgeJob(
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        sourceId: source.id,
        triggerType: input.trigger,
        inputJson: { schemaVersion: 1, meetingId: input.meetingId },
        idempotencyKey: `${input.trigger}:${input.meetingId}`,
        requestId: input.requestId,
        actor: { type: "system", id: null },
      },
      tx,
    );
    return { queued: true, jobId: job.jobId, created: job.created };
  });
}

export type MeetingReadRepairDeps = {
  enabled?: (organizationId: string) => Promise<boolean>;
  needsRepair?: (input: { organizationId: string; meetingId: string }) => Promise<boolean>;
  enqueue?: typeof enqueueMeetingKnowledgeCapture;
  drain?: (requestId: string) => void;
};

/**
 * The read route's repair (`ravi meetings fetch` runs it): when Knowledge is on
 * and the meeting has no stored transcript, no deleted source and no repair job
 * yet, queue `meeting_repair:<id>` and drain. Never throws.
 */
export async function repairMeetingKnowledgeAfterRead(
  input: { organizationId: string; projectId: string | null; meetingId: string; title: string | null; requestId: string },
  deps: MeetingReadRepairDeps = {},
): Promise<"queued" | "skipped" | "failed"> {
  if (!input.projectId) return "skipped";
  try {
    if (!(await (deps.enabled ?? isKnowledgeEnabledForOrganization)(input.organizationId))) return "skipped";
    if (!(await (deps.needsRepair ?? meetingNeedsRepair)({ organizationId: input.organizationId, meetingId: input.meetingId }))) {
      return "skipped";
    }
    const queued = await (deps.enqueue ?? enqueueMeetingKnowledgeCapture)({
      organizationId: input.organizationId,
      projectId: input.projectId,
      meetingId: input.meetingId,
      title: input.title,
      trigger: "meeting_repair",
      requestId: input.requestId,
    });
    if (!queued.queued) return "skipped";
    (deps.drain ?? scheduleKnowledgeDrain)(input.requestId);
    return "queued";
  } catch {
    console.warn("[knowledge] meeting read repair was not queued", { meetingId: input.meetingId, requestId: input.requestId });
    return "failed";
  }
}

/** No readable document for `meeting:<id>`, a source that is not deleted, and no `meeting_repair:<id>` job yet. */
export async function meetingNeedsRepair(
  input: { organizationId: string; meetingId: string },
  database: typeof db = db,
): Promise<boolean> {
  const originKey = meetingOriginKey(input.meetingId);
  const [source] = await database
    .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status })
    .from(schema.knowledgeSources)
    .where(and(eq(schema.knowledgeSources.organizationId, input.organizationId), eq(schema.knowledgeSources.originKey, originKey)))
    .limit(1);
  if (source?.status === "deleted") return false;
  if (source) {
    const [document] = await database
      .select({ id: schema.knowledgeDocuments.id })
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.sourceId, source.id),
          inArray(schema.knowledgeDocuments.status, [...READABLE_DOCUMENT_STATUSES]),
        ),
      )
      .limit(1);
    if (document) return false;
  }
  const [job] = await database
    .select({ id: schema.knowledgeIngestionJobs.id })
    .from(schema.knowledgeIngestionJobs)
    .where(
      and(
        eq(schema.knowledgeIngestionJobs.organizationId, input.organizationId),
        eq(schema.knowledgeIngestionJobs.idempotencyKey, `meeting_repair:${input.meetingId}`),
      ),
    )
    .limit(1);
  return !job;
}

/** The project's months, recomputed onto every meeting and approved-transcript source of the project. */
export async function recomputeMeetingRetention(
  input: { organizationId: string; projectId: string; months: number },
  database: Pick<typeof db, "execute"> = db,
): Promise<number> {
  const sources = schema.knowledgeSources;
  const result = await database.execute(sql`
    UPDATE ${sources} AS s
    SET retain_until = coalesce(m.recording_started_at, m.created_at, s.created_at) + make_interval(months => ${input.months}::int),
        updated_at = now()
    FROM ${sources} AS src
    LEFT JOIN ${schema.meetingBots} AS m
      ON src.origin_key LIKE 'meeting:%'
     AND m.organization_id = src.organization_id
     AND m.id::text = substring(src.origin_key from 9)
    WHERE s.id = src.id
      AND s.organization_id = ${input.organizationId}::uuid
      AND s.project_id = ${input.projectId}::uuid
      AND s.status <> 'deleted'
      AND (s.origin_key LIKE 'meeting:%' OR s.origin_key LIKE 'transcript:%')
    RETURNING s.id
  `);
  return rowCount(result);
}

export type StoredMeetingTranscript = {
  segments: Array<{ speaker: string; speakerId: string | null; t: number | null; text: string }>;
  documentVersion: number;
  retainUntil: string | null;
};

/** What the meetings routes need from Knowledge; injected in tests, the database otherwise. */
export type MeetingKnowledgeStore = {
  /** The project's months when Knowledge is on for the organization; null when it is off. */
  retentionMonths(input: { organizationId: string; projectId: string }): Promise<number | null>;
  storedTranscript(input: { organizationId: string; meetingId: string }): Promise<StoredMeetingTranscript | null>;
  deleteTranscript(input: {
    organizationId: string;
    projectId: string;
    meetingId: string;
    title: string | null;
    actorUserId: string;
    requestId: string;
  }): Promise<{ chunks: number }>;
  settings(input: { organizationId: string; projectId: string }): Promise<{ transcriptRetentionMonths: number; knowledgeEnabled: boolean }>;
  updateSettings(input: { organizationId: string; projectId: string; months: number; actorUserId: string; requestId: string }): Promise<{
    sources: number;
  }>;
  repairAfterRead(input: { organizationId: string; projectId: string | null; meetingId: string; title: string | null; requestId: string }): Promise<unknown>;
};

export const dbMeetingKnowledgeStore: MeetingKnowledgeStore = {
  async retentionMonths(input) {
    if (!(await isKnowledgeEnabledForOrganization(input.organizationId))) return null;
    return meetingRetentionMonths(await readProjectMetadata(input));
  },
  async storedTranscript(input) {
    const [source] = await db
      .select({ id: schema.knowledgeSources.id, status: schema.knowledgeSources.status, retainUntil: schema.knowledgeSources.retainUntil })
      .from(schema.knowledgeSources)
      .where(
        and(
          eq(schema.knowledgeSources.organizationId, input.organizationId),
          eq(schema.knowledgeSources.originKey, meetingOriginKey(input.meetingId)),
        ),
      )
      .limit(1);
    if (!source || source.status !== "active") return null;
    const [document] = await db
      .select({ id: schema.knowledgeDocuments.id, versionNumber: schema.knowledgeDocuments.versionNumber })
      .from(schema.knowledgeDocuments)
      .where(and(eq(schema.knowledgeDocuments.sourceId, source.id), inArray(schema.knowledgeDocuments.status, [...READABLE_DOCUMENT_STATUSES])))
      .orderBy(desc(schema.knowledgeDocuments.versionNumber))
      .limit(1);
    if (!document) return null;
    const chunks = await db
      .select({ text: schema.knowledgeChunks.text, metadata: schema.knowledgeChunks.safeMetadataJson })
      .from(schema.knowledgeChunks)
      .where(and(eq(schema.knowledgeChunks.documentId, document.id), eq(schema.knowledgeChunks.status, "active")))
      .orderBy(asc(schema.knowledgeChunks.chunkOrdinal));
    return {
      segments: chunks.flatMap((chunk) => storedSegments(chunk.text, chunk.metadata)),
      documentVersion: document.versionNumber,
      retainUntil: source.retainUntil?.toISOString() ?? null,
    };
  },
  async deleteTranscript(input) {
    // The source is created when missing, so a transcript deleted before it was captured is never captured later.
    const source = await db.transaction((tx) =>
      upsertKnowledgeSourceForOrigin(
        {
          organizationId: input.organizationId,
          projectId: input.projectId,
          originKey: meetingOriginKey(input.meetingId),
          sourceType: "meeting",
          trustTier: "said",
          title: input.title?.trim() || "Meeting",
          sourceRef: { meetingBotId: input.meetingId, projectId: input.projectId },
          actor: { type: "user", id: input.actorUserId },
          requestId: input.requestId,
          allowRevive: false,
        },
        tx,
      ),
    );
    const deleted = await deleteKnowledgeSourceContent({
      organizationId: input.organizationId,
      sourceId: source.id,
      actor: { type: "user", id: input.actorUserId },
      reason: "user_deleted",
      requestId: input.requestId,
    });
    return { chunks: deleted.chunks };
  },
  async settings(input) {
    const [enabled, metadata] = await Promise.all([isKnowledgeEnabledForOrganization(input.organizationId), readProjectMetadata(input)]);
    return { transcriptRetentionMonths: meetingRetentionMonths(metadata), knowledgeEnabled: enabled };
  },
  async updateSettings(input) {
    const patch = JSON.stringify({ meetingRetentionMonths: input.months });
    const sources = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.projects)
        .set({
          metadataJson: sql`jsonb_set(coalesce(${schema.projects.metadataJson}, '{}'::jsonb), '{knowledge}', coalesce(${schema.projects.metadataJson}->'knowledge', '{}'::jsonb) || ${patch}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.projects.organizationId, input.organizationId), eq(schema.projects.id, input.projectId)))
        .returning({ id: schema.projects.id });
      if (updated.length === 0) return 0;
      const count = await recomputeMeetingRetention({ organizationId: input.organizationId, projectId: input.projectId, months: input.months }, tx);
      await tx.insert(schema.auditEvents).values({
        organizationId: input.organizationId,
        projectId: input.projectId,
        actorType: "user",
        actorId: input.actorUserId,
        targetType: "project",
        targetId: input.projectId,
        action: "meetings.transcript_retention.updated",
        requestId: input.requestId,
        metadataJson: { source: "meetings", meetingRetentionMonths: input.months, sources: count },
      });
      return count;
    });
    return { sources };
  },
  async repairAfterRead(input) {
    return repairMeetingKnowledgeAfterRead(input);
  },
};

/** A stored window back into segments: its `«Name»: text` lines paired with the `lines` metadata. */
export function storedSegments(text: string, metadata: JsonRecord): StoredMeetingTranscript["segments"] {
  const lines = Array.isArray(metadata.lines) ? (metadata.lines as unknown[]) : [];
  return text
    .split("\n")
    .map((line, index) => {
      const match = /^«([^»]*)»: ?([\s\S]*)$/.exec(line);
      const meta = record(lines[index]);
      const t = typeof meta.t === "number" && Number.isFinite(meta.t) ? meta.t : null;
      return {
        speaker: match ? match[1]! : typeof meta.speaker === "string" ? meta.speaker : "Unknown speaker",
        speakerId: typeof meta.speakerId === "string" ? meta.speakerId : null,
        t,
        text: (match ? match[2]! : line).replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      };
    })
    .filter((segment) => segment.text.trim().length > 0);
}

async function readProjectMetadata(input: { organizationId: string; projectId: string }): Promise<unknown> {
  const [project] = await db
    .select({ metadataJson: schema.projects.metadataJson })
    .from(schema.projects)
    .where(and(eq(schema.projects.organizationId, input.organizationId), eq(schema.projects.id, input.projectId)))
    .limit(1);
  return project?.metadataJson ?? null;
}

function windowChunk(lines: Line[], meetingId: string | null): ProducerChunkInput {
  const first = lines[0]!;
  const firstSeconds = first.segment.callSeconds ?? first.segment.startSeconds ?? 0;
  const partStart = first.segment.startSeconds;
  const partEnd = Math.max(...lines.map((line) => line.segment.endSeconds ?? line.segment.startSeconds ?? -Infinity));
  const endSeconds =
    first.segment.callSeconds !== null && partStart !== null && Number.isFinite(partEnd)
      ? round3(first.segment.callSeconds + Math.max(0, partEnd - partStart))
      : null;
  const speakers = new Map<string, { id: string | null; name: string }>();
  for (const line of lines) {
    if (!speakers.has(line.speakerKey)) speakers.set(line.speakerKey, { id: line.segment.speakerId, name: line.speaker });
  }
  const names = [...new Set([...speakers.values()].map((speaker) => speaker.name))];
  const metadata: JsonRecord = {
    segmentKind: "meeting_window",
    speakers: [...speakers.values()],
    speakersFolded: [...new Set(names.map((name) => foldKnowledgeText(name)).filter(Boolean))],
    lines: lines.map((line) => ({ speakerId: line.segment.speakerId, speaker: line.speaker, t: line.segment.callSeconds })),
  };
  return {
    stableKey: `t${Math.round(firstSeconds)}:${first.speakerKey}:p${first.segment.part}`,
    text: lines.map((line) => `«${line.speaker}»: ${line.text}`).join("\n"),
    heading: null,
    speakers: names,
    location: {
      kind: "meeting",
      meetingId,
      part: first.segment.part,
      startSeconds: first.segment.callSeconds,
      endSeconds,
      partStartSeconds: partStart,
      recordedAt: first.segment.startedAt ?? null,
    },
    metadata,
  };
}

function windowChars(lines: Line[]) {
  return lines.reduce((total, line, index) => total + (index ? 1 : 0) + `«${line.speaker}»: ${line.text}`.length, 0);
}

/** Seconds from the window's first start to its latest end, on the part's own clock. */
function windowSpan(lines: Line[]) {
  const start = lines[0]!.segment.startSeconds;
  if (start === null) return 0;
  const end = Math.max(...lines.map((line) => line.segment.endSeconds ?? line.segment.startSeconds ?? start));
  return Math.max(0, end - start);
}

/** Part, then time; a segment without a time keeps its place after what came before it. */
function orderSegments(segments: readonly SystemMeetingSegment[]) {
  let carriedPart = -1;
  let carried = -Infinity;
  return segments
    .map((segment, order) => {
      if (segment.part !== carriedPart) {
        carriedPart = segment.part;
        carried = -Infinity;
      }
      if (segment.startSeconds !== null) carried = Math.max(carried, segment.startSeconds);
      return { segment, order, at: segment.startSeconds ?? carried };
    })
    .sort((a, b) => a.segment.part - b.segment.part || a.at - b.at || a.order - b.order)
    .map((entry) => entry.segment);
}

/** Pieces of at most `max` chars, cut after sentence ends, then at spaces, then anywhere. */
export function splitAtSentences(text: string, max: number): string[] {
  const limit = Math.max(1, max);
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    for (const part of fitWords(sentence, limit)) {
      const next = current ? `${current} ${part}` : part;
      if (next.length > limit) {
        push();
        current = part;
      } else current = next;
    }
  }
  push();
  return pieces;
}

function fitWords(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const out: string[] = [];
  let current = "";
  for (const word of sentence.split(" ")) {
    const pieces = word.length > limit ? (word.match(new RegExp(`.{1,${limit}}`, "gsu")) ?? []) : [word];
    for (const piece of pieces) {
      const next = current ? `${current} ${piece}` : piece;
      if (next.length > limit) {
        if (current) out.push(current);
        current = piece;
      } else current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const count = (result as { count?: unknown; rowCount?: unknown } | null)?.count ?? (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof count === "number" ? count : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
