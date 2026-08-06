---
id: cli/credentials
title: "Credentials agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - credentials
tags:
  - cli
  - credentials
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - secret-hygiene
applies_to:
  - src/cli/commands/credentials.ts
  - src/credentials/broker.ts
  - src/credentials/store.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Credentials agent-first CLI contract

## Intent

Make `ravi credentials` (groups `connections`, `policies`, `broker`) reliable
for agent consumers under the agent-first contract defined by `cli`: typed
error envelopes, the 0/1/2/3 exit taxonomy, a write brake on the riskiest
mutations, and compact discovery — with one domain-specific hardening on top:
credential material is radioactive, so secret values and secret refs MUST NOT
appear in any plan, envelope, or suggestion.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy (write brake).
3. `connections show|remove|enable|disable` and `broker exec` on an unknown
   `provider:connection` MUST exit 1 with `CREDENTIAL_CONNECTION_NOT_FOUND` and
   up to 3 `suggestions` built from local `provider:connection` pairs and ids.
4. `connections remove` and `broker exec` MUST default to dry-run and require
   `--execute`; the dry-run MUST report `dryRun: true` and the `plan`, and MUST
   NOT remove metadata, delete secrets, or resolve any backend secret.
5. Anti-leak: plans, envelopes, and suggestions MUST NOT contain secret values,
   raw `secretRef` strings, or backend paths. Success payloads keep using
   `publicCredentialConnection` (redacted `secretRef`).
6. `broker exec --dry-run` keeps the pre-existing exit-0 planned payload as the
   documented equivalent (not renamed); the contract brake applies when neither
   `--dry-run` nor `--execute` is passed.
7. `connections list` MUST accept `--fields a,b,c` for compact output.
8. Unbraked writes (`connections add`, `enable`, `disable`) keep their
   immediate-write behavior and MUST be declared as unbraked in this spec.
9. Validation (required flags, connection existence) runs BEFORE the brake:
   an invalid call never produces a dry-run plan.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| connections remove | destructive (metadata + optional backend secret deletion) | dry-run + `--execute` |
| broker exec | resolves a REAL backend credential inside the broker boundary (high) | dry-run + `--execute` (`--dry-run` = legacy exit-0 plan) |
| connections add | upsert with reverse path (remove) | not braked (declared) |
| connections enable / disable | reversible pair | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| connection not found | `CREDENTIAL_CONNECTION_NOT_FOUND` + suggestions | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |

## Internal consumers

`ravi channels create|set --credential-connection` validates against this store
and reuses the same `CREDENTIAL_CONNECTION_NOT_FOUND` envelope (see
`cli/channels`). There is no shipped `credentials` skill yet — lacuna
registrada; the CLI `--help` plus this spec are the teaching surface.

## Validation

- `bun test src/cli/commands/credentials.test.ts` green (contract describes
  included; anti-leak assertions check the serialized envelope for the planted
  secret value and secret ref).
- `bun run typecheck` clean.

## Known Failure Modes

- Parser usage errors use the global exit-2 `USAGE_ERROR` envelope because the
  `credentials` root is registered in `AGENT_CONTRACT_DOMAINS`.
- `broker exec` predates the brake with an opt-in `--dry-run`; inverting its
  polarity silently (making `--dry-run` the default semantics of the same
  flag) would break scripts — that is why the brake is a separate `--execute`
  and `--dry-run` stays as the legacy exit-0 planned payload.
- `removeCredentialConnection` returns `null` for unknown targets; checking
  only its return value would put the not-found AFTER the brake. The command
  pre-checks with `getCredentialConnection` so validation stays before the
  dry-run.
