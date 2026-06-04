---
id: voice
title: Voice
kind: domain
domain: voice
capabilities:
  - sessions
  - transports
  - cli
tags:
  - voice
  - realtime
  - sessions
  - agents
  - extension
applies_to:
  - src/voice
  - src/cli/commands/voice.ts
  - packages/ravi-os-sdk
  - extensions/whatsapp-overlay
owners:
  - ravi-dev
status: draft
normative: true
---

# Voice

## Intent

The `voice` domain owns live speech conversations between a human operator and a Ravi agent.

Voice is a Ravi semantic domain, not a provider name. OpenAI Realtime, LiveKit, SIP, browser WebRTC, and future media runtimes are implementation transports behind the same Ravi contract.

The first production path SHOULD be browser extension to OpenAI Realtime 2 over WebRTC with a Ravi server-side sideband connection for tools, context, permissions, persistence, and observability.

The default OpenAI realtime model for new `openai-direct` voice profiles SHOULD be `gpt-realtime-2`, not the older `gpt-realtime` alias. Profiles MAY opt into another supported realtime model only when latency, cost, or compatibility requires it.

## Boundary

Voice owns:

- live voice session lifecycle: start, connect, interrupt, end, status;
- reusable voice profiles: model, voice, transport, turn detection, tool policy, and UI defaults;
- voice transport adapter selection: `openai-direct`, `livekit`, or future adapters;
- server-side sideband control for provider sessions when the media path is client-to-provider;
- voice transcript, tool, state, and provider events linked to Ravi sessions;
- extension-facing and SDK-facing command contracts for voice calls.

Voice does NOT own:

- Ravi session identity, rename, attach, or output chat routing. Those remain in `sessions` and `sessions/attach`.
- Chat identity or chat participants. Those remain in `channels/chats`.
- Runtime provider lifecycle for normal text turns. That remains in `runtime`.
- Static TTS/audio file generation. That remains in `audio`.
- WhatsApp transport delivery. That remains in channels/Omni.

## Core Model

A `voice_session` is a live call-like interaction linked to one Ravi session and one agent.

It MUST reference:

- `voice_session_id`: stable id for the voice call.
- `session_key`: canonical Ravi session key.
- `session_name`: optional secondary lookup/display value.
- `agent_id`: Ravi agent that owns the conversation.
- `chat_id`: canonical chat id when the call was initiated from a chat-scoped surface.
- `profile_id`: reusable voice profile.
- `transport_id`: transport adapter used for this session.
- `client_kind`: `wa-overlay`, `cli`, `sdk`, `test`, or future client.
- `state`: `created`, `pending_client`, `connecting`, `active`, `interrupting`, `ending`, `ended`, or `failed`.
- `provider_session_id` and `provider_call_id`: provider-native ids stored as provenance only.

Voice MUST NOT treat provider call ids as Ravi session ids.

Voice MUST NOT mutate `sessions.session_key`, `sessions.name`, chat bindings, route config, or channel output selection as part of normal call start/end.

## Default Transport Decision

For browser and extension calls, the default MVP transport SHOULD be `openai-direct`.

`openai-direct` means:

- the browser owns microphone capture and playback;
- the browser connects to OpenAI Realtime with WebRTC;
- Ravi uses the OpenAI Realtime unified WebRTC interface by default: browser creates an SDP offer, Ravi posts the SDP plus session config to `/v1/realtime/calls`, and Ravi returns the provider SDP answer;
- Ravi MAY use Realtime client secrets as a fallback/alternate `webrtc-token` mode, but those secrets currently expire after one minute and MUST be treated as single-session browser credentials;
- Ravi keeps OpenAI API keys server-side;
- Ravi stores the provider call id returned by OpenAI as provenance and uses it to open a server-side sideband connection to the same realtime session when supported;
- Ravi executes tools server-side through existing host services and permission policy.

`livekit` MAY be added behind the same voice transport interface when Ravi needs multi-party rooms, telephony/SIP, recording, media routing, cross-platform room orchestration, or LiveKit-managed agent dispatch.

## Security

Client-facing voice start/connect commands MUST NOT expose provider API keys.

The browser extension MUST authenticate to Ravi with the active gateway context key defined by `wa-overlay/auth`.

OpenAI Realtime client secrets, SDP answers, LiveKit room tokens, and equivalent provider credentials MUST be short-lived and scoped to one voice session, one client kind, and the authenticated Ravi gateway context that requested them.

For OpenAI `webrtc-token` mode, Ravi MUST set `OpenAI-Safety-Identifier` on the server-side client-secret request using a stable, non-reversible identifier for the local operator/contact/session actor. The browser MUST NOT be required to send the safety identifier separately when connecting with the returned client secret.

Client-facing connection material MUST NOT be persisted in SQLite, extension storage, SDK logs, traces, or raw provider event payloads. A reconnect MUST mint or negotiate fresh connection material instead of reusing expired output from `start` or `connect`.

Tool execution MUST remain server-side. A client MAY observe tool activity, but MUST NOT execute Ravi tools directly on behalf of the realtime model.

Voice tool permissions MUST flow through Ravi host services, context-key authorization, or the same permission system used by runtime providers. Voice MUST NOT introduce a parallel permission model.

## OpenAI Realtime 2 Baseline

When `transport_id=openai-direct` and `model=gpt-realtime-2`, Ravi MUST assume:

- speech-to-speech is the primary interaction mode;
- text input/output and image input are supported;
- video input/output is not supported;
- function calling is supported;
- structured outputs are not supported and MUST NOT be required for voice correctness;
- reasoning effort is configurable and higher effort can increase latency and token usage;
- the realtime context window is large, but long-session context still needs explicit structure.

OpenAI Realtime 2 voice prompts SHOULD be generated as short, structured sections rather than dense prose. Voice profile instructions SHOULD define:

- role and objective;
- language behavior and unclear-audio handling;
- turn/preamble behavior for long reasoning or tool flows;
- exact tool-call triggers and confirmation boundaries for write actions;
- current state versus background context when injecting session history;
- variety rules to avoid robotic repetition.

## Event Model

Voice events MUST be durable and linked to the voice session.

Canonical event types:

- `voice.session.created`
- `voice.session.connected`
- `voice.session.active`
- `voice.input.transcript.delta`
- `voice.input.transcript.completed`
- `voice.output.transcript.delta`
- `voice.output.transcript.completed`
- `voice.output.audio.started`
- `voice.output.audio.stopped`
- `voice.tool.requested`
- `voice.tool.started`
- `voice.tool.completed`
- `voice.interrupt.requested`
- `voice.interrupted`
- `voice.session.ended`
- `voice.session.failed`
- `voice.provider.raw`

Raw provider events MAY be stored under `voice.provider.raw`, but product logic MUST consume canonical voice events.

Raw provider event storage MUST be disabled by default or guarded by an explicit debug setting. When enabled, raw provider payloads MUST be redacted, size-limited, TTL-bound, and excluded from normal sync/export paths unless a separate safe export contract exists.

Voice transcript events SHOULD be projectable into session timelines and overlay UI, but they MUST NOT automatically emit as outbound chat messages.

## Relationship To Runtime Providers

The first cut SHOULD implement voice as a dedicated `VoiceSessionService`, not as a normal `RuntimeProvider`.

Reason: a live voice call has a continuous browser media path and server sideband control, while normal Ravi runtime turns are prompt/response executions.

Voice MAY reuse runtime primitives:

- agent/session resolution;
- prompt/context rendering;
- `RuntimeHostServices` for dynamic tools;
- permission checks;
- trace/event recording;
- runtime credential selection.

If a future implementation registers a `realtime` runtime provider, it MUST still satisfy `runtime/providers` and MUST NOT bypass the `voice` domain contract for browser media/session lifecycle.

## Validation

- Voice specs MUST be consulted before implementing `src/voice`, `ravi voice`, or extension voice UI.
- `ravi voice` list-like commands MUST support pagination and `--json`.
- `ravi voice sessions start --json` MUST return enough data for an SDK/extension client to perform the next connection step without scraping human output.
- Provider credentials MUST never appear in CLI output, SDK output, logs, traces, or extension storage.
