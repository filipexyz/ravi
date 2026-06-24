export const MEETING_RAW_ARTIFACT_KIND = "meeting.raw";

export type MeetingParticipantKind = "human" | "agent" | "unknown" | (string & {});
export type MeetingTranscriptSource =
  | "captions"
  | "realtime_transcription"
  | "audio_transcription"
  | "imported_transcript"
  | "provider"
  | (string & {});
export type MeetingMediaRefKind = "recording" | "audio" | "video" | "screenshot" | "log" | "diagnostic" | (string & {});
export type MeetingDiagnosticLevel = "info" | "warning" | "error" | (string & {});

export interface MeetingParticipant {
  id?: string;
  providerParticipantId?: string;
  displayName: string;
  kind?: MeetingParticipantKind;
  role?: string;
  joinedAt?: string;
  leftAt?: string;
  rawProvenance?: unknown;
}

export interface MeetingTranscriptSegment {
  id?: string;
  speakerId?: string;
  speakerName?: string;
  startAt?: string;
  endAt?: string;
  startOffsetMs?: number;
  endOffsetMs?: number;
  capturedAt?: string;
  text: string;
  source: MeetingTranscriptSource;
  confidence?: number;
  rawProvenance?: unknown;
}

export interface MeetingMediaRef {
  kind: MeetingMediaRefKind;
  path?: string;
  uri?: string;
  providerId?: string;
  artifactId?: string;
  mimeType?: string;
  sizeBytes?: number;
  startedAt?: string;
  endedAt?: string;
  capturedAt?: string;
  source?: string;
  rawProvenance?: unknown;
}

export interface MeetingCaptureDiagnostic {
  level?: MeetingDiagnosticLevel;
  code?: string;
  message: string;
  at?: string;
  rawProvenance?: unknown;
}

export interface MeetingSession {
  id: string;
  provider: string;
  providerMeetingId?: string;
  title?: string;
  url?: string;
  originSessionKey?: string;
  originSessionName?: string;
  originAgentId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
  messageId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  participants?: MeetingParticipant[];
  transcriptSegments?: MeetingTranscriptSegment[];
  mediaRefs?: MeetingMediaRef[];
  diagnostics?: MeetingCaptureDiagnostic[];
  artifactId?: string;
  rawProvenance?: unknown;
}
