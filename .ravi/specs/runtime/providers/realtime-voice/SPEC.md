---
id: runtime/providers/realtime-voice
title: Realtime Voice Runtime Providers
kind: feature
domain: runtime
capability: providers
feature: realtime-voice
tags:
  - runtime
  - providers
  - voice
  - realtime
  - openai
  - pipecat
  - livekit
  - meetings
applies_to:
  - src/runtime/
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/meetings/
  - src/channels/meetings/
owners:
  - ravi-dev
status: draft
normative: true
---

# Realtime Voice Runtime Providers

## Intent

A realtime voice runtime provider lets a Ravi agent run a low-latency voice/text conversation while preserving Ravi's normal session, permission, tool, trace, and response contract.

The primary initial use case is `channel=meet`, where the agent participates in a meeting room by listening to speech/text and speaking back. The runtime provider executes the agent. The meeting channel owns room lifecycle and media delivery.

## Product Contract

- Realtime voice execution MUST be modeled as a Ravi `RuntimeProvider` when it owns model turn execution.
- The provider MUST implement the canonical runtime provider contract: `RuntimeStartRequest` in, `RuntimeEvent` out, capabilities explicit.
- The provider MUST NOT own meeting lifecycle, channel routing, observer binding, artifacts, or task state.
- Voice input MUST be accepted through a normalized provider adapter. It MUST NOT require generic Ravi prompt publishing code to understand provider-specific audio frames.
- Text input MUST remain supported because voice sessions can receive chat messages, guidance updates, tool results, and orchestrator instructions.
- Dynamic tools MUST be surfaced through Ravi host services and explicit allowlists.
- The provider MUST emit canonical runtime events. Provider-native events MAY be emitted as `provider.raw` only for diagnostics.

## Candidate Provider Families

### OpenAI Realtime Direct

An OpenAI Realtime adapter connects Ravi directly to OpenAI's realtime model APIs.

Expected strengths:

- lowest adapter complexity for OpenAI-native realtime models;
- direct speech-to-speech path;
- function/tool calling can map to Ravi dynamic tools;
- WebRTC is the preferred browser/mobile realtime transport in current OpenAI docs.

Expected constraints:

- tightly coupled to OpenAI Realtime protocol and model capabilities;
- less room to swap STT/TTS/LLM independently;
- provider API changes affect the adapter directly;
- audio transport and session control must be normalized carefully.

The adapter MAY use WebRTC, WebSocket, or a server-side bridge, but MUST expose the same Ravi `RuntimeEvent` contract.

For Google Meet v0, `ravi meetings join --profile <id>` MUST resolve a Ravi-owned meeting profile before invoking the meeting provider. The resolved meeting profile is the boundary between reusable operator configuration, Ravi session state, and the provider worker:

- profile kind: `ravi.meetings.openai_direct_resolved_profile` while the selected voice runtime is `openai-direct`;
- reusable profile id and source when `--profile` is used;
- meeting provider: `google-meet`;
- Chrome/browser profile settings such as `chrome.profileDir`;
- voice runtime id: `openai-direct`;
- default model: `gpt-realtime-2`;
- default transcription model: `gpt-realtime-whisper`;
- default transport: `webrtc`;
- default reasoning effort: `low`;
- agent/session/context identifiers when available;
- redacted public session config for artifacts and diagnostics;
- private session config with instructions for provider workers only;
- explicit Ravi realtime tool manifest path and tool count when tools are enabled.

The CLI MUST preflight `OPENAI_API_KEY` without printing the key. For non-dry-run execution, a missing key MUST fail before launching the provider worker. Dry-run MAY report the missing key as preflight output without joining a meeting.

The provider worker SHOULD read `RAVI_MEET_RESOLVED_PROFILE` when present and use that resolved profile as the authoritative session contract. Inline legacy flags MAY remain for compatibility while the provider is migrated.

### Pipecat Adapter

Pipecat is a framework for realtime voice and multimodal agents. Its architecture is pipeline-oriented: transport input, STT, user context aggregation, LLM, TTS, transport output, and assistant aggregation.

Expected strengths:

- provider-agnostic composition of STT, LLM, TTS, VAD, transports, and processors;
- good fit when Ravi wants to swap models or services without changing the channel;
- can wrap complex voice pipelines behind one runtime provider;
- useful for experiments beyond OpenAI-native realtime.

Expected constraints:

- likely runs as an external service or subprocess bridge from Ravi;
- Ravi must normalize Pipecat frames and worker lifecycle into canonical runtime events;
- tool calls must route back through Ravi host services;
- duplicate context aggregation must not become a second source of truth for Ravi session state.

### LiveKit Agents Adapter

LiveKit Agents is a framework for realtime voice/video agents that join LiveKit rooms and can use STT, LLM, TTS, realtime models, turn detection, VAD, and function tools through plugins.

Expected strengths:

- strong room/participant/media model;
- production-oriented voice/video/telephony agent framework;
- can use pipeline mode with separate STT/LLM/TTS or realtime model plugins;
- useful if Ravi wants LiveKit rooms or telephony as meeting/channel providers.

Expected constraints:

- LiveKit has its own room/job/session abstractions that must not replace Ravi session ownership;
- if LiveKit also owns room transport, Ravi must decide whether LiveKit is a channel provider, runtime provider, or both for a given deployment;
- function tools must call Ravi host services with Ravi permissions;
- agent state and room state must be mapped back to Ravi traces and artifacts.

## Runtime Provider Shape

For the current Google Meet v0, the first runnable voice runtime SHOULD be `openai-direct` using OpenAI Realtime. Pipecat and LiveKit SHOULD remain explicit planned adapters until Ravi has a real adapter that maps their lifecycle, tool calls, interruption, events, and provenance back into the same meeting/voice contract.

Meeting live mode MUST expose the selected voice runtime in command output, artifact metadata, and diagnostics. It MUST NOT silently run a planned adapter through the OpenAI path.

The initial provider id SHOULD be generic enough to avoid locking to one vendor:

```text
provider: realtime-voice
model: openai/gpt-realtime-2
model: pipecat/openai-gpt-realtime-2
model: pipecat/deepgram-openai-cartesia
model: livekit/openai-gpt-realtime-2
model: livekit/deepgram-openai-cartesia
```

Provider-specific adapters MAY be separate provider ids during experimentation:

```text
provider: openai-realtime
provider: pipecat
provider: livekit-agents
```

If multiple provider ids are used, they MUST still implement the same voice runtime capability shape.

## Capability Requirements

Realtime voice providers SHOULD advertise:

```ts
RuntimeCapabilities = {
  execution: { mode: "external-service" | "subprocess-rpc" | "embedded" };
  dynamicTools: { mode: "host" };
  tools: {
    permissionMode: "ravi-host";
    accessRequirement: "tool_surface";
    supportsParallelCalls: false | true;
  };
  systemPrompt: { mode: "append" | "override" | "provider-composed" };
  terminalEvents: { guarantee: "adapter" | "provider" };
  usage: { semantics: "streaming" | "terminal-event" | "unavailable" };
  sessionState: { mode: "external-store" | "provider-session-id" | "none" };
  runtimeControl: {
    supported: true;
    operations: ["turn.interrupt", "turn.steer", "turn.follow_up", "model.set"?];
  };
}
```

The provider SHOULD set `supportsPartialText=true` when it can emit text deltas or transcript deltas. Audio output itself MUST NOT be represented only as text deltas; speech lifecycle needs dedicated metadata in canonical or provider raw events until Ravi adds explicit audio runtime events.

## Canonical Event Mapping

The adapter MUST map native events into Ravi events:

- session connected -> `thread.started`
- user speech turn accepted -> `turn.started` or `item.started`
- assistant partial text -> `text.delta`
- assistant final transcript/text -> `assistant.message`
- tool/function call start -> `tool.started`
- tool/function result accepted -> `tool.completed` and `tool.result_delivered`
- interruption/barge-in -> `turn.interrupted`
- fatal provider/session error -> `turn.failed`
- clean turn/session completion -> `turn.complete`

Voice-specific native events MAY be exposed as `provider.raw` with redacted payloads:

- input audio level/VAD;
- speech started/stopped;
- output audio started/stopped;
- transcript deltas;
- transport connected/disconnected;
- room participant state when the runtime owns a room.

Product logic MUST depend on normalized meeting/channel events for room state, not on runtime `provider.raw`.

## Input Model

Realtime voice providers need more than a one-shot text prompt.

The provider MUST support:

- initial system prompt from Ravi's normal prompt builder;
- initial user/context prompt when the session starts;
- live text input;
- live audio input or a bridge to channel-owned audio input;
- tool result input;
- non-interruptive guidance/context input when supported by the adapter.

The existing `RuntimeStartRequest.prompt` generator can carry text prompts. Audio frames and meeting media SHOULD be bridged through provider-local input APIs or runtime `control` operations, not by serializing raw audio into prompt text.

## Control Semantics

Realtime voice providers SHOULD implement:

- `turn.interrupt`: stop current model speech and active generation when a user barges in.
- `turn.steer`: inject short guidance into the active realtime session without forcing a full restart.
- `turn.follow_up`: enqueue a follow-up after the current utterance/turn.
- `model.set`: optional live model/voice pipeline switch when supported.

If a provider cannot safely steer the active session, Ravi MUST fall back to queue/interruption behavior.

## Channel Integration

For `channel=meet`, the channel and runtime connect like this:

```text
meet channel provider
  -> audio/text/meeting events
  -> realtime voice runtime provider
  -> canonical RuntimeEvent stream
  -> gateway / meeting delivery
  -> meet channel provider
```

The meeting channel remains the owner of:

- room join/leave;
- participant identity;
- provider text chat;
- media refs;
- artifact generation;
- meeting events and observer source metadata.

The runtime provider remains the owner of:

- model session;
- turn detection when provider-local;
- tool calls;
- model speech/text generation;
- interruption semantics exposed through runtime control.

## Open Questions

- Should Ravi expose explicit canonical audio runtime events, or keep audio lifecycle in provider metadata plus meeting channel events for v0?
- Should `realtime-voice` be one generic provider with adapter-specific model selectors, or separate provider ids for `openai-realtime`, `pipecat`, and `livekit-agents`?
- Which side owns VAD/turn detection when both meeting provider and runtime provider can observe audio?
- How should non-interruptive context append be represented for long-running System 2 coordination?
- Can LiveKit be both a meeting channel provider and a voice runtime provider in the same deployment without duplicating room ownership?

## Acceptance Criteria

- A realtime voice provider can be registered in `src/runtime/provider-registry.ts` without provider-specific branches in launcher, request builder, gateway, or observers.
- It declares explicit capabilities for dynamic tools, runtime control, session state, usage, terminal events, and tool permission mode.
- It emits canonical runtime events for text, tool calls, interruptions, failures, and completion.
- It can receive meeting audio/text through a normalized adapter path.
- It can emit speech/text output without owning channel delivery directly.
- It can call Ravi dynamic tools only through host services and explicit allowlists.
- It can be selected by a registered Ravi agent through normal provider/model config.
- It can be observed and traced using existing runtime/session trace surfaces.

## Non-Goals

- Making OpenAI Realtime the only possible voice runtime.
- Letting Pipecat or LiveKit replace Ravi sessions, permissions, tasks, or artifacts.
- Encoding provider-specific audio frame schemas into generic Ravi prompt messages.
- Treating room transport and model execution as the same layer in every deployment.
