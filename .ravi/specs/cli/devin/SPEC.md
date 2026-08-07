---
id: cli/devin
title: "Devin agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - devin
tags:
  - cli
  - devin
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/devin.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Devin agent-first CLI contract

## Intent

Make `ravi devin sessions` (and `devin auth`) reliable for agent consumers
under the agent-first contract defined by `cli`. Devin is a PAID external
service: `create` starts a billable remote session, `send` steers billable
work, and `archive` changes remote state without a CLI inverse, so all three
are braked. `sync` stays unbraked, and `terminate` is unbraked as a
cost/damage stop. Only
`src/cli/commands/devin.ts` implements this contract — the `src/devin/`
runtime is out of scope.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `devin sessions create` and `devin sessions send` MUST default to dry-run
   and require `--execute`; the dry-run MUST report `dryRun: true` and the
   `plan`, and MUST NOT construct the Devin client (the brake fires before
   `createDevinClientFromEnv`, so no credentials are needed to inspect).
4. The create plan MUST NEVER echo session-secret VALUES — only
   `sessionSecretCount`; the prompt is reported as `promptChars` +
   `promptPreview` (200 chars).
5. `--execute` MUST be the LAST declared option of every braked op.
6. Every op that resolves a session identifier (`show`, `messages`, `send`,
   `attachments`, `insights`, `sync`, `terminate`, `archive`) MUST exit 1 with
   `DEVIN_SESSION_NOT_FOUND` on unknown ids, carrying suggestions from the
   LOCAL session cache (`listDevinSessions`) — no remote call to build the
   envelope. `send` performs this validation BEFORE its brake.
7. `devin sessions list` MUST accept `--fields a,b,c`; `items` and the legacy
   `sessions` alias MUST carry the same projected rows.
8. `sync` and `terminate` stay unbraked with declared rationale (see
   classification). `archive` MUST require `--execute` before client creation
   or provider/cache effects.
9. `insights --generate` MUST require `--execute` before client construction,
   provider generation or cache persistence. Plain `insights` remains an
   immediate provider read plus local cache refresh.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| create | starts a billable session on the external paid service | dry-run + `--execute` |
| send | steers/resumes billable work on the external service | dry-run + `--execute` |
| terminate | cost/damage stop for a billable session (prox cancel precedent) | not braked (declared) |
| archive | external provider state change with no inverse in this CLI | dry-run + `--execute` |
| sync | reads remote, refreshes LOCAL cache (+ optional local artifact) | not braked (declared) |
| insights | provider read + local cache refresh | not braked |
| insights --generate | external generation/update + local cache refresh | conditional dry-run + `--execute` |
| list/show/messages/attachments/auth check | reads | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| session not found | `DEVIN_SESSION_NOT_FOUND` + suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| missing/invalid Devin env config | legacy text (DevinConfigError) | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/tasks/SKILL.md` (delegation protocol)
and `docs/task-profiles-catalog-v1.md` reference `ravi devin sessions
create|send` — both sit behind the brake, so those flows add `--execute` on
real dispatch. Plain insights examples remain valid; an example that adds
`--generate` must also add `--execute`. No dedicated `devin` skill
ships yet — **skill gap registered**: when created it MUST teach the brakes on
create/send/archive/insights generation, the unbraked terminate/sync rationale
and the not-found envelope.

## Validation

- `bun test src/cli/commands/devin.test.ts` green (client and store mocked;
  contract block included).
- Live checks (require DEVIN_* env only for `--execute`): `devin sessions
  create --prompt x --max-acu 5 --json` → exit 3 with plan and NO client
  construction; `devin sessions send sess-nope "x" --json` →
  `DEVIN_SESSION_NOT_FOUND`, exit 1; `devin sessions list --fields
  devinId,status --json` narrows items.

## Known Failure Modes

- `createDevinClientFromEnv` used to run FIRST in create/send; leaving it
  there would make the dry-run fail on machines without Devin credentials —
  the brake must stay before client construction.
- `resolveDevinId` accepts any `devin-*` id without a store hit (remote-first
  ids); the not-found envelope only fires for identifiers that are neither
  cached nor `devin-*`-shaped.
