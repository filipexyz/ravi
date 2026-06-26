---
id: channels/meetings/native-channel
mode: why
---

# Why

The existing meetings implementation proved the end-to-end product value: Ravi can enter Google Meet, capture a raw artifact, and hand it back to the origin session. The next step is to stop treating this as a CLI-only recorder run and model it as a native Ravi channel.

This is necessary because live meetings are not just artifacts. They are active conversation surfaces:

- humans speak to the agent;
- humans can send text chat;
- the agent speaks back;
- the agent should eventually send text chat;
- observers should watch the session;
- triggers and tasks should react to meeting events;
- post-call artifacts must be linked to the same source lifecycle.

The native channel pattern is a better fit than SDK stream channels. SDK streams expose server-sent event subscriptions to clients; they are not product lifecycles. The `src/channels/slack` implementation is the closer precedent because it normalizes inbound events, binds sessions, persists channel state, and supports native outbound delivery.

`google-meet` remains a provider, not the channel. This keeps the system open to Zoom, Teams, LiveKit rooms, browser-only providers, or future native integrations without rewriting observers, artifacts, permissions, or runtime behavior.

The channel/runtime split also prevents a common coupling error: the realtime voice model should not own meeting lifecycle. A runtime provider can speak and think, but the `meet` channel owns the room, participants, media, text chat, lifecycle, and artifact provenance.

References consulted for runtime comparison:

- OpenAI Realtime WebRTC docs: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Pipecat docs: https://github.com/pipecat-ai/docs
- LiveKit Agents docs: https://github.com/livekit/agents
