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
- Append chunks stay at or under 900 characters, also when a sentence ends exactly at the limit.
- Live delegation (`engines.test.ts`): everything since the previous delegation reaches it, split at
  `offset_ms` (also inside one utterance); review repro S1-S3 at any delay; a paused request the
  model acknowledged arrives whole; speech shows once (`displayText` excludes what is on screen); a
  closed sideband starts no work. `door.test.ts`: a replaced sideband's late delegation is ignored.
- Review of #1026 (`engines.test.ts`, `door.test.ts`): "E aí" answered and "para" 60 s later delegates
  only "para", and the door cancels the running turn from the last utterance; an answered "não"
  never flips a later request; speech before a pause over `REQUEST_GAP_MS` is conversation; answered
  speech is dropped from the pending parts.
- Review of #1026 @6621657: new speech while a delegation settles never erases its request (pruning
  waits for pending delegations); words kept after the offset never reopen a closed utterance; a
  sideband replaced while the transcript is published starts no turn (`door.test.ts`).
- Daily limit per profile: `door.test.ts` shows another profile's spend neither ends a call nor
  counts against its profile, and a call ends with `limit: max_daily_cost` when its own profile
  reaches the limit; `voice.test.ts` shows `calls start` refuses only the profile that spent its day.
  Both tests fail when the check reads another profile's meter.
- `when_idle` (`door.test.ts`, "when_idle delivery"): the reply is held while the person talks and
  spoken when they stop; spoken at the ceiling when the stop never comes; spoken at once with nobody
  talking, and `speak` never waits; ending the call drops the held reply and frees the session for
  the next call. Mutants that skip the hold, keep waiters on "quiet", keep them on end, or hold for
  every delivery each fail one of them. `voice.test.ts`: `calls activity` sends the control and
  refuses a state other than speaking or quiet.
