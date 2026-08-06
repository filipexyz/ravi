---
id: cli/media
title: "Media agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - media
tags:
  - cli
  - media
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/media.ts
  - src/cli/media-send.ts
  - src/cli/commands/sessions.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Media agent-first CLI contract

## Intent

Make `ravi media` reliable for agent consumers under the agent-first contract
defined by `cli`: typed error envelopes, the 0/1/2/3 exit taxonomy and a
write brake on `media send` — the op that delivers a file to a REAL chat on a
live channel (WhatsApp/Slack) and cannot be unsent.

## Invariants

1. With `--json`, every failure on `media send` MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   delivery) · `2` usage error · `3` blocked by policy (write brake).
3. `media send` MUST default to dry-run and require `--execute`; the dry-run
   MUST report `dryRun: true` and a `plan` with the resolved file
   (path/filename/mime/type), caption, voiceNote and target, and MUST NOT call
   the omni CLI or the Slack native sender.
4. A missing local file MUST exit 1 with `FILE_NOT_FOUND` BEFORE the brake — no
   plan is shown for a send that could never happen.
5. Delivery failures after `--execute` MUST exit 1 with `MEDIA_SEND_FAILED`
   (`retryable: true`).
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| send | external delivery to a live chat (high) | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| local file missing | `FILE_NOT_FOUND` | 1 |
| delivery failure | `MEDIA_SEND_FAILED` (retryable) | 1 |
| braked send without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- `src/cli/commands/sessions.ts` (`buildCurrentSessionMediaSendCommand` and the
  `sendMedia` usage hint) teaches `ravi media send "<file-path>" --execute` to
  live agents; the builder MUST carry `--execute`.
- `ravi image generate` and `ravi audio generate` return a `sendCommand` field
  that MUST carry `--execute` (`ravi media send "<path>" --execute`).

## Known gaps

- SKILL GAP: there is no `media` skill under
  `src/plugins/internal/ravi-system/skills/`; the surface is taught only through
  the sessions action hints and the image/audio skills. A dedicated skill (or a
  section in a channel skill) is pending.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
  `media` is registered in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`).

## Validation

- `bun test src/cli/commands/media-json.test.ts` green (the `media send
  contract` block included).
- Live checks: `ravi media send /tmp/img.png --json` → exit 3 + plan; adding
  `--execute` delivers; `ravi media send /tmp/nope.png --json` →
  `FILE_NOT_FOUND`, exit 1.

## Known Failure Modes

- `sendMediaWithOmniCli` both validates the file and resolves the target; the
  brake must run BEFORE it, so the command re-implements the cheap local checks
  (existsSync + mime inference) and shows the context-resolved target in the
  plan without calling the resolver that can spawn `omni`.
- Consumers that teach `ravi media send` without `--execute` put live agents in
  an exit-3 loop; the sessions builders and the image/audio `sendCommand`
  strings are the canonical teaching surfaces and carry the flag.
