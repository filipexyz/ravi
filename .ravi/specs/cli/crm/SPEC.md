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
routine local persistence has no confirmation loop, and discovery is cheap.
The original pilot benchmark established stable completion and cheaper
discovery; its blanket write brake is superseded by the global risk policy.
The shared helpers live in `src/cli/agent-contract.ts` and are reused by every
migrated `cli/<domain>` spec.

## Invariants

1. With `--json`, every failure MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`
   — never plain text, never a stack trace.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error (with `acceptedFlags`/`acceptedPositionals`) ·
   `3` blocked by policy (write brake / HITL — not a failure of the system).
3. Not-found errors MUST carry up to 3 `suggestions` of similar real entities
   (bigram/substring over live data).
4. `pipeline create`, `opportunity create`, and `opportunity move` are local
   persistence operations. They MUST execute immediately without `--execute`
   and MUST remain authorized as `kind: "mutate"`.
5. The absence of an opportunity delete command does not turn routine internal
   creation into irreversible destruction; idempotency keys remain available
   to prevent duplicate creates.
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
| pipeline create | routine internal config; idempotency supported | not braked |
| opportunity create | routine internal record creation; idempotency supported | not braked |
| opportunity move | reversible local transition (move back) | not braked |
| pipeline set / stage ops | reversible config | not braked |
| task / fact / contact / account writes | local CRM flows | not braked |

## Official error cases

| case | code | exit |
|---|---|---|
| entity not found | `PIPELINE_NOT_FOUND` / `OPPORTUNITY_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |

## Delivery scope

This change implements the contract on the surfaces measured by the benchmark:
`pipeline` (show/list/create/review/validate) and `opportunity` (show/create/move)
carry the envelope, taxonomy, suggestions and immediate local writes; listings carry
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
  suggestions (exit 1); local create/move without `--execute` → exit 0 and the
  record changes; unknown flag → exit 2 + acceptedFlags; `--fields` narrows list output;
  per-op `--help` stays a screenful.
- `bun test src/apps/router.test.ts src/channels/runtime-events.test.ts` — the
  per-op help router MUST NOT make router init eager.

## Known Failure Modes

- Commander parser errors bypass the command body; without the installed usage
  contract (`installUsageContract(program, "crm")` in `src/cli/index.ts`) they
  regress to plain text + exit 1.
- A new `@Option` shifts positional arguments in direct-call tests; suites MUST
  keep direct invocations aligned with the decorated method signature.
- `apps.help` per-op lookups on groups with their own positional argument
  (`contact`, `opportunity`) fail; use `--help` on the op instead.
