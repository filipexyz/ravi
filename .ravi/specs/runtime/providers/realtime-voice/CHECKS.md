---
id: runtime/providers/realtime-voice
mode: checks
---

# Checks

## Static Checks

- New voice runtime providers are registered through `provider-registry`, not hardcoded into launcher/request-builder/gateway.
- Provider capabilities explicitly declare runtime control, dynamic tools, execution mode, session state, terminal events, usage, and tool permission mode.
- Dynamic tools route through Ravi host services.
- Tool allowlists reject `all` and `*` when sourced from meeting live mode.
- Provider raw events are redacted and not consumed by product logic.
- Meeting/channel code owns room lifecycle and artifacts; runtime code owns model execution only.
- Google Meet live mode defaults to `openai-direct` and exposes that runtime in command output and artifact metadata.
- Planned adapters such as `pipecat` and `livekit` are rejected for live execution until their adapters are actually wired.
- `join --profile <id>` resolves a provider-agnostic meeting profile that includes Chrome profile settings and selected `voice.runtime`.
- `openai-direct` execution emits a redacted public `resolvedMeetingProfile` and a private provider profile with `gpt-realtime-2`, `gpt-realtime-whisper`, `webrtc`, and explicit tool metadata.
- `openai-direct` preflight fails non-dry-run execution when `OPENAI_API_KEY` is missing and never prints the key value.

## Test Targets

```bash
bun test src/runtime/provider-contract.test.ts
bun test src/runtime/*provider.test.ts
bun test src/runtime/session-trace.test.ts
bun test src/meetings/openai-direct.test.ts src/meetings/voice-runtime.test.ts src/cli/commands/meetings.test.ts
bun run typecheck
```

## Manual Acceptance

- Start a `meet` live session with a realtime voice provider.
- Speak into the meeting and observe a committed voice turn.
- Confirm runtime emits canonical events.
- Trigger one allowed dynamic tool and one denied tool.
- Interrupt assistant speech and confirm `turn.interrupted`.
- End the meeting and confirm artifact includes inbound speech, outbound speech, text chat when available, media refs, and diagnostics.
