---
id: cli/runtime-credentials
title: "Runtime credentials agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - runtime-credentials
tags:
  - cli
  - runtime-credentials
  - agent-first
  - error-envelope
  - exit-taxonomy
  - secret-hygiene
applies_to:
  - src/cli/commands/runtime-credentials.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Runtime credentials agent-first CLI contract

## Intent

Make `ravi runtime credentials` reliable for agent consumers under the
agent-first contract defined by `cli/crm`: typed error envelopes, the 0/1/2/3
exit taxonomy and compact discovery. The surface manages provider credential
POOLS (metadata, health, selection) — never secret values: the store only
exposes redacted serializations (`secretRef`, env names and auth-profile paths
are redacted at the source). The current surface has no destructive op, so no
new brake was introduced; every mutation is declared below.

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found) ·
   `2` usage error · `3` blocked by policy.
3. `status <id>`, `enable`, `disable`, `reset-health` and `refresh <id>` on an
   unknown credential MUST exit 1 with `CREDENTIAL_NOT_FOUND` and up to 3
   `suggestions` built from credential ids and labels — even though the
   underlying store throws plain `Error`s for the same case.
4. Secret hygiene: envelopes and suggestions MUST carry credential ids and
   labels only; secret env var names, secret values and unredacted auth
   profile paths MUST NEVER appear in an envelope.
5. `runtime credentials list` MUST accept `--fields a,b,c` for compact JSON
   output; human output stays complete.
6. All mutations on the current surface stay unbraked and MUST be listed as
   declared in the write classification below. If a destructive `remove` op is
   ever added (it is already referenced by
   `.ravi/specs/runtime/providers/credential-fallback/SPEC.md`), it MUST ship
   with the `--execute` write brake from day one.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| add | creates a managed pool entry (reversible via disable) | not braked (declared) |
| import | references an existing provider-native profile (reversible via disable) | not braked (declared) |
| enable / disable | reversible pair | not braked (declared) |
| reset-health | recoverable health-state maintenance | not braked (declared) |
| refresh | health maintenance / provider hook recovery | not braked (declared) |
| remove | DOES NOT EXIST on the current surface | future op MUST be born braked |
| exec | DOES NOT EXIST on the current surface | n/a |

## Official error cases

| case | code | exit |
|---|---|---|
| credential not found (status / enable / disable / reset-health / refresh) | `CREDENTIAL_NOT_FOUND` + id/label suggestions | 1 |
| invalid flag/arg (once the domain is registered in the usage-contract list) | `USAGE_ERROR` + acceptedFlags | 2 |

## Internal consumers

The daemon selects and refreshes credentials through the service layer
(`credential-pool.ts`, `credential-refresh.ts`), not through the CLI, so the
contract changes affect operator/agent CLI calls only. No skill currently
teaches this surface.

## Validation

- `bun test src/cli/commands/runtime-credentials.test.ts` green (contract block
  included), no new failures vs the `dev` baseline.
- Live checks (isolated `RAVI_STATE_DIR`): `runtime credentials status rc-nope
  --json` → `CREDENTIAL_NOT_FOUND`, exit 1, no secret env names in the
  envelope; `runtime credentials list --json --fields id,label` narrows items.

## Known Failure Modes

- Parser-level usage errors still follow commander's default path until
  `runtime` is added to `AGENT_CONTRACT_DOMAINS` in `src/cli/index.ts` (file
  owned by the shared-contract wave, not this domain migration).
- The store throws plain `Error("Runtime credential not found: ...")`; mapping
  by message pattern is intentional — wrapping only `getRuntimeCredential`
  would miss the enable/disable/reset-health/refresh paths.
- `runtime-credentials.test.ts` must mock `../context.js` with `hasContext`
  returning true, or the contract helpers call `process.exit` in tests.
