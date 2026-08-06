---
id: crm/agent-first-cli
title: "CRM agent-first CLI contract"
kind: capability
domain: crm
capabilities:
  - cli
tags:
  - cli
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/crm.ts
  - src/cli/commands/crm-contract.ts
  - src/apps/router.ts
  - src/plugins/internal/ravi-system/skills/crm/SKILL.md
owners:
status: active
normative: true
---
# CRM agent-first CLI contract

## Intent

Make `ravi crm` reliable for agent consumers: every failure is machine-actionable,
every write has a brake, and discovery is cheap. This spec is the pilot of the
agent-first contract proposed in issue #397, validated by a 270-execution benchmark
(write-safety 0/27 → 27/27 unsafe writes executed; completion 86.1% → 86.7%;
help calls per task 2.33 → 1.60).

## Invariants

1. With `--json`, every failure MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`
   — never plain text, never a stack trace.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error (with `acceptedFlags`/`acceptedPositionals`) ·
   `3` blocked by policy (write brake / HITL — not a failure of the system).
3. Not-found errors MUST carry up to 3 `suggestions` of similar real entities
   (bigram/substring over live data).
4. Every write op MUST default to dry-run and require `--execute` to apply
   (the `sessions prune` pattern). Dry-run output MUST show the plan and the
   literal `executeCommand`.
5. Writes with no reverse path in the domain (no delete/undo available) MUST be
   blocked with exit `3` before any network request, with documented HITL.
   Current case: `opportunity create` (the domain has no opportunity delete).
6. List ops MUST accept `--fields a,b,c` for compact output.
7. Positional args MUST be semantic (`<task>`, `<pipeline>`, never `argN`).
8. Per-op help MUST stay under 20KB and include arguments with domains/defaults,
   examples, and observed errors; the global help stays a compact index.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| task create/done/cancel/snooze | reversible state transitions | dry-run + `--execute` |
| pipeline create/set | reversible config | dry-run + `--execute` |
| opportunity create | no delete in domain | HITL (exit 3) until archive/delete exists |
| opportunity move | reversible (move back) | dry-run + `--execute` |
| opportunity link-contact | verify unlink availability | conservative if absent |
| fact propose/confirm/reject | reversible flow (reject path exists) | dry-run + `--execute` |
| contact set | reversible (re-set) | dry-run + `--execute` |
| account create/link-contact | verify reverse path | conservative if absent |

## Official error cases

| case | code | exit |
|---|---|---|
| entity not found | `CRM_*_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| irreversible write blocked | HITL block before network | 3 |
| provider error | sanitized (ANSI stripped, ~2KB truncated) | 1 |

## Internal consumers

`src/plugins/internal/ravi-system/skills/crm/SKILL.md` teaches agents this CLI,
including writes — it MUST be updated in the same change that lands the brake.
No daemon code invokes `ravi crm` programmatically (audited on `dev`).

## Validation

- Domain test suite green (`src/cli/commands/crm.test.ts`), no new failures vs
  the `dev` baseline.
- Live checks on the built CLI: not-found envelope + suggestions; write without
  `--execute` → exit 3 + plan; unknown flag → exit 2 + acceptedFlags; `--fields`
  narrows list output.
- Benchmark protocol (deterministic judge v2, sealed tasks, evaluator ≠ builder):
  write-safety 100%, completion ≥ 86.1%, recovery ≥ 50%.
