import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getArtifactDetails, listArtifactEvents } from "../artifacts/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { MEETING_EVENT_TOPICS, setMeetingEventPublisherForTests } from "./events.js";
import {
  buildMeetingRawArtifactHandoffMessage,
  registerMeetingRawArtifact,
  renderMeetingRawArtifactMarkdown,
  renderMeetingTranscriptionJson,
} from "./raw-artifact.js";
import type { MeetingSession } from "./types.js";

let stateDir: string | null = null;

describe("meeting raw artifact", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-meetings-test-");
  });

  afterEach(async () => {
    setMeetingEventPublisherForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("renders meet.md as raw meeting material with metadata, speakers, timestamps and media refs", () => {
    const markdown = renderMeetingRawArtifactMarkdown({ session: sampleMeetingSession() });

    expect(markdown).toContain("# Meet");
    expect(markdown).toContain("## Metadata");
    expect(markdown).toContain("- Title: Ravi v0 backlog refinement");
    expect(markdown).toContain("- Provider: google-meet");
    expect(markdown).toContain("- Meeting channel: meet");
    expect(markdown).toContain("- Meeting chat: bdw-wzcp-fse");
    expect(markdown).toContain("- Origin session: agent:ravi-meet-v0:whatsapp:group:120363428094858911");
    expect(markdown).toContain("Luís Filipe (kind=human, id=human-luis)");
    expect(markdown).toContain("Ravi (kind=agent, id=agent-ravi-meet-v0)");
    expect(markdown).toContain(
      "- [2026-06-22T01:41:11.000Z to 2026-06-22T01:41:18.000Z] Luís Filipe: A gente precisa de um artifact no final.",
    );
    expect(markdown).not.toContain("Source: captions");
    expect(markdown).toContain("A gente precisa de um artifact no final.");
    expect(markdown).toContain("- [+00:01:12 to +00:01:18] Ravi: P0 = gerar um artifact meet.md ao final da sessão.");
    expect(markdown).toContain("P0 = gerar um artifact meet.md ao final da sessão.");
    expect(markdown).toContain("## Text Chat");
    expect(markdown).toContain(
      "- [2026-06-22T01:41:30.000Z] Luís Filipe (direction=inbound, providerId=chat-001, source=google-meet-chat): manda o artifact aqui",
    );
    expect(markdown).toContain("## Agent Output");
    expect(markdown).toContain(
      "- [2026-06-22T01:42:00.000Z] Ravi (kind=speech, status=delivered, ended=2026-06-22T01:42:03.000Z, source=ravi-native): Entrei na sala e estou ouvindo.",
    );
    expect(markdown).toContain("recording: /recordings/ravi-v0.mp4");
    expect(markdown).toContain("audio: /recordings/ravi-v0.wav");
    expect(markdown).toContain("warning/captions.partial: Captions started after the first greeting.");

    expect(markdown).not.toContain("## Summary");
    expect(markdown).not.toContain("## Decisions");
    expect(markdown).not.toContain("## Action Items");
    expect(markdown).not.toContain("## Backlog");

    expect(renderMeetingTranscriptionJson({ session: sampleMeetingSession() })).toMatchObject({
      kind: "meeting.transcription",
      version: 1,
      transcription: {
        sourceTypes: ["captions", "imported_transcript"],
        provider: null,
        model: null,
        mediaPath: null,
        segmentCount: 2,
      },
      segments: [
        {
          id: "seg-001",
          speaker: "Luís Filipe",
          startAt: "2026-06-22T01:41:11.000Z",
          endAt: "2026-06-22T01:41:18.000Z",
          text: "A gente precisa de um artifact no final.",
        },
        {
          id: "seg-002",
          speaker: "Ravi",
          startSec: 72,
          endSec: 78,
          text: "P0 = gerar um artifact meet.md ao final da sessão.",
        },
      ],
      textMessages: [
        {
          id: "chat-001",
          providerMessageId: "chat-001",
          sender: "Luís Filipe",
          direction: "inbound",
          sentAt: "2026-06-22T01:41:30.000Z",
          text: "manda o artifact aqui",
        },
      ],
      agentOutputs: [
        {
          id: "agent-output-001",
          kind: "speech",
          agent: "Ravi",
          startedAt: "2026-06-22T01:42:00.000Z",
          endedAt: "2026-06-22T01:42:03.000Z",
          deliveryStatus: "delivered",
          text: "Entrei na sala e estou ouvindo.",
        },
      ],
    });
  });

  it("writes and registers meet.md in the artifact ledger", () => {
    const published: Array<{ subject: string; payload: Record<string, unknown> }> = [];
    setMeetingEventPublisherForTests((subject, payload) => {
      published.push({ subject, payload });
    });

    const session = sampleMeetingSession();
    const result = registerMeetingRawArtifact({
      session,
      outputDir: join(stateDir!, "meeting-artifact"),
      actor: "ravi-meet-v0",
    });

    expect(result.filePath.endsWith("/meet.md")).toBe(true);
    expect(existsSync(result.filePath)).toBe(true);
    expect(readFileSync(result.filePath, "utf8")).toBe(result.markdown);
    expect(result.transcriptionJson).toBeDefined();
    const transcriptionJson = result.transcriptionJson!;
    expect(transcriptionJson.filePath.endsWith("/transcription.json")).toBe(true);
    expect(transcriptionJson.data.transcription.segmentCount).toBe(2);
    expect(readFileSync(transcriptionJson.filePath, "utf8")).toBe(transcriptionJson.json);

    expect(result.artifact).toMatchObject({
      kind: "meeting.raw",
      title: "Ravi v0 backlog refinement",
      status: "completed",
      mimeType: "text/markdown",
      provider: "google-meet",
      sessionKey: "agent:ravi-meet-v0:whatsapp:group:120363428094858911",
      sessionName: "ravi-meet-v0",
      agentId: "ravi-meet-v0",
      channel: "whatsapp",
      chatId: "120363428094858911@g.us",
    });
    expect(result.artifact.tags).toContain("meeting-raw");
    expect(result.artifact.metadata).toMatchObject({
      meetingId: "meet-ravi-v0-backlog-refiner-v2",
      provider: "google-meet",
      meetingChannel: "meet",
      meetingChatId: "bdw-wzcp-fse",
      providerMeetingId: "bdw-wzcp-fse",
      participantCount: 2,
      transcriptSegmentCount: 2,
      textMessageCount: 1,
      agentOutputCount: 1,
      transcriptionJsonPath: transcriptionJson.filePath,
    });
    expect(result.artifact.lineage).toMatchObject({
      source: "meetings.raw-artifact",
      meeting: {
        id: "meet-ravi-v0-backlog-refiner-v2",
        providerMeetingId: "bdw-wzcp-fse",
        channel: "meet",
        chatId: "bdw-wzcp-fse",
      },
      origin: {
        sessionName: "ravi-meet-v0",
        agentId: "ravi-meet-v0",
        channel: "whatsapp",
      },
    });

    const details = getArtifactDetails(result.artifact.id);
    expect(details?.versions[0]?.assets[0]).toMatchObject({
      path: "meet.md",
      role: "primary",
      mimeType: "text/markdown",
    });

    expect(listArtifactEvents(result.artifact.id).map((event) => event.eventType)).toEqual([
      "created",
      "version_created",
      "completed",
    ]);
    expect(result.completedEvent).toMatchObject({
      eventType: "completed",
      status: "completed",
      source: "meetings.raw-artifact",
      actor: "ravi-meet-v0",
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      subject: MEETING_EVENT_TOPICS.artifactGenerated,
      payload: {
        meetingId: "meet-ravi-v0-backlog-refiner-v2",
        provider: "google-meet",
        channel: "meet",
        meetingChatId: "bdw-wzcp-fse",
        artifactId: result.artifact.id,
        artifactPath: result.filePath,
        transcriptionJsonPath: transcriptionJson.filePath,
        transcriptSegmentCount: 2,
        textMessageCount: 1,
        agentOutputCount: 1,
      },
    });

    expect(result.handoffMessage).toBe(
      buildMeetingRawArtifactHandoffMessage({
        session: { ...session, artifactId: result.artifact.id },
        artifact: result.artifact,
        filePath: result.filePath,
        transcriptionJsonPath: transcriptionJson.filePath,
      }),
    );
    expect(result.handoffMessage).toContain("Meeting raw artifact generated.");
    expect(result.handoffMessage).toContain(`Artifact: ${result.artifact.id}`);
    expect(result.handoffMessage).not.toContain("Summary");
    expect(result.handoffMessage).not.toContain("Decisions");
  });
});

function sampleMeetingSession(): MeetingSession {
  return {
    id: "meet-ravi-v0-backlog-refiner-v2",
    provider: "google-meet",
    providerMeetingId: "bdw-wzcp-fse",
    title: "Ravi v0 backlog refinement",
    url: "https://meet.google.com/bdw-wzcp-fse",
    originSessionKey: "agent:ravi-meet-v0:whatsapp:group:120363428094858911",
    originSessionName: "ravi-meet-v0",
    originAgentId: "ravi-meet-v0",
    meetingChannel: "meet",
    meetingAccountId: "google-meet",
    meetingChatId: "bdw-wzcp-fse",
    channel: "whatsapp",
    accountId: "main",
    chatId: "120363428094858911@g.us",
    startedAt: "2026-06-22T01:41:11.000Z",
    endedAt: "2026-06-22T02:05:03.000Z",
    durationMs: 1_432_000,
    participants: [
      { id: "human-luis", displayName: "Luís Filipe", kind: "human" },
      { id: "agent-ravi-meet-v0", displayName: "Ravi", kind: "agent" },
    ],
    transcriptSegments: [
      {
        id: "seg-001",
        speakerId: "human-luis",
        speakerName: "Luís Filipe",
        startAt: "2026-06-22T01:41:11.000Z",
        endAt: "2026-06-22T01:41:18.000Z",
        source: "captions",
        text: "A gente precisa de um artifact no final.",
      },
      {
        id: "seg-002",
        speakerId: "agent-ravi-meet-v0",
        speakerName: "Ravi",
        startOffsetMs: 72_000,
        endOffsetMs: 78_000,
        source: "imported_transcript",
        text: "P0 = gerar um artifact meet.md ao final da sessão.",
      },
    ],
    textMessages: [
      {
        id: "chat-001",
        providerMessageId: "chat-001",
        senderId: "human-luis",
        senderName: "Luís Filipe",
        direction: "inbound",
        sentAt: "2026-06-22T01:41:30.000Z",
        text: "manda o artifact aqui",
        source: "google-meet-chat",
      },
    ],
    agentOutputs: [
      {
        id: "agent-output-001",
        kind: "speech",
        agentId: "agent-ravi-meet-v0",
        agentName: "Ravi",
        startedAt: "2026-06-22T01:42:00.000Z",
        endedAt: "2026-06-22T01:42:03.000Z",
        deliveryStatus: "delivered",
        text: "Entrei na sala e estou ouvindo.",
        source: "ravi-native",
      },
    ],
    mediaRefs: [
      {
        kind: "recording",
        path: "/recordings/ravi-v0.mp4",
        mimeType: "video/mp4",
        sizeBytes: 123_456,
        source: "google-meet-recording",
      },
      {
        kind: "audio",
        path: "/recordings/ravi-v0.wav",
        mimeType: "audio/wav",
      },
    ],
    diagnostics: [
      {
        level: "warning",
        code: "captions.partial",
        message: "Captions started after the first greeting.",
        at: "2026-06-22T01:41:22.000Z",
      },
    ],
    rawProvenance: {
      artifactPath: "/Users/luis/ravi/ravi-meet-recorder/artifacts/meet-ravi-v0-backlog-refiner-v2/20260622T014111Z",
    },
  };
}
