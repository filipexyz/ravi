import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendArtifactEvent, createArtifact, type ArtifactEvent, type ArtifactRecord } from "../artifacts/store.js";
import { getRaviStateDir } from "../utils/paths.js";
import { buildMeetingEventPayload, emitMeetingEvent, MEETING_EVENT_TOPICS } from "./events.js";
import {
  MEETING_RAW_ARTIFACT_KIND,
  type MeetingCaptureDiagnostic,
  type MeetingMediaRef,
  type MeetingParticipant,
  type MeetingSession,
  type MeetingTranscriptSegment,
} from "./types.js";

const RENDERER_SOURCE = "meetings.raw-artifact";

export interface RenderMeetingRawArtifactInput {
  session: MeetingSession;
}

export interface WriteMeetingRawArtifactInput extends RenderMeetingRawArtifactInput {
  outputDir?: string;
  fileName?: string;
}

export interface RegisterMeetingRawArtifactInput extends WriteMeetingRawArtifactInput {
  actor?: string;
}

export interface WriteMeetingRawArtifactResult {
  markdown: string;
  filePath: string;
}

export interface RegisterMeetingRawArtifactResult extends WriteMeetingRawArtifactResult {
  artifact: ArtifactRecord;
  completedEvent: ArtifactEvent;
  handoffMessage: string;
}

export function renderMeetingRawArtifactMarkdown(input: RenderMeetingRawArtifactInput): string {
  const { session } = input;
  const lines: string[] = [];

  lines.push("# Meet", "");
  lines.push("## Metadata", "");
  lines.push(`- Title: ${valueOrDash(session.title ?? session.providerMeetingId ?? session.id)}`);
  lines.push(`- Provider: ${valueOrDash(session.provider)}`);
  lines.push(`- Meeting ID: ${valueOrDash(session.providerMeetingId ?? session.id)}`);
  lines.push(`- URL: ${valueOrDash(session.url)}`);
  lines.push(`- Started at: ${valueOrDash(session.startedAt)}`);
  lines.push(`- Ended at: ${valueOrDash(session.endedAt)}`);
  lines.push(`- Duration: ${session.durationMs === undefined ? "-" : formatDuration(session.durationMs)}`);
  lines.push(`- Origin session: ${valueOrDash(session.originSessionKey ?? session.originSessionName)}`);
  lines.push(`- Origin agent: ${valueOrDash(session.originAgentId)}`);
  lines.push("");

  lines.push("## Participants", "");
  const participants = session.participants ?? [];
  if (participants.length === 0) {
    lines.push("- unavailable");
  } else {
    for (const participant of participants) lines.push(`- ${formatParticipant(participant)}`);
  }
  lines.push("");

  lines.push("## Transcript", "");
  const segments = session.transcriptSegments ?? [];
  if (segments.length === 0) {
    lines.push("- unavailable");
  } else {
    for (const segment of segments) lines.push(formatTranscriptSegment(segment));
    lines.push("");
  }

  lines.push("## Media References", "");
  const mediaRefs = session.mediaRefs ?? [];
  if (mediaRefs.length === 0) {
    lines.push("- none");
  } else {
    for (const mediaRef of mediaRefs) lines.push(`- ${formatMediaRef(mediaRef)}`);
  }
  lines.push("");

  lines.push("## Capture Diagnostics", "");
  const diagnostics = buildDiagnostics(session);
  if (diagnostics.length === 0) {
    lines.push("- none");
  } else {
    for (const diagnostic of diagnostics) lines.push(`- ${formatDiagnostic(diagnostic)}`);
  }
  lines.push("");

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

export function writeMeetingRawArtifact(input: WriteMeetingRawArtifactInput): WriteMeetingRawArtifactResult {
  const markdown = renderMeetingRawArtifactMarkdown(input);
  const outputDir = input.outputDir ?? defaultMeetingArtifactDir(input.session);
  const fileName = input.fileName ?? "meet.md";
  mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, fileName);
  writeFileSync(filePath, markdown, "utf8");
  return { markdown, filePath };
}

export function registerMeetingRawArtifact(input: RegisterMeetingRawArtifactInput): RegisterMeetingRawArtifactResult {
  const written = writeMeetingRawArtifact(input);
  const { session } = input;

  const artifact = createArtifact({
    kind: MEETING_RAW_ARTIFACT_KIND,
    title: session.title ?? session.providerMeetingId ?? session.id,
    status: "completed",
    filePath: written.filePath,
    mimeType: "text/markdown",
    provider: session.provider,
    sessionKey: session.originSessionKey,
    sessionName: session.originSessionName,
    agentId: session.originAgentId,
    messageId: session.messageId,
    channel: session.channel,
    accountId: session.accountId,
    chatId: session.chatId,
    threadId: session.threadId,
    durationMs: session.durationMs,
    metadata: buildArtifactMetadata(session),
    lineage: buildArtifactLineage(session),
    tags: ["meeting", "meeting-raw", "meet-md", session.provider],
  });

  const completedEvent = appendArtifactEvent(artifact.id, {
    eventType: "completed",
    status: "completed",
    message: "Meeting raw artifact generated",
    source: RENDERER_SOURCE,
    actor: input.actor,
    payload: {
      meetingId: session.id,
      provider: session.provider,
      providerMeetingId: session.providerMeetingId ?? null,
      filePath: written.filePath,
      transcriptSegmentCount: session.transcriptSegments?.length ?? 0,
    },
  });

  emitMeetingEvent(
    MEETING_EVENT_TOPICS.artifactGenerated,
    buildMeetingEventPayload({
      session: { ...session, artifactId: artifact.id },
      artifactId: artifact.id,
      artifactPath: written.filePath,
    }),
  );

  return {
    ...written,
    artifact,
    completedEvent,
    handoffMessage: buildMeetingRawArtifactHandoffMessage({
      session: { ...session, artifactId: artifact.id },
      artifact,
      filePath: written.filePath,
    }),
  };
}

export function buildMeetingRawArtifactHandoffMessage(input: {
  session: MeetingSession;
  artifact: Pick<ArtifactRecord, "id">;
  filePath: string;
}): string {
  const { session } = input;
  return [
    "[System] Inform: Meeting raw artifact generated.",
    "",
    `Artifact: ${input.artifact.id}`,
    `Path: ${input.filePath}`,
    `Provider: ${session.provider}`,
    `Meeting: ${session.title ?? session.providerMeetingId ?? session.id}`,
    `Started: ${session.startedAt ?? "-"}`,
    `Ended: ${session.endedAt ?? "-"}`,
    "",
    "Use the artifact as the raw source of truth for post-meeting work.",
  ].join("\n");
}

function buildArtifactMetadata(session: MeetingSession): Record<string, unknown> {
  return {
    meetingId: session.id,
    provider: session.provider,
    providerMeetingId: session.providerMeetingId ?? null,
    title: session.title ?? null,
    url: session.url ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    durationMs: session.durationMs ?? null,
    participantCount: session.participants?.length ?? 0,
    transcriptSegmentCount: session.transcriptSegments?.length ?? 0,
    mediaRefs: (session.mediaRefs ?? []).map((mediaRef) => ({
      kind: mediaRef.kind,
      path: mediaRef.path ?? null,
      uri: mediaRef.uri ?? null,
      providerId: mediaRef.providerId ?? null,
      artifactId: mediaRef.artifactId ?? null,
      mimeType: mediaRef.mimeType ?? null,
      sizeBytes: mediaRef.sizeBytes ?? null,
    })),
  };
}

function buildArtifactLineage(session: MeetingSession): Record<string, unknown> {
  return {
    source: RENDERER_SOURCE,
    meeting: {
      id: session.id,
      provider: session.provider,
      providerMeetingId: session.providerMeetingId ?? null,
    },
    origin: {
      sessionKey: session.originSessionKey ?? null,
      sessionName: session.originSessionName ?? null,
      agentId: session.originAgentId ?? null,
      channel: session.channel ?? null,
      accountId: session.accountId ?? null,
      chatId: session.chatId ?? null,
      threadId: session.threadId ?? null,
      messageId: session.messageId ?? null,
    },
    mediaRefs: (session.mediaRefs ?? []).map((mediaRef) => ({
      kind: mediaRef.kind,
      path: mediaRef.path ?? null,
      uri: mediaRef.uri ?? null,
      providerId: mediaRef.providerId ?? null,
      artifactId: mediaRef.artifactId ?? null,
      source: mediaRef.source ?? null,
    })),
    rawProvenance: session.rawProvenance ?? null,
  };
}

function buildDiagnostics(session: MeetingSession): MeetingCaptureDiagnostic[] {
  const diagnostics = [...(session.diagnostics ?? [])];
  const segments = session.transcriptSegments ?? [];

  if (segments.length === 0) {
    diagnostics.push({ level: "warning", code: "transcript.empty", message: "No transcript segments were captured." });
  }
  if ((session.participants ?? []).length === 0) {
    diagnostics.push({ level: "info", code: "participants.empty", message: "No participant list was captured." });
  }

  const missingSpeakerCount = segments.filter((segment) => !segment.speakerName && !segment.speakerId).length;
  if (missingSpeakerCount > 0) {
    diagnostics.push({
      level: "warning",
      code: "transcript.missing_speaker",
      message: `${missingSpeakerCount} transcript segment(s) have no speaker identity.`,
    });
  }

  const missingTimestampCount = segments.filter(
    (segment) => !segment.startAt && segment.startOffsetMs === undefined && !segment.capturedAt,
  ).length;
  if (missingTimestampCount > 0) {
    diagnostics.push({
      level: "warning",
      code: "transcript.missing_timestamp",
      message: `${missingTimestampCount} transcript segment(s) have no timestamp.`,
    });
  }

  return diagnostics;
}

function defaultMeetingArtifactDir(session: MeetingSession): string {
  return join(getRaviStateDir(), "meetings", safePathSegment(session.id));
}

function safePathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "meeting";
}

function formatParticipant(participant: MeetingParticipant): string {
  const details = [
    participant.kind ? `kind=${participant.kind}` : null,
    participant.role ? `role=${participant.role}` : null,
    participant.id ? `id=${participant.id}` : null,
    participant.providerParticipantId ? `providerId=${participant.providerParticipantId}` : null,
    participant.joinedAt ? `joined=${participant.joinedAt}` : null,
    participant.leftAt ? `left=${participant.leftAt}` : null,
  ].filter(Boolean);
  return details.length > 0 ? `${participant.displayName} (${details.join(", ")})` : participant.displayName;
}

function formatSegmentTimestamp(segment: MeetingTranscriptSegment): string {
  if (segment.startAt) return segment.endAt ? `${segment.startAt} to ${segment.endAt}` : segment.startAt;
  if (segment.startOffsetMs !== undefined) {
    const start = `+${formatOffset(segment.startOffsetMs)}`;
    return segment.endOffsetMs !== undefined ? `${start} to +${formatOffset(segment.endOffsetMs)}` : start;
  }
  if (segment.capturedAt) return segment.capturedAt;
  return "timestamp unavailable";
}

function formatTranscriptSegment(segment: MeetingTranscriptSegment): string {
  const timestamp = formatSegmentTimestamp(segment);
  const speaker = segment.speakerName ?? segment.speakerId ?? "Unknown speaker";
  const text = normalizeMarkdownText(segment.text);
  if (!text.includes("\n")) return `- [${timestamp}] ${speaker}: ${text}`;
  const indented = text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `- [${timestamp}] ${speaker}:\n${indented}`;
}

function formatMediaRef(mediaRef: MeetingMediaRef): string {
  const ref = mediaRef.path ?? mediaRef.uri ?? mediaRef.providerId ?? mediaRef.artifactId ?? "-";
  const details = [
    mediaRef.mimeType ? `mime=${mediaRef.mimeType}` : null,
    mediaRef.sizeBytes !== undefined ? `size=${mediaRef.sizeBytes}` : null,
    mediaRef.source ? `source=${mediaRef.source}` : null,
    mediaRef.startedAt ? `started=${mediaRef.startedAt}` : null,
    mediaRef.endedAt ? `ended=${mediaRef.endedAt}` : null,
    mediaRef.capturedAt ? `captured=${mediaRef.capturedAt}` : null,
  ].filter(Boolean);
  return details.length > 0 ? `${mediaRef.kind}: ${ref} (${details.join(", ")})` : `${mediaRef.kind}: ${ref}`;
}

function formatDiagnostic(diagnostic: MeetingCaptureDiagnostic): string {
  const prefix = [diagnostic.level ?? "info", diagnostic.code].filter(Boolean).join("/");
  const suffix = diagnostic.at ? ` (${diagnostic.at})` : "";
  return `${prefix}: ${diagnostic.message}${suffix}`;
}

function normalizeMarkdownText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trimEnd();
}

function valueOrDash(value: string | undefined): string {
  return value && value.trim() ? value : "-";
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [hours > 0 ? `${hours}h` : null, minutes > 0 || hours > 0 ? `${minutes}m` : null, `${seconds}s`].filter(
    Boolean,
  );
  return parts.join(" ");
}

function formatOffset(offsetMs: number): string {
  const totalMs = Math.max(0, Math.floor(offsetMs));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const base = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
  return ms > 0 ? `${base}.${ms.toString().padStart(3, "0")}` : base;
}
