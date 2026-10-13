import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifact, getArtifact, listArtifactEvents, listArtifacts } from "../artifacts/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { CloudMeeting, CloudMeetingRecording } from "./cloud.js";
import { defaultCloudMeetingDir, MeetingsCloudClient, normalizeGoogleMeetUrl } from "./cloud.js";
import { fetchCloudMeeting } from "./cloud-finalize.js";
import { setMeetingEventPublisherForTests } from "./events.js";
import { handOffMeetingInboxItem, meetingFetchArgsForInboxItem } from "./inbox-handoff.js";

const MEETING_ID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const PROJECT_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const ROOT = `/api/cli/projects/ravi/meetings/${MEETING_ID}`;

let stateDir: string | null = null;

describe("cloud meetings", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-meetings-cloud-test-");
    setMeetingEventPublisherForTests(async () => {});
  });

  afterEach(async () => {
    setMeetingEventPublisherForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("normalizes Meet links and codes and refuses everything else", () => {
    expect(normalizeGoogleMeetUrl("ABC-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
    expect(normalizeGoogleMeetUrl("meet.google.com/abc-defg-hij?authuser=0")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(normalizeGoogleMeetUrl("https://zoom.us/j/123")).toBeNull();
    expect(normalizeGoogleMeetUrl("https://user@meet.google.com/abc-defg-hij")).toBeNull();
    expect(normalizeGoogleMeetUrl("https://meet.google.com/new")).toBeNull();
  });

  it("finalizes a finished cloud recording once, downloads audio only and informs the asking session", async () => {
    const joinArtifact = createArtifact({
      kind: "meeting.join",
      status: "running",
      sessionName: "dev-main",
      metadata: { consoleMeetingId: MEETING_ID },
    });
    const client = fakeClient(meeting({ status: "done", ready: true, clientRef: joinArtifact.id }));
    const notified: string[] = [];
    const notify = (artifact: { id: string }, status: string, message: string) => {
      notified.push(`${artifact.id}:${status}:${message.split("\n")[0]}`);
    };

    const first = await fetchCloudMeeting({ client, meetingId: MEETING_ID, actor: "test" }, { notify });
    expect(first).toMatchObject({ outcome: "finalized", status: "finalized", joinArtifactId: joinArtifact.id });
    if (first.outcome !== "finalized") throw new Error("expected finalized");
    expect(first.transcriptSegmentCount).toBe(2);
    expect(first.downloadedMediaCount).toBe(1);
    expect(client.downloads).toEqual([`${ROOT}/media/audio?part=0`]);
    expect(notified).toHaveLength(1);

    const raw = getArtifact(first.rawArtifactId!);
    expect(raw?.kind).toBe("meeting.raw");
    const transcription = readFileSync(join(first.rawArtifactPath!, "..", "transcription.json"), "utf8");
    expect(transcription).toContain("Ana");
    expect(transcription).not.toMatch(/vendor|recall/i);

    const closed = getArtifact(joinArtifact.id);
    expect(closed?.status).toBe("completed");
    expect(closed?.metadata?.finalArtifactId).toBe(first.rawArtifactId);

    const again = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify });
    expect(again).toMatchObject({
      outcome: "finalized",
      status: "already_finalized",
      rawArtifactId: first.rawArtifactId,
    });
    expect(notified).toHaveLength(1);
  });

  it("closes the join artifact of a failed bot and says why, and leaves a running bot alone", async () => {
    const joinArtifact = createArtifact({
      kind: "meeting.join",
      status: "running",
      sessionName: "dev-main",
      metadata: { consoleMeetingId: MEETING_ID },
    });
    const notified: string[] = [];
    const notify = (_artifact: unknown, status: string) => {
      notified.push(status);
    };

    const pending = await fetchCloudMeeting(
      { client: fakeClient(meeting({ status: "waiting_room", clientRef: joinArtifact.id })), meetingId: MEETING_ID },
      { notify },
    );
    expect(pending.outcome).toBe("pending");
    expect(getArtifact(joinArtifact.id)?.status).toBe("running");

    const failed = await fetchCloudMeeting(
      {
        client: fakeClient(meeting({ status: "failed", clientRef: joinArtifact.id, failureReason: "nobody_admitted" })),
        meetingId: MEETING_ID,
      },
      { notify },
    );
    expect(failed).toMatchObject({ outcome: "failed", joinArtifactId: joinArtifact.id, notified: true });
    expect(getArtifact(joinArtifact.id)?.status).toBe("failed");
    expect(listArtifactEvents(joinArtifact.id).some((event) => event.message?.includes("nobody_admitted"))).toBe(true);
    expect(notified).toEqual(["failed"]);
  });

  it("ignores a join artifact that belongs to another meeting", async () => {
    const other = createArtifact({ kind: "meeting.join", status: "running", metadata: { consoleMeetingId: "other" } });
    const result = await fetchCloudMeeting(
      { client: fakeClient(meeting({ status: "done", ready: true, clientRef: other.id })), meetingId: MEETING_ID },
      { notify: () => {} },
    );
    expect(result).toMatchObject({ outcome: "finalized", joinArtifactId: null, notified: false });
    expect(getArtifact(other.id)?.status).toBe("running");
  });

  it("registers one raw artifact per meeting even without a join artifact, and adds the video later in place", async () => {
    const client = fakeClient(meeting({ status: "done", ready: true }));
    const notify = () => {};

    const first = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify });
    expect(first).toMatchObject({ outcome: "finalized", status: "finalized", joinArtifactId: null });
    if (first.outcome !== "finalized") throw new Error("expected finalized");

    const again = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify });
    expect(again).toMatchObject({ status: "already_finalized", rawArtifactId: first.rawArtifactId });
    expect(client.downloads).toEqual([`${ROOT}/media/audio?part=0`]);

    const withVideo = await fetchCloudMeeting({ client, meetingId: MEETING_ID, video: true }, { notify });
    expect(withVideo).toMatchObject({ status: "enriched", rawArtifactId: first.rawArtifactId });
    expect(client.downloads).toEqual([`${ROOT}/media/audio?part=0`, `${ROOT}/media/video?part=0`]);
    const refs = getArtifact(first.rawArtifactId!)?.metadata?.mediaRefs as Array<{ kind: string; path: string | null }>;
    expect(refs.find((ref) => ref.kind === "video")?.path).toMatch(/video\.mp4$/);

    const videoAgain = await fetchCloudMeeting({ client, meetingId: MEETING_ID, video: true }, { notify });
    expect(videoAgain).toMatchObject({ status: "already_finalized" });
    expect(client.downloads).toHaveLength(2);
    expect(listArtifacts({ kind: "meeting.raw" })).toHaveLength(1);
  });

  it("completes a join a previous run left open after it recorded the raw artifact, and only once", async () => {
    // The first run recorded its raw artifact but died before closing the join.
    const first = await fetchCloudMeeting(
      { client: fakeClient(meeting({ status: "done", ready: true })), meetingId: MEETING_ID },
      { notify: () => {} },
    );
    if (first.outcome !== "finalized") throw new Error("expected finalized");
    const joinArtifact = createArtifact({
      kind: "meeting.join",
      status: "running",
      sessionName: "dev-main",
      metadata: { consoleMeetingId: MEETING_ID },
    });
    const client = fakeClient(meeting({ status: "done", ready: true, clientRef: joinArtifact.id }));
    const notified: string[] = [];
    const notify = (_artifact: unknown, status: string, message: string) => {
      notified.push(`${status}:${message.split("\n")[0]}`);
    };

    const retry = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify });
    expect(retry).toMatchObject({ status: "already_finalized", rawArtifactId: first.rawArtifactId, notified: true });
    expect(getArtifact(joinArtifact.id)?.status).toBe("completed");
    expect(getArtifact(joinArtifact.id)?.metadata?.finalArtifactId).toBe(first.rawArtifactId);
    expect(notified).toEqual(["completed:[System] Inform: Meeting raw artifact generated."]);
    expect(client.downloads).toEqual([]);

    const again = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify });
    expect(again).toMatchObject({ status: "already_finalized", notified: false });
    expect(notified).toHaveLength(1);
    expect(listArtifacts({ kind: "meeting.raw" })).toHaveLength(1);
  });

  it("bounds a media download and removes the partial file when it fails", async () => {
    const client = new MeetingsCloudClient({
      client: {} as never,
      credentials: { accessToken: "token", consoleUrl: "https://console.example" } as never,
      projectRef: "ravi",
      write: (() => {}) as never,
      delete: (() => {}) as never,
    });
    const dir = defaultCloudMeetingDir(MEETING_ID);
    mkdirSync(dir, { recursive: true });
    const destination = join(dir, "audio.mp3");
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(client.downloadMedia(`${ROOT}/media/audio?part=0`, destination, fetchImpl)).rejects.toThrow();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(existsSync(`${destination}.part`)).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it("leaves a meeting alone while another fetch holds it", async () => {
    const client = fakeClient(meeting({ status: "done", ready: true }));
    mkdirSync(defaultCloudMeetingDir(MEETING_ID), { recursive: true });
    writeFileSync(join(defaultCloudMeetingDir(MEETING_ID), "fetch.lock"), "");

    const busy = await fetchCloudMeeting({ client, meetingId: MEETING_ID }, { notify: () => {} });
    expect(busy).toMatchObject({ outcome: "finalized", status: "in_progress", rawArtifactId: null, notified: false });
    expect(client.downloads).toEqual([]);
  });

  it("hands ready and failed inbox items to `ravi meetings fetch`, and nothing else", () => {
    expect(
      meetingFetchArgsForInboxItem({
        eventType: "meetings.recording.ready",
        payload: { meetingId: MEETING_ID, projectId: PROJECT_ID },
      }),
    ).toEqual(["meetings", "fetch", MEETING_ID, "--project", PROJECT_ID, "--json"]);
    expect(
      meetingFetchArgsForInboxItem({ eventType: "meetings.recording.failed", payload: { meetingId: MEETING_ID } }),
    ).toEqual(["meetings", "fetch", MEETING_ID, "--json"]);
    expect(meetingFetchArgsForInboxItem({ eventType: "mail.message.received", payload: {} })).toBeNull();
    expect(
      meetingFetchArgsForInboxItem({ eventType: "meetings.recording.ready", payload: { meetingId: "--evil" } }),
    ).toBeNull();

    const spawned: string[][] = [];
    expect(
      handOffMeetingInboxItem({ eventType: "meetings.recording.ready", payload: { meetingId: MEETING_ID } }, (args) => {
        spawned.push(args);
        return 1;
      }),
    ).toBe(true);
    expect(spawned).toHaveLength(1);
  });
});

function meeting(overrides: Partial<CloudMeeting>): CloudMeeting {
  return {
    id: MEETING_ID,
    projectId: PROJECT_ID,
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    botName: "Ravi",
    title: "Daily",
    language: "pt",
    clientRef: null,
    status: "joining",
    statusSubCode: null,
    transcriptStatus: "done",
    ready: false,
    joinAt: null,
    recordingStartedAt: "2026-10-13T14:01:00.000Z",
    endedAt: "2026-10-13T14:31:00.000Z",
    doneAt: "2026-10-13T14:32:00.000Z",
    recordingSeconds: 1800,
    maxRecordingSeconds: 10800,
    failureReason: null,
    createdAt: "2026-10-13T14:00:00.000Z",
    updatedAt: "2026-10-13T14:32:00.000Z",
    ...overrides,
  };
}

function fakeClient(current: CloudMeeting) {
  const downloads: string[] = [];
  const recording: CloudMeetingRecording = {
    meeting: current,
    transcript: {
      status: "done",
      segments: [
        {
          speaker: "Ana",
          speakerId: "1",
          isHost: true,
          startSeconds: 3,
          endSeconds: 5,
          startedAt: null,
          text: "Bom dia.",
        },
        {
          speaker: "Bruno",
          speakerId: "2",
          isHost: false,
          startSeconds: 6,
          endSeconds: 9,
          startedAt: null,
          text: "Oi.",
        },
      ],
    },
    participants: [
      { id: "1", name: "Ana", isHost: true },
      { id: "2", name: "Bruno", isHost: false },
    ],
    chat: [],
    media: [
      {
        kind: "video",
        format: "mp4",
        path: `${ROOT}/media/video?part=0`,
        part: 0,
        expiresAt: "2026-10-20T14:31:00.000Z",
      },
      {
        kind: "audio",
        format: "mp3",
        path: `${ROOT}/media/audio?part=0`,
        part: 0,
        expiresAt: "2026-10-20T14:31:00.000Z",
      },
    ],
    recordings: [{ startedAt: "2026-10-13T14:01:00.000Z", completedAt: "2026-10-13T14:31:00.000Z", expiresAt: null }],
  };
  const client = {
    projectRef: "ravi",
    consoleUrl: "https://console.example",
    downloads,
    async show() {
      return current;
    },
    async recording() {
      return recording;
    },
    async downloadMedia(path: string, destination: string) {
      downloads.push(path);
      writeFileSync(destination, "mp3");
      if (!existsSync(destination)) throw new Error("not written");
    },
  };
  return client as unknown as MeetingsCloudClient & { downloads: string[] };
}
