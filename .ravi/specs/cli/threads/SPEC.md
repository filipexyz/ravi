---
id: cli/threads
title: "Threads agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - threads
tags:
  - cli
  - threads
  - agent-first
  - error-envelope
  - exit-taxonomy
applies_to:
  - src/cli/commands/threads.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Threads agent-first CLI contract

## Intent

Make `ravi threads` reliable for agent consumers under the agent-first
contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3 exit
taxonomy, and compact discovery. This domain ships WITHOUT a write brake —
the value of the migration here is the envelope, the exit taxonomy and
`--fields`, not exit 3.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (no threads op uses 3).
3. `threads show|comment|note|link|entries|brief|close` on an unknown id/slug
   MUST exit 1 with `THREAD_NOT_FOUND` and up to 3 `suggestions` built from
   live thread ids/slugs/titles (`listThreads`, an already-local SQLite
   listing) — even though the underlying `resolveThread` throws on unknown
   refs.
4. `threads list` MUST accept `--fields a,b,c` for compact output.
5. Ambiguous slugs across scopes and invalid pointers keep the legacy `fail()`
   path (exit 1, no NOT_FOUND code): those are resolution conflicts, not
   missing entities.
6. When invoked from an agent context (`RAVI_*` envs present), a thrown
   `ContractError` MUST preserve its exit code through the registry
   dispatcher.

## Write classification (no new brakes — rationale)

| op | class | brake |
|---|---|---|
| create | local SQLite insert, visible via list, reversible via close | not braked (declared) |
| comment / note | append-only local journal entries (same class as unbraked `tasks comment`) | not braked (declared) |
| link | idempotent local upsert of a pointer | not braked (declared) |
| close | reversible status transition (`updateThreadStatus` can set any status) | not braked (declared) |
| show / list / entries / brief | read | n/a |

No threads op dispatches execution, deletes data, or touches an external
provider; braking them would add exit-3 friction to a purely local,
reversible journal with no destructive candidate. Verdict: "sem freios
novos".

## Official error cases

| case | code | exit |
|---|---|---|
| thread not found | `THREAD_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

No shipped skill teaches `ravi threads` today — **skill gap registered**: when
a threads skill is written it MUST document this contract (envelope, exits,
`--fields`, and the declared absence of brakes). No AGENTS.md/CLAUDE.md
section teaches braked threads syntax (there is none).

## Validation

- `bun test src/cli/commands/threads.test.ts` green (contract suite), no new
  failures vs the `dev` baseline.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`):
  `threads show nope --json` → `THREAD_NOT_FOUND`, exit 1;
  `threads list --fields id,status --json` narrows items.

## Known Failure Modes

- `resolveThread` throws a plain `Thread not found: ...` instead of returning
  null; mapping only a null return would be dead code — the CLI helper
  catches the throw and re-classifies by message.
- `findThread` also throws on ambiguous slugs; treating every throw as
  not-found would mislabel ambiguity. Only messages matching
  `/thread not found/i` map to `THREAD_NOT_FOUND`.
- Parser-level usage errors only exit 2 once the `threads` group is listed in
  `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`) — that list is owned by the
  migration coordinator, not this spec's wave.
