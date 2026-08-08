---
id: cli/sessions
title: "Sessions agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - sessions
tags:
  - cli
  - sessions
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/sessions.ts
  - src/cli/commands/sessions-runtime.ts
  - src/cli/commands/session-followups.ts
  - src/cli/agent-contract.ts
  - src/ephemeral/runner.ts
  - src/prompt-builder.ts
  - src/plugins/internal/ravi-system/skills/sessions/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Sessions agent-first CLI contract

## Intent

Make `ravi sessions` reliable for agent consumers under the agent-first contract
defined by `.ravi/specs/cli`. Sessions are the communication surface between
agents, so routine messaging stays friction-free while destruction and
triggered runtime execution use risk-based confirmation.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error · `2` usage
   error · `3` blocked by policy (write brake).
3. `SESSION_NOT_FOUND` MUST NOT carry `suggestions`: scope isolation cloaks
   unauthorized sessions as not-found, and suggesting real session names would
   defeat that cloak (enumeration leak). The envelope teaches
   `ravi sessions list --json` instead.
4. `sessions reset`, `sessions delete`, `sessions delete-message` and
   `sessions edit-message` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the `plan`, and MUST NOT touch state,
   queues or providers. The `edit-message` plan MUST contain only `session`,
   `messageId`, `providerMessageIdPresent`, `channel` and `newTextChars`; it
   MUST NOT contain the provider message ID or new message text.
5. `sessions prune` keeps its native richer dry-run (candidates payload,
   exit 0 preview) — declared exception that predates the taxonomy; its
   `--execute` semantics are the model the contract generalizes.
6. `sessions list` MUST accept `--fields a,b,c` for compact output.
7. Every surface that teaches a braked command (skill, session action hints,
   ephemeral TTL warning, prompt-builder guidance) MUST show `--execute`.
8. Runtime `follow-up`, `rollback` and `fork` MUST default to dry-run and
   require `--execute`: they queue work, alter history or create a new runtime
   branch. `interrupt` and `steer` remain immediate because delaying emergency
   containment or active correction can increase harm.
9. Unbraked writes (send/ask/answer/inform/execute, rename, set-*, ttl ops,
   attach/detach, mute/unmute and threads) keep immediate behavior and MUST be
   listed as unbraked in the shipped skill.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| reset | context irrecoverable after reset | dry-run + `--execute` |
| delete | permanent removal | dry-run + `--execute` |
| delete-message / edit-message | irreversible channel mutation | dry-run + `--execute` |
| prune | bulk permanent removal | native dry-run + `--execute` (pre-existing) |
| send / ask / answer / inform / execute | core messaging loop | not braked (declared) |
| rename / set-* / extend / keep / set-ttl | reversible config | not braked (declared) |
| attach / detach / mute / unmute / threads / followups | reversible state | not braked (declared) |
| runtime follow-up | queues triggered work | dry-run + `--execute` |
| runtime rollback | changes completed history | dry-run + `--execute` |
| runtime fork | creates a provider/runtime branch | dry-run + `--execute` |
| runtime interrupt / steer | containment or active correction | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| session not found (or scope-cloaked) | `SESSION_NOT_FOUND`, no suggestions | 1 |
| own message not found | `MESSAGE_NOT_FOUND` | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

- `src/plugins/internal/ravi-system/skills/sessions/SKILL.md` — teaches the
  contract; braked examples carry `--execute`.
- `src/cli/commands/sessions.ts` hint builders
  (`build*DeleteMessageCommand`/`build*EditMessageCommand`) — emitted into
  session action payloads consumed by live agents; MUST include `--execute`.
- `src/ephemeral/runner.ts` TTL warning — teaches `sessions delete`; MUST show
  `--execute`.
- `src/prompt-builder.ts` session guidance — same requirement.

## Validation

- `bun test src/cli/commands/sessions.test.ts` green (50 tests, contract block
  included); `sessions-runtime.test.ts` green; `prompt-builder.test.ts` green.
- Live checks (isolated `RAVI_STATE_DIR`): `sessions info ghost --json` →
  `SESSION_NOT_FOUND` without suggestions, exit 1; `reset`/`delete` without
  `--execute` → exit 3 and the session still resolvable; `delete --execute` →
  `changed: true` and the session gone; unknown flag → `USAGE_ERROR`, exit 2;
  `list --fields name,agentId --json` narrows items.

## Known Failure Modes

- Suggestions on `SESSION_NOT_FOUND` would leak session names across scope
  boundaries — the cloak in `resolveTarget`/scope checks exists precisely to
  prevent enumeration.
- `sessions-trace.test.ts` and `session-followups.test.ts` fail on Windows with
  environment errors (EBUSY temp cleanup) — pre-existing on the virgin tree,
  verified via stash-compare; not caused by the contract.
- Hint builders are asserted literally in `sessions.test.ts`; changing a taught
  command without updating the test (and vice versa) breaks the suite — this is
  intentional drift protection between hints and the real contract.
