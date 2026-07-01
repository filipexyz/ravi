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
import { GOOGLE_MEET_PROVIDER_ID, MEETING_CHANNEL_ID } from "../../channels/meetings/types.js";
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
  const existingSegments = session.transcriptSegments ?? [];
  if (!shouldAddPostCallAudioTranscription(existingSegments)) return session;

  const audioRefs = selectPostCallAudioRefs(session.mediaRefs ?? []);
  if (audioRefs.length === 0) {
    return appendSessionDiagnostic(session, {
      level: "warning",
      code: "transcription.audio_missing",
      message: "Post-call transcription skipped because no captured audio file was available.",
    });
  }

  const speakerNamesByTrackId = loadSpeakerNamesByTrackId(session);
  const audioSegments: MeetingTranscriptSegment[] = [];
  const diagnostics: MeetingCaptureDiagnostic[] = [];
  const transcribedTracks: unknown[] = [];

  for (const audioRef of audioRefs) {
    if (!audioRef.path) continue;
    const mimeType = resolveAudioMimeType(audioRef);
    if (!mimeType) {
      diagnostics.push({
        level: "warning",
        code: "transcription.audio_type_unsupported",
        message: `Post-call transcription skipped because audio type could not be inferred for ${audioRef.path}.`,
      });
      continue;
    }

    try {
      const result = await transcribeFileForMeeting({
        filePath: audioRef.path,
        mimeType,
        language: options.language,
        durationHintSec: mediaRefDurationSeconds(audioRef),
      });
      const speaker = speakerForAudioRef(audioRef, speakerNamesByTrackId);
      const segments = transcriptionResultToMeetingSegments(result, audioRef, session, speaker);
      if (segments.length === 0) {
        diagnostics.push({
          level: "warning",
          code: "transcription.post_call_empty",
          message: `Post-call transcription completed but returned no text for ${audioRef.path}.`,
          rawProvenance: {
            mediaPath: audioRef.path,
            provider: result.provider ?? null,
            model: result.model ?? null,
          },
        });
        continue;
      }

      audioSegments.push(...segments);
      transcribedTracks.push({
        mediaPath: audioRef.path,
        mediaProviderId: audioRef.providerId ?? null,
        speakerId: speaker.speakerId,
        speakerName: speaker.speakerName,
        mimeType,
        provider: result.provider ?? null,
        model: result.model ?? null,
        chunks: result.chunks ?? null,
        duration: result.duration ?? null,
      });
      diagnostics.push({
        level: "info",
        code: "transcription.post_call_audio",
        message: `Generated ${segments.length} post-call audio transcription segment(s) from ${audioRef.path}.`,
        rawProvenance: {
          mediaPath: audioRef.path,
          mediaProviderId: audioRef.providerId ?? null,
          speakerId: speaker.speakerId,
          speakerName: speaker.speakerName,
          provider: result.provider ?? null,
          model: result.model ?? null,
          chunks: result.chunks ?? null,
        },
      });
    } catch (error) {
      diagnostics.push({
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

  if (audioSegments.length === 0) return appendSessionDiagnostics(session, diagnostics);

  return appendSessionDiagnostics(
    {
      ...session,
      participants: ensureTranscriptParticipants(session.participants, audioSegments),
      transcriptSegments: sortTranscriptSegments([...audioSegments, ...existingSegments]),
      rawProvenance: {
        ...(isRecord(session.rawProvenance) ? session.rawProvenance : {}),
        postCallTranscription: {
          tracks: transcribedTracks,
        },
      },
    },
    diagnostics,
  );
}

export function importGoogleMeetRecorderRun(input: GoogleMeetRecorderImportInput): MeetingSession {
  const runDir = input.runDir;
  const metadataPath = join(runDir, "metadata.json");
  const metadata = readJsonFile<RecorderMetadata>(metadataPath);
  const manifest = readOptionalJsonFile<RecorderTrackManifest>(join(runDir, "webrtc-tap", "manifest.json"));
  const transcriptSegments: MeetingTranscriptSegment[] = [];
  const mediaRefs = mergeMediaRefs([...mediaRefsFromManifest(manifest), ...mediaRefsFromMetadata(metadata)]);
  const participants = buildParticipants(metadata, transcriptSegments);
  const diagnostics = buildDiagnostics({ metadata, manifest });
  const providerMeetingId = meetingCodeFromUrl(metadata.meetUrl);
  const startedAt = metadata.timestamps?.recordingStartedAt ?? metadata.startedAt;
  const endedAt = metadata.timestamps?.recordingEndedAt ?? metadata.completedAt;

  return {
    id: meetingIdFromMetadata(input.runDir, metadata),
    provider: GOOGLE_MEET_PROVIDER_ID,
    providerMeetingId,
    title: input.title ?? meetingTitleFromMetadata(input.runDir, metadata),
    url: metadata.meetUrl,
    originSessionKey: input.originSessionKey,
    originSessionName: input.originSessionName,
    originAgentId: input.originAgentId,
    meetingChannel: MEETING_CHANNEL_ID,
    meetingAccountId: GOOGLE_MEET_PROVIDER_ID,
    meetingChatId: providerMeetingId ?? meetingIdFromMetadata(input.runDir, metadata),
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
      manifestPath: manifest ? join(runDir, "webrtc-tap", "manifest.json") : null,
      runId: metadata.runId ?? null,
      status: metadata.status ?? null,
      admissionStatus: metadata.admissionStatus ?? null,
      captureMode: metadata.options?.captureMode ?? null,
    },
  };
}

function selectPostCallAudioRefs(mediaRefs: MeetingMediaRef[]): MeetingMediaRef[] {
  const candidates = mediaRefs.filter(
    (ref) => ref.kind === "audio" && typeof ref.path === "string" && existsSync(ref.path),
  );
  const preferredWebRtcTap = candidates.filter(isWebRtcTapAudioRef);
  return (preferredWebRtcTap.length > 0 ? preferredWebRtcTap : candidates).sort((left, right) => {
    const leftStart = left.startedAt ? Date.parse(left.startedAt) : Number.MAX_SAFE_INTEGER;
    const rightStart = right.startedAt ? Date.parse(right.startedAt) : Number.MAX_SAFE_INTEGER;
    if (leftStart !== rightStart) return leftStart - rightStart;
    return String(left.providerId ?? left.path).localeCompare(String(right.providerId ?? right.path));
  });
}

function shouldAddPostCallAudioTranscription(segments: MeetingTranscriptSegment[]): boolean {
  if (segments.length === 0) return true;
  return !segments.some((segment) => isMeetingAudioTranscriptSegment(segment));
}

function isMeetingAudioTranscriptSegment(segment: MeetingTranscriptSegment): boolean {
  if (segment.source === "audio_transcription") return true;
  if (segment.source === "captions" || segment.source === "imported_transcript" || segment.source === "provider")
    return true;
  return segment.speakerId === "meeting-audio";
}

function isWebRtcTapAudioRef(ref: MeetingMediaRef): boolean {
  const provenanceSource = stringValue(getRecordValue(ref.rawProvenance, "source"));
  const provenanceKind = stringValue(getRecordValue(ref.rawProvenance, "kind"));
  return (
    provenanceKind === "webrtc-track" ||
    provenanceSource === "webrtc-tap" ||
    ref.source === "webrtc-tap manifest" ||
    Boolean(ref.path?.includes("/webrtc-tap/"))
  );
}

function resolveAudioMimeType(mediaRef: MeetingMediaRef): string | undefined {
  if (mediaRef.mimeType?.startsWith("audio/")) return mediaRef.mimeType;
  return mediaRef.path ? inferAudioMimeType(mediaRef.path) : undefined;
}

function mediaRefDurationSeconds(mediaRef: MeetingMediaRef): number | undefined {
  const startedAt = mediaRef.startedAt ? Date.parse(mediaRef.startedAt) : NaN;
  const endedAt = mediaRef.endedAt ? Date.parse(mediaRef.endedAt) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return undefined;
  return (endedAt - startedAt) / 1000;
}

function speakerForAudioRef(
  mediaRef: MeetingMediaRef,
  speakerNamesByTrackId: Map<string, string>,
): { speakerId: string; speakerName: string } {
  const trackId = stringValue(getRecordValue(mediaRef.rawProvenance, "trackId"));
  const speakerName = trackId ? speakerNamesByTrackId.get(trackId) : undefined;
  if (speakerName) return { speakerId: participantId(speakerName), speakerName };
  const fallbackId = mediaRef.providerId ?? (mediaRef.path ? basename(mediaRef.path) : "meeting-audio");
  const fallbackMid = stringValue(getRecordValue(mediaRef.rawProvenance, "mid"));
  return {
    speakerId: participantId(`meeting-audio-${fallbackId}`) || "meeting-audio",
    speakerName: fallbackMid ? `Track ${fallbackMid}` : "Audio da reunião",
  };
}

function transcriptionResultToMeetingSegments(
  result: TranscribeFileResult,
  mediaRef: MeetingMediaRef,
  session: MeetingSession,
  speaker: { speakerId: string; speakerName: string },
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
    .map((segment, index) => {
      const startAt = absoluteIsoFromOffset(mediaRef.startedAt, segment.startSec);
      const endAt =
        segment.endSec !== undefined ? absoluteIsoFromOffset(mediaRef.startedAt, segment.endSec) : undefined;
      return {
        id: `audio-${mediaRef.providerId ?? "track"}-${index}`,
        speakerId: speaker.speakerId,
        speakerName: speaker.speakerName,
        ...(startAt ? { startAt } : {}),
        ...(endAt ? { endAt } : {}),
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
      };
    });
}

function absoluteIsoFromOffset(startedAt: string | undefined, offsetSec: number): string | undefined {
  if (!startedAt) return undefined;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return undefined;
  return new Date(startedMs + Math.round(offsetSec * 1000)).toISOString();
}

function sortTranscriptSegments(segments: MeetingTranscriptSegment[]): MeetingTranscriptSegment[] {
  return [...segments].sort((left, right) => transcriptSortKey(left) - transcriptSortKey(right));
}

function transcriptSortKey(segment: MeetingTranscriptSegment): number {
  const absolute = segment.startAt ?? segment.capturedAt;
  if (absolute) {
    const parsed = Date.parse(absolute);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (segment.startOffsetMs !== undefined) return segment.startOffsetMs;
  return Number.MAX_SAFE_INTEGER;
}

function ensureTranscriptParticipants(
  participants: MeetingParticipant[] | undefined,
  segments: MeetingTranscriptSegment[],
): MeetingParticipant[] {
  const existing = participants ?? [];
  const byId = new Map(existing.map((participant) => [participant.id ?? participant.displayName, participant]));
  for (const segment of segments) {
    if (!segment.speakerId || !segment.speakerName || byId.has(segment.speakerId)) continue;
    byId.set(segment.speakerId, { id: segment.speakerId, displayName: segment.speakerName, kind: "human" });
  }
  return [...byId.values()];
}

function appendSessionDiagnostic(session: MeetingSession, diagnostic: MeetingCaptureDiagnostic): MeetingSession {
  return { ...session, diagnostics: [...(session.diagnostics ?? []), diagnostic] };
}

function appendSessionDiagnostics(session: MeetingSession, diagnostics: MeetingCaptureDiagnostic[]): MeetingSession {
  if (diagnostics.length === 0) return session;
  return { ...session, diagnostics: [...(session.diagnostics ?? []), ...diagnostics] };
}

function loadSpeakerNamesByTrackId(session: MeetingSession): Map<string, string> {
  const runDir = stringValue(getRecordValue(session.rawProvenance, "runDir"));
  if (!runDir) return new Map();
  const eventsPath = join(runDir, "webrtc-tap", "events.jsonl");
  if (!existsSync(eventsPath)) return new Map();

  const counts = new Map<string, Map<string, number>>();
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (getRecordValue(event, "type") !== "speaker-context") continue;
    const trackId = stringValue(getRecordValue(event, "trackId"));
    const name = normalizeDisplayName(getRecordValue(event, "name"));
    const source = stringValue(getRecordValue(event, "source"));
    if (!trackId || !name) continue;
    if (!isReliableSpeakerContextSource(source)) continue;
    const confidence = getRecordValue(event, "confidence");
    if (typeof confidence === "number" && Number.isFinite(confidence) && confidence < 0.5) continue;
    const byName = counts.get(trackId) ?? new Map<string, number>();
    byName.set(name, (byName.get(name) ?? 0) + 1);
    counts.set(trackId, byName);
  }

  const speakers = new Map<string, string>();
  for (const [trackId, byName] of counts.entries()) {
    const [best] = [...byName.entries()].sort((left, right) => right[1] - left[1]);
    if (best) speakers.set(trackId, best[0]);
  }
  return speakers;
}

function isReliableSpeakerContextSource(source: string | undefined): boolean {
  if (!source) return false;
  if (/paired-video/i.test(source)) return false;
  return /participants-panel|external-agent-bus|agent-speaker-bus|media-element-ancestor-attribute/i.test(source);
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
      rawProvenance: { source: "webrtc-tap", mid: track.mid, trackId: track.trackId },
    }));
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
