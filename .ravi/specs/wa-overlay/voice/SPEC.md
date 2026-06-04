---
id: wa-overlay/voice
title: WhatsApp Overlay Voice
kind: capability
domain: wa-overlay
capability: voice
tags:
  - extension
  - voice
  - webrtc
  - sessions
applies_to:
  - extensions/whatsapp-overlay
owners:
  - ravi-dev
status: draft
normative: true
---

# WhatsApp Overlay Voice

## Intent

The WhatsApp overlay voice UI lets the operator talk to a selected Ravi agent/session from inside WhatsApp Web.

The overlay is the browser media client. Ravi remains the owner of voice sessions, provider credentials, sideband control, tool execution, persistence, and permissions.

## UI Contract

The first UI SHOULD be compact:

- a mic/action button near the current session/agent controls;
- call state indicator: idle, connecting, listening, speaking, thinking/tooling, failed, ended;
- mute toggle;
- interrupt button;
- end button;
- compact transcript/tool activity panel.

The UI MUST use the selected Ravi session/agent/chat from the overlay state when starting a call.

If no session is selected, the UI MUST require the user to choose or create a session before starting voice.

The UI MUST NOT start microphone capture before explicit user action.

## Backend Contract

The overlay MUST use SDK/gateway calls equivalent to:

```ts
voice.sessions.start({
  session,
  agent,
  chat,
  profile,
  client: "wa-overlay"
})
```

Then it MUST follow the returned connection mode:

- `webrtc-sdp`: create `RTCPeerConnection`, add microphone track, create SDP offer, call `voice.sessions.connect`, set the returned SDP answer, and keep connection secrets out of extension storage.
- `webrtc-token`: use the returned short-lived client secret with the provider WebRTC flow.
- `livekit-room`: join the returned LiveKit room URL with the returned short-lived token.

The overlay MUST call `voice.sessions.end` when the user ends the call or the UI tears down an active connection.

For the MVP, `webrtc-sdp` SHOULD be the preferred mode. The overlay SHOULD treat `clientSecret`, `roomToken`, and `sdpAnswer` as in-memory connection material only; it MUST NOT write them to localStorage, IndexedDB, extension storage, logs, or debug panels.

## Storage

The overlay MAY store UI preferences:

- last selected voice profile id;
- mic muted preference;
- whether the compact transcript panel is collapsed.

The overlay MUST NOT store:

- provider API keys;
- long-lived provider credentials;
- provider raw events;
- durable transcript source of truth.

## Microphone And WebRTC

The overlay MUST release all microphone tracks when a call ends or fails terminally.

The overlay SHOULD surface browser permission errors as actionable UI errors.

The overlay SHOULD keep the WebRTC/data-channel state synchronized with Ravi voice session status. If the browser connection dies, it MUST notify Ravi or allow Ravi to observe timeout and mark the voice session failed.

The overlay MUST create at most one active browser media connection for a given Ravi voice session. If the user presses start twice, the UI MUST reuse the in-flight voice session or surface the existing active call instead of creating a competing call.

## Transcript And Chat Delivery

Voice transcript displayed in the overlay is not the same as sending a WhatsApp message.

The overlay MUST NOT auto-send transcript text into WhatsApp.

A future "send summary" or "send transcript" action MUST be explicit and must use Ravi channel delivery rules.

## Error Handling

The overlay SHOULD show compact errors for:

- missing/expired Ravi context key;
- microphone permission denied;
- no selected session;
- transport not configured;
- client credential expired;
- provider connection failed;
- sideband/tool bridge unavailable.

Errors MUST avoid provider secrets and raw credentials.

Credential-expired errors SHOULD prompt a fresh `voice.sessions.start`/`connect` flow instead of retrying stale connection material.

## Acceptance Criteria

- Starting voice from the overlay creates a Ravi voice session linked to the selected Ravi session and chat.
- Ending voice releases microphone capture and marks the voice session ended.
- Interrupt stops current assistant speech when the transport supports it.
- Tool activity is visible but tools execute server-side.
- Transcript is visible in the compact panel and recoverable through Ravi, but is not auto-sent to WhatsApp.
