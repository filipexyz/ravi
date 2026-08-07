---
id: cli/audio
title: "Audio agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - audio
tags:
  - cli
  - audio
  - tts
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - external-api-cost
applies_to:
  - src/cli/commands/audio.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/audio/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Audio agent-first CLI contract

## Intent

Make `ravi audio` reliable for agent consumers under the agent-first contract
defined by `cli`. Routine generation runs immediately because the CLI has no
configured cost limit or trustworthy cost estimate. `audio generate --send`
is braked because it delivers to a live chat; `audio tts` remains braked because
its NATS publish triggers downstream generation and playback.

## Invariants

1. `audio generate` without `--send` MUST run immediately without `--execute`.
   When `--send` is present, the command MUST require `--execute` and the
   dry-run plan MUST carry the resolved generation options, `textChars`,
   `captionPresent` and `send: true`; it MUST NOT contain text or caption bytes.
2. `audio tts` MUST default to dry-run and require `--execute`; the dry-run
   MUST exit 3 BEFORE the `ravi.tts` NATS emit (the emit is what triggers the
   paid ElevenLabs generation downstream) and MUST show the resolved voice
   config, target, playback and `textChars` in the plan, never the text itself.
3. Text/`--text-file` validation (both given, neither given, unsafe paths)
   and delivery-target resolution MUST fail before generation or conditional
   delivery confirmation.
4. `audio voices` and `audio pending` MUST accept `--fields a,b,c` for compact
   output (narrowing `voices`/`items` respectively).
5. `audio blob` keeps raw bytes on success. A non-success binary `Response`
   MUST become the same safe contract failure in CLI, tool and gateway; raw
   provider bodies and resource ids MUST NOT leak.
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| generate without `--send` | routine generation/local file | not braked |
| generate with `--send` | external chat delivery | dry-run + `--execute` |
| tts | triggered generation/playback via `ravi.tts` | dry-run + `--execute` |
| voices / pending / blob | reads | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| missing text and `--text-file` | `USAGE_ERROR` + accepted inputs | 2 |
| other invalid text/`--text-file` combinations | `COMMAND_FAILED` compatibility envelope | 1 |
| generate `--send` or tts without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

Missing input is a usage error in both modes: JSON mode writes the envelope to
stdout; text mode preserves the concise legacy message on stderr; both exit 2.

## Internal consumers

- The `audio` skill (`src/plugins/internal/ravi-system/skills/audio/SKILL.md`)
  MUST document `--execute` on `generate --send` and `tts`, but not on pure
  generation examples.
- The generate payload's `sendCommand` teaches `ravi media send` and MUST carry
  `--execute` (see `cli/media`).

## Known gaps

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `audio` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/media-json.test.ts` green (the `audio contract`
  block included).
- Live checks: `ravi audio generate "oi" --json` generates immediately;
  adding `--send` without `--execute` exits 3 before provider/delivery;
  `ravi audio voices --json --fields voiceId,name` narrows.

## Known Failure Modes

- The daemon-side TTS pipeline (`ravi.tts` consumer) generates audio without
  the CLI, so the brake protects only CLI-initiated spends — automation-driven
  TTS is governed by agent `tts_auto` defaults, not by this contract.
- The conditional `--send` brake MUST stay before `generateAudio`; otherwise a
  confirmation pass would incur cost and create a file before delivery is
  approved.
