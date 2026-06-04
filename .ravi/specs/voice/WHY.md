---
id: voice
title: Voice Why
kind: domain
domain: voice
tags:
  - voice
  - architecture
owners:
  - ravi-dev
status: draft
normative: false
---

# Voice Why

## Decision

Ravi should introduce `voice` as a domain-level abstraction for live speech conversations and implement the first extension flow with direct OpenAI Realtime WebRTC plus a Ravi sideband connection.

## Why Not `audio`

`audio` already means file-oriented TTS generation. Live voice has different lifecycle, credentials, media transport, interruption, transcript, tool, and session semantics.

Mixing live calls into `audio` would make the CLI ambiguous:

- `ravi audio generate` produces an audio file.
- `ravi voice sessions start` starts a live conversation.

## Why Not `realtime`

`realtime` is a provider/API capability name, not a Ravi product concept.

If the CLI is named after OpenAI Realtime, LiveKit, SIP, or another provider, the operator-facing contract will churn when the transport changes. `voice` stays stable while transports change underneath.

## Why Direct OpenAI First

For the WhatsApp overlay MVP, the browser is already the UI surface with microphone access. OpenAI recommends WebRTC for browser/mobile realtime clients, and the server-side sideband pattern keeps Ravi's business logic and tool execution on the server.

Direct OpenAI first minimizes moving parts:

- no LiveKit room lifecycle yet;
- no LiveKit agent worker deployment yet;
- no extra dispatch service before we prove UX;
- lower conceptual distance between extension button and active call.

The default model should be `gpt-realtime-2` for this path because it is the current reasoning voice model for stronger instruction following, tool use, and long-session state. The profile still owns the model field so Ravi can choose a faster/lower-cost realtime model later without renaming the `voice` domain.

## Why Prefer SDP / Unified WebRTC First

OpenAI supports both unified WebRTC session creation through `/v1/realtime/calls` and browser client secrets through `/v1/realtime/client_secrets`.

Ravi should prefer SDP/unified WebRTC for the MVP because:

- standard OpenAI API keys stay only on the Ravi server;
- the browser receives only an SDP answer, not a reusable provider token;
- Ravi can bind provider call id provenance immediately;
- the sideband connection can target the same provider call/session;
- it matches the overlay flow: browser creates offer, Ravi negotiates, browser sets answer.

Client-secret mode remains useful as an alternate transport mode, but its one-minute token lifetime makes stale/retry handling part of the product contract.

## Why Keep LiveKit As Adapter

LiveKit is still a good future adapter when Ravi needs:

- multi-participant rooms;
- SIP/telephony;
- recording and media egress;
- agent room dispatch;
- advanced media routing or noise-cancellation infrastructure;
- native mobile or multi-client room orchestration.

The `VoiceTransport` boundary exists so LiveKit can be added without changing `ravi voice` or the extension UX.

## Why Sideband

The realtime model may need tools, context updates, interruptions, and transcript persistence. Those must remain Ravi-owned.

Sideband lets:

- audio flow directly between browser and provider for low latency;
- OpenAI API keys remain server-side;
- Ravi observe and update the session;
- tool calls execute through Ravi host services;
- permissions, traces, and audit stay consistent with other runtime work.

## Alternatives Rejected

- Extension calls OpenAI directly with a long-lived API key: rejected because it leaks provider credentials into browser storage.
- Extension executes tools directly: rejected because it bypasses Ravi permissions and audit.
- Treat every voice utterance as a normal `ravi sessions send`: rejected because speech-to-speech needs continuous low-latency interruption and audio playback, not only text turns.
- Start with LiveKit for all voice: deferred because it adds room/agent deployment overhead before the extension voice UX is proven.
