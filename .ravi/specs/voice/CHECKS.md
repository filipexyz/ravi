---
id: voice
title: Voice Checks
kind: domain
domain: voice
tags:
  - voice
owners:
  - ravi-dev
status: active
normative: false
---

# Checks

- `bun test src/voice` covers the store, speech extraction and sanitizer, engines (mock, push with
  stubbed STT/TTS, live session creation and sideband handling with a fake socket, LiveKit token),
  the door (utterance → prompt, turn completion, approvals, cancel, limits) and authority.
- `bun test src/cli/commands/voice.test.ts` covers the command contract: agent turns refused,
  write brake on `approve`, digest mismatch refused, device scope.
- The SDK and OpenAPI drift checks in `bun run test` cover the generated `voice` surface.
- A voice prompt never carries `source`, always carries `deliveryBarrier: "after_response"`,
  `_cliDestination: true` and `_approvalSource.channel === "voice"`.
- The live sideband handler never emits `session.input_audio.append` or `session.output_audio.delta`
  payloads to NATS or the event store.
