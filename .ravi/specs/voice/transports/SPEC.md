---
id: voice/transports
title: Voice Transports
kind: capability
domain: voice
capability: transports
tags:
  - voice
  - transports
  - openai
  - livekit
  - webrtc
applies_to:
  - src/voice/transports
  - src/voice/openai-direct
  - src/voice/livekit
owners:
  - ravi-dev
status: draft
normative: true
---

# Voice Transports

## Intent

Voice transports adapt provider/media infrastructure into the Ravi voice session contract.

A transport MUST be replaceable without changing `ravi voice` command semantics or the overlay's high-level call UX.

## Transport Interface

Every transport MUST provide:

- stable `id`;
- `check()`: redacted health and configuration readiness;
- `startVoiceSession(input)`: creates or prepares provider resources;
- `connectClient(input)`: completes client connection when required and returns the client-facing connection result;
- `openSideband(input)`: opens server-side control when supported and binds it to the same provider call/session;
- `sendToolResult(input)`: sends provider-compatible tool output;
- `interrupt(input)`: stops active output when supported;
- `end(input)`: closes provider/media resources;
- event normalization into canonical `voice.*` events.

Transports MUST NOT:

- execute Ravi tools directly;
- own Ravi session or chat routing;
- expose provider secrets to clients;
- persist product state outside the voice store except provider-specific caches explicitly referenced by id.

## `openai-direct`

`openai-direct` is the preferred MVP transport for browser extension voice.

It SHOULD use:

- WebRTC for browser audio media;
- SDP answer exchange through the OpenAI Realtime unified interface as the default browser path;
- short-lived client secrets only as an alternate `webrtc-token` path;
- server-side OpenAI API key only;
- sideband server connection to monitor and control the same realtime session when available;
- provider function-call events bridged to Ravi host services.

For `webrtc-sdp`, the adapter MUST:

1. receive the browser SDP offer from Ravi;
2. combine it with the selected realtime session config;
3. call `/v1/realtime/calls` with the server-side OpenAI API key;
4. return the provider SDP answer to Ravi;
5. extract and persist the provider call id as redacted provenance when available.

For `webrtc-token`, the adapter MUST mint a Realtime client secret through `/v1/realtime/client_secrets`, return only the ephemeral client secret value and expiry to Ravi, and set `OpenAI-Safety-Identifier` on the server-side request when a safe actor identifier is available.

For `gpt-realtime-2`, the adapter MUST support provider config for `reasoning.effort` when present, but MUST NOT require structured outputs.

When sideband is available, `openSideband` SHOULD connect to the provider sideband endpoint for the same call/session id and use it for server-side session updates, tool monitoring, and tool-result delivery.

OpenAI native session/call ids MUST be stored as provider provenance only.

The adapter MUST normalize provider events into canonical voice events before product code observes them.

The adapter MUST classify provider failures into redacted categories such as:

- credential missing;
- credential rejected;
- quota or billing;
- rate limit;
- invalid request;
- client connection failed;
- sideband failed;
- provider disconnected;
- unknown.

## `livekit`

`livekit` is a future transport adapter, not the required MVP.

LiveKit SHOULD be chosen when Ravi needs:

- multi-client or multi-human rooms;
- SIP/telephony;
- room recording or media egress;
- LiveKit agent dispatch;
- LiveKit-managed media server features;
- cross-platform room orchestration beyond a single browser extension call.

The LiveKit adapter MUST still satisfy the same voice session lifecycle, event, tool, and persistence contract.

LiveKit room ids, participant ids, and dispatch ids MUST be provider provenance, not Ravi session identity.

## Transport Selection

Profiles select a default transport.

Session start MAY override transport only when:

- the caller has permission to do so;
- the target transport passes `check`;
- the profile allows the override or a future profile policy permits it.

`ravi voice transports list --json` MUST expose at least:

- `id`;
- `status`;
- supported connection modes;
- whether sideband is supported;
- whether browser WebRTC is supported;
- whether telephony/SIP is supported;
- whether the transport supports `gpt-realtime-2`;
- whether the transport supports reasoning effort;
- whether the transport supports server-side tool sideband;
- redacted missing configuration hints.

## Credential Handling

Transport secrets MUST come from runtime credential storage, environment variables, or provider-local secret stores already supported by Ravi.

Transport secrets MUST NOT be stored in:

- `voice_profiles`;
- `voice_sessions`;
- `voice_session_events`;
- extension storage;
- SDK request/response payloads;
- provider raw summaries.

Client-facing ephemeral credentials are not transport secrets, but they are still sensitive. They MUST be returned only through authorized `start`/`connect` calls, must be short-lived, and MUST NOT be logged or persisted.

## Acceptance Criteria

- `openai-direct` and `livekit` can share the same `ravi voice sessions start` contract.
- A transport failure becomes a canonical voice event and a redacted CLI/SDK error.
- A transport can be checked independently before starting a call.
- Transport-specific data remains behind the transport adapter or redacted provider metadata.
