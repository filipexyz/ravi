export const MEETING_RAW_ARTIFACT_KIND = "meeting.raw";

export type MeetingParticipantKind = "human" | "agent" | "unknown" | (string & {});
export type MeetingTranscriptSource =
  | "captions"
  | "audio_transcription"
  | "imported_transcript"
  | "provider"
  | (string & {});
export type MeetingMediaRefKind = "recording" | "audio" | "video" | "screenshot" | "log" | "diagnostic" | (string & {});
export type MeetingDiagnosticLevel = "info" | "warning" | "error" | (string & {});
export type MeetingTextMessageDirection = "inbound" | "outbound" | (string & {});
export type MeetingAgentOutputKind = "speech" | "text" | (string & {});

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

export interface MeetingTextMessage {
  id?: string;
  providerMessageId?: string;
  senderId?: string;
  senderName?: string;
  direction?: MeetingTextMessageDirection;
  sentAt?: string;
  capturedAt?: string;
  threadId?: string;
  replyToId?: string;
  text: string;
  source?: string;
  rawProvenance?: unknown;
}

export interface MeetingAgentOutput {
  id?: string;
  kind: MeetingAgentOutputKind;
  agentId?: string;
  agentName?: string;
  providerMessageId?: string;
  startedAt?: string;
  endedAt?: string;
  sentAt?: string;
  capturedAt?: string;
  text: string;
  deliveryStatus?: "sent" | "delivered" | "failed" | "unknown" | (string & {});
  source?: string;
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
  meetingChannel?: string;
  meetingAccountId?: string;
  meetingChatId?: string;
  meetingThreadId?: string;
  meetingMessageId?: string;
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
  textMessages?: MeetingTextMessage[];
  agentOutputs?: MeetingAgentOutput[];
  mediaRefs?: MeetingMediaRef[];
  diagnostics?: MeetingCaptureDiagnostic[];
  artifactId?: string;
  rawProvenance?: unknown;
}
