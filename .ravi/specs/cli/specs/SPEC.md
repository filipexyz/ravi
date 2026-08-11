---
id: cli/specs
title: "Specs agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - specs
tags:
  - cli
  - specs
  - agent-first
  - error-envelope
  - exit-taxonomy
  - compact-mode
applies_to:
  - src/cli/commands/specs.ts
  - src/cli/agent-contract.ts
  - src/specs/service.ts
  - src/plugins/internal/ravi-system/skills/specs/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Specs agent-first CLI contract

## Intent

Make `ravi specs` reliable for agent consumers under the agent-first contract
defined by `cli`. Specs are the durable rules memory agents consult
BEFORE editing code, so the priority here is precise not-found feedback and
compact discovery. The domain has NO braked op: `new` creates local Markdown
and fails on existing specs; `sync` is an idempotent local reindex whose
source of truth remains the Markdown tree.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedValues?}}`.
2. `specs get` on an unknown id MUST exit 1 with `SPEC_NOT_FOUND` and up to 3
   `suggestions` from real spec ids — even though the underlying
   `getSpecContext` throws plain errors on unknown ids.
3. Invalid `--mode` on `get` and invalid `--kind` on `list`/`new` MUST exit 2
   with `USAGE_ERROR` and `acceptedValues`; missing `--title`/`--kind` on
   `new` are usage errors too.
4. `specs list` MUST accept `--fields a,b,c` for compact output, applied to
   both `items` and the legacy `specs` array.
5. `specs new` MUST stay UNBRAKED (declared): it only creates local Markdown
   files and fails on already-existing specs (exit 1, no overwrite path
   exists).
6. `specs sync` MUST stay UNBRAKED (declared): it rebuilds a rebuildable
   SQLite index from Markdown, is idempotent, and is invoked by CI quality
   gates (`src/ci/quality-gate.ts` calls `syncSpecs()`), docs and many spec
   CHECKS — a brake here would break automation with zero safety gain.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.
8. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| new | creates local Markdown; refuses existing ids | not braked (declared) |
| sync | idempotent local reindex; Markdown stays source of truth | not braked (declared) |
| list / get | reads | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| spec not found | `SPEC_NOT_FOUND` + suggestions | 1 |
| invalid mode/kind, missing title/kind | `USAGE_ERROR` + acceptedValues | 2 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/specs/SKILL.md` teaches this surface
and carries the contract section. `ravi specs sync --json` is embedded in
dozens of spec CHECKS/RUNBOOKs, README, `.github/copilot-instructions.md` and
the CI quality gate — all keep working unchanged because `sync` is unbraked.

## Validation

- `bun test src/cli/commands/specs.test.ts` green (contract block included).
- Live checks (isolated workspace): `specs get nope --json` →
  `SPEC_NOT_FOUND` + suggestions, exit 1; `specs get <id> --mode bogus --json`
  → `USAGE_ERROR`, exit 2; `specs list --fields id,kind --json` narrows both
  arrays; `specs sync --json` succeeds with no extra flag.

## Known Failure Modes

- `getSpecContext` throws plain `Spec not found: <id>` errors; mapping must
  match that message or every unknown id regresses to text + exit 1.
- `specIdCandidates` must swallow index errors (empty suggestions beat a
  crashing not-found path when `.ravi/specs` is absent).
- `specs.test.ts` originally imported the SUT statically with the real
  `../context.js`; the file MUST mock it (with `hasContext: () => true`)
  BEFORE a dynamic import of `./specs.js`.
