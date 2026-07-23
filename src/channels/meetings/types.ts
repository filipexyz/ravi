import type { MessageContext, MessageTarget } from "../../runtime/message-types.js";
import type { MeetingSession } from "../../meetings/types.js";

export const MEETING_CHANNEL_ID = "meet" as const;
export const GOOGLE_MEET_PROVIDER_ID = "google-meet" as const;

export const MEETING_CHANNEL_EVENT_TYPES = [
  "meeting.room.started",
  "meeting.room.admitted",
  "meeting.participant.joined",
  "meeting.participant.left",
  "meeting.voice.turn.started",
  "meeting.voice.turn.delta",
  "meeting.voice.turn.committed",
  "meeting.text.message",
  "meeting.agent.speech.started",
  "meeting.agent.speech.completed",
  "meeting.media.ref",
  "meeting.diagnostic",
  "meeting.room.ended",
  "meeting.artifact.generated",
] as const;

export type MeetingChannelId = typeof MEETING_CHANNEL_ID;
export type MeetingProviderId = typeof GOOGLE_MEET_PROVIDER_ID | (string & {});
export type MeetingChannelEventType = (typeof MEETING_CHANNEL_EVENT_TYPES)[number];

export interface MeetingChannelEvent {
  type: MeetingChannelEventType;
  meetingId: string;
  channel: MeetingChannelId;
  provider: MeetingProviderId;
  providerMeetingId?: string | null;
  meetingChatId: string;
  sourceSessionKey?: string | null;
  sourceSessionName?: string | null;
  originAgentId?: string | null;
  sequence?: number;
  occurredAt: string;
  payload?: Record<string, unknown>;
  rawProvenance?: unknown;
}

export function isMeetingChannelId(channel: string | undefined | null): channel is MeetingChannelId {
  return channel === MEETING_CHANNEL_ID;
}

export function isMeetingMessageTarget(target: Pick<MessageTarget, "channel"> | undefined | null): boolean {
  return isMeetingChannelId(target?.channel);
}

export function getMeetingChannelId(session?: Pick<MeetingSession, "meetingChannel"> | null): MeetingChannelId {
  return isMeetingChannelId(session?.meetingChannel) ? session.meetingChannel : MEETING_CHANNEL_ID;
}

export function getMeetingChatId(session: Pick<MeetingSession, "meetingChatId" | "providerMeetingId" | "id">): string {
  return session.meetingChatId?.trim() || session.providerMeetingId?.trim() || session.id;
}

export function buildMeetingMessageTarget(
  session: Pick<
    MeetingSession,
    | "id"
    | "provider"
    | "providerMeetingId"
    | "meetingAccountId"
    | "meetingChatId"
    | "meetingThreadId"
    | "meetingMessageId"
  >,
  overrides: Partial<MessageTarget> = {},
): MessageTarget {
  return {
    channel: MEETING_CHANNEL_ID,
    accountId: overrides.accountId ?? session.meetingAccountId ?? session.provider,
    chatId: overrides.chatId ?? getMeetingChatId(session),
    ...(overrides.instanceId ? { instanceId: overrides.instanceId } : {}),
    ...(overrides.canonicalChatId ? { canonicalChatId: overrides.canonicalChatId } : {}),
    ...((overrides.threadId ?? session.meetingThreadId)
      ? { threadId: overrides.threadId ?? session.meetingThreadId }
      : {}),
    ...((overrides.sourceMessageId ?? session.meetingMessageId)
      ? { sourceMessageId: overrides.sourceMessageId ?? session.meetingMessageId }
      : {}),
    ...(overrides.actorType ? { actorType: overrides.actorType } : {}),
    ...(overrides.rawSenderId ? { rawSenderId: overrides.rawSenderId } : {}),
    ...(overrides.normalizedSenderId ? { normalizedSenderId: overrides.normalizedSenderId } : {}),
  };
}

export function buildMeetingMessageContext(input: {
  session: Pick<
    MeetingSession,
    "id" | "provider" | "providerMeetingId" | "title" | "meetingAccountId" | "meetingChatId" | "meetingMessageId"
  >;
  senderId: string;
  senderName?: string;
  messageId?: string;
  timestamp?: number;
}): MessageContext {
  const chatId = getMeetingChatId(input.session);
  return {
    channelId: MEETING_CHANNEL_ID,
    channelName: "Meet",
    accountId: input.session.meetingAccountId ?? input.session.provider,
    chatId,
    messageId:
      input.messageId ?? input.session.meetingMessageId ?? `${input.session.id}:${input.timestamp ?? Date.now()}`,
    senderId: input.senderId,
    ...(input.senderName ? { senderName: input.senderName } : {}),
    isGroup: true,
    groupId: chatId,
    groupName: input.session.title ?? input.session.providerMeetingId ?? input.session.id,
    timestamp: input.timestamp ?? Date.now(),
  };
}

export function buildMeetingChannelEvent(
  type: MeetingChannelEventType,
  session: Pick<
    MeetingSession,
    | "id"
    | "provider"
    | "providerMeetingId"
    | "meetingChannel"
    | "meetingChatId"
    | "originSessionKey"
    | "originSessionName"
    | "originAgentId"
  >,
  input: {
    occurredAt?: string;
    sequence?: number;
    payload?: Record<string, unknown>;
    rawProvenance?: unknown;
  } = {},
): MeetingChannelEvent {
  return {
    type,
    meetingId: session.id,
    channel: getMeetingChannelId(session),
    provider: session.provider,
    providerMeetingId: session.providerMeetingId ?? null,
    meetingChatId: getMeetingChatId(session),
    sourceSessionKey: session.originSessionKey ?? null,
    sourceSessionName: session.originSessionName ?? null,
    originAgentId: session.originAgentId ?? null,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...(input.payload ? { payload: input.payload } : {}),
    ...(input.rawProvenance !== undefined ? { rawProvenance: input.rawProvenance } : {}),
  };
}
