---
id: cli/crm
title: "CRM agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - crm
tags:
  - cli
  - crm
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/crm.ts
  - src/cli/agent-contract.ts
  - src/apps/router.ts
  - src/plugins/internal/ravi-system/skills/crm/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# CRM agent-first CLI contract

## Intent

Make `ravi crm` reliable for agent consumers: every failure is machine-actionable,
every braked write requires confirmation, and discovery is cheap. This is the
reference capability of the agent-first contract, validated by a 270-execution
benchmark (write-safety 0/27 → 27/27 unsafe writes blocked; completion
86.1% → 86.7%; help calls per task 2.33 → 1.60). The shared helpers live in
`src/cli/agent-contract.ts` and are reused by every migrated `cli/<domain>` spec.

## Invariants

1. With `--json`, every failure MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`
   — never plain text, never a stack trace.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error (with `acceptedFlags`/`acceptedPositionals`) ·
   `3` blocked by policy (write brake / HITL — not a failure of the system).
3. Not-found errors MUST carry up to 3 `suggestions` of similar real entities
   (bigram/substring over live data).
4. Every braked write op MUST default to dry-run and require `--execute` to
   apply (the `sessions prune` pattern). Dry-run output MUST report
   `dryRun: true`, show the `plan`, and teach the literal re-run with
   `--execute` via `suggestedAction`.
5. Writes with no reverse path in the domain (no delete/undo available) MUST be
   blocked with exit `3` before any write or network request. Current case:
   `opportunity create` (the domain has no opportunity delete).
6. Migrated list ops MUST accept `--fields a,b,c` for compact output.
7. Positional args MUST be semantic (`<pipeline>`, `<opportunity>`, never `argN`).
8. Per-op help (`ravi crm <group> <op> --help`) MUST stay compact — a screenful
   with semantic arguments and option defaults, never the whole-domain dump.
9. Without `--json`, error output and exit 1 behavior MUST stay byte-compatible
   with the legacy text path (`fail()`), except usage errors which exit 2 and
   teach the correct syntax inline.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| pipeline create | reversible config | dry-run + `--execute` |
| opportunity create | no delete in domain | dry-run + `--execute` (HITL until archive/delete exists) |
| opportunity move | reversible (move back) | dry-run + `--execute` |
| pipeline set / stage ops | reversible config | not braked yet (declared debt) |
| task / fact / contact / account writes | reversible flows | not braked yet (declared debt) |

## Official error cases

| case | code | exit |
|---|---|---|
| entity not found | `PIPELINE_NOT_FOUND` / `OPPORTUNITY_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Delivery scope

This change implements the contract on the surfaces measured by the benchmark:
`pipeline` (show/list/create/review/validate) and `opportunity` (show/create/move)
carry the envelope, taxonomy, suggestions and the write brake; listings carry
`--fields` and actionable pagination; per-op help for app aliases ships in the
apps router builtin. Remaining crm surfaces (`task`, `fact`, `contact`,
`account`) keep their current behavior and are declared debt of this spec —
they migrate in follow-up waves under the same invariants.

## Internal consumers

`src/plugins/internal/ravi-system/skills/crm/SKILL.md` teaches agents this CLI,
including writes — it MUST be updated in the same change that lands a brake.
No daemon code invokes `ravi crm` programmatically (audited on `dev`).

## Validation

- Domain test suite green (`bun test src/cli/commands/crm.test.ts`), no new
  failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`): not-found envelope +
  suggestions (exit 1); write without `--execute` → exit 3 + plan and nothing
  written; unknown flag → exit 2 + acceptedFlags; `--fields` narrows list output;
  per-op `--help` stays a screenful.
- `bun test src/apps/router.test.ts src/channels/runtime-events.test.ts` — the
  per-op help router MUST NOT make router init eager.

## Known Failure Modes

- Commander parser errors bypass the command body; without the installed usage
  contract (`installUsageContract(program, "crm")` in `src/cli/index.ts`) they
  regress to plain text + exit 1.
- A new `@Option` on a braked op shifts positional arguments in direct-call
  tests; suites MUST pass the new `execute` positional explicitly.
- `apps.help` per-op lookups on groups with their own positional argument
  (`contact`, `opportunity`) fail; use `--help` on the op instead.
