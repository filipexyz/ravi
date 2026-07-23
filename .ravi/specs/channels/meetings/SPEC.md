---
id: channels/meetings
title: Meeting Channels
kind: capability
domain: channels
capability: meetings
tags:
  - channels
  - meetings
  - providers
  - sessions
  - events
  - artifacts
  - permissions
applies_to:
  - src/channels/
  - src/channels/native/
  - src/channels/meetings/
  - src/runtime/
  - src/artifacts/
  - src/triggers/
owners:
  - ravi-dev
status: draft
normative: true
---

# Meeting Channels

## Intent

Meeting channels make live meetings a first-class Ravi native channel capability.

A meeting is a conversation container where an explicit Ravi agent participant can join, listen, speak, capture raw transcript/media provenance, emit lifecycle events, and produce artifacts for the originating session.

The P0 goal is a demonstrable Google Meet flow that produces a raw `meet.md` artifact at session end and returns that artifact to the agent/session that requested the meeting.

The v0 direction is broader: `meet` is a channel. Concrete surfaces such as Google Meet are providers of that channel. A meeting channel can carry voice, text chat, participant state, media, lifecycle, and artifacts. The channel must be usable by normal Ravi systems such as sessions, observers, triggers, permissions, artifacts, and future apps.

## Product Contract

- Ravi MUST treat a meeting as a native Ravi semantic object, not as an Omni-owned product lifecycle.
- Ravi MUST model `meet` as the channel id for live meeting rooms. `google-meet` MUST be a provider id under that channel, not the channel id itself.
- Meeting providers MUST expose bidirectional channel behavior: inbound voice/text/lifecycle events and outbound voice/text/control delivery.
- Omni or any other transport MAY deliver meeting-related transport events in the future, but Ravi MUST own meeting lifecycle, participants, permissions, artifact lineage, and session handoff semantics.
- A meeting provider MUST represent an explicit participant in the meeting. Ravi MUST NOT capture, record, transcribe, or speak in a hidden or deceptive way.
- A meeting session that starts from `channel=meet` SHOULD be eligible for observer rules, trigger rules, routing rules, permission policy, and artifact policy using the same Ravi-owned source metadata used by other channels.
- Meeting channel text chat MUST be modeled as first-class inbound/outbound messages when provider support exists. Voice transcript segments MUST remain first-class meeting events, not lossy chat-message text only.
- P0 MUST produce a raw artifact. It MUST NOT generate AI summaries, decisions, action items, or backlog interpretation before the consumer agent receives the artifact.
- The consumer agent, not the meeting recorder runtime, owns summarization and interpretation after artifact handoff.

## Definitions

- `meeting`: Ravi semantic container for one live meeting occurrence.
- `meeting_provider`: adapter for a concrete meeting surface such as Google Meet.
- `meeting_session`: one Ravi-managed participation run in a meeting.
- `origin_session`: Ravi session that requested or owns the meeting work.
- `meeting_participant`: human, agent, or unknown actor observed in the meeting.
- `transcript_segment`: one raw utterance or caption segment with timestamp and speaker/provenance metadata.
- `media_ref`: path, URI, provider id, or artifact id for recording, audio, video, screenshot, or diagnostics produced by capture.
- `meeting_raw_artifact`: durable artifact containing raw meeting material, normally `meet.md`.
- `meeting_channel_session`: Ravi source session whose source channel is `meet`.
- `meeting_voice_runtime`: optional runtime provider used by a live meeting agent to perform low-latency speech/text interaction.
- `meeting_observer`: observer binding attached because the source session is a meeting channel session.

## Provider Boundary

Meeting providers are not runtime LLM providers.

A `MeetingProvider` SHOULD own meeting-surface operations such as:

- `start` or `join`;
- `observe`;
- `speak`;
- `leave`;
- `finalize`;
- provider diagnostics.

A `MeetingProvider` MUST NOT implement LLM turn execution through `RuntimeProvider` unless it is separately acting as a real LLM runtime engine. Google Meet participation MUST NOT be added as provider-specific branches inside the runtime provider host.

Meeting provider adapters MUST expose normalized meeting events and data to Ravi-owned services. Product logic MUST consume normalized meeting events and data, not raw browser/Meet internals.

## Channel Boundary

The `meet` channel owns room-level communication semantics:

- joining or leaving a live meeting room;
- observing participants, voice turns, text chat, reactions when available, and lifecycle;
- delivering outbound speech, outbound text chat, and explicit room controls;
- binding a meeting room to a Ravi source session and artifact lineage;
- emitting normalized channel and meeting events.

The `meet` channel MUST NOT own model execution, deep reasoning, task execution, or post-meeting interpretation. Those remain responsibilities of runtime providers, tasks, observers, and consumer agents.

Concrete providers such as `google-meet` own surface mechanics:

- browser/profile/session setup;
- provider admission flow;
- WebRTC/media/caption/chat extraction;
- provider-specific send text/speak/leave primitives;
- provider diagnostics and provenance.

Feature code outside the provider SHOULD target the normalized `meet` channel contract.

## Data Model

P0 MAY persist meeting state in a minimal local structure before a dedicated database model exists, but the normalized shape MUST include:

```ts
type MeetingSession = {
  id: string;
  provider: string;
  providerMeetingId?: string;
  title?: string;
  url?: string;
  originSessionKey?: string;
  originSessionName?: string;
  originAgentId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  participants?: MeetingParticipant[];
  transcriptSegments?: TranscriptSegment[];
  mediaRefs?: MediaRef[];
  artifactId?: string;
  rawProvenance?: unknown;
};
```

`TranscriptSegment` MUST include:

- stable segment id when available;
- speaker display label or unresolved speaker id;
- start timestamp or captured-at timestamp;
- end timestamp when available;
- raw text;
- source/provenance, such as captions, realtime transcription, audio transcription, or imported transcript.

`MediaRef` SHOULD include:

- kind: `recording`, `audio`, `video`, `screenshot`, `log`, `diagnostic`, or future kind;
- path, URI, provider id, or artifact id;
- mime type and size when available;
- provenance and capture timestamps when available.

## Events

P0 SHOULD start with coarse meeting events.

Required P0 event topics:

- `ravi.meetings.ended`
- `ravi.meetings.transcript_available`
- `ravi.meetings.artifact_generated`

Each event payload SHOULD include:

- `meetingId`;
- `provider`;
- `providerMeetingId` when known;
- `originSessionKey` or `originSessionName`;
- `originAgentId`;
- `artifactId` when available;
- `title`;
- `startedAt`;
- `endedAt`;
- `durationMs`;
- `participants`;
- `mediaRefs`;
- `rawProvenance`.

Fine-grained transcript chunk events MAY be added later for scale, resumability, or live-agent workflows. They are not required for P0.

Live channel mode SHOULD add a scoped event stream for a single meeting room. Required v0 event families are specified in `channels/meetings/native-channel`.

## Session Handoff

When a meeting raw artifact is generated, Ravi MUST deliver a post-meeting context message to the origin session.

The handoff message SHOULD include:

- artifact id;
- local path or URI;
- meeting title or provider id;
- start/end timestamps;
- short machine-readable metadata.

The handoff message MUST NOT include an AI-generated summary, interpretation, decisions, or task list.

If the origin session has an active turn, the handoff SHOULD use the existing delivery barrier behavior for post-response delivery, such as `after_response`, so it does not interrupt an active user-visible answer.

## Observer Integration

Meeting channel sessions SHOULD be observable through the Observation Plane.

Observer rules MUST match meeting sessions through Ravi-owned source metadata such as `source.channel == "meet"`, meeting provider, meeting id, origin agent, session tag, or project tag. Providers MUST NOT create observer prompts directly.

A system MAY define a default observer rule for meeting sessions, but a fresh Ravi install MUST NOT silently create global observers unless an operator or feature profile explicitly enables that rule.

Observers attached to meeting sessions SHOULD consume compact meeting events such as speaker turns, transcript commits, text chat messages, participant lifecycle, tool results, and meeting artifacts. They MUST NOT consume raw browser internals as their product contract.

## Permissions And Consent

- A meeting provider MUST require explicit operator/user intent before joining a meeting.
- Ravi MUST NOT bypass lobbies, provider access control, media permission prompts, consent UX, or meeting platform policies.
- Meeting capture MUST preserve enough audit metadata to show which agent/session requested participation and which provider surface was used.
- Access to meeting artifacts MUST be governed by Ravi artifact/session/agent permissions, not by raw provider URLs alone.
- Secrets, tokens, cookies, and browser profile credentials MUST NOT be written into meeting artifacts or event payloads.

## P0 Acceptance Criteria

- A Google Meet session can end and automatically produce a `meet.md` raw artifact.
- The artifact contains title/date/duration or equivalent meeting metadata.
- The artifact contains participants detected when available.
- The artifact contains complete transcript segments by speaker with timestamps when available.
- The artifact references recording, audio, video, and diagnostics when they exist.
- The artifact contains no AI-generated summary, decisions, action items, or backlog interpretation.
- The artifact is registered in Ravi's artifact ledger with lineage to origin session and agent.
- Ravi emits coarse meeting/artifact events for the completed meeting.
- The origin session receives the artifact as post-meeting context.

## Non-Goals For P0

- Omni-owned meeting product lifecycle.
- Fine-grained transcript chunk eventing.
- Multi-provider meeting abstraction beyond the Google Meet adapter contract.
- Hidden recording or bypass of meeting consent and access controls.
- AI summary generation before artifact handoff.
- Using legacy prox/calls as the architectural precedent.
