---
id: voice/sessions
title: Voice Sessions
kind: capability
domain: voice
capability: sessions
tags:
  - voice
  - sessions
  - realtime
  - transcripts
applies_to:
  - src/voice
  - src/voice/voice-db.ts
  - src/voice/session-service.ts
  - src/cli/commands/voice.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Voice Sessions

## Intent

`voice/sessions` defines the lifecycle and durable model for live speech conversations attached to Ravi sessions.

A voice session is a live child interaction of a Ravi session. It MUST NOT replace, rename, reset, or fork the parent Ravi session by default.

## Data Model

### `voice_profiles`

Fields:

- `id`: stable profile id.
- `name`: human label.
- `transport_id`: `openai-direct`, `livekit`, or future transport.
- `model`: provider model. For `openai-direct`, new profiles SHOULD default to `gpt-realtime-2`.
- `voice`: provider voice id.
- `language`: optional BCP-47 language hint.
- `instructions`: optional voice-specific instruction overlay.
- `reasoning_effort`: optional provider reasoning effort for models that support it. For `gpt-realtime-2`, the default SHOULD be `low` unless a profile explicitly optimizes for deeper reasoning over latency.
- `preamble_policy_json`: when the model may speak brief status updates before longer reasoning or tool flows.
- `turn_detection_json`: VAD/turn detection settings.
- `tool_policy_json`: tool allowlist, approval policy, and max parallelism.
- `provider_config_json`: provider-local non-secret settings.
- `enabled`.
- `created_at`, `updated_at`.

Secrets MUST NOT be stored in `voice_profiles`.

### `voice_sessions`

Fields:

- `id`: stable id, for example `vcs_<random>`.
- `profile_id`.
- `transport_id`.
- `session_key`.
- `session_name`.
- `agent_id`.
- `chat_id`.
- `client_kind`.
- `state`.
- `started_by_type`: `user`, `agent`, `system`, or `test`.
- `started_by_id`.
- `provider_session_id`.
- `provider_call_id`.
- `provider_connection_id`: optional provider connection id when distinct from session/call id.
- `provider_room_id`.
- `provider_metadata_json`: redacted provenance only.
- `connection_mode`: `webrtc-sdp`, `webrtc-token`, `livekit-room`, or future mode.
- `connection_expires_at`: expiry for the latest client-facing connection material.
- `expires_at`.
- `started_at`, `connected_at`, `ended_at`.
- `created_at`, `updated_at`.

Constraints:

- `session_key` MUST reference a Ravi session row when one exists.
- `agent_id` MUST match the Ravi session's owner agent unless an explicit handoff feature is introduced.
- `chat_id` MUST be canonical Ravi chat id when present.
- A voice session with state `active` MUST have exactly one active transport binding.
- By default, Ravi MUST allow at most one non-terminal voice session per `(session_key, chat_id, client_kind)` tuple. `start` MUST either return the existing voice session for an idempotent retry or fail with `VOICE_SESSION_ALREADY_ACTIVE`; it MUST NOT silently create a competing live call.
- Multiple simultaneous calls for the same parent Ravi session require an explicit future profile/session policy and distinct operator-visible call ids.
- A voice session MUST transition to `ended` or `failed`; abandoned sessions SHOULD be reaped by TTL.

### `voice_session_events`

Fields:

- `id`.
- `voice_session_id`.
- `event_type`.
- `seq`: monotonic per voice session.
- `direction`: `input`, `output`, `tool`, `system`, `provider`.
- `payload_json`: canonical redacted payload.
- `provider_event_id`.
- `provider_raw_json`: optional raw redacted payload.
- `created_at`.

Constraints:

- Events MUST be append-only.
- Product logic MUST consume `event_type` and canonical `payload_json`, not `provider_raw_json`.
- Transcript deltas MAY be compacted for display, but original event ordering MUST remain reconstructable.
- `provider_raw_json` MUST be null unless raw provider capture is explicitly enabled for debug. When present it MUST be redacted, size-limited, TTL-bound, and non-authoritative.

## Lifecycle

### Start

`start` creates a `voice_sessions` row and prepares the transport.

It MUST validate:

- Ravi session exists and is visible to the caller;
- agent exists and matches session ownership;
- chat exists or is omitted for non-chat clients;
- profile exists and is enabled;
- transport exists and is healthy enough to start.
- no conflicting non-terminal voice session exists for the same `(session_key, chat_id, client_kind)` unless the request is an idempotent retry.

It MUST return client connection instructions without exposing provider secrets.

For OpenAI Realtime 2 profiles, `start` MUST build a provider session config that includes model, voice, audio settings, reasoning effort when configured, prompt/instructions, server-side tool definitions, and turn detection settings. It MUST NOT require structured outputs for correctness because `gpt-realtime-2` does not support structured outputs.

### Connect

`connect` completes the client media connection.

For `openai-direct` with SDP mode, `connect` accepts a client SDP offer and returns a provider SDP answer.

In `webrtc-sdp` mode, Ravi MUST keep the standard OpenAI API key server-side, POST the client's SDP offer plus the provider session config to `/v1/realtime/calls`, persist the resulting provider call id as provenance, and return only the SDP answer plus redacted connection metadata to the client.

For token mode, connect MAY be unnecessary if `start` returns a short-lived client secret.

For LiveKit, connect MAY return a room URL/token at `start` time.

Client-facing connection material MUST expire quickly. For OpenAI client-secret mode, Ravi MUST treat the provider client secret as expiring after the provider `expires_at` value and SHOULD assume a one-minute TTL unless the provider returns otherwise.

### Active

During active state:

- transcript events MUST be recorded as voice events;
- provider tool requests MUST be bridged to server-side tool execution;
- tool results MUST be sent back to the provider through the transport adapter;
- interruptions MUST produce canonical events;
- sideband loss MUST transition or degrade explicitly.

When OpenAI returns a call id for a WebRTC session, Ravi SHOULD open a sideband WebSocket to that same call id for session updates, tool-call monitoring, and tool results. If sideband cannot be established, Ravi MUST record a canonical event and either fail the voice session or degrade to a mode that cannot expose server-side tools.

### End

`end` MUST close transport resources and mark the session terminal.

Ending a voice session MUST NOT delete the parent Ravi session and MUST NOT detach any chat subscriptions.

## Transcript Semantics

Voice transcripts are conversation evidence, not chat delivery.

Transcript events MAY be shown in:

- `ravi voice sessions transcript`;
- overlay call panel;
- session debug/timeline views;
- future summaries.

Transcript events MUST NOT be sent as WhatsApp/Omni messages unless the user or agent takes an explicit send/summarize action governed by channel delivery policy.

## Tool Semantics

Tools exposed to a voice session MUST be generated from a voice profile policy and the active Ravi session/agent permissions.

Tool definitions sent to the provider MUST be the minimal allowlist needed for the current voice session.

Tool policy MUST define max parallelism. When the provider requests more tools than the policy allows, Ravi MUST queue, reject, or fail the excess request deterministically and record the decision as a canonical voice event.

When the provider requests a tool:

1. record `voice.tool.requested`;
2. authorize the tool through Ravi policy;
3. record `voice.tool.started`;
4. execute server-side;
5. record `voice.tool.completed` with success/failure;
6. send a provider-compatible tool result through the transport.

Voice MUST NOT allow the browser client to fabricate tool results.

If a voice session is interrupted or terminal before a tool result is sent, Ravi MUST NOT send stale tool output to the provider. It MUST record whether the local tool was cancelled, completed-but-dropped, or failed.

Tool event payloads MUST be redacted. Full tool input/output MUST NOT be stored in `payload_json`, `provider_raw_json`, logs, traces, or extension storage unless a separate explicit safe capture policy exists.

## Prompt And Context Semantics

Voice profile prompts SHOULD be generated for Realtime 2 as short structured sections, not long paragraphs.

At minimum, the composed prompt SHOULD separate:

- role/objective;
- speaking style, language, and unclear-audio handling;
- tool-use rules and write-action confirmation boundaries;
- preamble/status-update policy;
- current session state;
- background context.

When injecting prior Ravi session history into a voice session, Ravi MUST NOT dump raw unbounded transcripts. It SHOULD provide a compact current-state summary plus relevant recent turns, with clear source priority between current user speech, current chat/session state, and older background notes.

## Acceptance Criteria

- A voice call can be started for an existing Ravi session without changing the Ravi session key/name.
- A voice call can be inspected after it ends.
- A transcript can be recovered with ordered input and output text.
- Tools are auditable as voice events.
- Provider ids are present only as redacted provenance.
