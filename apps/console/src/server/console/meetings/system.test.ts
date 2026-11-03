import { describe, expect, test } from "bun:test";

import { buildConversation } from "@/features/meetings/conversation";
import type { MeetingRecording } from "@/features/meetings/types";

import type { RecallBot, RecallClient } from "./recall";
import type { MeetingBotRow, MeetingBotStore } from "./store";
import { loadRecordingForSystem, MeetingCaptureRetryError } from "./system";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const MEETING = "00000000-0000-4000-8000-000000000009";
const NOW = new Date("2026-10-13T16:00:00.000Z");

function row(patch: Partial<MeetingBotRow> = {}): MeetingBotRow {
  return {
    id: MEETING,
    organizationId: ORG,
    projectId: PROJECT,
    requestedByUserId: null,
    localInstallationId: null,
    provider: "recall",
    providerBotId: "bot_1",
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    botName: "Ravi",
    title: "Kickoff",
    language: "pt",
    clientRef: null,
    status: "done",
    statusSubCode: null,
    transcriptStatus: "done",
    joinAt: null,
    recordingStartedAt: new Date("2026-10-13T14:00:00.000Z"),
    endedAt: null,
    doneAt: null,
    recordingSeconds: 600,
    maxRecordingSeconds: 3600,
    readyNotifiedAt: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  } as MeetingBotRow;
}

function store(found: MeetingBotRow | null): MeetingBotStore {
  return { findById: async (organizationId: string, id: string) => (found && found.organizationId === organizationId && found.id === id ? found : null) } as unknown as MeetingBotStore;
}

function recall(bot: Partial<RecallBot>, downloads: Record<string, unknown>): RecallClient {
  return {
    createBot: async () => ({ id: "bot_1" }),
    getBot: async (id) => ({ id, ...bot }),
    leaveCall: async () => undefined,
    downloadJson: async (url) => downloads[url],
  };
}

function words(name: string, id: number, start: number, end: number, text: string, absolute?: string) {
  return {
    participant: { id, name },
    words: [{ text, start_timestamp: { relative: start, absolute: absolute ?? null }, end_timestamp: { relative: end } }],
  };
}

const twoParts: Partial<RecallBot> = {
  recordings: [
    {
      id: "r0",
      started_at: "2026-10-13T14:00:00.000Z",
      completed_at: "2026-10-13T14:05:00.000Z",
      expires_at: "2026-10-20T14:05:00.000Z",
      media_shortcuts: { transcript: { status: { code: "done" }, data: { download_url: "https://dl/t0" } } },
    },
    {
      id: "r1",
      started_at: "2026-10-13T14:10:00.000Z",
      completed_at: "2026-10-13T14:15:00.000Z",
      expires_at: "2026-10-20T14:15:00.000Z",
      media_shortcuts: { transcript: { status: { code: "done" }, data: { download_url: "https://dl/t1" } } },
    },
  ],
};

const twoPartDownloads = {
  "https://dl/t0": [
    words("Ana", 1, 3, 5, "Bom dia", "2026-10-13T14:00:03.000Z"),
    words("Bruno", 2, 20, 25, "Vamos lá", "2026-10-13T14:00:20.000Z"),
  ],
  "https://dl/t1": [words("Ana", 1, 4, 9, "Voltamos", "2026-10-13T14:10:04.000Z")],
};

describe("loadRecordingForSystem", () => {
  test("keeps the part index and puts every segment on the call clock", async () => {
    const loaded = await loadRecordingForSystem(
      { organizationId: ORG, meetingId: MEETING },
      { store: store(row()), recall: recall(twoParts, twoPartDownloads), now: () => NOW },
    );
    if (loaded.status !== "ok") throw new Error(`expected ok, got ${loaded.status}`);
    expect(loaded.segments.map((segment) => [segment.part, segment.startSeconds, segment.callSeconds])).toEqual([
      [0, 3, 3],
      [0, 20, 20],
      [1, 4, 604],
    ]);
    expect(loaded.meeting).toMatchObject({ id: MEETING, projectId: PROJECT, title: "Kickoff", language: "pt" });
    expect(loaded.recordings).toHaveLength(2);
  });

  test("matches the conversation's clock on every input the conversation can seek", async () => {
    const loaded = await loadRecordingForSystem(
      { organizationId: ORG, meetingId: MEETING },
      { store: store(row()), recall: recall(twoParts, twoPartDownloads), now: () => NOW },
    );
    if (loaded.status !== "ok") throw new Error("expected ok");
    const recording = {
      meeting: { recordingSeconds: 600 },
      transcript: { status: "done", segments: loaded.segments.map(({ part: _part, callSeconds: _call, ...segment }) => segment) },
      participants: [],
      chat: [],
      media: [],
      recordings: loaded.recordings,
    } as unknown as MeetingRecording;
    const conversation = buildConversation(recording);
    expect(conversation.seekable).toBe(true);
    expect(conversation.lines.map((line) => line.start)).toEqual(loaded.segments.map((segment) => segment.callSeconds));
  });

  test("a segment without an absolute time in a multi-part call gets no call clock", async () => {
    const loaded = await loadRecordingForSystem(
      { organizationId: ORG, meetingId: MEETING },
      {
        store: store(row()),
        recall: recall(twoParts, { ...twoPartDownloads, "https://dl/t1": [words("Ana", 1, 4, 9, "Sem hora")] }),
        now: () => NOW,
      },
    );
    if (loaded.status !== "ok") throw new Error("expected ok");
    expect(loaded.segments.at(-1)).toMatchObject({ part: 1, startSeconds: 4, callSeconds: null });
  });

  test("one part: the call clock is the part's own time", async () => {
    const loaded = await loadRecordingForSystem(
      { organizationId: ORG, meetingId: MEETING },
      { store: store(row()), recall: recall({ recordings: [twoParts.recordings![0]!] }, { "https://dl/t0": [words("Ana", 1, 3, 5, "Oi")] }), now: () => NOW },
    );
    if (loaded.status !== "ok") throw new Error("expected ok");
    expect(loaded.segments[0]).toMatchObject({ part: 0, callSeconds: 3 });
  });

  test("statuses: not_found, not_ready, no_project, gone", async () => {
    const vendor = recall(twoParts, twoPartDownloads);
    const load = (found: MeetingBotRow | null, client: RecallClient = vendor, meetingId = MEETING) =>
      loadRecordingForSystem({ organizationId: ORG, meetingId }, { store: store(found), recall: client, now: () => NOW });
    expect(await load(null)).toEqual({ status: "not_found" });
    expect(await load(row(), vendor, "not-a-uuid")).toEqual({ status: "not_found" });
    expect(await load(row({ status: "ended" }))).toEqual({ status: "not_ready" });
    expect(await load(row({ providerBotId: null }))).toEqual({ status: "not_ready" });
    expect(await load(row({ projectId: null }))).toEqual({ status: "no_project" });
    const expired = recall(
      { recordings: twoParts.recordings!.map((recording) => ({ ...recording, expires_at: "2026-10-13T15:00:00.000Z" })) },
      twoPartDownloads,
    );
    expect(await load(row(), expired)).toEqual({ status: "gone" });
    const deleted = recall({ recordings: twoParts.recordings!.map((recording) => ({ ...recording, status: { code: "deleted" } })) }, {});
    expect(await load(row(), deleted)).toEqual({ status: "gone" });
  });

  test("a transcript still processing is retried, with a code and no text", async () => {
    const processing = recall(
      { recordings: [{ ...twoParts.recordings![0]!, media_shortcuts: { transcript: { status: { code: "processing" } } } }] },
      {},
    );
    const error = await loadRecordingForSystem({ organizationId: ORG, meetingId: MEETING }, { store: store(row()), recall: processing, now: () => NOW }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(MeetingCaptureRetryError);
    expect(error.code).toBe("meeting_not_ready");
  });
});
