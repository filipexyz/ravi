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
  `_cliDestination: true`, `_correlationId` (the turn id) and `_approvalSource.channel === "voice"`.
- `src/voice/door.test.ts` ends a turn queued behind two others on a provider without
  `turn.started`, never aborts another turn for a queued cancel, and frees a pending turn when its
  call ends; `src/runtime/session-trace.test.ts` ("queues a second sessions.send…") checks that each
  terminal carries only its own turn's `_correlationIds`.
- The live sideband handler never emits `session.input_audio.append` or `session.output_audio.delta`
  payloads to NATS or the event store.
- `src/voice/engines/engines.test.ts` (live sideband): appends carry `content`, never `text`; the
  provider `error` is read from `error.{code,type,message,param}`; two utterances split by a pause
  both reach the delegation, in order; speech the model already answered is not resent; a barge-in
  over a reply stays one request (with and without timestamps); `drain` publishes pending speech once.
- `src/voice/door.test.ts`: live gets sanitized context (no secret-looking tokens, paths or links
  from the screen text); ending a live call drains pending speech while the call is still `active`.
- Live delegation order (`engines.test.ts`): the model talking before it delegates does not lose the
  request; speech after the delegation's `offset_ms` stays for the next request; answered speech is
  shown as conversation only after the window; append chunks stay at or under 900 characters (also
  when a sentence ends exactly at the limit); a window ending while a delegation settles does not
  erase its request; each reply's window shows only what that reply answered; the offset splits an
  utterance without a pause.
