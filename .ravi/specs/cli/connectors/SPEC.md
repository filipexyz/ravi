---
id: cli/connectors
title: "Connectors agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - connectors
tags:
  - cli
  - connectors
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/connectors.ts
  - src/link/connectors.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Connectors agent-first CLI contract

## Intent

Make `ravi connectors` (external service connections via Ravi Console/Link)
reliable for agent consumers under the agent-first contract defined by
`cli`: typed error envelopes, the 0/1/2/3 exit taxonomy, a write brake on
the destructive revoke, and compact discovery. Connectors are remote Console
resources, so the not-found surface stays with the provider (Link/Console
errors through the legacy CloudAuthError funnel) instead of inventing local
suggestions that would require extra remote calls.

## Invariants

1. With `--json`, every failure raised by the contract layer MUST return the
   envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes on contract paths MUST follow the taxonomy: `0` success · `1`
   error · `2` usage error · `3` blocked by policy (write brake).
3. `connectors revoke` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the `plan` (`{id,
   deletesStoredCredentials}`), and MUST NOT call the Link API. The
   pre-existing `--yes` flag is the documented equivalent of `--execute` (not
   renamed): `--yes` alone still revokes.
4. `connectors connect` is declared UNBRAKED: it is a human-in-the-loop
   browser OAuth flow — nothing is granted until the human consents in the
   provider page, so an exit-3 plan would add friction without preventing any
   write.
5. `connectors list` MUST accept `--fields a,b,c` for compact output.
6. A `ContractError` thrown inside a command MUST pass through
   `runConnectorCommand` untouched — the legacy CloudAuthError funnel MUST NOT
   rewrap it (which would corrupt the exit taxonomy).
7. Remote failures (auth, project resolution, unknown connector ids) preserve
   their stable CloudAuthError code through the global taxonomy:
   `PAYLOAD_INVALID` exits `2`; other provider/auth failures exit `1`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | destructive (deletes stored provider tokens) | dry-run + `--execute` (`--yes` = documented equivalent) |
| connect | human-in-the-loop browser OAuth | not braked (declared interactive) |

## Official error cases

| case | code | exit |
|---|---|---|
| braked revoke without `--yes`/`--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| remote/provider errors | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

`gmail`, `calendar`, and `drive` CLIs wrap `execCapability` re-exported from
this command module; they consume the helper, not the braked `revoke`. There
is no shipped `connectors` skill — lacuna registrada; the CLI `--help` plus
this spec are the teaching surface.

## Validation

- `bun test src/cli/commands/connectors.test.ts` green (contract describes
  included).
- `bun run typecheck` clean.

## Known Failure Modes

- Parser usage errors use the global exit-2 `USAGE_ERROR` envelope because the
  `connectors` root is registered in `AGENT_CONTRACT_DOMAINS`.
- The shared transport boundary MUST normalize the CloudAuthError object's
  historical exit map. `WRITE_REQUIRES_EXECUTE` is the only exit-3 code.
- Before the rethrow guard, a `ContractError` thrown by the brake was
  rewrapped as `SERVER_UNAVAILABLE` exit 5 by `cloudAuthErrorFromUnknown`,
  silently defeating the taxonomy.
