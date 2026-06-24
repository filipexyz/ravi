---
id: channels/meetings/google-meet
title: Google Meet Provider
kind: feature
domain: channels
capability: meetings
feature: google-meet
tags:
  - meetings
  - google-meet
  - provider
  - browser
  - transcription
applies_to:
  - src/channels/
  - src/meetings/
owners:
  - ravi-dev
status: draft
normative: true
---

# Google Meet Provider

## Intent

The Google Meet provider adapts the current recorder implementation into a Ravi-owned meeting provider.

The provider exists to join a Google Meet as an explicit Ravi participant, capture raw transcript/media provenance, speak when allowed, leave cleanly, and finalize a raw meeting artifact through Ravi services.

## Provider Contract

The P0 provider SHOULD expose a narrow interface:

```ts
interface MeetingProvider {
  id: "google-meet";
  start(input: MeetingStartInput): Promise<MeetingSessionHandle>;
}

interface MeetingSessionHandle {
  meetingId: string;
  providerMeetingId?: string;
  observe(): AsyncIterable<MeetingEvent>;
  speak(input: MeetingSpeakInput): Promise<void>;
  leave(input?: MeetingLeaveInput): Promise<void>;
  finalize(): Promise<MeetingFinalizeResult>;
}
```

P0 MAY implement this with browser automation and the existing recorder capture code, but the rest of Ravi MUST depend on normalized `MeetingProvider` behavior instead of recorder internals.

## Join And Identity

- The provider MUST join with an explicit Ravi identity visible to meeting participants.
- The provider MUST NOT bypass Google Meet lobby, admission, account, camera, microphone, or meeting access controls.
- The provider SHOULD record admission status and timestamps such as browser opened, prejoin ready, join clicked, admitted, recording started, and recording ended.
- The provider SHOULD capture the meeting URL and provider meeting code as raw provenance.

## Capture Sources

P0 capture MAY use multiple sources:

- Meet captions;
- realtime speech transcription events;
- browser-side WebRTC track diagnostics;
- audio files;
- UI participant snapshots.

The provider MUST normalize all usable transcript data into `TranscriptSegment` records before artifact rendering.

The provider SHOULD prefer sources that preserve speaker and timestamp metadata. Audio-only transcription MAY be used as fallback, but it MUST be marked with weaker provenance when speaker or segment timestamps are missing.

## Speaking

If the agent speaks in the meeting, the provider MUST preserve outbound utterances as transcript segments with speaker `Ravi` or the configured agent display name.

The provider MUST keep speaking control explicit. It MUST NOT claim microphone or camera state that it cannot actually control or observe.

## Leave And Finalize

The provider MUST support explicit leave when requested by the meeting owner or origin agent.

At finalize, the provider MUST return:

- normalized meeting metadata;
- participants detected when available;
- transcript segments;
- media references;
- diagnostics and failures;
- raw provenance paths.

Finalize MUST be idempotent enough that retrying artifact generation does not duplicate user-visible artifacts without clear versioning.

## Failure Handling

- Failure to capture final screenshot MUST NOT fail the entire meeting if transcript/media data is usable.
- Failure to stop a browser-side tap MUST be recorded as diagnostics and MUST NOT be hidden.
- Missing participants or speaker mapping MUST be represented as unknown/unresolved, not invented.
- Provider raw events MUST be kept as provenance/diagnostics but MUST NOT be the product contract consumed by downstream agents.

## Acceptance Criteria

- Provider can join a Google Meet when admitted through normal Meet flow.
- Provider records visible Ravi participant identity and admission status.
- Provider returns normalized metadata, participants, transcript segments, media refs, and diagnostics from `finalize`.
- Provider does not generate summaries or decisions.
- Provider can leave cleanly on request or at max duration.
- Provider output is sufficient for `channels/meetings/raw-artifact` to render `meet.md`.
