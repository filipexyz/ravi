---
id: cli/transcribe
title: "Transcribe agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - transcribe
tags:
  - cli
  - transcribe
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - external-api-cost
applies_to:
  - src/cli/commands/transcribe.ts
  - src/transcribe/service.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Transcribe agent-first CLI contract

## Intent

Make `ravi transcribe` reliable for agent consumers under the agent-first
contract defined by `cli/crm`. `transcribe file` always calls a PAID external
API (OpenAI Whisper) — there is no free local path — so the single op is
braked: dry-run by default showing the file, size and language that would be
billed.

## Invariants

1. `transcribe file` MUST default to dry-run and require `--execute`; the
   dry-run MUST exit 3 with `dryRun: true` and a `plan` carrying the absolute
   file path, mimeType, sizeBytes/sizeMB (the billing driver), lang and
   provider (`openai-whisper`), and MUST NOT call the transcription service.
2. An unsupported audio format MUST fail with the legacy message (exit 1)
   BEFORE the brake.
3. A missing local file MUST exit 1 with `FILE_NOT_FOUND` BEFORE the brake.
4. Provider failures after `--execute` MUST exit 1 with `TRANSCRIBE_FAILED`
   (`retryable: true`).
5. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| file | external API money (Whisper) | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| unsupported format | legacy text (validation) | 1 |
| local file missing | `FILE_NOT_FOUND` | 1 |
| provider failure | `TRANSCRIBE_FAILED` (retryable) | 1 |
| braked run without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

Inbound voice messages are transcribed automatically by the daemon through the
service layer (`transcribeFile`), not through this CLI — the brake governs
CLI-initiated spends only and does not affect message-flow transcription.

## Known gaps

- SKILL GAP: there is no `transcribe` skill under
  `src/plugins/internal/ravi-system/skills/`; agents currently discover the
  command via `--help` only. A dedicated skill (or a section in the audio
  skill) is pending.
- Parser-level usage errors (exit 2 + `acceptedFlags`) depend on registering
  `transcribe` in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`), out of scope
  for this migration batch.

## Validation

- `bun test src/cli/commands/transcribe.test.ts` green.
- Live checks: `ravi transcribe file /tmp/audio.mp3 --json` → exit 3 + plan
  with sizeMB; adding `--execute` bills Whisper; a `.xyz` file → exit 1
  unsupported format; a missing `.mp3` → `FILE_NOT_FOUND`.

## Known Failure Modes

- The extension check (`inferAudioMimeType`) passes for a path that does not
  exist; without the explicit `existsSync` gate the brake would show a plan
  for a file Whisper could never receive.
- `statSync` in the plan runs only after the existence check — reordering
  those two turns a clean `FILE_NOT_FOUND` into an uncaught ENOENT throw.
