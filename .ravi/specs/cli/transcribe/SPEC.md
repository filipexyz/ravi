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
  - external-api-cost
applies_to:
  - src/cli/commands/transcribe.ts
  - src/transcribe/service.ts
  - src/transcribe/openai.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Transcribe agent-first CLI contract

## Intent

Make `ravi transcribe` reliable for agent consumers under the agent-first
contract defined by `cli`. `transcribe file` is routine processing with no
external delivery. Although the provider may bill, the CLI has no configured
cost limit or reliable preflight estimate, so the command runs immediately.

## Invariants

1. `transcribe file` MUST call the transcription service without `--execute`.
2. An unsupported audio format MUST fail with `COMMAND_FAILED` in JSON mode
   and the concise legacy message in text mode (exit 1), before the provider
   call.
3. A missing local file MUST exit 1 with `FILE_NOT_FOUND` before the provider.
4. Provider failures MUST exit 1 with `TRANSCRIBE_FAILED`
   (`retryable: true`).
5. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.
6. Provider wrappers MUST retain the original throwable and nested cause
   internally, adding typed operation/provider/model context and known
   credential values for deferred redaction. They MUST NOT sanitize the error
   into a replacement string at the throw site.
7. The CLI failure constructor requires explicit cause/context. Diagnostic
   ingress follows the global field allowlist: normalized code/message/cause
   plus status/provider/model/operation/actor/file/syscall/provider code in
   typed context. Arbitrary provider properties, headers, cookies, query,
   body/PII and stack MUST NOT enter the diagnostic envelope.
8. At egress, the shared versioned finite-pattern redactor replaces sensitive
   field contents with markers such as `[redacted:url-query]` while retaining
   the safe original reason and code. Both text and JSON output carry that
   diagnosis and available file/provider/model/status. Paths with credentials
   are normalized; ordinary diagnostic path components remain actionable.
   The same rule applies to logs and trace artifacts, including debug output:
   no raw stack or payload is permitted as a private diagnostic shortcut.
9. APIError normalization MUST extract declared provider reason/code fields
   rather than re-export a body embedded in `message`. Focused transcription
   tests complement the global 14-row/nine-sink corpus; they do not establish
   that every inbound-audio consumer or live chat route was exercised.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| file | routine processing; no delivery or configured cost threshold | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| unsupported format | `COMMAND_FAILED` compatibility envelope | 1 |
| local file missing | `FILE_NOT_FOUND` | 1 |
| provider failure | `TRANSCRIBE_FAILED` (retryable) | 1 |

## Internal consumers

Inbound voice messages are transcribed automatically by the daemon through the
service layer (`transcribeFile`), not through this CLI. Both paths remain
immediate.

## Known gaps

- SKILL GAP: there is no `transcribe` skill under
  `src/plugins/internal/ravi-system/skills/`; agents currently discover the
  command via `--help` only. A dedicated skill (or a section in the audio
  skill) is pending.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `transcribe` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/transcribe.test.ts` green.
- Live checks: `ravi transcribe file /tmp/audio.mp3 --json` transcribes
  immediately; a `.xyz` file exits 1 unsupported format; a missing `.mp3`
  returns `FILE_NOT_FOUND`.

## Known Failure Modes

- The extension check (`inferAudioMimeType`) passes for a path that does not
  exist; keep the explicit `existsSync` gate before the provider call.
