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
defined by `cli/crm`. `audio generate` and `audio tts` spend EXTERNAL API money
(ElevenLabs) on every call, so both are braked: dry-run by default showing the
resolved voice/model/speed that would be billed. `voices`, `pending` and `blob`
are reads and stay immediate.

## Invariants

1. `audio generate` MUST default to dry-run and require `--execute`; the
   dry-run MUST exit 3 with `dryRun: true` and a `plan` carrying the RESOLVED
   voice, model, speed, lang, format, outputDir, send flag and a text preview
   plus character count.
2. `audio tts` MUST default to dry-run and require `--execute`; the dry-run
   MUST exit 3 BEFORE the `ravi.tts` NATS emit (the emit is what triggers the
   paid ElevenLabs generation downstream) and MUST show the resolved voice
   config, target and playback in the `plan`.
3. Text/`--text-file` validation (both given, neither given, unsafe paths)
   MUST fail BEFORE the brake with the legacy messages (exit 1).
4. `audio voices` and `audio pending` MUST accept `--fields a,b,c` for compact
   output (narrowing `voices`/`items` respectively).
5. `audio blob` keeps its binary Response behavior untouched (it is on the
   binary returns allowlist and MUST NOT be migrated to JSON envelopes).
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| generate | external API money (high) | dry-run + `--execute` |
| tts | external API money via ravi.tts pipeline (high) | dry-run + `--execute` |
| voices / pending / blob | reads | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| invalid text/--text-file combinations | legacy text (validation) | 1 |
| braked generate/tts without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- The `audio` skill (`src/plugins/internal/ravi-system/skills/audio/SKILL.md`)
  MUST document `--execute` on every generate/tts example.
- The generate payload's `sendCommand` teaches `ravi media send` and MUST carry
  `--execute` (see `cli/media`).

## Known gaps

- Parser-level usage errors (exit 2 + `acceptedFlags`) depend on registering
  `audio` in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`), out of scope for
  this migration batch.

## Validation

- `bun test src/cli/commands/media-json.test.ts` green (the `audio contract`
  block included).
- Live checks: `ravi audio generate "oi" --json` → exit 3 + plan with
  voice/model; adding `--execute` bills and saves the file; `ravi audio voices
  --json --fields voiceId,name` narrows.

## Known Failure Modes

- The daemon-side TTS pipeline (`ravi.tts` consumer) generates audio without
  the CLI, so the brake protects only CLI-initiated spends — automation-driven
  TTS is governed by agent `tts_auto` defaults, not by this contract.
- `--send` on generate delivers through the media surface AFTER generation;
  braking generate is what prevents the paid step, not the delivery step.
