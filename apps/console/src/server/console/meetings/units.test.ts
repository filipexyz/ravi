import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { estimateMeetingCostUsd, evaluateMeetingAllowance, MEETING_DEFAULT_LIMITS, parseMeetingLimits } from "./limits";
import { parseGoogleMeetUrl } from "./meet-url";
import {
  buildRecallCreateBotBody,
  createRecallClient,
  parseRecallWebhookEvent,
  RecallApiError,
  verifyRecallWebhookSignature,
} from "./recall";
import { normalizeRecallChatMessages, normalizeRecallParticipants, normalizeRecallTranscript } from "./transcript";
import { buildMeetingRecordingUsageEvents } from "./usage";

describe("Google Meet links", () => {
  test("accepts links and bare codes, normalized to the code", () => {
    for (const input of [
      "https://meet.google.com/abc-defg-hij",
      "https://meet.google.com/abc-defg-hij?authuser=1&pli=1",
      "meet.google.com/ABC-DEFG-HIJ/",
      "abc-defg-hij",
    ]) {
      expect(parseGoogleMeetUrl(input)).toEqual({
        platform: "google_meet",
        code: "abc-defg-hij",
        url: "https://meet.google.com/abc-defg-hij",
      });
    }
  });

  test("rejects other hosts, credentials, ports and malformed codes", () => {
    for (const input of [
      "https://zoom.us/j/123",
      "https://meet.google.com.evil.test/abc-defg-hij",
      "https://user:pw@meet.google.com/abc-defg-hij",
      "https://meet.google.com:8443/abc-defg-hij",
      "https://meet.google.com/lookup/abc",
      "javascript:alert(1)",
      "",
    ]) {
      expect(parseGoogleMeetUrl(input)).toBeNull();
    }
  });
});

describe("meeting limits", () => {
  test("clamps entitlement overrides", () => {
    expect(parseMeetingLimits(null)).toEqual(MEETING_DEFAULT_LIMITS);
    expect(parseMeetingLimits({ enabled: true, limits: { maxConcurrentBots: 500, maxRecordingSeconds: 10, monthlyBudgetUsd: 12.5 } })).toEqual({
      maxConcurrentBots: 50,
      maxRecordingSeconds: 300,
      monthlyBudgetUsd: 12.5,
    });
  });

  test("estimates recording plus transcription per second", () => {
    expect(estimateMeetingCostUsd(3600)).toBe(0.65);
    expect(estimateMeetingCostUsd(-5)).toBe(0);
  });

  test("blocks at the concurrency cap and when open bots reserve the budget", () => {
    const limits = { maxConcurrentBots: 2, maxRecordingSeconds: 3 * 3600, monthlyBudgetUsd: 30 };
    expect(evaluateMeetingAllowance({ limits, openBots: 2, openReservedSeconds: 0, monthSpentUsd: 0 })).toMatchObject({
      allowed: false,
      reason: "concurrency",
    });
    expect(evaluateMeetingAllowance({ limits, openBots: 1, openReservedSeconds: 3 * 3600, monthSpentUsd: 28 })).toMatchObject({
      allowed: false,
      reason: "budget",
    });
  });

  test("cuts the cap down to what the budget still pays for", () => {
    const limits = { maxConcurrentBots: 3, maxRecordingSeconds: 3 * 3600, monthlyBudgetUsd: 30 };
    const allowance = evaluateMeetingAllowance({ limits, openBots: 0, openReservedSeconds: 0, monthSpentUsd: 29.35 });
    expect(allowance).toMatchObject({ allowed: true });
    if (allowance.allowed) expect(allowance.maxRecordingSeconds).toBe(3599);
  });
});

describe("Recall client", () => {
  test("asks for a visible, announced, capped recording with speakers", () => {
    const body = buildRecallCreateBotBody({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botName: "Ravi",
      joinAt: null,
      language: "pt",
      maxRecordingSeconds: 3600,
      announcement: "Ravi está gravando.",
      metadata: { ravi_meeting_id: "m1" },
    });
    expect(body).toMatchObject({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "Ravi",
      metadata: { ravi_meeting_id: "m1" },
      recording_config: {
        transcript: { provider: { recallai_streaming: { mode: "prioritize_accuracy", language_code: "pt" } } },
        audio_mixed_mp3: {},
      },
      automatic_leave: { in_call_recording_timeout: 3600 },
      chat: { on_bot_join: { send_to: "everyone", message: "Ravi está gravando." } },
    });
    expect("join_at" in body).toBe(false);
  });

  test("sends the API key and maps vendor errors without echoing the body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createRecallClient({ apiKey: "key_1", baseUrl: "https://us-east-1.recall.ai" }, (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ meeting_url: ["https://meet.google.com/secret-link"] }), { status: 400 });
    }) as typeof fetch);
    const error = await client.getBot("bot_1").catch((caught) => caught);
    expect(error).toBeInstanceOf(RecallApiError);
    expect(error.message).toBe("The meeting bot provider rejected: meeting_url.");
    expect(calls[0]?.url).toBe("https://us-east-1.recall.ai/api/v1/bot/bot_1/");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Token key_1");
  });
});

describe("Recall webhooks", () => {
  const secret = `whsec_${Buffer.from("recall-test-secret").toString("base64")}`;
  const body = JSON.stringify({
    event: "bot.done",
    data: {
      data: { code: "done", sub_code: null, updated_at: "2026-10-13T15:00:00.000Z" },
      bot: { id: "bot_1", metadata: { ravi_meeting_id: "m1", ignored: 3 } },
    },
  });
  const now = new Date("2026-10-13T15:00:10.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const sign = (id: string, ts: string, payload: string) =>
    createHmac("sha256", Buffer.from("recall-test-secret")).update(`${id}.${ts}.${payload}`).digest("base64");

  test("verifies Standard Webhooks signatures, also under svix headers", () => {
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,bogus v1,${sign("msg_1", timestamp, body)}`,
    });
    expect(verifyRecallWebhookSignature({ body, headers, secret, now })).toBe(true);
    const svix = new Headers({
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${sign("msg_1", timestamp, body)}`,
    });
    expect(verifyRecallWebhookSignature({ body, headers: svix, secret, now })).toBe(true);
  });

  test("rejects a changed body, a stale timestamp and a malformed secret", () => {
    const signature = `v1,${sign("msg_1", timestamp, body)}`;
    const headers = new Headers({ "webhook-id": "msg_1", "webhook-timestamp": timestamp, "webhook-signature": signature });
    expect(verifyRecallWebhookSignature({ body: `${body} `, headers, secret, now })).toBe(false);
    expect(verifyRecallWebhookSignature({ body, headers, secret, now: new Date(now.getTime() + 10 * 60_000) })).toBe(false);
    expect(verifyRecallWebhookSignature({ body, headers, secret: "recall-test-secret", now })).toBe(false);
  });

  test("parses the bot event and keeps only string metadata", () => {
    expect(parseRecallWebhookEvent(body)).toEqual({
      event: "bot.done",
      botId: "bot_1",
      code: "done",
      subCode: null,
      updatedAt: new Date("2026-10-13T15:00:00.000Z"),
      metadata: { ravi_meeting_id: "m1" },
    });
    expect(parseRecallWebhookEvent("{")).toBeNull();
    expect(parseRecallWebhookEvent(JSON.stringify({ event: "bot.done", data: {} }))).toBeNull();
  });
});

describe("Recall downloads", () => {
  test("transcript entries become speaker segments with offsets", () => {
    const segments = normalizeRecallTranscript([
      {
        participant: { id: 100, name: "Luís", is_host: true, email: "luis@example.com" },
        language_code: "pt",
        words: [
          { text: "Bom", start_timestamp: { relative: 1.25, absolute: "2026-10-13T14:00:01.250Z" }, end_timestamp: { relative: 1.5 } },
          { text: "dia.", start_timestamp: { relative: 1.6 }, end_timestamp: { relative: 2.1, absolute: null } },
        ],
      },
      { participant: { id: 101, name: null }, words: [] },
      "junk",
    ]);
    expect(segments).toEqual([
      {
        speaker: "Luís",
        speakerId: "100",
        isHost: true,
        startSeconds: 1.25,
        endSeconds: 2.1,
        startedAt: "2026-10-13T14:00:01.250Z",
        text: "Bom dia.",
      },
    ]);
    expect(JSON.stringify(segments)).not.toContain("luis@example.com");
  });

  test("participants are unique and chat comes from chat_message events only", () => {
    expect(
      normalizeRecallParticipants([
        { id: 1, name: "Ana", is_host: false, email: "ana@example.com" },
        { id: 1, name: "Ana" },
        { id: 2, name: " " },
      ]),
    ).toEqual([
      { id: "1", name: "Ana", isHost: false },
      { id: "2", name: null, isHost: null },
    ]);
    expect(
      normalizeRecallChatMessages([
        { action: "join", participant: { id: 1, name: "Ana" }, timestamp: { relative: 0 } },
        {
          action: "chat_message",
          participant: { id: 1, name: "Ana" },
          timestamp: { relative: 12, absolute: "2026-10-13T14:00:12.000Z" },
          data: { text: "link da apresentação", to: "everyone" },
        },
      ]),
    ).toEqual([
      { sender: "Ana", senderId: "1", atSeconds: 12, sentAt: "2026-10-13T14:00:12.000Z", to: "everyone", text: "link da apresentação" },
    ]);
  });
});

describe("meeting usage", () => {
  test("one bot count with its estimated cost and the recorded seconds, idempotent per bot", () => {
    const events = buildMeetingRecordingUsageEvents({
      organizationId: "org_1",
      projectId: "proj_1",
      meetingBotId: "m1",
      provider: "recall",
      platform: "google_meet",
      recordingSeconds: 1800,
      outcome: "done",
      endedAt: new Date("2026-10-13T15:00:00.000Z"),
      requestId: "req_1",
    });
    expect(events.map((event) => [event.metricKey, event.quantity, event.unit, event.idempotencyKey])).toEqual([
      ["meetings.bots", "1", "count", "meetings.recording_closed:m1:meetings.bots"],
      ["meetings.recording_seconds", "1800", "seconds", "meetings.recording_closed:m1:meetings.recording_seconds"],
    ]);
    expect(events[0]?.measurementsJson).toMatchObject({ estimatedCostUsd: 0.325 });
    expect(events.every((event) => event.source === "meetings")).toBe(true);
  });
});
