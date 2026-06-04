---
id: voice
title: Voice Runbook
kind: domain
domain: voice
tags:
  - voice
  - runbook
owners:
  - ravi-dev
status: draft
normative: false
---

# Voice Runbook

## Start A Browser Voice Session

Expected operator flow:

```bash
ravi voice profiles list --json
ravi voice sessions start --session <session> --profile <profile-id> --client wa-overlay --json
```

The `start` result should include the next client action:

- `webrtc-sdp`: client creates an SDP offer and calls `ravi voice sessions connect`; connect returns the SDP answer.
- `webrtc-token`: client receives a short-lived provider client secret and connects directly.
- `livekit-room`: client receives a LiveKit room URL and short-lived room token.

For the OpenAI Realtime 2 MVP, `webrtc-sdp` is the preferred path. Ravi keeps the OpenAI API key server-side, posts SDP plus session config to `/v1/realtime/calls`, and stores only redacted provider ids as provenance.

```bash
ravi voice sessions connect <voice-session-id> --sdp-offer-file - --json
```

## Inspect State

```bash
ravi voice sessions status <voice-session-id> --json
ravi voice sessions events <voice-session-id> --limit 100 --json
ravi voice sessions transcript <voice-session-id> --json
```

## Interrupt

Use when the assistant is speaking or executing a voice turn that should stop:

```bash
ravi voice sessions interrupt <voice-session-id>
```

Expected behavior:

- client audio playback stops or is cancelled;
- provider response is cancelled/interrupted if supported;
- `voice.interrupt.requested` and terminal interrupt event are recorded;
- the underlying Ravi session remains valid.

## End

```bash
ravi voice sessions end <voice-session-id>
```

Expected behavior:

- sideband connection is closed;
- provider session is ended when the transport supports it;
- client credentials stop working;
- final transcript/tool events are flushed;
- state becomes `ended` or `failed`.

## Common Failures

### Client Cannot Connect

Check:

- context key is valid for the active gateway;
- browser has microphone permission;
- provider credentials are configured server-side;
- short-lived credential has not expired;
- transport `check` passes.
- duplicate start did not return an existing active voice session.

Commands:

```bash
ravi voice transports check openai-direct --json
ravi voice sessions status <voice-session-id> --json
```

### Tool Call Hangs

Check:

- sideband connection is active;
- OpenAI sideband is bound to the same provider call id as the browser WebRTC session;
- tool was registered in the voice profile policy;
- Ravi host services authorized the tool;
- a `voice.tool.completed` or failed event exists.
- the voice session was not interrupted/ended before the tool result was sent.

### Transcript Exists But No Chat Message

This is expected by default. Voice transcript persistence does not imply outbound channel delivery.

If a future feature sends a summary or transcript to a chat, it must be explicit UI/CLI action and use normal channel delivery rules.
