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

The Google Meet provider adapts the current recorder implementation into a Ravi-owned meeting provider under the `meet` native channel.

The provider exists to join a Google Meet as an explicit Ravi participant, capture raw transcript/media provenance, speak when allowed, leave cleanly, and finalize a raw meeting artifact through Ravi services.

Google Meet MUST remain a provider id. The Ravi semantic channel id for sessions, observers, triggers, permissions, and delivery is `meet`.

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

When the provider is used through the native channel, provider output MUST be normalized into `channels/meetings/native-channel` events before it is consumed by observers, triggers, artifacts, or runtime bridges.

## Join And Identity

- The provider MUST join with an explicit Ravi identity visible to meeting participants.
- The provider MUST NOT bypass Google Meet lobby, admission, account, camera, microphone, or meeting access controls.
- The provider SHOULD record admission status and timestamps such as browser opened, prejoin ready, join clicked, admitted, recording started, and recording ended.
- The provider SHOULD capture the meeting URL and provider meeting code as raw provenance.

## Capture Sources

P0 capture MAY use multiple sources:

- Meet captions;
- Meet text chat when provider extraction is implemented;
- realtime speech transcription events;
- browser-side WebRTC track diagnostics;
- audio files;
- UI participant snapshots.

The provider MUST normalize all usable transcript data into `TranscriptSegment` records before artifact rendering.

The provider SHOULD prefer sources that preserve speaker and timestamp metadata. Audio-only transcription MAY be used as fallback, but it MUST be marked with weaker provenance when speaker or segment timestamps are missing.

Text chat capture MUST preserve message id, sender, timestamp, body, reply/thread metadata when available, and provider provenance. Chat messages MUST NOT be mixed into voice transcript segments without a distinct source/provenance marker.

## Speaking

If the agent speaks in the meeting, the provider MUST preserve outbound utterances as transcript segments with speaker `Ravi` or the configured agent display name.

The provider MUST keep speaking control explicit. It MUST NOT claim microphone or camera state that it cannot actually control or observe.

## Text Chat Output

When Google Meet text chat sending is supported, the provider SHOULD expose it through the `meet` channel delivery contract.

Outbound text MUST be separately gated from outbound speech. A live agent allowed to speak is not automatically allowed to send text chat unless the meeting channel permissions and provider capability allow it.

Outbound text MUST be captured in the meeting artifact with sender, timestamp, body, provider message id when available, and delivery diagnostics.

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
- Provider identifies itself as `provider=google-meet` under `channel=meet` in normalized source/events.
- Provider does not generate summaries or decisions.
- Provider can leave cleanly on request or at max duration.
- Provider output is sufficient for `channels/meetings/raw-artifact` to render `meet.md`.
