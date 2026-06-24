import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getArtifactDetails } from "../../artifacts/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { MEETING_EVENT_TOPICS, setMeetingEventPublisherForTests } from "../events.js";
import {
  finalizeGoogleMeetRecorderRun,
  GoogleMeetRecorderProvider,
  importGoogleMeetRecorderRun,
  setGoogleMeetRecorderTranscriberForTests,
} from "./recorder-run.js";

let stateDir: string | null = null;

describe("Google Meet recorder adapter", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-google-meet-recorder-test-");
  });

  afterEach(async () => {
    setMeetingEventPublisherForTests();
    setGoogleMeetRecorderTranscriberForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("normalizes a recorder run directory into a MeetingSession", () => {
    const runDir = writeRecorderFixture();

    const session = importGoogleMeetRecorderRun({
      runDir,
      originSessionKey: "agent:ravi-meet-v0:whatsapp:group:120363428094858911",
      originSessionName: "ravi-meet-v0",
      originAgentId: "ravi-meet-v0",
      channel: "whatsapp",
      chatId: "120363428094858911@g.us",
    });

    expect(session).toMatchObject({
      id: "meet-ravi-v0-backlog-refiner-v2",
      provider: "google-meet",
      providerMeetingId: "bdw-wzcp-fse",
      title: "Google Meet bdw-wzcp-fse",
      url: "https://meet.google.com/bdw-wzcp-fse",
      originSessionName: "ravi-meet-v0",
      durationMs: 1_800_958,
    });
    expect(session.participants).toEqual([
      { id: "ravi", displayName: "Ravi", kind: "agent" },
      { id: "meeting-audio", displayName: "Audio da reunião", kind: "unknown" },
    ]);
    expect(session.transcriptSegments).toMatchObject([
      {
        id: "input-item-luis",
        speakerName: "Audio da reunião",
        startAt: "2026-06-22T01:42:47.519Z",
        text: "A gente precisa de um artifact no final.",
        source: "realtime_transcription",
      },
      {
        id: "output-item-ravi",
        speakerName: "Ravi",
        startAt: "2026-06-22T01:44:02.559Z",
        text: "P0 é gerar um artifact meet.md raw no final da sessão.",
        source: "realtime_transcription",
      },
    ]);
    expect(session.mediaRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "audio",
          path: join(runDir, "webrtc-tap", "audio-3.fixture.audio.webm"),
          mimeType: "audio/webm",
          sizeBytes: 1234,
        }),
        expect.objectContaining({
          kind: "log",
          path: join(runDir, "realtime-webrtc", "events.jsonl"),
          mimeType: "application/x-ndjson",
        }),
      ]),
    );
    expect(session.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: "recorder.artifact_missing",
        }),
        expect.objectContaining({
          level: "info",
          code: "realtime.events_parsed",
          message: expect.stringContaining("Parsed 2 final transcript segment"),
        }),
      ]),
    );
  });

  it("imports websocket realtime transcript JSONL from a recorder run", () => {
    const runDir = writeRecorderTranscriptFixture();

    const session = importGoogleMeetRecorderRun({ runDir });

    expect(session.transcriptSegments).toMatchObject([
      {
        id: "input-item-a",
        speakerName: "Audio da reunião",
        startAt: "2026-06-24T00:57:33.676Z",
        text: "Eu",
      },
      {
        id: "input-item-b",
        speakerName: "Audio da reunião",
        startAt: "2026-06-24T00:57:37.761Z",
        text: "Me fale se tu conseguiu transcrever",
      },
      {
        id: "input-item-c",
        speakerName: "Audio da reunião",
        startAt: "2026-06-24T00:57:41.871Z",
        text: "ABC 1, 2, 3",
      },
    ]);
    expect(session.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "realtime.events_parsed",
          message: expect.stringContaining("Parsed 3 final transcript segment"),
        }),
      ]),
    );
  });

  it("finalizes a recorder run by registering a raw meet.md artifact", async () => {
    const published: Array<{ subject: string; payload: Record<string, unknown> }> = [];
    setMeetingEventPublisherForTests((subject, payload) => {
      published.push({ subject, payload });
    });

    const runDir = writeRecorderFixture();
    const result = await finalizeGoogleMeetRecorderRun({
      runDir,
      outputDir: join(stateDir!, "rendered-meet"),
      actor: "ravi-meet-v0",
      originSessionName: "ravi-meet-v0",
      originAgentId: "ravi-meet-v0",
    });

    expect(result.artifactId).toBe(result.registeredArtifact.artifact.id);
    expect(result.artifactPath).toBe(result.registeredArtifact.filePath);
    expect(result.registeredArtifact.markdown).toContain("A gente precisa de um artifact no final.");
    expect(result.registeredArtifact.markdown).toContain("P0 é gerar um artifact meet.md raw no final da sessão.");
    expect(result.registeredArtifact.markdown).not.toContain("## Summary");
    expect(result.registeredArtifact.markdown).not.toContain("## Decisions");

    expect(result.registeredArtifact.artifact).toMatchObject({
      kind: "meeting.raw",
      title: "Google Meet bdw-wzcp-fse",
      provider: "google-meet",
      sessionName: "ravi-meet-v0",
      agentId: "ravi-meet-v0",
    });
    expect(result.registeredArtifact.artifact.metadata).toMatchObject({
      meetingId: "meet-ravi-v0-backlog-refiner-v2",
      providerMeetingId: "bdw-wzcp-fse",
      participantCount: 2,
      transcriptSegmentCount: 2,
    });
    expect(
      getArtifactDetails(result.artifactId!)
        ?.events.map((event) => event.eventType)
        .sort(),
    ).toEqual(["completed", "created", "version_created"]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      subject: MEETING_EVENT_TOPICS.artifactGenerated,
      payload: {
        meetingId: "meet-ravi-v0-backlog-refiner-v2",
        provider: "google-meet",
        artifactId: result.artifactId,
        transcriptSegmentCount: 2,
      },
    });
  });

  it("adds post-call audio transcription segments before registering the raw artifact", async () => {
    const runDir = writeAudioOnlyRecorderFixture();
    setGoogleMeetRecorderTranscriberForTests(async (input) => ({
      text: "Primeiro trecho Segundo trecho",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      duration: 65,
      chunks: 2,
      segments: [
        {
          index: 0,
          text: "Primeiro trecho",
          startSec: 0,
          endSec: 30,
          duration: 30,
          provider: "groq",
          model: "whisper-large-v3-turbo",
        },
        {
          index: 1,
          text: "Segundo trecho",
          startSec: 30,
          endSec: 65,
          duration: 35,
          provider: "groq",
          model: "whisper-large-v3-turbo",
        },
      ],
      source: {
        filePath: input.filePath,
        mimeType: input.mimeType ?? "audio/webm",
        sizeBytes: 2048,
        sizeMB: 0,
      },
    }));

    const result = await finalizeGoogleMeetRecorderRun({
      runDir,
      outputDir: join(stateDir!, "post-call-rendered-meet"),
      actor: "ravi-meet-v0",
    });

    expect(result.transcriptSegments).toMatchObject([
      {
        speakerName: "Audio da reunião",
        startOffsetMs: 0,
        endOffsetMs: 30_000,
        text: "Primeiro trecho",
        source: "audio_transcription",
      },
      {
        speakerName: "Audio da reunião",
        startOffsetMs: 30_000,
        endOffsetMs: 65_000,
        text: "Segundo trecho",
        source: "audio_transcription",
      },
    ]);
    expect(result.registeredArtifact.markdown).toContain("### +00:00:00 to +00:00:30 - Audio da reunião");
    expect(result.registeredArtifact.markdown).toContain("Primeiro trecho");
    expect(result.registeredArtifact.markdown).toContain("Segundo trecho");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "transcription.post_call_audio",
        }),
      ]),
    );
  });

  it("exposes a provider handle whose finalize registers the artifact", async () => {
    const runDir = writeRecorderFixture();
    const provider = new GoogleMeetRecorderProvider({
      runDir,
      outputDir: join(stateDir!, "provider-finalize"),
      actor: "ravi-meet-v0",
    });

    const handle = await provider.start({
      provider: "google-meet",
      originSessionName: "ravi-meet-v0",
      originAgentId: "ravi-meet-v0",
    });
    const observed: string[] = [];
    for await (const event of handle.observe()) observed.push(event.type);

    const result = await handle.finalize();

    expect(observed).toEqual(["meeting.ended"]);
    expect(result.artifactId).toBeTruthy();
    expect(result.artifactPath?.endsWith("/meet.md")).toBe(true);
    expect(result.session.artifactId).toBe(result.artifactId);
  });
});

function writeRecorderFixture(): string {
  const runDir = join(stateDir!, "meet-ravi-v0-backlog-refiner-v2", "20260622T014111Z");
  const realtimeDir = join(runDir, "realtime-webrtc");
  const tapDir = join(runDir, "webrtc-tap");
  mkdirSync(realtimeDir, { recursive: true });
  mkdirSync(tapDir, { recursive: true });

  const metadata = {
    version: 1,
    runId: "20260622T014111Z",
    meetUrl: "https://meet.google.com/bdw-wzcp-fse",
    botName: "Ravi",
    status: "completed",
    admissionStatus: "joined",
    startedAt: "2026-06-22T01:41:11.247Z",
    timestamps: {
      recordingStartedAt: "2026-06-22T01:41:31.400Z",
      recordingEndedAt: "2026-06-22T02:11:32.358Z",
    },
    options: {
      outDir: join(stateDir!, "meet-ravi-v0-backlog-refiner-v2"),
      captureMode: "webrtc-tap",
      realtimeAgent: true,
      realtimeTranscribe: false,
      realtimeModel: "gpt-realtime-2",
      realtimeTranscriptionModel: "gpt-realtime-whisper",
    },
    artifacts: {
      runDir,
      metadataPath: join(runDir, "metadata.json"),
      media: [
        {
          kind: "log",
          path: join(realtimeDir, "events.jsonl"),
          note: "Raw local-server and browser events for OpenAI Realtime WebRTC.",
          exists: true,
          sizeBytes: 100,
        },
        {
          kind: "webrtc-track",
          path: join(tapDir, "audio-3.fixture.audio.webm"),
          note: "Individual MediaStreamTrack file captured from the visible browser participant.",
          exists: true,
          sizeBytes: 1234,
        },
        {
          kind: "screenshot",
          path: join(runDir, "final-page.png"),
          exists: false,
        },
      ],
    },
    browser: {
      channel: "chrome",
      profileDir: "/tmp/profile",
      finalUrl: "https://meet.google.com/bdw-wzcp-fse",
    },
    participants: {
      detected: true,
      names: [],
      note: "WebRTC tap ran for the fixed --duration window.",
    },
    failures: [],
  };

  const events = [
    {
      at: "2026-06-22T01:42:47.520Z",
      type: "browser.event",
      payload: {
        type: "realtime-webrtc-event",
        event: {
          type: "conversation.item.input_audio_transcription.completed",
          event_id: "event-input",
          item_id: "item-luis",
          content_index: 0,
          transcript: "A gente precisa de um artifact no final.",
        },
        at: "2026-06-22T01:42:47.519Z",
      },
    },
    {
      at: "2026-06-22T01:44:02.560Z",
      type: "browser.event",
      payload: {
        type: "realtime-webrtc-event",
        event: {
          type: "response.output_audio_transcript.done",
          event_id: "event-output",
          response_id: "resp-ravi",
          item_id: "item-ravi",
          output_index: 0,
          content_index: 0,
          transcript: "P0 é gerar um artifact meet.md raw no final da sessão.",
        },
        at: "2026-06-22T01:44:02.559Z",
      },
    },
  ];

  const manifest = {
    version: 1,
    mode: "webrtc-tap",
    startedAt: "2026-06-22T01:41:31.401Z",
    stoppedAt: "2026-06-22T02:11:32.359Z",
    tracks: [
      {
        id: "audio-3",
        kind: "audio",
        path: join(tapDir, "audio-3.fixture.audio.webm"),
        mimeType: "audio/webm;codecs=opus",
        bytes: 1234,
        startedAt: "2026-06-22T01:41:31.463Z",
        stoppedAt: "2026-06-22T01:51:59.966Z",
      },
    ],
    eventsPath: join(tapDir, "events.jsonl"),
    errors: [],
  };

  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(
    join(realtimeDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(join(tapDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(tapDir, "events.jsonl"), "", "utf8");
  writeFileSync(join(tapDir, "audio-3.fixture.audio.webm"), "fake-webm", "utf8");

  return runDir;
}

function writeAudioOnlyRecorderFixture(): string {
  const runDir = join(stateDir!, "meet-ravi-v0-audio-only", "20260624T143853Z");
  const tapDir = join(runDir, "webrtc-tap");
  mkdirSync(tapDir, { recursive: true });
  const audioPath = join(tapDir, "audio-3.fixture.audio.webm");

  const metadata = {
    version: 1,
    runId: "20260624T143853Z",
    meetUrl: "https://meet.google.com/ird-sbmq-dix",
    botName: "Ravi",
    status: "completed",
    admissionStatus: "joined",
    startedAt: "2026-06-24T14:38:53.100Z",
    timestamps: {
      recordingStartedAt: "2026-06-24T14:39:09.405Z",
      recordingEndedAt: "2026-06-24T14:41:31.365Z",
    },
    options: {
      outDir: join(stateDir!, "meet-ravi-v0-audio-only"),
      captureMode: "webrtc-tap",
      realtimeAgent: false,
      realtimeTranscribe: false,
    },
    artifacts: {
      runDir,
      metadataPath: join(runDir, "metadata.json"),
      media: [
        {
          kind: "webrtc-track",
          path: audioPath,
          note: "Individual MediaStreamTrack file captured from the visible browser participant.",
          exists: true,
          sizeBytes: 2048,
        },
      ],
    },
    participants: {
      detected: true,
      names: [],
      note: "Stopped WebRTC tap because left_call.",
    },
    failures: [],
  };

  const manifest = {
    version: 1,
    mode: "webrtc-tap",
    startedAt: "2026-06-24T14:39:09.405Z",
    stoppedAt: "2026-06-24T14:41:31.365Z",
    tracks: [
      {
        id: "audio-3",
        kind: "audio",
        path: audioPath,
        mimeType: "audio/webm;codecs=opus",
        bytes: 2048,
        startedAt: "2026-06-24T14:39:09.405Z",
        stoppedAt: "2026-06-24T14:41:31.365Z",
      },
    ],
    eventsPath: join(tapDir, "events.jsonl"),
    errors: [],
  };

  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(tapDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(tapDir, "events.jsonl"), "", "utf8");
  writeFileSync(audioPath, "fake-webm", "utf8");

  return runDir;
}

function writeRecorderTranscriptFixture(): string {
  const runDir = join(stateDir!, "meet-ravi-v0-live-transcript", "20260624T005716Z");
  const realtimeDir = join(runDir, "realtime");
  mkdirSync(realtimeDir, { recursive: true });

  const metadata = {
    version: 1,
    runId: "20260624T005716Z",
    meetUrl: "https://meet.google.com/ggt-kebk-fjo",
    botName: "Ravi",
    status: "completed",
    admissionStatus: "joined",
    startedAt: "2026-06-24T00:57:16.205Z",
    timestamps: {
      recordingStartedAt: "2026-06-24T00:57:31.047Z",
      recordingEndedAt: "2026-06-24T00:57:42.105Z",
    },
    options: {
      outDir: join(stateDir!, "meet-ravi-v0-live-transcript"),
      captureMode: "webrtc-tap",
      realtimeAgent: false,
      realtimeTranscribe: true,
      realtimeTranscriptionModel: "gpt-realtime-whisper",
    },
    artifacts: {
      runDir,
      metadataPath: join(runDir, "metadata.json"),
      media: [
        {
          kind: "transcript",
          path: join(realtimeDir, "transcript.jsonl"),
          note: "Realtime transcription delta/completed events as JSONL.",
          exists: true,
          sizeBytes: 300,
        },
      ],
    },
    browser: {
      channel: "chrome",
      profileDir: "/tmp/profile",
      finalUrl: "https://meet.google.com/ggt-kebk-fjo",
    },
    participants: {
      detected: true,
      names: [],
      note: "Stopped WebRTC tap because left_call.",
    },
    failures: [],
  };
  const transcriptEvents = [
    {
      at: "2026-06-24T00:57:33.170Z",
      kind: "delta",
      itemId: "item-a",
      contentIndex: 0,
      text: " Eu",
    },
    {
      at: "2026-06-24T00:57:33.676Z",
      kind: "completed",
      itemId: "item-a",
      contentIndex: 0,
      text: "Eu",
    },
    {
      at: "2026-06-24T00:57:37.761Z",
      kind: "completed",
      itemId: "item-b",
      contentIndex: 0,
      text: "Me fale se tu conseguiu transcrever",
    },
    {
      at: "2026-06-24T00:57:41.871Z",
      kind: "completed",
      itemId: "item-c",
      contentIndex: 0,
      text: "ABC 1, 2, 3",
    },
    {
      at: "2026-06-24T00:57:43.796Z",
      kind: "completed",
      itemId: "item-empty",
      contentIndex: 0,
      text: "",
    },
  ];

  writeFileSync(join(runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(
    join(realtimeDir, "transcript.jsonl"),
    `${transcriptEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  return runDir;
}
