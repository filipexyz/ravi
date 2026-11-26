---
id: voice
title: Voice
kind: domain
domain: voice
tags:
  - voice
  - sessions
  - realtime
applies_to:
  - src/voice
  - src/cli/commands/voice.ts
  - src/sdk/gateway/streaming/channels.ts
  - packages/ravi-os-voice
  - packages/ravi-voice-worker
owners:
  - ravi-dev
status: active
normative: true
---

# Voice

## Intent

The `voice` domain gives every Ravi session a **voice door**: an app built on the SDK opens a call
on an existing session, speaks, and hears the answer. The session (Claude Code, Codex, Pi or Grok
runtime) is the one that thinks the work and the only actor. The door turns speech into session
turns in the caller's name, keeps the person company while the session works, and speaks a short
form of the result.

Voice is a Ravi domain, not a vendor. OpenAI GPT-Live, LiveKit, ElevenLabs and Whisper are engines
behind one contract. Users see only Ravi.

This spec supersedes the earlier draft in which a realtime model was the brain and transcripts never
entered the session, and the feature spec `runtime/providers/realtime-voice` (archived).

## Three rules

1. **Acknowledge fast, delegate the work.** A voice turn becomes an ordinary session prompt. The
   session is never the inline LLM of a media pipeline.
2. **Interrupting speech never cancels work.** Cancel is explicit (`calls cancel-turn`).
3. **Every result has a delivery class.** `speak` (now), `when_idle` (after the person stops
   talking), `silent` (screen and context only).

## Modes and engines

| Mode | Engine | Ears and mouth | Connection |
|---|---|---|---|
| `push` | `push` | batch STT (Groq `whisper-large-v3-turbo`, else OpenAI `whisper-1`) + ElevenLabs TTS | none; clips through `calls push` |
| `live` | `live` | OpenAI GPT-Live with `delegation: client` | app to OpenAI WebRTC; the daemon owns the sideband |
| `handsfree` | `handsfree` | streaming STT + fast model + streaming TTS in a LiveKit room | app joins the room; `packages/ravi-voice-worker` serves it |
| any | `mock` | text in, text out, no vendor | none; for apps and CI |

- Every engine MUST declare `capabilities` (`bargeIn`, `streamingAudio`, `exactSpeech`,
  `serverAudio`, `needs`) and a `check` that reports missing configuration without calling the vendor.
- The default mode is `push`. A profile MAY choose another.
- The `live` engine MUST use its own key (`RAVI_VOICE_OPENAI_API_KEY`), never `OPENAI_API_KEY`, which
  Codex inherits. It MUST create sessions with `store: false` and lock the browser data channel with
  `allowed_client_events: []`. The sideband receives copies of both audio directions; the daemon MUST
  discard them, never log them and never publish them on NATS.
- In `live`, the voice model may converse and may be wrong. Anything about the workspace or the work
  MUST be delegated to the session; the session's answers reach the voice model only through
  `session.commentary.append` (speak) or `session.thinking.append` (silent). Appends carry their text
  in `content` (an append with any other field is rejected, and the voice model then never hears the
  result). Provider `error` events nest their details under `error`; the door MUST publish the
  provider's `code` and `message`, never a generic text.
- GPT-Live transcripts stream as deltas with no done event. A pause longer than 1.2 s between user
  deltas, or the voice model starting to answer, ends an utterance. A delegation takes the last
  utterance said before its `offset_ms`, plus the utterances right before it that belong to it: no
  model reply started in between and the pause was at most 15 s (`REQUEST_GAP_MS`). Speech the model
  already answered, or older than that, was conversation: it is shown once and never sent. Words
  after the offset wait for the next delegation. No wall clock decides any of this; only the
  provider's timeline and reply starts do. Spoken cancel and deny are read from the last utterance,
  not from the whole request. Speech is shown on screen once; `turn.accepted` carries the full
  request text so a turn can be matched to what was said. A sideband that was closed or replaced, or
  a call that is ending, starts no work: a request said in the instant before hanging up is shown on
  screen and does not become a turn.
- Appends are capped at 500 tokens; the sideband splits text into chunks of at most 900 characters.
  This is an estimate for Portuguese text (about 2 characters per token): text dense in symbols,
  long links or base64 can pass the cap, and the provider then answers with a `VOICE_LIVE_ERROR`.
- Open point (unverified): the docs show an empty `session.thinking.append` cancelling the automatic
  acknowledgement, but do not state that `content: ""` is accepted. If the first delegation of a
  call produces a `VOICE_LIVE_ERROR`, this is the place to look.
- GPT-Live usage reports billable seconds only. In `live`, `audioInSeconds`, `audioOutSeconds` and
  `charactersSpoken` stay 0 by design; cost comes from `engineSeconds`.
- The `handsfree` worker is a stateless media worker. It has no database access, joins rooms with a
  token the daemon mints, and talks to the daemon only through the gateway with the call's device
  credential.

## The door

- The door lives in the **daemon** (`VoiceDoorService`, `src/voice/door.ts`), not in `ravi-channels`.
- A voice utterance becomes `publishSessionPrompt(session, …)` with:
  - `deliveryBarrier: "after_response"` (a voice utterance never steers running work);
  - `_cliDestination: true` and no `source`, so it never writes the session's `last_channel` or
    `last_to`, and the reply is read from the transcript, not delivered to a chat;
  - `_approvalSource: { channel: "voice", accountId: "voice", chatId: <callId> }`, so approvals for
    the turn come back to the call;
  - a `session-relay` turn origin built from the caller's context.
- The prompt carries a voice surface line asking the session to open its reply with one spoken line
  (`🔊 …`, 1-3 sentences, no markdown). The door speaks that line; when it is missing, it speaks the
  first sentences of the reply with markdown removed. The full text goes to the screen.
- The public sanitizer runs before any speech: no code blocks, URLs, paths, secrets or raw tool
  output reach the voice.
- One active call per (session, speaker). One utterance in flight per call; later utterances queue
  in the door in order. Across calls on the same session, one voice turn runs at a time, so each
  call reads only its own reply.
- A voice turn MUST find its own terminal by identity, never by event order (Claude emits no
  `turn.started`; isolated prompts ahead run as separate turns; compaction keeps a turn in flight).
  Its prompt carries `_correlationId: <turnId>`; the host stamps every runtime event of a physical
  turn with `_correlationIds`, the ids of the prompts that turn consumed. The terminal carrying this
  turn's id is its own; every other terminal is another turn's. A cancel aborts only after an event
  of this turn's own physical turn, never on another turn's event.
- Ending a call releases its pending turn as `cancelled` at once (the session turn keeps its reply),
  so it never holds the next voice turn of the session. A voice turn that outlives 10 min fails with
  `VOICE_TURN_TIMEOUT`.
- Long turns: one acknowledgement, progress only from real session events (`work.state`,
  `work.tool`), completion announced by event.
- A daemon restart ends `live` calls (the sideband cannot reconnect); `push` and `mock` calls survive
  because every state change is stored.

## Authority

- Starting, connecting, approving and denying MUST refuse agent turn contexts (every command is also a
  session tool): exit 3 with `VOICE_AGENT_TURN_REFUSED`.
- The caller needs the same authority as `sessions send` on the target session: the local operator,
  or a context that can access the session. A paired **device credential** (`voice devices pair`) is
  a person-bound context key (`kind: voice-device`) limited to `voice` commands and the sessions
  listed at pairing. Device keys last 30 days; `voice devices revoke` marks the device revoked first, then revokes the key and ends the
  device's calls; the door's sweep finishes both from the device record if the command stops.
- The speaker is recorded on every utterance (`speaker.kind`: `operator` | `device` | `guest`;
  `speaker.contactId`). The speaker never adds authority: the session turn runs with the caller's
  authority, exactly as `sessions send`.
- **Third-party speakers (guests).** A guest is someone in the call who is not the paired person
  (a callee on a phone call, a meeting participant). Guests MUST be opted in on the profile
  (`allowGuests`). A guest utterance is marked as such in the prompt, can never approve, deny,
  cancel or end, and is dropped when the profile does not allow guests.
- **Approvals are tap only in v1.** A spoken "yes" never approves. A spoken deny or cancel is
  allowed. `calls approve` MUST carry the approval's `--version` and `--digest` and `--execute`; it
  is accepted only from the paired person (operator or device), and is checked again by the approval
  grantor gate (`channel: voice`, sender = the device id or `operator`).

## Surface

```
ravi voice targets list
ravi voice calls start <session> [--profile <id>] [--mode push|live|handsfree|mock] [--offer <sdp>]
ravi voice calls connect <call> [--offer <sdp>]
ravi voice calls list | show <call> | transcript <call> | events <call> [--after <seq>]
ravi voice calls push <call> --audio <file> | --audio-data <base64> [--mime <type>]
ravi voice calls audio <call> <item>
ravi voice calls send <call> <text>
ravi voice calls silence <call>
ravi voice calls cancel-turn <call> --turn <id>
ravi voice calls approve <call> <approval> --version <n> --digest <d> --execute
ravi voice calls deny <call> <approval>
ravi voice calls end <call>
ravi voice profiles list|show|create|update|delete
ravi voice voices list
ravi voice devices pair|list|revoke
ravi voice engines list|check
GET /api/v1/_stream/voice/{call}?after=<seq>
```

- `start` and `connect` return flat fields: `callId`, `connectionKind` (`none` | `webrtc` | `room`),
  `sdpAnswer`, `roomUrl`, `roomToken`, `lastSeq`. Connection material leaves only through these two.
- `start` with `--execute` is not required: a call is a reversible local action and costs nothing
  until speech flows. `approve` is braked; `end`, `deny`, `cancel-turn` and `silence` reduce
  authority and run immediately.

## Events

Calls store every event in `voice.db` with a per-call `seq`. The stream opens with `call.snapshot`
and resumes with `after`.

| Event | Meaning |
|---|---|
| `call.snapshot` | full state at subscribe time |
| `call.state` | `starting` → `active` → `ending` → `ended` |
| `call.ended` | final; carries `reason` and usage totals |
| `agent.state` | `listening` · `thinking` · `speaking` · `idle`; `reason: silenced` after `calls silence` |
| `work.state` | `queued` · `running` · `done` · `failed` · `cancelled` for a turn |
| `work.tool` | a tool started or finished in the session (name only) |
| `user.transcript` | what the person said (final text) |
| `agent.transcript` | what the door spoke: `text`, `turnId`, `delivery`, optional `audio` item (`item`, `mime`, `durationSec`) for push and mock calls |
| `turn.accepted` | an utterance became a session turn (`turnId`) |
| `turn.completed` | `turnId`, `spokenText`, `fullText` (text only; audio rides on `agent.transcript`) |
| `turn.approval_requested` | `approvalId`, `version`, `digest`, `text` |
| `turn.approval_resolved` | `approvalId`, `decision` (`approved`, `rejected` or `expired`, as the approval store committed it; the daemon publishes it even after `calls approve` stops waiting) |
| `usage` | audio seconds in and out, characters spoken, estimated cost |
| `error` | `code`, `message` |

## Limits and money

- Each profile has `maxCallMinutes`, `maxCallCostUsd` and `maxDailyCostUsd`. The door ends the call
  with `reason: limit` when one is reached. Defaults: 30 minutes, US$ 2 per call, US$ 10 per day.
- Usage is metered per call (audio seconds in and out, characters synthesized, engine minutes) and
  summed per day.
- No audio is recorded. Synthesized clips are kept only until the call ends, for `calls audio`.

## Storage

`voice.db` under `RAVI_STATE_DIR`, owned by the daemon like every runtime store:
`voice_calls`, `voice_events`, `voice_profiles`, `voice_devices`, `voice_usage_daily`.
