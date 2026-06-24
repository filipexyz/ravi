import type { MeetingCaptureDiagnostic, MeetingMediaRef, MeetingSession, MeetingTranscriptSegment } from "./types.js";

export interface MeetingStartInput {
  provider: string;
  url?: string;
  title?: string;
  originSessionKey?: string;
  originSessionName?: string;
  originAgentId?: string;
  agentDisplayName?: string;
  rawProvenance?: unknown;
}

export interface MeetingSpeakInput {
  text: string;
  voice?: string;
  interrupt?: boolean;
  rawProvenance?: unknown;
}

export interface MeetingLeaveInput {
  reason?: string;
  rawProvenance?: unknown;
}

export interface MeetingFinalizeResult {
  session: MeetingSession;
  transcriptSegments: MeetingTranscriptSegment[];
  mediaRefs: MeetingMediaRef[];
  diagnostics: MeetingCaptureDiagnostic[];
  artifactId?: string;
  artifactPath?: string;
  handoffMessage?: string;
}

export type MeetingEvent =
  | { type: "meeting.started"; session: MeetingSession }
  | { type: "meeting.transcript_segment"; sessionId: string; segment: MeetingTranscriptSegment }
  | { type: "meeting.media_ref"; sessionId: string; mediaRef: MeetingMediaRef }
  | { type: "meeting.diagnostic"; sessionId: string; diagnostic: MeetingCaptureDiagnostic }
  | { type: "meeting.ended"; session: MeetingSession };

export interface MeetingSessionHandle {
  id: string;
  provider: string;
  providerMeetingId?: string;
  observe(): AsyncIterable<MeetingEvent>;
  speak(input: MeetingSpeakInput): Promise<void>;
  leave(input?: MeetingLeaveInput): Promise<void>;
  finalize(): Promise<MeetingFinalizeResult>;
}

export interface MeetingProvider {
  id: string;
  start(input: MeetingStartInput): Promise<MeetingSessionHandle>;
}
