---
id: cli/context
title: "Context agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - context
tags:
  - cli
  - context
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - secret-hygiene
applies_to:
  - src/cli/commands/context.ts
  - src/cli/agent-contract.ts
  - src/plugins/internal/ravi-dev/skills/context-cli/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Context agent-first CLI contract

## Intent

Make `ravi context` and `ravi context credentials` reliable for agent consumers
under the agent-first contract defined by `cli`: typed error envelopes, the
0/1/2/3 exit taxonomy, a write brake on the destructive ops, and compact
discovery. This domain is auth substrate: `revoke` kills live runtime auth
(cascading to child contexts by default) and `credentials remove` drops a
working local credential — both are braked. The domain also carries a security
invariant stronger than most: context keys (`rctx_*`) ARE credentials.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `context info`, `context lineage` and `context revoke` on an unknown id MUST
   exit 1 with `CONTEXT_NOT_FOUND` and up to 3 `suggestions` built from context
   IDs only.
4. `context credentials remove` and `context credentials set-default` on an
   unknown entry MUST exit 1 with `CREDENTIAL_NOT_FOUND`; suggestions carry
   context IDs and labels only.
5. `context revoke` and `context credentials remove` MUST default to dry-run
   and require `--execute`; the dry-run MUST report `dryRun: true` and the
   `plan`, and MUST NOT revoke or delete anything. Revoke uses
   `{contextId,kind,agentId,cascade,reasonPresent}`. Credential removal uses
   `{credentialsPathPresent,contextKeyPresent,contextId,agentId,labelPresent,kind,wasDefault}`.
   Neither plan carries the reason, path, key, or label text.
6. Secret hygiene: a full `rctx_*` context key MUST NEVER appear in an error
   envelope, dry-run plan, or suggestion list. A credential-removal plan uses
   only `contextKeyPresent`; not-found envelopes may echo the user's queried
   key only as a masked prefix (first 8 characters + `...`).
7. `context list` and `context credentials list` MUST accept `--fields a,b,c`
   for compact JSON output; human output stays complete.
8. `context prune` keeps its pre-existing, STRONGER equivalent brake
   (`--apply` + `--confirm prune-contexts`); the flags MUST NOT be renamed to
   `--execute`.
9. `context cleanup-agent-runtime` keeps its pre-existing local equivalent
   (dry-run by default, opt-in `--revoke`); the flag MUST NOT be renamed.
10. Without `--json`, error output keeps the legacy text path (exit 1).

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | destructive (kills live runtime auth, cascades) | dry-run + `--execute` |
| credentials remove | destructive (drops a working local credential) | dry-run + `--execute` |
| prune | destructive (deletes inactive context rows) | pre-existing `--apply` + `--confirm prune-contexts` (stronger equivalent, documented) |
| cleanup-agent-runtime | destructive (revokes stale contexts) | pre-existing dry-run default + `--revoke` (equivalent, documented) |
| credentials add / set-default | reversible local-store writes | not braked (declared) |
| issue | mints a revocable child context (reverse path: revoke) | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| context not found (info / lineage / revoke) | `CONTEXT_NOT_FOUND` + id suggestions | 1 |
| credential entry not found (remove / set-default) | `CREDENTIAL_NOT_FOUND` + id/label suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid flag/arg (once the domain is registered in the usage-contract list) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

- `src/plugins/internal/ravi-dev/skills/context-cli/SKILL.md` teaches this
  surface and documents `--execute` on `context revoke`.
- `src/cli/commands/daemon.ts` prints an operator hint pointing at
  `ravi context revoke <id>`; with the brake, the operator's first run is a
  dry-run by design (the hint may later mention `--execute`, owned by the
  daemon domain).
- `.ravi/specs/wa-overlay/auth/SPEC.md` references `ravi context revoke` as the
  daemon-side key-kill path; the brake adds one explicit `--execute` step.

## Validation

- `bun test src/cli/commands/context.test.ts` green (contract blocks included),
  no new failures vs the `dev` baseline.
- Live checks (isolated `RAVI_STATE_DIR`): `context info ctx-nope --json` →
  `CONTEXT_NOT_FOUND`, exit 1; `context revoke <id> --json` → exit 3 with plan
  and the context still active; with `--execute` → revoked; `context
  credentials remove <key> --json` → exit 3 and the entry still stored; the
  dry-run plan shows key/path/label presence only; `context list --json --fields
  contextId,kind` narrows items.

## Known Failure Modes

- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
- `context.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  (returning true) or the contract helpers call `process.exit` in tests.
- The local credentials store lists full keys in its own `credentials list`
  output (the operator's own store); the secret-hygiene invariant applies to
  error envelopes, plans and suggestions — not to that explicit listing.
