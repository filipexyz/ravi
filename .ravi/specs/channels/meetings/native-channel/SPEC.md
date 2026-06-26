---
id: channels/meetings/native-channel
title: Meeting Native Channel
kind: feature
domain: channels
capability: meetings
feature: native-channel
tags:
  - channels
  - meetings
  - voice
  - text
  - sessions
  - observers
  - artifacts
applies_to:
  - src/channels/
  - src/channels/native/
  - src/meetings/
  - src/gateway.ts
  - src/runtime/
  - src/runtime/observation-plane.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Meeting Native Channel

## Intent

`meet` is Ravi's native channel for live meeting rooms.

The channel exists so a Ravi agent can participate in a meeting as a visible participant, receive voice and text input, speak and send text back, expose normalized events to observers/triggers/tasks/apps, and produce post-meeting artifacts without depending on Omni as the product lifecycle owner.

Google Meet is a provider of the `meet` channel. It is not the channel itself.

## Product Contract

- Ravi MUST use `meet` as the semantic channel id for live meeting room sessions.
- Provider ids such as `google-meet` MUST live under the `meet` channel contract.
- A meeting channel session MUST be a normal Ravi source session from the perspective of routing, observers, permissions, context keys, artifacts, triggers, and audit.
- A meeting channel provider MUST join as an explicit visible participant and MUST NOT hide capture or bypass provider access controls.
- The channel MUST support inbound voice transcript events and SHOULD support inbound text chat events as soon as provider data is available.
- The channel MUST support outbound speech. It SHOULD support outbound text chat when the provider supports sending chat messages.
- The channel MUST keep voice transcript segments, text chat messages, media refs, and provider diagnostics distinguishable. It MUST NOT collapse all meeting input into plain chat text.
- The channel MUST preserve raw artifact generation as a first-class lifecycle output.

## Channel Shape

The normalized channel id is:

```text
channel: meet
```

The provider id is:

```text
provider: google-meet
```

Recommended source target shape:

```ts
type MeetingMessageTarget = {
  channel: "meet";
  accountId: string;
  instanceId?: string;
  chatId: string; // canonical meeting room id
  canonicalChatId?: string;
  threadId?: string; // optional substream such as chat, voice, or breakout later
  sourceMessageId?: string;
  actorType?: "contact" | "agent" | "system" | "unknown";
  rawSenderId?: string;
  normalizedSenderId?: string;
};
```

`chatId` SHOULD be the Ravi canonical meeting room id. Provider meeting codes, URLs, participant ids, and raw event ids MUST be stored as provenance.

The persistent chat row MAY use `chatType="meeting"` or an equivalent typed enum. If the current schema only accepts generic chat types, the implementation MAY use the closest compatible type temporarily, but the normalized source payload MUST still identify `channel="meet"` and provider metadata.

## Native Runtime Components

The implementation SHOULD follow the native channel pattern already used by `src/channels/slack`:

- a channel service that runs provider loops and normalizes inbound events;
- a delivery adapter used by the gateway for outbound text and/or speech;
- routing/session binding logic that creates or reuses the target Ravi session;
- durable message/event persistence with provider provenance;
- daemon startup/shutdown hooks.

Meeting channels need a richer native interface than current `NativeTextDelivery`:

```ts
interface NativeMeetingDelivery {
  channelId: "meet";
  supports(target: MessageTarget): boolean;
  deliverText(request: NativeTextDeliveryRequest): Promise<NativeTextDeliveryResult>;
  deliverSpeech(request: MeetingSpeechDeliveryRequest): Promise<MeetingSpeechDeliveryResult>;
  leave?(request: MeetingLeaveRequest): Promise<MeetingLeaveResult>;
}
```

The implementation MAY start with text delivery unsupported if the provider cannot yet send chat messages. Speech delivery MUST be explicit and auditable.

## Inbound Event Model

The channel SHOULD normalize provider events into meeting-scoped events before publishing prompts or observer events.

Required v0 event types:

- `meeting.room.started`
- `meeting.room.admitted`
- `meeting.participant.joined`
- `meeting.participant.left`
- `meeting.voice.turn.started`
- `meeting.voice.turn.delta`
- `meeting.voice.turn.committed`
- `meeting.text.message`
- `meeting.agent.speech.started`
- `meeting.agent.speech.completed`
- `meeting.media.ref`
- `meeting.diagnostic`
- `meeting.room.ended`
- `meeting.artifact.generated`

Every event MUST include:

- meeting id;
- channel id `meet`;
- provider id;
- provider meeting id or room id when available;
- source session key/name when bound;
- origin agent id when known;
- timestamp;
- provider provenance sufficient for debugging;
- monotonic sequence when available.

Events intended for user-facing runtime prompts SHOULD be compact. Raw provider payloads MAY be stored as diagnostics/provenance but MUST NOT be the primary product contract.

## Voice And Text Semantics

Voice input and text chat are separate input classes.

Voice input:

- SHOULD enter Ravi as transcript turns, not as arbitrary partial text spam.
- MUST preserve speaker identity when available.
- MUST preserve turn timing and provenance.
- MAY expose partial deltas for live UX, but committed turns are the stable input for observers and heavy agents.

Text chat input:

- SHOULD enter Ravi as channel messages when provider support exists.
- MUST preserve provider message id, sender, timestamp, reply/thread metadata when available, and raw provenance.
- SHOULD be eligible for normal routing, observer rules, and contact identity resolution.

Outbound speech:

- MUST go through meeting delivery, not generic chat send.
- MUST be recorded in meeting transcript/artifact as agent speech.
- MUST support interruption/barge-in policy when the runtime/provider can enforce it.

Outbound text:

- SHOULD go through channel delivery with `channel="meet"` and a provider-specific text/chat primitive.
- MUST be recorded in meeting artifact as agent text output.

## Runtime Relationship

The `meet` channel is not itself an LLM runtime provider.

A live meeting can choose a runtime provider for the agent that speaks in the room. For low-latency voice, that provider MAY be `realtime-voice`, OpenAI Realtime, Pipecat, LiveKit Agents, or another adapter described in `runtime/providers/realtime-voice`.

The channel owns room media and delivery. The runtime provider owns model execution and dynamic tool calls. The bridge between them MUST be normalized runtime and channel events, not provider-specific shortcuts.

## Observer Integration

Meeting channel sessions SHOULD support observer rules.

Recommended default policy shape:

```text
scope: channel
source.channel: meet
role: meeting-observer
mode: observe | summarize | report
delivery: realtime or debounce
profile: meeting-live
```

The current Observer Rule model does not yet define `scope=channel`. Until it does, implementations MAY use `scope=tag`, `scope=agent`, or `scope=session` with meeting source metadata. A future channel selector MUST be deterministic and explainable through `ravi observers rules explain`.

Observers MUST NOT be created by provider code directly. Provider code emits normalized events; the Observation Plane attaches observers based on rules.

## Artifacts

The meeting channel MUST preserve the existing raw artifact contract:

- `meet.md` is raw and contains no AI-generated summary.
- `transcription.json` SHOULD be generated when structured transcript data exists.
- media refs SHOULD include audio, video, text chat export, WebRTC tracks, logs, screenshots, and diagnostics when available.
- outbound agent speech/text MUST be represented in the raw artifact with provenance.

## Permissions

- Joining a meeting MUST require explicit user/operator intent.
- Speech output MUST be explicitly enabled for live agent modes.
- Text output MUST be separately controllable from speech output.
- Tool access for live runtime MUST use explicit allowlists; `all` and `*` MUST NOT be accepted.
- Provider credentials, browser profiles, cookies, tokens, and raw API keys MUST NOT be emitted in prompts, artifacts, traces, or events.
- Meeting artifacts and event streams MUST use Ravi permissions, not raw provider URLs, as the access control boundary.

## Acceptance Criteria

- `ravi meetings join --provider google-meet` creates or binds a source whose normalized channel is `meet`.
- The provider records the visible Ravi participant identity and meeting lifecycle.
- Inbound voice turns are available as normalized meeting events with timestamps and speaker/provenance when available.
- Inbound text chat has a normalized event/message contract, even if Google Meet chat ingestion is implemented after voice.
- The agent can speak into the room through a meeting delivery path.
- The agent can send text chat through the same channel contract when provider support is implemented.
- Meeting sessions are eligible for observer rules using Ravi-owned source metadata.
- Meeting lifecycle and artifact events remain available on `ravi.meetings.>`.
- `meet.md` and `transcription.json` remain raw, complete, and linked to origin session/agent.
- No model/runtime/provider-specific branch is added to generic channel, gateway, runtime launcher, or observer code unless protected by a typed capability.

## Non-Goals

- Rebuilding Omni transport behavior inside the meeting provider.
- Treating Google Meet as the channel id.
- Treating SDK SSE stream channels as the meeting product channel.
- Forcing meeting voice turns to look exactly like WhatsApp text messages.
- Letting the realtime speech model own session routing, observers, artifacts, or task state.
