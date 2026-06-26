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
      meetingChannel: "meet",
      meetingAccountId: "google-meet",
      meetingChatId: "bdw-wzcp-fse",
      title: "Google Meet bdw-wzcp-fse",
      url: "https://meet.google.com/bdw-wzcp-fse",
      originSessionName: "ravi-meet-v0",
      durationMs: 1_800_958,
    });
    expect(session.participants).toEqual([{ id: "ravi", displayName: "Ravi", kind: "agent" }]);
    expect(session.transcriptSegments).toEqual([]);
    expect(session.mediaRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "audio",
          path: join(runDir, "webrtc-tap", "audio-3.fixture.audio.webm"),
          mimeType: "audio/webm;codecs=opus",
          sizeBytes: 1234,
          startedAt: "2026-06-22T01:41:31.463Z",
        }),
      ]),
    );
    expect(session.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: "recorder.artifact_missing",
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
    setGoogleMeetRecorderTranscriberForTests(async (input) => ({
      text: "A gente precisa de um artifact no final. P0 é gerar um artifact meet.md raw no final da sessão.",
      provider: "groq",
      model: "whisper-large-v3-turbo",
      duration: 1800,
      chunks: 1,
      segments: [
        {
          index: 0,
          text: "A gente precisa de um artifact no final.",
          startSec: 76,
          endSec: 79,
          duration: 3,
          provider: "groq",
          model: "whisper-large-v3-turbo",
        },
        {
          index: 1,
          text: "P0 é gerar um artifact meet.md raw no final da sessão.",
          startSec: 151,
          endSec: 156,
          duration: 5,
          provider: "groq",
          model: "whisper-large-v3-turbo",
        },
      ],
      source: {
        filePath: input.filePath,
        mimeType: input.mimeType ?? "audio/webm",
        sizeBytes: 1234,
        sizeMB: 0,
      },
    }));
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
    expect(result.registeredArtifact.markdown).toContain(
      "- [2026-06-24T14:39:09.405Z to 2026-06-24T14:39:39.405Z] Audio da reunião: Primeiro trecho",
    );
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
  const tapDir = join(runDir, "webrtc-tap");
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
    },
    artifacts: {
      runDir,
      metadataPath: join(runDir, "metadata.json"),
      media: [
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
