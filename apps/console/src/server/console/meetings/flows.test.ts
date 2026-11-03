import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { UsageEventRecordInput } from "@/server/console/billing/usage-metering";

import { handleMeetingsCliRequest, routeMeetingsRequest, type MeetingsCliRequest, type MeetingsRouteRequest } from "./cli";
import type { RecallBot, RecallClient, RecallCreateBotInput, RecallWebhookEvent } from "./recall";
import { createRecallClient, RecallApiError } from "./recall";
import type { MeetingsDeps } from "./service";
import { OPEN_MEETING_BOT_STATUSES, type MeetingBotRow, type MeetingBotStore, type MeetingInboxItem } from "./store";
import { processRecallWebhook, queueMeetingKnowledgeAfterWebhook, type RecallWebhookResult } from "./webhook";
import type { MeetingKnowledgeStore } from "@/server/console/knowledge/producers/meeting";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const INSTALLATION = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-10-13T14:00:00.000Z");

function memoryStore(options: { open?: { count: number; reservedSeconds: number }; spent?: number } = {}) {
  const rows = new Map<string, MeetingBotRow>();
  const deliveries = new Set<string>();
  const usage: UsageEventRecordInput[] = [];
  const inbox: MeetingInboxItem[] = [];
  const audits: string[] = [];
  const store: MeetingBotStore = {
    async insert(values) {
      const row = {
        id: randomUUID(),
        projectId: null,
        requestedByUserId: null,
        localInstallationId: null,
        provider: "recall",
        providerBotId: null,
        meetingCode: null,
        title: null,
        clientRef: null,
        status: "requested",
        statusSubCode: null,
        transcriptStatus: "pending",
        joinAt: null,
        recordingStartedAt: null,
        endedAt: null,
        doneAt: null,
        recordingSeconds: null,
        readyNotifiedAt: null,
        failureReason: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...values,
      } as MeetingBotRow;
      rows.set(row.id, row);
      return row;
    },
    async update(id, patch) {
      const row = { ...rows.get(id)!, ...patch } as MeetingBotRow;
      rows.set(id, row);
      return row;
    },
    async findById(organizationId, id) {
      const row = rows.get(id);
      return row && row.organizationId === organizationId ? row : null;
    },
    async findByProviderBotId(provider, botId) {
      return [...rows.values()].find((row) => row.provider === provider && row.providerBotId === botId) ?? null;
    },
    async listForProject(_organizationId, projectId) {
      return [...rows.values()].filter((row) => row.projectId === projectId);
    },
    async openBots() {
      const base = options.open ?? { count: 0, reservedSeconds: 0 };
      const open = [...rows.values()].filter((row) => OPEN_MEETING_BOT_STATUSES.includes(row.status as never));
      return {
        count: base.count + open.length,
        reservedSeconds: base.reservedSeconds + open.reduce((sum, row) => sum + row.maxRecordingSeconds, 0),
      };
    },
    async monthSpentUsd() {
      return options.spent ?? 0;
    },
    async limitsValueJson() {
      return { enabled: true };
    },
    async recordDelivery(input) {
      if (deliveries.has(input.deliveryId)) return false;
      deliveries.add(input.deliveryId);
      return true;
    },
    async forgetDelivery(_provider, deliveryId) {
      deliveries.delete(deliveryId);
    },
    async recordUsage(events) {
      usage.push(...events);
    },
    async recordInboxItem(item) {
      inbox.push(item);
    },
    async audit(input) {
      audits.push(input.action);
    },
  };
  return { store, rows, usage, inbox, audits };
}

function fakeRecall(bot: Partial<RecallBot> = {}, downloads: Record<string, unknown> = {}) {
  const created: RecallCreateBotInput[] = [];
  const left: string[] = [];
  const recall: RecallClient = {
    async createBot(input) {
      created.push(input);
      return { id: "bot_1", ...bot };
    },
    async getBot(id) {
      return { id, ...bot };
    },
    async leaveCall(id) {
      left.push(id);
    },
    async downloadJson(url) {
      return downloads[url];
    },
  };
  return { recall, created, left };
}

function request(method: string, segments: string[], body: unknown = {}, scopes = ["console.projects.read", "console.projects.link"]): MeetingsCliRequest {
  return {
    auth: {
      user: { id: USER } as MeetingsCliRequest["auth"]["user"],
      organization: { id: ORG } as MeetingsCliRequest["auth"]["organization"],
      membership: { role: "owner" } as MeetingsCliRequest["auth"]["membership"],
      localInstallation: { id: INSTALLATION },
      cliSession: { id: "synthetic-session" },
      accessTokenJti: "synthetic-jti",
      scopes,
    },
    requestId: "req_1",
    method,
    projectRef: "ravi",
    segments,
    body,
    searchParams: new URLSearchParams(),
  };
}

function fakeKnowledge(options: { months?: number | null } = {}) {
  const calls: string[] = [];
  const knowledge: MeetingKnowledgeStore = {
    async retentionMonths() {
      calls.push("retentionMonths");
      return options.months ?? null;
    },
    async storedTranscript() {
      calls.push("storedTranscript");
      return { segments: [{ speaker: "Ana", speakerId: "1", t: 3, text: "Oi" }], documentVersion: 1, retainUntil: null };
    },
    async deleteTranscript() {
      calls.push("deleteTranscript");
      return { chunks: 4 };
    },
    async settings() {
      calls.push("settings");
      return { transcriptRetentionMonths: 12, knowledgeEnabled: true };
    },
    async updateSettings(input) {
      calls.push(`updateSettings:${input.months}`);
      return { sources: 2 };
    },
    async repairAfterRead() {
      calls.push("repairAfterRead");
    },
  };
  return { knowledge, calls };
}

function deps(store: MeetingBotStore, recall: RecallClient | null, enabled = true, knowledge = fakeKnowledge().knowledge): MeetingsDeps {
  return {
    store,
    recall,
    now: () => NOW,
    featureEnabled: async () => enabled,
    resolveProject: async (_workspace, ref) => (ref === "ravi" ? { id: PROJECT } : null),
    knowledge,
  };
}

function event(name: string, extra: Partial<RecallWebhookEvent> = {}): RecallWebhookEvent {
  return { event: name, botId: "bot_1", code: null, subCode: null, updatedAt: null, metadata: {}, ...extra };
}

describe("meetings CLI", () => {
  test("join sends a bot for the calling installation and returns the meeting", async () => {
    const { store, rows, audits } = memoryStore();
    const { recall, created } = fakeRecall();
    const result = await handleMeetingsCliRequest(
      request("POST", [], { meetingUrl: "https://meet.google.com/abc-defg-hij?authuser=0", clientRef: "art_1", title: "Daily" }),
      deps(store, recall),
    );
    expect(result.status).toBe(201);
    const meeting = (result.payload as { meeting: { id: string; status: string; meetingCode: string } }).meeting;
    expect(meeting).toMatchObject({ status: "joining", meetingCode: "abc-defg-hij" });
    expect(created[0]).toMatchObject({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botName: "Ravi",
      language: "pt",
      maxRecordingSeconds: 3 * 3600,
      metadata: { ravi_meeting_id: meeting.id, ravi_organization_id: ORG },
    });
    expect(created[0]?.announcement).toContain("gravar");
    expect(rows.get(meeting.id)).toMatchObject({ localInstallationId: INSTALLATION, clientRef: "art_1", providerBotId: "bot_1" });
    expect(audits).toEqual(["meetings.bot.created"]);
  });

  test("refuses other platforms, missing scope, disabled feature and the caps", async () => {
    const { store } = memoryStore();
    const { recall } = fakeRecall();
    const fail = (promise: Promise<unknown>) => promise.then(() => null, (error: { status: number; code: string }) => [error.status, error.code]);

    expect(await fail(handleMeetingsCliRequest(request("POST", [], { meetingUrl: "https://zoom.us/j/1" }), deps(store, recall)))).toEqual([400, "PAYLOAD_INVALID"]);
    expect(await fail(handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }, ["console.projects.read"]), deps(store, recall)))).toEqual([403, "PROJECT_ACCESS_DENIED"]);
    expect(await fail(handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall, false)))).toEqual([403, "ORG_ACCESS_DENIED"]);
    expect(await fail(handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, null)))).toEqual([503, "SERVER_UNAVAILABLE"]);
    const busy = memoryStore({ open: { count: 3, reservedSeconds: 0 } });
    expect(await fail(handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(busy.store, recall)))).toEqual([429, "RATE_LIMITED"]);
  });

  test("a joinAt within the tolerance but not in the future joins now", async () => {
    const { store } = memoryStore();
    const { recall, created } = fakeRecall();
    const past = await handleMeetingsCliRequest(
      request("POST", [], { meetingUrl: "abc-defg-hij", joinAt: new Date(NOW.getTime() - 30_000).toISOString() }),
      deps(store, recall),
    );
    expect((past.payload as { meeting: { status: string; joinAt: string | null } }).meeting).toMatchObject({ status: "joining", joinAt: null });
    expect(created[0]?.joinAt).toBeNull();

    const later = new Date(NOW.getTime() + 3_600_000);
    const scheduled = await handleMeetingsCliRequest(
      request("POST", [], { meetingUrl: "abc-defg-hij", joinAt: later.toISOString() }),
      deps(store, recall),
    );
    expect((scheduled.payload as { meeting: { status: string } }).meeting.status).toBe("requested");
    expect(created[1]?.joinAt?.toISOString()).toBe(later.toISOString());
  });

  test("parallel joins that cross the cap back out before any bot is sent", async () => {
    const memory = memoryStore({ open: { count: 2, reservedSeconds: 0 } });
    const insert = memory.store.insert;
    // Another join for the same organization lands between our check and our insert.
    memory.store.insert = async (values) => {
      await insert({ ...values, clientRef: "other" });
      return insert(values);
    };
    const { recall, created } = fakeRecall();
    const error = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(memory.store, recall)).catch(
      (caught) => caught,
    );
    expect([error.status, error.code, error.details?.reason]).toEqual([429, "RATE_LIMITED", "concurrency"]);
    expect(created).toHaveLength(0);
    expect([...memory.rows.values()].find((row) => row.clientRef !== "other")).toMatchObject({
      status: "failed",
      failureReason: "limit_exceeded",
    });
  });

  test("the budget recheck reads spend again, so a bot that finished in between counts", async () => {
    const memory = memoryStore();
    let spentReads = 0;
    // $29 of the $30 budget is spent between the first check and the recheck.
    memory.store.monthSpentUsd = async () => (spentReads++ === 0 ? 0 : 29);
    const { recall, created } = fakeRecall();
    const error = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(memory.store, recall)).catch(
      (caught) => caught,
    );
    expect([error.status, error.details?.reason]).toEqual([429, "budget"]);
    expect(created).toHaveLength(0);
  });

  test("the vendor client gives up after its timeout", async () => {
    let signal: AbortSignal | null | undefined;
    const client = createRecallClient({ apiKey: "k", baseUrl: "https://vendor.test" }, (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch);
    const error = await client.getBot("bot_1").catch((caught) => caught);
    expect(error).toBeInstanceOf(RecallApiError);
    expect([error.status, error.message]).toEqual([503, "The meeting bot provider timed out."]);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(await client.downloadJson("https://vendor.test/x").catch((caught) => caught.status)).toBe(503);

    // A body that stalls past the timeout aborts while it is read.
    const stalled = createRecallClient({ apiKey: "k", baseUrl: "https://vendor.test" }, (async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new DOMException("The operation timed out.", "TimeoutError"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch);
    expect(await stalled.getBot("bot_1").catch((caught) => [caught.constructor.name, caught.status])).toEqual(["RecallApiError", 503]);
    expect(await stalled.downloadJson("https://vendor.test/x").catch((caught) => caught.status)).toBe(503);
  });

  test("a vendor refusal marks the row failed", async () => {
    const { store, rows } = memoryStore();
    const recall: RecallClient = {
      ...fakeRecall().recall,
      async createBot() {
        throw new RecallApiError(507, "No cloud meeting bot is available right now. Try again in a few minutes.");
      },
    };
    const error = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall)).catch((caught) => caught);
    expect([error.status, error.code]).toEqual([429, "RATE_LIMITED"]);
    expect([...rows.values()][0]).toMatchObject({ status: "failed" });
  });

  test("recording is refused until done, then comes back in Ravi's shape", async () => {
    const { store } = memoryStore();
    const bot: Partial<RecallBot> = {
      recordings: [
        {
          id: "rec_1",
          started_at: "2026-10-13T14:01:00.000Z",
          completed_at: "2026-10-13T14:31:00.000Z",
          expires_at: "2026-10-20T14:31:00.000Z",
          status: { code: "done" },
          media_shortcuts: {
            transcript: { status: { code: "done" }, data: { download_url: "https://dl/transcript" } },
            participant_events: {
              status: { code: "done" },
              data: { participants_download_url: "https://dl/participants", participant_events_download_url: "https://dl/events" },
            },
            video_mixed: { status: { code: "done" }, format: "mp4", data: { download_url: "https://dl/video.mp4" } },
            audio_mixed: { status: { code: "done" }, format: "mp3", data: { download_url: "https://dl/audio.mp3" } },
          },
        },
      ],
    };
    const { recall } = fakeRecall(bot, {
      "https://dl/transcript": [{ participant: { id: 1, name: "Ana" }, words: [{ text: "Oi", start_timestamp: { relative: 3 }, end_timestamp: { relative: 4 } }] }],
      "https://dl/participants": [{ id: 1, name: "Ana", is_host: true }],
      "https://dl/events": [],
    });
    const joined = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall));
    const id = (joined.payload as { meeting: { id: string } }).meeting.id;

    const early = await handleMeetingsCliRequest(request("GET", [id, "recording"]), deps(store, recall)).catch((caught) => caught);
    expect([early.status, early.code]).toEqual([409, "CONFLICT"]);

    await processRecallWebhook({ deliveryId: "d1", event: event("bot.in_call_recording"), requestId: "r" }, { store, recall });
    await processRecallWebhook({ deliveryId: "d2", event: event("bot.done"), requestId: "r" }, { store, recall });

    const result = await handleMeetingsCliRequest(request("GET", [id, "recording"]), deps(store, recall));
    expect(result.payload).toMatchObject({
      meeting: { id, status: "done", ready: true, recordingSeconds: 1800, transcriptStatus: "done" },
      transcript: { status: "done", segments: [{ speaker: "Ana", startSeconds: 3, text: "Oi" }] },
      participants: [{ id: "1", name: "Ana", isHost: true }],
      media: [
        { kind: "video", format: "mp4", path: `/api/cli/projects/ravi/meetings/${id}/media/video?part=0`, part: 0, expiresAt: "2026-10-20T14:31:00.000Z" },
        { kind: "audio", format: "mp3", path: `/api/cli/projects/ravi/meetings/${id}/media/audio?part=0`, part: 0 },
      ],
      recordings: [{ startedAt: "2026-10-13T14:01:00.000Z" }],
    });
    // The vendor never shows: no provider field, no vendor ids, no vendor links.
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toMatch(/recall|rec_1|bot_1|https:\/\/dl\//i);

    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return new Response("mp3-bytes", { headers: { "content-length": "9" } });
    }) as unknown as typeof fetch;
    const audioRequest = { ...request("GET", [id, "media", "audio"]), searchParams: new URLSearchParams("part=0") };
    const audio = await handleMeetingsCliRequest(audioRequest, { ...deps(store, recall), fetchImpl });
    if (!audio.stream) throw new Error("expected a stream");
    expect(audio.stream.headers).toMatchObject({ "content-type": "audio/mpeg", "content-length": "9" });
    expect(await new Response(audio.stream.body).text()).toBe("mp3-bytes");
    expect(fetched).toEqual(["https://dl/audio.mp3"]);
    const missing = await handleMeetingsCliRequest(
      { ...request("GET", [id, "media", "audio"]), searchParams: new URLSearchParams("part=4") },
      { ...deps(store, recall), fetchImpl },
    ).catch((caught) => caught);
    expect([missing.status, missing.code]).toEqual([404, "NOT_FOUND"]);

    const other = await handleMeetingsCliRequest(request("GET", [id]), { ...deps(store, recall), resolveProject: async () => ({ id: "another" }) }).catch((caught) => caught);
    expect([other.status, other.code]).toEqual([404, "NOT_FOUND"]);
  });

  test("the Console UI envelope serves media from its own route, with no installation, and lets players seek", async () => {
    const { store, rows } = memoryStore();
    const { recall } = fakeRecall({
      recordings: [
        {
          id: "rec_1",
          started_at: "2026-10-13T14:01:00.000Z",
          completed_at: "2026-10-13T14:31:00.000Z",
          status: { code: "done" },
          media_shortcuts: {
            transcript: { status: { code: "done" }, data: { download_url: "https://dl/transcript" } },
            audio_mixed: { status: { code: "done" }, format: "mp3", data: { download_url: "https://dl/audio.mp3" } },
          },
        },
      ],
    }, { "https://dl/transcript": [] });
    const ui = (method: string, segments: string[], extra: Partial<MeetingsRouteRequest> = {}): MeetingsRouteRequest => ({
      workspace: { user: { id: USER }, organization: { id: ORG }, membership: { role: "developer" } },
      envelope: "console",
      localInstallationId: null,
      mediaBasePath: "/api/console/projects/ravi/meetings",
      requestId: "req_ui",
      method,
      projectRef: "ravi",
      segments,
      body: {},
      searchParams: new URLSearchParams(),
      ...extra,
    });

    const sent = await routeMeetingsRequest(ui("POST", [], { body: { meetingUrl: "abc-defg-hij", title: "Weekly" } }), deps(store, recall));
    expect(sent.status).toBe(201);
    const id = (sent.payload as { meeting: { id: string } }).meeting.id;
    // Sent from the Console: no daemon is waiting for it, so no inbox item will target one.
    expect(rows.get(id)?.localInstallationId).toBeNull();

    await processRecallWebhook({ deliveryId: "u1", event: event("bot.in_call_recording"), requestId: "r" }, { store, recall });
    await processRecallWebhook({ deliveryId: "u2", event: event("bot.done"), requestId: "r" }, { store, recall });

    const recording = await routeMeetingsRequest(ui("GET", [id, "recording"]), deps(store, recall));
    expect(recording.payload).toMatchObject({
      media: [{ kind: "audio", path: `/api/console/projects/ravi/meetings/${id}/media/audio?part=0` }],
    });

    const asked: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      asked.push(range);
      return range
        ? new Response("3-bytes", { status: 206, headers: { "content-length": "7", "content-range": "bytes 100-106/900" } })
        : new Response("whole", { headers: { "content-length": "5" } });
    }) as unknown as typeof fetch;
    const media = (range: string | null, query = "part=0&inline=1") =>
      routeMeetingsRequest(ui("GET", [id, "media", "audio"], { range, searchParams: new URLSearchParams(query) }), {
        ...deps(store, recall),
        fetchImpl,
      });

    const seek = await media("bytes=100-106");
    if (!seek.stream) throw new Error("expected a stream");
    expect(seek.status).toBe(206);
    expect(seek.stream.headers).toMatchObject({
      "content-range": "bytes 100-106/900",
      "accept-ranges": "bytes",
      "content-disposition": 'inline; filename="audio.mp3"',
    });
    const whole = await media(null, "part=0");
    expect([whole.status, whole.stream?.headers["content-disposition"]]).toEqual([200, 'attachment; filename="audio.mp3"']);
    // A malformed range is dropped, not forwarded.
    await media("bytes=0-1, 5-6");
    await media("bytes=-");
    expect(await media("bytes=-500").then((r) => r.status)).toBe(206);
    expect(asked).toEqual(["bytes=100-106", null, null, null, "bytes=-500"]);
  });

  test("leave asks the vendor only while the bot is in the call", async () => {
    const { store } = memoryStore();
    const { recall, left } = fakeRecall();
    const joined = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall));
    const id = (joined.payload as { meeting: { id: string } }).meeting.id;
    expect((await handleMeetingsCliRequest(request("POST", [id, "leave"]), deps(store, recall))).payload).toMatchObject({ left: true });
    await processRecallWebhook({ deliveryId: "d1", event: event("bot.fatal", { subCode: "bot_kicked_from_call" }), requestId: "r" }, { store, recall: null });
    expect((await handleMeetingsCliRequest(request("POST", [id, "leave"]), deps(store, recall))).payload).toMatchObject({ left: false });
    expect(left).toEqual(["bot_1"]);
  });
});

describe("Recall webhook flow", () => {
  async function joined(recall: RecallClient) {
    const memory = memoryStore();
    const result = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij", title: "Daily" }), deps(memory.store, recall));
    return { ...memory, id: (result.payload as { meeting: { id: string } }).meeting.id };
  }

  test("waits for the transcript after the bot is done, bills once and notifies the asking installation", async () => {
    const recall = fakeRecall({
      recordings: [
        {
          id: "rec_1",
          started_at: "2026-10-13T14:00:00.000Z",
          completed_at: "2026-10-13T14:10:00.000Z",
          media_shortcuts: { transcript: { status: { code: "processing" } } },
        },
      ],
    }).recall;
    const { store, rows, usage, inbox, id } = await joined(recall);

    await processRecallWebhook({ deliveryId: "d1", event: event("bot.in_call_recording", { updatedAt: NOW }), requestId: "r" }, { store, recall });
    const done = await processRecallWebhook({ deliveryId: "d2", event: event("bot.done"), requestId: "r" }, { store, recall });
    expect(done).toMatchObject({ status: "done", notified: null });
    expect(rows.get(id)).toMatchObject({ recordingSeconds: 600, transcriptStatus: "pending" });
    expect(usage.map((row) => [row.metricKey, row.quantity])).toEqual([
      ["meetings.bots", "1"],
      ["meetings.recording_seconds", "600"],
    ]);

    // A late status event never moves a finished bot backwards.
    await processRecallWebhook({ deliveryId: "d3", event: event("bot.in_call_recording"), requestId: "r" }, { store, recall });
    expect(rows.get(id)?.status).toBe("done");

    const ready = await processRecallWebhook({ deliveryId: "d4", event: event("transcript.done"), requestId: "r" }, { store, recall });
    expect(ready).toMatchObject({ notified: "ready" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      category: "meetings",
      eventType: "meetings.recording.ready",
      targetType: "local_installation",
      targetId: INSTALLATION,
      dedupeKey: `meetings:bot:${id}:ready`,
      payloadJson: { meetingId: id, title: "Daily", recordingSeconds: 600, transcriptStatus: "done" },
    });
    expect(JSON.stringify(inbox[0])).not.toContain("meet.google.com");

    const duplicate = await processRecallWebhook({ deliveryId: "d4", event: event("transcript.done"), requestId: "r" }, { store, recall });
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(inbox).toHaveLength(1);
    expect(usage).toHaveLength(2);
  });

  test("a bot nobody admitted ends as failed, unbilled time zero, and says so", async () => {
    const recall = fakeRecall({ recordings: [] }).recall;
    const { store, rows, usage, inbox, id } = await joined(recall);
    await processRecallWebhook({ deliveryId: "d1", event: event("bot.in_waiting_room"), requestId: "r" }, { store, recall });
    await processRecallWebhook(
      { deliveryId: "d2", event: event("bot.call_ended", { subCode: "timeout_exceeded_waiting_room" }), requestId: "r" },
      { store, recall },
    );
    const result = await processRecallWebhook({ deliveryId: "d3", event: event("bot.done"), requestId: "r" }, { store, recall });
    expect(result).toMatchObject({ status: "failed", notified: "failed" });
    expect(rows.get(id)).toMatchObject({ failureReason: "timeout_exceeded_waiting_room", recordingSeconds: 0 });
    expect(usage.find((row) => row.metricKey === "meetings.recording_seconds")?.quantity).toBe("0");
    expect(inbox[0]).toMatchObject({ eventType: "meetings.recording.failed", severity: "warning" });
  });

  test("a delivery whose processing fails is processed again on the vendor's retry", async () => {
    const recall = fakeRecall({
      recordings: [{ id: "rec_1", started_at: "2026-10-13T14:00:00.000Z", completed_at: "2026-10-13T14:05:00.000Z", media_shortcuts: { transcript: { status: { code: "done" } } } }],
    }).recall;
    const { store, inbox, usage } = await joined(recall);
    const recordInboxItem = store.recordInboxItem;
    store.recordInboxItem = async () => {
      throw new Error("database unavailable");
    };
    await expect(processRecallWebhook({ deliveryId: "d1", event: event("bot.done"), requestId: "r" }, { store, recall })).rejects.toThrow(
      "database unavailable",
    );
    store.recordInboxItem = recordInboxItem;

    const retry = await processRecallWebhook({ deliveryId: "d1", event: event("bot.done"), requestId: "r" }, { store, recall });
    expect(retry).toMatchObject({ duplicate: false, notified: "ready" });
    expect(inbox).toHaveLength(1);
    // The first attempt already billed; the retry writes the same idempotency keys.
    expect(new Set(usage.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  test("a failed billing write leaves the bot open, so the retry bills it", async () => {
    const recall = fakeRecall({
      recordings: [{ id: "rec_1", started_at: "2026-10-13T14:00:00.000Z", completed_at: "2026-10-13T14:05:00.000Z", media_shortcuts: { transcript: { status: { code: "done" } } } }],
    }).recall;
    const { store, rows, usage, id } = await joined(recall);
    const recordUsage = store.recordUsage;
    store.recordUsage = async () => {
      throw new Error("database unavailable");
    };
    await expect(processRecallWebhook({ deliveryId: "d1", event: event("bot.done"), requestId: "r" }, { store, recall })).rejects.toThrow();
    expect(rows.get(id)?.status).toBe("joining");
    store.recordUsage = recordUsage;

    await processRecallWebhook({ deliveryId: "d1", event: event("bot.done"), requestId: "r" }, { store, recall });
    expect(usage.map((row) => [row.metricKey, row.quantity])).toEqual([
      ["meetings.bots", "1"],
      ["meetings.recording_seconds", "300"],
    ]);
    expect(rows.get(id)?.status).toBe("done");
  });

  test("ignores bots this Console did not create", async () => {
    const recall = fakeRecall().recall;
    const { store, inbox } = await joined(recall);
    const foreign = await processRecallWebhook(
      { deliveryId: "d1", event: event("bot.done", { botId: "someone-else" }), requestId: "r" },
      { store, recall },
    );
    expect(foreign).toMatchObject({ matched: false });
    const mismatch = await processRecallWebhook(
      { deliveryId: "d2", event: event("bot.done", { metadata: { ravi_meeting_id: "other" } }), requestId: "r" },
      { store, recall },
    );
    expect(mismatch).toMatchObject({ matched: false });
    expect(inbox).toHaveLength(0);
  });
});

describe("meetings and Knowledge", () => {
  const ui = (method: string, segments: string[], body: unknown = {}): MeetingsRouteRequest => ({
    workspace: { user: { id: USER }, organization: { id: ORG }, membership: { role: "owner" } },
    envelope: "console",
    localInstallationId: null,
    mediaBasePath: "/api/console/projects/ravi/meetings",
    requestId: "req_ui",
    method,
    projectRef: "ravi",
    segments,
    body,
    searchParams: new URLSearchParams(),
  });

  test("the bot's notice names the kept months only when Knowledge is on", async () => {
    for (const [months, expected] of [
      [12, "A transcrição fica guardada por 12 meses no Ravi desta organização"],
      [null, "Ravi entrou para gravar e transcrever esta reunião. Quem não concordar pode remover este participante."],
    ] as const) {
      const { store } = memoryStore();
      const { recall, created } = fakeRecall();
      await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall, true, fakeKnowledge({ months }).knowledge));
      expect(created[0]?.announcement).toContain(expected);
    }
    const { store } = memoryStore();
    const { recall, created } = fakeRecall();
    const silent = fakeKnowledge({ months: 6 });
    await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij", announce: false }), deps(store, recall, true, silent.knowledge));
    expect(created[0]?.announcement).toBeNull();
    expect(silent.calls).not.toContain("retentionMonths");
  });

  test("the CLI envelope never serves stored transcripts, deletes or settings", async () => {
    const { store } = memoryStore();
    const { recall } = fakeRecall();
    const knowledge = fakeKnowledge();
    const id = randomUUID();
    for (const [method, segments] of [
      ["GET", [id, "stored-transcript"]],
      ["POST", [id, "transcript", "delete"]],
      ["POST", ["settings"]],
      ["GET", ["settings"]],
    ] as const) {
      const error = await handleMeetingsCliRequest(request(method, [...segments], { transcriptRetentionMonths: 6 }), deps(store, recall, true, knowledge.knowledge)).catch(
        (caught) => caught,
      );
      expect([error.status, error.code]).toEqual([404, "NOT_FOUND"]);
    }
    expect(knowledge.calls).toEqual([]);
  });

  test("the Console envelope serves them; settings is matched before :id", async () => {
    const { store, rows } = memoryStore();
    const { recall } = fakeRecall();
    const knowledge = fakeKnowledge();
    const sent = await routeMeetingsRequest(ui("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall, true, knowledge.knowledge));
    const id = (sent.payload as { meeting: { id: string } }).meeting.id;
    rows.set(id, { ...rows.get(id)!, projectId: PROJECT });

    const saved = await routeMeetingsRequest(ui("POST", ["settings"], { transcriptRetentionMonths: 6 }), deps(store, recall, true, knowledge.knowledge));
    expect(saved).toMatchObject({ status: 200, payload: { transcriptRetentionMonths: 12, canManage: true } });
    expect(knowledge.calls).toContain("updateSettings:6");
    const bad = await routeMeetingsRequest(ui("POST", ["settings"], { transcriptRetentionMonths: 37 }), deps(store, recall, true, knowledge.knowledge)).catch(
      (caught) => caught,
    );
    expect([bad.status, bad.code]).toEqual([400, "PAYLOAD_INVALID"]);
    expect((await routeMeetingsRequest(ui("GET", ["settings"]), deps(store, recall, true, knowledge.knowledge))).payload).toMatchObject({
      canManage: true,
      knowledgeEnabled: true,
    });

    const stored = await routeMeetingsRequest(ui("GET", [id, "stored-transcript"]), deps(store, recall, true, knowledge.knowledge));
    expect(stored.payload).toMatchObject({ segments: [{ speaker: "Ana", t: 3, text: "Oi" }], documentVersion: 1 });
    const deleted = await routeMeetingsRequest(ui("POST", [id, "transcript", "delete"]), deps(store, recall, true, knowledge.knowledge));
    expect(deleted.payload).toEqual({ deleted: true, chunks: 4 });

    // Someone who can read but not administer the project cannot delete or change retention.
    const reader: MeetingsDeps = {
      ...deps(store, recall, true, knowledge.knowledge),
      resolveProject: async (_workspace, ref, action) => (ref === "ravi" && action !== "admin" ? { id: PROJECT } : null),
    };
    const denied = await routeMeetingsRequest(ui("POST", [id, "transcript", "delete"]), reader).catch((caught) => caught);
    expect([denied.status, denied.code]).toEqual([403, "PROJECT_ACCESS_DENIED"]);
    expect((await routeMeetingsRequest(ui("GET", ["settings"]), reader)).payload).toMatchObject({ canManage: false });
  });

  test("the read route asks for a repair after the recording is served", async () => {
    const { store } = memoryStore();
    const { recall } = fakeRecall({
      recordings: [{ id: "rec_1", started_at: "2026-10-13T14:00:00.000Z", completed_at: "2026-10-13T14:05:00.000Z", media_shortcuts: {} }],
    });
    const knowledge = fakeKnowledge();
    const joined = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(store, recall, true, knowledge.knowledge));
    const id = (joined.payload as { meeting: { id: string } }).meeting.id;
    await processRecallWebhook({ deliveryId: "d1", event: event("bot.in_call_recording"), requestId: "r" }, { store, recall });
    await processRecallWebhook({ deliveryId: "d2", event: event("bot.done"), requestId: "r" }, { store, recall });
    await handleMeetingsCliRequest(request("GET", [id, "recording"]), deps(store, recall, true, knowledge.knowledge));
    expect(knowledge.calls).toContain("repairAfterRead");
  });

  test("the webhook result carries the organization and project, and the capture never fails the delivery", async () => {
    const recall = fakeRecall({
      recordings: [{ id: "rec_1", started_at: "2026-10-13T14:00:00.000Z", completed_at: "2026-10-13T14:05:00.000Z", media_shortcuts: { transcript: { status: { code: "done" } } } }],
    }).recall;
    const memory = memoryStore();
    const joined = await handleMeetingsCliRequest(request("POST", [], { meetingUrl: "abc-defg-hij" }), deps(memory.store, recall));
    const id = (joined.payload as { meeting: { id: string } }).meeting.id;
    const result = await processRecallWebhook({ deliveryId: "d1", event: event("bot.done"), requestId: "r" }, { store: memory.store, recall });
    expect(result).toMatchObject({ notified: "ready", status: "done", meetingId: id, organizationId: ORG, projectId: PROJECT });

    const enqueued: string[] = [];
    const drained: string[] = [];
    const ok = await queueMeetingKnowledgeAfterWebhook(result, { requestId: "r" }, {
      enabled: async () => true,
      enqueue: async (input) => {
        enqueued.push(`${input.trigger}:${input.meetingId}`);
        return { queued: true, jobId: "job", created: true };
      },
      drain: (requestId) => void drained.push(requestId),
    });
    expect([ok, enqueued, drained]).toEqual(["queued", [`meeting_ready:${id}`], ["r"]]);

    // Knowledge off for the organization: nothing is enqueued.
    const off = await queueMeetingKnowledgeAfterWebhook(result, { requestId: "r" }, {
      enabled: async () => false,
      enqueue: async () => {
        throw new Error("must not enqueue");
      },
    });
    expect(off).toBe("skipped");

    // The enqueue throws: the hook still resolves, so the route answers 202.
    const failed = await queueMeetingKnowledgeAfterWebhook(result, { requestId: "r" }, {
      enabled: async () => true,
      enqueue: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(failed).toBe("failed");

    // Not a ready event: nothing to do.
    const notReady: RecallWebhookResult = { ...result, notified: null };
    expect(await queueMeetingKnowledgeAfterWebhook(notReady, { requestId: "r" }, { enabled: async () => true })).toBe("skipped");
  });
});
