// Shapes of the Console's meetings envelope (`/api/console/projects/<p>/meetings`).

export type MeetingStatus =
  | "requested"
  | "joining"
  | "waiting_room"
  | "in_call"
  | "recording"
  | "ended"
  | "done"
  | "failed";

export type Meeting = {
  id: string;
  projectId: string | null;
  platform: string;
  meetingUrl: string;
  meetingCode: string | null;
  botName: string;
  title: string | null;
  language: string;
  clientRef: string | null;
  status: MeetingStatus;
  statusSubCode: string | null;
  transcriptStatus: string;
  ready: boolean;
  joinAt: string | null;
  recordingStartedAt: string | null;
  endedAt: string | null;
  doneAt: string | null;
  recordingSeconds: number | null;
  maxRecordingSeconds: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptSegment = {
  speaker: string | null;
  speakerId: string | null;
  isHost: boolean | null;
  startSeconds: number | null;
  endSeconds: number | null;
  startedAt: string | null;
  text: string;
};

export type MeetingRecording = {
  meeting: Meeting;
  transcript: { status: string; segments: TranscriptSegment[] };
  participants: Array<{ id: string; name: string | null; isHost: boolean | null }>;
  chat: Array<{
    sender: string | null;
    senderId: string | null;
    atSeconds: number | null;
    sentAt: string | null;
    to: string | null;
    text: string;
  }>;
  media: Array<{ kind: "video" | "audio"; format: string; path: string; part: number; expiresAt: string | null }>;
  recordings: Array<{ startedAt: string | null; completedAt: string | null; expiresAt: string | null }>;
};

export type MeetingCreateInput = {
  meetingUrl: string;
  title?: string;
  language?: string;
  joinAt?: string;
};

/** One person given a meeting by email (`meetings/<id>/access`). */
export type MeetingGrant = {
  id: string;
  email: string;
  name: string | null;
  userId: string;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  /** The meeting's page for that person, on this Console. */
  url: string;
};

/** The organization's rule for agents logged into other organizations (`/api/console/meetings/settings`). */
export type MeetingsSharingSettings = {
  externalAgents: boolean;
  canEdit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** A meeting at `/shared/meetings/<id>`, for whoever may see it (`/api/console/shared/meetings/<id>`). */
export type SharedMeeting = {
  meeting: Meeting;
  organization: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string } | null;
  access: "member" | "guest";
  recording: Omit<MeetingRecording, "meeting"> | null;
};

/** The transcript Ravi kept for a meeting (Knowledge), once the recording's own is gone. */
export type StoredTranscript = {
  /** `t`: seconds on the call's clock, or null when the time is unknown. */
  segments: Array<{ speaker: string; speakerId: string | null; t: number | null; text: string }>;
  documentVersion: number;
  retainUntil: string | null;
};

export type MeetingSettings = {
  transcriptRetentionMonths: number;
  knowledgeEnabled: boolean;
  canManage: boolean;
};
