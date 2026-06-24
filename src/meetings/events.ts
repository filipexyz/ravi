import { isExplicitConnect, publish } from "../nats.js";
import { logger } from "../utils/logger.js";
import type { MeetingMediaRef, MeetingParticipant, MeetingSession } from "./types.js";

const log = logger.child("meetings:events");

export const MEETING_EVENT_TOPICS = {
  ended: "ravi.meetings.ended",
  transcriptAvailable: "ravi.meetings.transcript_available",
  artifactGenerated: "ravi.meetings.artifact_generated",
} as const;

export type MeetingEventTopic = (typeof MEETING_EVENT_TOPICS)[keyof typeof MEETING_EVENT_TOPICS];

type MeetingEventPublisher = (subject: string, payload: Record<string, unknown>) => Promise<void> | void;

let publisherForTests: MeetingEventPublisher | null = null;

export function setMeetingEventPublisherForTests(publisher?: MeetingEventPublisher): void {
  publisherForTests = publisher ?? null;
}

export interface BuildMeetingEventPayloadInput {
  session: MeetingSession;
  artifactId?: string;
  artifactPath?: string;
}

export function buildMeetingEventPayload(input: BuildMeetingEventPayloadInput): Record<string, unknown> {
  const { session } = input;
  return {
    version: 1,
    eventType: "meeting.lifecycle",
    meetingId: session.id,
    provider: session.provider,
    providerMeetingId: session.providerMeetingId ?? null,
    originSessionKey: session.originSessionKey ?? null,
    originSessionName: session.originSessionName ?? null,
    originAgentId: session.originAgentId ?? null,
    artifactId: input.artifactId ?? session.artifactId ?? null,
    artifactPath: input.artifactPath ?? null,
    title: session.title ?? null,
    url: session.url ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    durationMs: session.durationMs ?? null,
    participants: (session.participants ?? []).map(publicParticipantPayload),
    transcriptSegmentCount: session.transcriptSegments?.length ?? 0,
    mediaRefs: (session.mediaRefs ?? []).map(publicMediaRefPayload),
    rawProvenance: session.rawProvenance ?? null,
    occurredAt: new Date().toISOString(),
  };
}

export function emitMeetingEvent(topic: MeetingEventTopic, payload: Record<string, unknown>): void {
  const publisher = publisherForTests ?? (isExplicitConnect() ? publish : null);
  if (!publisher) return;

  Promise.resolve(publisher(topic, payload)).catch((error) => {
    log.warn("Failed to publish meeting event", {
      topic,
      meetingId: typeof payload.meetingId === "string" ? payload.meetingId : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function publicParticipantPayload(participant: MeetingParticipant): Record<string, unknown> {
  return {
    id: participant.id ?? null,
    providerParticipantId: participant.providerParticipantId ?? null,
    displayName: participant.displayName,
    kind: participant.kind ?? null,
    role: participant.role ?? null,
    joinedAt: participant.joinedAt ?? null,
    leftAt: participant.leftAt ?? null,
  };
}

function publicMediaRefPayload(mediaRef: MeetingMediaRef): Record<string, unknown> {
  return {
    kind: mediaRef.kind,
    path: mediaRef.path ?? null,
    uri: mediaRef.uri ?? null,
    providerId: mediaRef.providerId ?? null,
    artifactId: mediaRef.artifactId ?? null,
    mimeType: mediaRef.mimeType ?? null,
    sizeBytes: mediaRef.sizeBytes ?? null,
    startedAt: mediaRef.startedAt ?? null,
    endedAt: mediaRef.endedAt ?? null,
    capturedAt: mediaRef.capturedAt ?? null,
    source: mediaRef.source ?? null,
  };
}
