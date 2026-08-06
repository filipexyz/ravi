---
id: cli/commands
title: "Ravi Commands agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - commands
tags:
  - cli
  - commands
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/commands.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-system/skills/commands/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Ravi Commands agent-first CLI contract

## Intent

Make `ravi commands` (prompt-command management: list, show, validate, run)
reliable for agent consumers under the agent-first contract defined by
`cli`: typed error envelopes, the 0/1/2/3 exit taxonomy, and compact
discovery. The domain is READ-ONLY — `run` only RENDERS the composed prompt
and never publishes to a session — so this migration ships WITHOUT a write
brake.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found)
   · `2` usage error · `3` blocked by policy (no commands op uses 3).
3. `commands show` and `commands run` on an unknown command MUST exit 1 with
   `COMMAND_NOT_FOUND` and up to 3 `suggestions` built from the ids of the
   SAME registry the lookup used (zero extra cost).
4. Any op given an unknown `--agent` MUST exit 1 with `AGENT_NOT_FOUND` and
   suggestions from the local agent config, BEFORE any filesystem discovery
   runs.
5. `commands list` MUST accept `--fields a,b,c` for compact output (applied
   to both the `items` and `commands` arrays, which carry the same rows).
6. `commands validate` keeps its pre-existing semantics: exit 1 via
   `process.exitCode` when validation errors exist — that is a validation
   verdict, not a contract envelope, and is NOT renamed or re-coded.
7. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (no new brakes — rationale)

| op | class | brake |
|---|---|---|
| list / show / validate | read (filesystem discovery only) | n/a |
| run | read — renders the composed prompt for preview; publishes nothing | not braked (declared) |

`run` looks like execution but is explicitly a renderer (see the commands
skill: "Ele nao publica em sessao e nao executa runtime"). Verdict: "sem
freios novos".

## Official error cases

| case | code | exit |
|---|---|---|
| command not found | `COMMAND_NOT_FOUND` + suggestions | 1 |
| agent not found | `AGENT_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| validation errors present (`validate`) | pre-existing exit 1 verdict | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/commands/SKILL.md` teaches this
surface and carries the `## Contrato Do CLI` section (envelope, exits,
`--fields`, declared absence of brakes). No other doc teaches braked commands
syntax (there is none).

## Validation

- `bun test src/cli/commands/commands.test.ts` green (contract suite), no new
  failures vs the `dev` baseline.
- Live checks on the local CLI: `commands show nope --json` →
  `COMMAND_NOT_FOUND`, exit 1; `commands list --fields id,scope --json`
  narrows items; `commands run <name> --json -- args` renders without side
  effects.

## Known Failure Modes

- `resolveRaviCommand` returns null (it does not throw); the not-found branch
  must build suggestions from `registry.commands` BEFORE bailing, or the
  registry work is discarded and re-done.
- `--agent` failures after discovery would waste a filesystem scan; agent
  resolution happens first and fails with `AGENT_NOT_FOUND` from the local
  config only.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
