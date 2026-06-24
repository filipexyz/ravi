import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type {
  MeetingEvent,
  MeetingFinalizeResult,
  MeetingLeaveInput,
  MeetingProvider,
  MeetingSessionHandle,
  MeetingSpeakInput,
  MeetingStartInput,
} from "../provider.js";
import { registerMeetingRawArtifact, type RegisterMeetingRawArtifactResult } from "../raw-artifact.js";
import type {
  MeetingCaptureDiagnostic,
  MeetingMediaRef,
  MeetingParticipant,
  MeetingSession,
  MeetingTranscriptSegment,
} from "../types.js";
import {
  inferAudioMimeType,
  transcribeFile,
  type TranscribeFileInput,
  type TranscribeFileResult,
} from "../../transcribe/service.js";

export interface GoogleMeetRecorderImportInput {
  runDir: string;
  originSessionKey?: string;
  originSessionName?: string;
  originAgentId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
  messageId?: string;
  title?: string;
}

export interface GoogleMeetRecorderFinalizeInput extends GoogleMeetRecorderImportInput {
  outputDir?: string;
  actor?: string;
  postTranscribe?: boolean;
  transcriptionLanguage?: string;
}

export interface GoogleMeetRecorderFinalizeResult extends MeetingFinalizeResult {
  registeredArtifact: RegisterMeetingRawArtifactResult;
}

interface RecorderMediaArtifact {
  kind?: string;
  path?: string;
  exists?: boolean;
  sizeBytes?: number;
  note?: string;
}

interface RecorderFailure {
  step?: string;
  message?: string;
  details?: string;
}

interface RecorderMetadata {
  runId?: string;
  meetUrl?: string;
  botName?: string;
  status?: string;
  admissionStatus?: string;
  startedAt?: string;
  completedAt?: string;
  timestamps?: {
    admittedAt?: string;
    recordingStartedAt?: string;
    recordingEndedAt?: string;
  };
  participants?: {
    detected?: boolean;
    names?: string[];
    note?: string;
  };
  artifacts?: {
    runDir?: string;
    media?: RecorderMediaArtifact[];
  };
  failures?: RecorderFailure[];
  options?: {
    outDir?: string;
    captureMode?: string;
    realtimeAgent?: boolean;
    realtimeTranscribe?: boolean;
    realtimeModel?: string;
    realtimeTranscriptionModel?: string;
  };
}

interface RecorderTrackManifest {
  tracks?: Array<{
    id?: string;
    kind?: string;
    path?: string;
    mimeType?: string;
    bytes?: number;
    startedAt?: string;
    stoppedAt?: string;
    trackId?: string;
    mid?: string;
  }>;
  eventsPath?: string;
  startedAt?: string;
  stoppedAt?: string;
  mode?: string;
  note?: string;
  errors?: string[];
}

interface RealtimeEventEnvelope {
  at?: string;
  event: Record<string, unknown>;
}

let transcribeFileForMeeting: (input: TranscribeFileInput) => Promise<TranscribeFileResult> = transcribeFile;

export function setGoogleMeetRecorderTranscriberForTests(
  implementation: (input: TranscribeFileInput) => Promise<TranscribeFileResult> = transcribeFile,
): void {
  transcribeFileForMeeting = implementation;
}

export class GoogleMeetRecorderProvider implements MeetingProvider {
  readonly id = "google-meet-recorder";

  constructor(private readonly options: { runDir: string; outputDir?: string; actor?: string }) {}

  async start(input: MeetingStartInput): Promise<MeetingSessionHandle> {
    const imported = importGoogleMeetRecorderRun({
      runDir: this.options.runDir,
      title: input.title,
      originSessionKey: input.originSessionKey,
      originSessionName: input.originSessionName,
      originAgentId: input.originAgentId,
    });
    return new GoogleMeetRecorderSessionHandle(imported, {
      outputDir: this.options.outputDir,
      actor: this.options.actor,
    });
  }
}

class GoogleMeetRecorderSessionHandle implements MeetingSessionHandle {
  readonly id: string;
  readonly provider = "google-meet";
  readonly providerMeetingId?: string;

  constructor(
    private readonly session: MeetingSession,
    private readonly options: { outputDir?: string; actor?: string } = {},
  ) {
    this.id = session.id;
    this.providerMeetingId = session.providerMeetingId;
  }

  async *observe(): AsyncIterable<MeetingEvent> {
    yield { type: "meeting.ended", session: this.session };
  }

  async speak(_input: MeetingSpeakInput): Promise<void> {
    throw new Error("GoogleMeetRecorderProvider cannot speak through an already completed recorder run.");
  }

  async leave(_input?: MeetingLeaveInput): Promise<void> {
    return;
  }

  async finalize(): Promise<GoogleMeetRecorderFinalizeResult> {
    const runDir = getRecordValue(this.session.rawProvenance, "runDir");
    if (typeof runDir !== "string" || !runDir.trim()) {
      throw new Error("Google Meet recorder runDir is missing from session provenance.");
    }
    return await finalizeGoogleMeetRecorderRun({
      runDir,
      outputDir: this.options.outputDir,
      actor: this.options.actor,
      originSessionKey: this.session.originSessionKey,
      originSessionName: this.session.originSessionName,
      originAgentId: this.session.originAgentId,
      channel: this.session.channel,
      accountId: this.session.accountId,
      chatId: this.session.chatId,
      threadId: this.session.threadId,
      messageId: this.session.messageId,
      title: this.session.title,
    });
  }
}

export async function finalizeGoogleMeetRecorderRun(
  input: GoogleMeetRecorderFinalizeInput,
): Promise<GoogleMeetRecorderFinalizeResult> {
  const importedSession = importGoogleMeetRecorderRun(input);
  const session =
    input.postTranscribe === false
      ? importedSession
      : await addPostCallAudioTranscription(importedSession, {
          language: input.transcriptionLanguage ?? "pt",
        });
  const registeredArtifact = registerMeetingRawArtifact({
    session,
    outputDir: input.outputDir,
    actor: input.actor,
  });
  const finalizedSession = { ...session, artifactId: registeredArtifact.artifact.id };

  return {
    session: finalizedSession,
    transcriptSegments: finalizedSession.transcriptSegments ?? [],
    mediaRefs: finalizedSession.mediaRefs ?? [],
    diagnostics: finalizedSession.diagnostics ?? [],
    artifactId: registeredArtifact.artifact.id,
    artifactPath: registeredArtifact.filePath,
    handoffMessage: registeredArtifact.handoffMessage,
    registeredArtifact,
  };
}

async function addPostCallAudioTranscription(
  session: MeetingSession,
  options: { language: string },
): Promise<MeetingSession> {
  if ((session.transcriptSegments ?? []).length > 0) return session;

  const audioRef = selectPostCallAudioRef(session.mediaRefs ?? []);
  if (!audioRef?.path) {
    return appendSessionDiagnostic(session, {
      level: "warning",
      code: "transcription.audio_missing",
      message: "Post-call transcription skipped because no captured audio file was available.",
    });
  }

  const mimeType = resolveAudioMimeType(audioRef);
  if (!mimeType) {
    return appendSessionDiagnostic(session, {
      level: "warning",
      code: "transcription.audio_type_unsupported",
      message: `Post-call transcription skipped because audio type could not be inferred for ${audioRef.path}.`,
    });
  }

  try {
    const result = await transcribeFileForMeeting({
      filePath: audioRef.path,
      mimeType,
      language: options.language,
    });
    const segments = transcriptionResultToMeetingSegments(result, audioRef, session);
    if (segments.length === 0) {
      return appendSessionDiagnostic(session, {
        level: "warning",
        code: "transcription.post_call_empty",
        message: `Post-call transcription completed but returned no text for ${audioRef.path}.`,
        rawProvenance: {
          mediaPath: audioRef.path,
          provider: result.provider ?? null,
          model: result.model ?? null,
        },
      });
    }

    return appendSessionDiagnostic(
      {
        ...session,
        participants: ensureMeetingAudioParticipant(session.participants),
        transcriptSegments: segments,
        rawProvenance: {
          ...(isRecord(session.rawProvenance) ? session.rawProvenance : {}),
          postCallTranscription: {
            mediaPath: audioRef.path,
            mimeType,
            provider: result.provider ?? null,
            model: result.model ?? null,
            chunks: result.chunks ?? null,
            duration: result.duration ?? null,
          },
        },
      },
      {
        level: "info",
        code: "transcription.post_call_audio",
        message: `Generated ${segments.length} post-call audio transcription segment(s) from ${audioRef.path}.`,
        rawProvenance: {
          mediaPath: audioRef.path,
          provider: result.provider ?? null,
          model: result.model ?? null,
          chunks: result.chunks ?? null,
        },
      },
    );
  } catch (error) {
    return appendSessionDiagnostic(session, {
      level: "warning",
      code: "transcription.post_call_failed",
      message: `Post-call transcription failed for ${audioRef.path}: ${error instanceof Error ? error.message : String(error)}`,
      rawProvenance: {
        mediaPath: audioRef.path,
        mimeType,
      },
    });
  }
}

export function importGoogleMeetRecorderRun(input: GoogleMeetRecorderImportInput): MeetingSession {
  const runDir = input.runDir;
  const metadataPath = join(runDir, "metadata.json");
  const metadata = readJsonFile<RecorderMetadata>(metadataPath);
  const manifest = readOptionalJsonFile<RecorderTrackManifest>(join(runDir, "webrtc-tap", "manifest.json"));
  const realtimeEventsPath = resolveRealtimeEventsPath(runDir, metadata);
  const transcriptSegments = realtimeEventsPath ? extractTranscriptSegments(realtimeEventsPath, metadata.botName) : [];
  const mediaRefs = mergeMediaRefs([
    ...mediaRefsFromMetadata(metadata),
    ...mediaRefsFromManifest(manifest),
    ...(realtimeEventsPath ? [logMediaRef(realtimeEventsPath, "Realtime transcription events")] : []),
  ]);
  const participants = buildParticipants(metadata, transcriptSegments);
  const diagnostics = buildDiagnostics({ metadata, manifest, realtimeEventsPath, transcriptSegments });
  const startedAt = metadata.timestamps?.recordingStartedAt ?? metadata.startedAt;
  const endedAt = metadata.timestamps?.recordingEndedAt ?? metadata.completedAt;

  return {
    id: meetingIdFromMetadata(input.runDir, metadata),
    provider: "google-meet",
    providerMeetingId: meetingCodeFromUrl(metadata.meetUrl),
    title: input.title ?? meetingTitleFromMetadata(input.runDir, metadata),
    url: metadata.meetUrl,
    originSessionKey: input.originSessionKey,
    originSessionName: input.originSessionName,
    originAgentId: input.originAgentId,
    channel: input.channel,
    accountId: input.accountId,
    chatId: input.chatId,
    threadId: input.threadId,
    messageId: input.messageId,
    startedAt,
    endedAt,
    durationMs: durationBetween(startedAt, endedAt),
    participants,
    transcriptSegments,
    mediaRefs,
    diagnostics,
    rawProvenance: {
      source: "ravi-meet-recorder",
      runDir,
      metadataPath,
      realtimeEventsPath: realtimeEventsPath ?? null,
      manifestPath: manifest ? join(runDir, "webrtc-tap", "manifest.json") : null,
      runId: metadata.runId ?? null,
      status: metadata.status ?? null,
      admissionStatus: metadata.admissionStatus ?? null,
      captureMode: metadata.options?.captureMode ?? null,
      realtimeAgent: metadata.options?.realtimeAgent ?? null,
      realtimeTranscribe: metadata.options?.realtimeTranscribe ?? null,
      realtimeModel: metadata.options?.realtimeModel ?? null,
      realtimeTranscriptionModel: metadata.options?.realtimeTranscriptionModel ?? null,
    },
  };
}

function selectPostCallAudioRef(mediaRefs: MeetingMediaRef[]): MeetingMediaRef | undefined {
  return mediaRefs
    .filter((ref) => ref.kind === "audio" && typeof ref.path === "string" && existsSync(ref.path))
    .sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0))[0];
}

function resolveAudioMimeType(mediaRef: MeetingMediaRef): string | undefined {
  if (mediaRef.mimeType?.startsWith("audio/")) return mediaRef.mimeType;
  return mediaRef.path ? inferAudioMimeType(mediaRef.path) : undefined;
}

function transcriptionResultToMeetingSegments(
  result: TranscribeFileResult,
  mediaRef: MeetingMediaRef,
  session: MeetingSession,
): MeetingTranscriptSegment[] {
  const provider = result.provider ?? "transcribe";
  const model = result.model ?? "unknown";
  const source = {
    mediaPath: mediaRef.path ?? null,
    mediaProviderId: mediaRef.providerId ?? null,
    provider,
    model,
  };
  const transcriptSegments = result.segments?.length
    ? result.segments.map((segment) => ({
        index: segment.index,
        text: segment.text,
        startSec: segment.startSec,
        endSec: segment.endSec,
        duration: segment.duration,
      }))
    : result.text.trim()
      ? [
          {
            index: 0,
            text: result.text.trim(),
            startSec: 0,
            endSec: result.duration,
            duration: result.duration,
          },
        ]
      : [];

  return transcriptSegments
    .filter((segment) => segment.text.trim())
    .map((segment, index) => ({
      id: `audio-${index}`,
      speakerId: "meeting-audio",
      speakerName: "Audio da reunião",
      startOffsetMs: Math.round(segment.startSec * 1000),
      ...(segment.endSec !== undefined ? { endOffsetMs: Math.round(segment.endSec * 1000) } : {}),
      capturedAt: session.endedAt,
      text: segment.text.trim(),
      source: "audio_transcription",
      rawProvenance: {
        ...source,
        chunkIndex: segment.index,
        chunkDuration: segment.duration ?? null,
      },
    }));
}

function ensureMeetingAudioParticipant(participants: MeetingParticipant[] | undefined): MeetingParticipant[] {
  const existing = participants ?? [];
  if (existing.some((participant) => participant.id === "meeting-audio")) return existing;
  return [...existing, { id: "meeting-audio", displayName: "Audio da reunião", kind: "unknown" }];
}

function appendSessionDiagnostic(session: MeetingSession, diagnostic: MeetingCaptureDiagnostic): MeetingSession {
  return { ...session, diagnostics: [...(session.diagnostics ?? []), diagnostic] };
}

function extractTranscriptSegments(eventsPath: string, botName?: string): MeetingTranscriptSegment[] {
  const segments: MeetingTranscriptSegment[] = [];
  const localSpeaker = normalizeDisplayName(botName) || "Ravi";
  const meetingAudioSpeaker = "Audio da reunião";

  for (const envelope of readRealtimeEventEnvelopes(eventsPath)) {
    const eventType = stringValue(envelope.event.type);
    if (eventType === "conversation.item.input_audio_transcription.completed") {
      const text = stringValue(envelope.event.transcript);
      if (!text) continue;
      const itemId = stringValue(envelope.event.item_id);
      segments.push({
        id: itemId ? `input-${itemId}` : stringValue(envelope.event.event_id),
        speakerId: "meeting-audio",
        speakerName: meetingAudioSpeaker,
        startAt: envelope.at,
        capturedAt: envelope.at,
        text,
        source: "realtime_transcription",
        rawProvenance: {
          eventsPath,
          realtimeEventType: eventType,
          eventId: stringValue(envelope.event.event_id) ?? null,
          itemId: itemId ?? null,
        },
      });
      continue;
    }

    if (eventType === "response.output_audio_transcript.done") {
      const text = stringValue(envelope.event.transcript);
      if (!text) continue;
      const itemId = stringValue(envelope.event.item_id);
      segments.push({
        id: itemId ? `output-${itemId}` : stringValue(envelope.event.event_id),
        speakerId: "ravi",
        speakerName: localSpeaker,
        startAt: envelope.at,
        capturedAt: envelope.at,
        text,
        source: "realtime_transcription",
        rawProvenance: {
          eventsPath,
          realtimeEventType: eventType,
          eventId: stringValue(envelope.event.event_id) ?? null,
          responseId: stringValue(envelope.event.response_id) ?? null,
          itemId: itemId ?? null,
        },
      });
    }
  }

  return segments.sort((left, right) => (left.startAt ?? "").localeCompare(right.startAt ?? ""));
}

function readRealtimeEventEnvelopes(eventsPath: string): RealtimeEventEnvelope[] {
  return readJsonl(eventsPath)
    .map(unwrapRealtimeEvent)
    .filter((event): event is RealtimeEventEnvelope => Boolean(event));
}

function unwrapRealtimeEvent(record: unknown): RealtimeEventEnvelope | null {
  if (!isRecord(record)) return null;
  if (record.kind === "completed") {
    const text = stringValue(record.text);
    if (!text) return null;
    return {
      at: stringValue(record.at),
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: text,
        item_id: stringValue(record.itemId),
        content_index: record.contentIndex,
      },
    };
  }
  const directType = stringValue(record.type);
  if (
    directType === "conversation.item.input_audio_transcription.completed" ||
    directType === "response.output_audio_transcript.done"
  ) {
    return { at: stringValue(record.at), event: record };
  }
  if (record.type === "realtime-webrtc-event" && isRecord(record.event)) {
    return { at: stringValue(record.at), event: record.event };
  }
  if (record.type === "browser.event" && isRecord(record.payload)) {
    const payload = record.payload;
    if (payload.type === "realtime-webrtc-event" && isRecord(payload.event)) {
      return { at: stringValue(payload.at) ?? stringValue(record.at), event: payload.event };
    }
  }
  return null;
}

function buildParticipants(metadata: RecorderMetadata, segments: MeetingTranscriptSegment[]): MeetingParticipant[] {
  const participants = new Map<string, MeetingParticipant>();
  const botName = normalizeDisplayName(metadata.botName) || "Ravi";
  participants.set("ravi", { id: "ravi", displayName: botName, kind: "agent" });

  for (const name of metadata.participants?.names ?? []) {
    const displayName = normalizeDisplayName(name);
    if (!displayName) continue;
    const id = participantId(displayName);
    participants.set(id, { id, displayName, kind: "human" });
  }

  if (segments.some((segment) => segment.speakerId === "meeting-audio")) {
    participants.set("meeting-audio", { id: "meeting-audio", displayName: "Audio da reunião", kind: "unknown" });
  }

  return [...participants.values()];
}

function buildDiagnostics(input: {
  metadata: RecorderMetadata;
  manifest: RecorderTrackManifest | null;
  realtimeEventsPath: string | null;
  transcriptSegments: MeetingTranscriptSegment[];
}): MeetingCaptureDiagnostic[] {
  const diagnostics: MeetingCaptureDiagnostic[] = [];

  for (const failure of input.metadata.failures ?? []) {
    diagnostics.push({
      level: "error",
      code: failure.step,
      message: [failure.message, failure.details].filter(Boolean).join(" "),
    });
  }

  const participantsNote = input.metadata.participants?.note;
  if (participantsNote) {
    diagnostics.push({ level: "info", code: "recorder.participants", message: participantsNote });
  }

  for (const artifact of input.metadata.artifacts?.media ?? []) {
    if (artifact.exists === false && artifact.path) {
      diagnostics.push({
        level: "warning",
        code: "recorder.artifact_missing",
        message: `Expected recorder artifact was not found: ${artifact.path}`,
      });
    }
  }

  for (const error of input.manifest?.errors ?? []) {
    diagnostics.push({ level: "error", code: "webrtc-tap.error", message: error });
  }

  if (!input.realtimeEventsPath) {
    diagnostics.push({ level: "warning", code: "realtime.events_missing", message: "Realtime events log not found." });
  } else {
    diagnostics.push({
      level: "info",
      code: "realtime.events_parsed",
      message: `Parsed ${input.transcriptSegments.length} final transcript segment(s) from ${input.realtimeEventsPath}.`,
    });
  }

  return diagnostics;
}

function mediaRefsFromMetadata(metadata: RecorderMetadata): MeetingMediaRef[] {
  return (metadata.artifacts?.media ?? [])
    .filter((artifact) => artifact.exists !== false && Boolean(artifact.path))
    .map((artifact) => ({
      kind: mapMediaKind(artifact.kind, artifact.path),
      path: artifact.path,
      providerId: artifact.path ? basename(artifact.path) : undefined,
      mimeType: inferMimeType(artifact.path, artifact.kind),
      sizeBytes: artifact.sizeBytes,
      source: artifact.note ?? artifact.kind,
      rawProvenance: { source: "metadata.json", kind: artifact.kind },
    }));
}

function mediaRefsFromManifest(manifest: RecorderTrackManifest | null): MeetingMediaRef[] {
  if (!manifest) return [];
  return (manifest.tracks ?? [])
    .filter((track) => Boolean(track.path))
    .map((track) => ({
      kind: track.kind === "video" ? "video" : track.kind === "audio" ? "audio" : "diagnostic",
      path: track.path,
      providerId: track.id ?? track.trackId,
      mimeType: track.mimeType ?? inferMimeType(track.path, track.kind),
      sizeBytes: track.bytes,
      startedAt: track.startedAt,
      endedAt: track.stoppedAt,
      source: "webrtc-tap manifest",
      rawProvenance: { mid: track.mid, trackId: track.trackId },
    }));
}

function logMediaRef(path: string, source: string): MeetingMediaRef {
  return {
    kind: "log",
    path,
    providerId: basename(path),
    mimeType: inferMimeType(path, "log"),
    source,
  };
}

function mergeMediaRefs(refs: MeetingMediaRef[]): MeetingMediaRef[] {
  const seen = new Set<string>();
  const merged: MeetingMediaRef[] = [];
  for (const ref of refs) {
    const key = ref.path
      ? [ref.kind, ref.path].join("\0")
      : [ref.kind, ref.uri, ref.providerId, ref.artifactId].filter(Boolean).join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

function resolveRealtimeEventsPath(runDir: string, metadata: RecorderMetadata): string | null {
  const candidates = [
    join(runDir, "realtime-webrtc", "events.jsonl"),
    join(runDir, "realtime", "transcript.jsonl"),
    join(runDir, "webrtc-tap", "events.jsonl"),
    ...(metadata.artifacts?.media ?? [])
      .map((artifact) => artifact.path)
      .filter((path): path is string => Boolean(path && /realtime.*\.jsonl$/.test(path))),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function meetingIdFromMetadata(runDir: string, metadata: RecorderMetadata): string {
  const genericContainers = new Set(["artifacts", "meetings", "meet-recordings", "runs", "recordings"]);
  const outDirBase = basename(stringValue(metadata.options?.outDir) ?? "");
  if (outDirBase && !genericContainers.has(outDirBase)) return outDirBase;
  const parent = basename(dirname(runDir));
  if (parent && parent !== "." && !genericContainers.has(parent)) return parent;
  const code = meetingCodeFromUrl(metadata.meetUrl);
  const prefix = code ? `google-meet-${code}` : "google-meet";
  return `${prefix}-${metadata.runId ?? Date.now()}`;
}

function meetingTitleFromMetadata(runDir: string, metadata: RecorderMetadata): string {
  const code = meetingCodeFromUrl(metadata.meetUrl);
  return code ? `Google Meet ${code}` : meetingIdFromMetadata(runDir, metadata);
}

function meetingCodeFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "meet.google.com") return undefined;
    const code = parsed.pathname.split("/").filter(Boolean)[0];
    return code || undefined;
  } catch {
    return undefined;
  }
}

function mapMediaKind(kind: string | undefined, path: string | undefined): MeetingMediaRef["kind"] {
  if (kind === "avfoundation") return "recording";
  if (kind === "playwright-video") return "video";
  if (kind === "screenshot") return "screenshot";
  if (kind === "log" || kind === "transcript") return "log";
  if (kind === "realtime-audio") return "audio";
  if (kind === "webrtc-tap") return "diagnostic";
  if (kind === "webrtc-track") {
    if (path?.includes(".audio.") || path?.endsWith(".audio.webm")) return "audio";
    if (path?.includes(".video.") || path?.endsWith(".video.webm")) return "video";
    return "diagnostic";
  }
  return kind || "diagnostic";
}

function inferMimeType(path: string | undefined, kind: string | undefined): string | undefined {
  const ext = path ? extname(path).toLowerCase() : "";
  if (ext === ".json") return "application/json";
  if (ext === ".jsonl") return "application/x-ndjson";
  if (ext === ".png") return "image/png";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".webm") {
    if (kind === "audio" || path?.includes(".audio.")) return "audio/webm";
    if (kind === "video" || path?.includes(".video.")) return "video/webm";
    return "application/octet-stream";
  }
  return undefined;
}

function durationBetween(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readOptionalJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return readJsonFile<T>(path);
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function participantId(displayName: string): string {
  return displayName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getRecordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
