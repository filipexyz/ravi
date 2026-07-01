---
id: runtime/providers/realtime-voice
mode: runbook
---

# Runbook

## Inspect Runtime Provider Fit

```bash
ravi agents show <agent-id> --json
ravi self permissions --json
ravi sessions trace <session> --since 2h --explain
```

Confirm:

- effective agent provider/model;
- runtime context key is present;
- dynamic tool allowlist is explicit;
- session trace shows canonical runtime events.

## Direct OpenAI Realtime Probe

Use the provider adapter's dry-run/preflight:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/xxx-yyyy-zzz \
  --realtime-transcribe \
  --voice-runtime openai-direct \
  --dry-run \
  --json
```

Confirm:

- API key is present without printing it;
- model selector is valid;
- public output includes a reusable `meetingProfile` when `--profile` is passed;
- public output includes a redacted `resolvedMeetingProfile.sessionConfig` when a voice runtime is active;
- private execution writes `RAVI_MEET_RESOLVED_PROFILE`;
- session can be created;
- data channel or equivalent event stream can carry tool calls/results;
- audio output can be stopped on interruption.

For live mode with tools, always pass an explicit allowlist:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/xxx-yyyy-zzz \
  --live \
  --profile default \
  --agent <registered-agent-id> \
  --tools meetings_realtime-call \
  --voice-runtime openai-direct \
  --dry-run \
  --json
```

## Pipecat Probe

Confirm the adapter can run a minimal pipeline:

```text
transport.input -> STT -> user aggregation -> LLM -> TTS -> transport.output -> assistant aggregation
```

Then validate:

- Ravi system prompt maps into Pipecat LLM context;
- Ravi dynamic tools map into Pipecat function/tool calls;
- Pipecat frames map into Ravi `RuntimeEvent`;
- worker shutdown maps to exactly one terminal event.

## LiveKit Agents Probe

Confirm:

- a LiveKit AgentSession can start with selected STT/LLM/TTS or realtime model plugin;
- the adapter can join or attach to the intended room without taking over Ravi channel ownership;
- function tools call Ravi host services;
- room/participant state is routed to the channel layer, not hidden inside runtime state.

## Incident Classification

- Audio reaches room but no runtime events: channel-to-runtime bridge failure.
- Runtime emits assistant text but no speech: runtime-to-channel speech delivery failure.
- Tool call happens outside Ravi permissions: adapter bypassed host services.
- User barge-in fails: missing or broken `turn.interrupt` control mapping.
- Session never completes: provider adapter failed terminal event guarantee.
