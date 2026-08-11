---
id: cli/rules
title: "Rules agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - rules
tags:
  - cli
  - rules
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/rules.ts
  - src/cli/agent-contract.ts
  - src/runtime/ravi-rules.ts
  - src/plugins/internal/ravi-dev/skills/ravi-rules/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Rules agent-first CLI contract

## Intent

Make `ravi rules` reliable for agent consumers under the agent-first contract
defined by `cli`. The domain imports provider rule files
(`.claude/rules`, `.agents/rules`) into Ravi-owned `.ravi/rules/imported`.
Its riskiest op, `import --force`, can overwrite previously imported rules —
but the domain ALREADY ships a native two-stage brake (`--write`, then
`--force`), which this contract adopts as the official `--execute`
equivalent instead of adding a redundant flag.

## Invariants

1. `rules import` MUST keep its NATIVE brake as the contract equivalent of
   `--execute`: without `--write` it is a dry-run (no files created, exit 0
   with the would-be plan in `candidates`); with `--write` existing imported
   files are still skipped unless `--force` is passed. Neither flag may be
   renamed and no separate `--execute` may be added.
2. The import dry-run and JSON summaries MUST NOT expose raw rule content
   (candidates are serialized without `content`).
3. An invalid source provider on `sources` or `import` MUST exit 2 with the
   `USAGE_ERROR` envelope carrying `acceptedValues` (`all`, `claude`,
   `agents`) and `suggestions` — and MUST fire before any filesystem work.
4. There is no per-rule lookup op in this domain, so no `RULE_NOT_FOUND`
   envelope applies — declared.
5. `rules sources` MUST accept `--fields a,b,c` for compact output of
   `sources`.
6. User-level sources (`~/.claude/rules`, `~/.agents/rules`) MUST stay
   excluded unless `--include-user` is passed, on both `sources` and
   `import`.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| import (no flags) | dry-run by construction | native brake stage 1 (no `--write`) |
| import --write | creates new local files; skips existing | native brake stage 2 (skip-existing) |
| import --write --force | overwrites existing imported rules (destructive) | explicit `--force` opt-in (equivalent; kept, not renamed) |
| sources | read | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| invalid provider filter | `USAGE_ERROR` + acceptedValues + suggestions | 2 |

## Internal consumers

`src/plugins/internal/ravi-dev/skills/ravi-rules/SKILL.md` teaches this
surface and documents the native brake equivalence. The normative runtime spec
`runtime/prompt-rules` (RUNBOOK/CHECKS) already teaches `--write` on every
import example and stays accurate unchanged.

## Validation

- `bun test src/cli/commands/rules.test.ts` green (contract block included).
- Live checks: `rules import bogus --json` → `USAGE_ERROR`, exit 2;
  `rules import claude --force --json` (no `--write`) → exit 0, nothing
  written; `rules sources all --fields provider,exists --json` narrows
  sources.

## Known Failure Modes

- The exit-code asymmetry is deliberate and documented: the native dry-run
  exits 0 (with the plan payload), not 3 — converting it to `contractDryRun`
  would break every existing caller and the `runtime/prompt-rules` contract
  for zero safety gain.
- `rules.test.ts` originally imported the SUT statically with the real
  `../context.js`; contract helpers would `process.exit` in tests. The file
  MUST mock `../context.js` (with `hasContext: () => true`) BEFORE a dynamic
  import of `./rules.js`.
