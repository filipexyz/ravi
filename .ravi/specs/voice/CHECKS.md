---
id: voice
title: Voice Checks
kind: domain
domain: voice
tags:
  - voice
  - checks
owners:
  - ravi-dev
status: draft
normative: false
---

# Voice Checks

## Design Checks

- `ravi voice` exists as the operator/agent-facing domain; provider names are transport options, not top-level CLI groups.
- `ravi audio` remains file/TTS oriented.
- A voice session references a canonical Ravi `session_key`.
- A voice session references canonical `chat_id` when started from a chat surface.
- Provider-native ids are stored as provenance only.
- Voice start/connect responses do not expose OpenAI API keys, LiveKit API secrets, or long-lived credentials.
- `openai-direct` profiles default to `gpt-realtime-2` unless explicitly overridden.
- `gpt-realtime-2` profiles do not require structured outputs for correctness.
- Realtime 2 reasoning effort is represented in profile/session config and defaults conservatively for latency.
- Tool execution remains server-side.
- Voice transcript persistence does not automatically send outbound chat messages.
- Raw provider event capture is disabled by default or explicitly debug-only, redacted, size-limited, and TTL-bound.

## CLI Checks

- Every machine-consumed command supports `--json`.
- List/history commands are paginated.
- Human output includes next useful commands.
- `start --json` includes `voiceSession`, `connection`, and `hints`.
- `start --json` for `webrtc-sdp` does not include provider credentials and tells the client to call `connect` with an SDP offer.
- `connect --json` for `webrtc-sdp` returns an SDP answer and redacted provider provenance without provider API keys.
- `events --follow` is marked CLI-only or implemented through a dedicated streaming transport, not exposed as a fake single-shot SDK call.
- SDK/gateway logs and traces redact `clientSecret`, `roomToken`, and `sdpAnswer`.

## Runtime Checks

- Voice tool calls flow through Ravi host services or equivalent permission checks.
- Sideband disconnects result in explicit voice session state transition.
- OpenAI sideband binds to the same provider call id created during WebRTC connection.
- Interrupt records both requested and terminal state when provider confirms or adapter enforces interruption.
- Stale tool results after interrupt/end are dropped and recorded instead of being sent to the provider.
- Provider raw events are not consumed as product source of truth.
- A second `start` for the same `(session_key, chat_id, client_kind)` is idempotent or returns `VOICE_SESSION_ALREADY_ACTIVE`, not a duplicate call.

## Extension Checks

- The overlay requests microphone permission only when the user starts a call.
- The overlay stores no provider API key.
- The overlay uses the active Ravi gateway/context-key model from `wa-overlay/auth`.
- The overlay exposes compact call states: idle, connecting, listening, speaking, thinking/tooling, failed, ended.
- Ending a call releases microphone tracks.
- The overlay never stores `clientSecret`, `roomToken`, or `sdpAnswer` in browser storage.
