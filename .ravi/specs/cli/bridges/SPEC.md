---
id: cli/bridges
title: "MCP Bridges agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - bridges
tags:
  - cli
  - bridges
  - mcp
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/bridges.ts
  - src/bridges/client.ts
  - src/cli/agent-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---
# MCP Bridges agent-first CLI contract

## Intent

Make `ravi bridges` (Ravi MCP bridges managed through Console) reliable for
agent consumers under the agent-first contract defined by `cli/crm`: typed
error envelopes, the 0/1/2/3 exit taxonomy, a write brake on the destructive
revoke, and compact discovery. Bridges are remote Console resources; remote
errors keep the legacy CloudAuthError funnel, with `ContractError` rethrown
before it.

## Invariants

1. With `--json`, every failure raised by the contract layer MUST return the
   envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
2. Exit codes on contract paths MUST follow the taxonomy: `0` success · `1`
   error · `2` usage error · `3` blocked by policy (write brake).
3. `bridges revoke` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and the plan `{bridgeId,
   revokesClientTokens}`, and MUST NOT call Console. The pre-existing `--yes`
   flag is the documented equivalent of `--execute` (not renamed): `--yes`
   alone still revokes.
4. `bridges create` is declared UNBRAKED: it mints a new bridge (additive, no
   existing resource is touched) and its reverse path is the braked `revoke`.
   The returned `bridgeToken`/`bridgeUrl` appear only in the success payload —
   never in any plan or error envelope.
5. `bridges list` MUST accept `--fields a,b,c` for compact output.
6. A `ContractError` thrown inside a command MUST pass through
   `runBridgesCommand` untouched — the legacy CloudAuthError funnel MUST NOT
   rewrap it.
7. Remote failures (missing project, auth, Console denials) keep the legacy
   CloudAuthError funnel with its pre-existing code/exit map.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| revoke | destructive (kills bridge + every OAuth token minted for it) | dry-run + `--execute` (`--yes` = documented equivalent) |
| create | additive mint with braked reverse path | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| braked revoke without `--yes`/`--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| remote/provider errors | legacy CloudAuthError codes (`AUTH_REQUIRED`, `PAYLOAD_INVALID`, ...) | legacy CloudAuthError exit map |

## Internal consumers

`cli/console-scope` lists `ravi bridges list|create` among the commands that
should adopt the shared Console scope resolver; that adoption is orthogonal to
this contract. There is no shipped `bridges` skill — lacuna registrada; the
CLI `--help` plus this spec are the teaching surface.

## Validation

- `bun test src/cli/commands/bridges.test.ts` green (contract describes
  included).
- `bun run typecheck` clean.

## Known Failure Modes

- The `bridges` domain root is not yet listed in `AGENT_CONTRACT_DOMAINS`
  (`src/cli/index.ts`, out of scope for this migration lot), so commander
  parser usage errors still print plain text with exit 1 instead of the
  `USAGE_ERROR` envelope with exit 2.
- The legacy CloudAuthError funnel has its own conflicting exit map
  (`PAYLOAD_INVALID` → 3): a missing `--project` can exit 3 without being a
  write brake. Read `error.code`, not the exit code, to distinguish.
- Before the rethrow guard, a `ContractError` thrown by the brake was
  rewrapped as `SERVER_UNAVAILABLE` exit 5 by `cloudAuthErrorFromUnknown`.
