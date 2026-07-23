import { describe, expect, it } from "bun:test";
import {
  buildMeetingChannelEvent,
  buildMeetingMessageContext,
  buildMeetingMessageTarget,
  GOOGLE_MEET_PROVIDER_ID,
  isMeetingMessageTarget,
  MEETING_CHANNEL_ID,
} from "./types.js";
import type { MeetingSession } from "../../meetings/types.js";

describe("meeting native channel types", () => {
  it("builds message targets with channel=meet and provider provenance kept out of channel id", () => {
    const session = sampleMeetingSession();

    const target = buildMeetingMessageTarget(session, { actorType: "agent", normalizedSenderId: "ravi" });

    expect(target).toEqual({
      channel: MEETING_CHANNEL_ID,
      accountId: GOOGLE_MEET_PROVIDER_ID,
      chatId: "bdw-wzcp-fse",
      actorType: "agent",
      normalizedSenderId: "ravi",
    });
    expect(isMeetingMessageTarget(target)).toBe(true);
  });

  it("builds meeting message context for runtime prompts", () => {
    const context = buildMeetingMessageContext({
      session: sampleMeetingSession(),
      senderId: "human-luis",
      senderName: "Luis",
      messageId: "voice-turn-1",
      timestamp: 1782500000000,
    });

    expect(context).toMatchObject({
      channelId: "meet",
      channelName: "Meet",
      accountId: "google-meet",
      chatId: "bdw-wzcp-fse",
      messageId: "voice-turn-1",
      senderId: "human-luis",
      senderName: "Luis",
      isGroup: true,
      groupId: "bdw-wzcp-fse",
      groupName: "Google Meet bdw-wzcp-fse",
      timestamp: 1782500000000,
    });
  });

  it("builds normalized meeting channel events", () => {
    const event = buildMeetingChannelEvent("meeting.voice.turn.committed", sampleMeetingSession(), {
      sequence: 7,
      occurredAt: "2026-06-26T21:00:00.000Z",
      payload: { text: "teste" },
    });

    expect(event).toEqual({
      type: "meeting.voice.turn.committed",
      meetingId: "meeting-1",
      channel: "meet",
      provider: "google-meet",
      providerMeetingId: "bdw-wzcp-fse",
      meetingChatId: "bdw-wzcp-fse",
      sourceSessionKey: "agent:ravi-meet-v0:whatsapp:group:120363428094858911",
      sourceSessionName: "ravi-meet-v0",
      originAgentId: "ravi-meet-v0",
      sequence: 7,
      occurredAt: "2026-06-26T21:00:00.000Z",
      payload: { text: "teste" },
    });
  });
});

function sampleMeetingSession(): MeetingSession {
  return {
    id: "meeting-1",
    provider: "google-meet",
    providerMeetingId: "bdw-wzcp-fse",
    title: "Google Meet bdw-wzcp-fse",
    originSessionKey: "agent:ravi-meet-v0:whatsapp:group:120363428094858911",
    originSessionName: "ravi-meet-v0",
    originAgentId: "ravi-meet-v0",
    meetingChannel: "meet",
    meetingAccountId: "google-meet",
    meetingChatId: "bdw-wzcp-fse",
  };
}
