---
id: runtime/providers/realtime-voice
mode: why
---

# Why

Realtime voice behaves like a runtime because it executes an agent turn: it receives input, applies system prompt and model config, calls tools, emits assistant output, handles interruption, and has session state. That is the same ownership shape as Codex, Claude, and Pi.

But realtime voice is not just another text LLM. It has audio transport, turn detection, speech output, and tool calling under strict latency constraints. If implemented as meeting-provider logic, it would couple model execution to Google Meet and make it hard to use the same agent in other voice rooms or telephony.

The correct abstraction is:

- `meet` channel owns the room and media surface;
- realtime voice runtime owns the low-latency model execution;
- observers and heavy System 2 agents consume normalized events, not raw runtime protocol.

OpenAI Realtime direct is attractive for the first working adapter because it has a native speech-to-speech path and current docs describe WebRTC support for realtime models. Pipecat and LiveKit Agents are attractive as runtime wrappers because they can compose STT, LLM, TTS, VAD, transports, and tool/function calling with swappable providers.

Decision for Google Meet v0: start with `openai-direct`. It is already closest to the current `meet-record` live path, has the fewest new deployment boundaries, and proves the Ravi-side contracts first: agent prompt, explicit tool allowlist, speech output, interruption, transcript/artifact provenance, and meeting lifecycle. Pipecat should be the next adapter when we want provider-swappable STT/LLM/TTS pipelines. LiveKit should wait until we intentionally want LiveKit rooms, SIP/telephony, egress, or LiveKit agent dispatch as part of the channel/runtime design.

This spec keeps Ravi free to test all three paths without changing the `meet` channel contract.

References:

- OpenAI Realtime: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI Realtime server controls / sideband: https://developers.openai.com/api/docs/guides/realtime-server-controls
- Pipecat docs: https://docs.pipecat.ai/
- LiveKit Agents docs: https://docs.livekit.io/agents/
