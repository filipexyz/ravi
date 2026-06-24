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
    expect(markdown).toContain("- Origin session: agent:ravi-meet-v0:whatsapp:group:120363428094858911");
    expect(markdown).toContain("Luís Filipe (kind=human, id=human-luis)");
    expect(markdown).toContain("Ravi (kind=agent, id=agent-ravi-meet-v0)");
    expect(markdown).toContain("### 2026-06-22T01:41:11.000Z to 2026-06-22T01:41:18.000Z - Luís Filipe");
    expect(markdown).toContain("Source: captions");
    expect(markdown).toContain("A gente precisa de um artifact no final.");
    expect(markdown).toContain("### +00:01:12 to +00:01:18 - Ravi");
    expect(markdown).toContain("P0 = gerar um artifact meet.md ao final da sessão.");
    expect(markdown).toContain("recording: /recordings/ravi-v0.mp4");
    expect(markdown).toContain("audio: /recordings/ravi-v0.wav");
    expect(markdown).toContain("warning/captions.partial: Captions started after the first greeting.");

    expect(markdown).not.toContain("## Summary");
    expect(markdown).not.toContain("## Decisions");
    expect(markdown).not.toContain("## Action Items");
    expect(markdown).not.toContain("## Backlog");
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
      providerMeetingId: "bdw-wzcp-fse",
      participantCount: 2,
      transcriptSegmentCount: 2,
    });
    expect(result.artifact.lineage).toMatchObject({
      source: "meetings.raw-artifact",
      meeting: { id: "meet-ravi-v0-backlog-refiner-v2", providerMeetingId: "bdw-wzcp-fse" },
      origin: {
        sessionName: "ravi-meet-v0",
        agentId: "ravi-meet-v0",
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
        artifactId: result.artifact.id,
        artifactPath: result.filePath,
        transcriptSegmentCount: 2,
      },
    });

    expect(result.handoffMessage).toBe(
      buildMeetingRawArtifactHandoffMessage({
        session: { ...session, artifactId: result.artifact.id },
        artifact: result.artifact,
        filePath: result.filePath,
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
