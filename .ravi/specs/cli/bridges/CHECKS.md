# MCP Bridges agent-first CLI contract / CHECKS

## Checks

- `bridges revoke <id>` without `--yes` and without `--execute` MUST exit 3
  with `dryRun: true` and the plan `{bridgeId, revokesClientTokens: true}`,
  and MUST NOT call the Console revoke endpoint.
- `bridges revoke <id> --execute` MUST revoke, and the legacy
  `bridges revoke <id> --yes` MUST keep revoking (documented equivalent — the
  flag is not renamed and not removed).
- `bridges create` is declared unbraked; its `bridgeToken`/`bridgeUrl` MUST
  appear only in the success payload, never in a plan or error envelope.
- `bridges list --fields a,b,c --json` MUST return bridge items containing
  only the requested fields (both `bridges` and `items` keys).
- A `ContractError` thrown inside a bridges command MUST pass through
  `runBridgesCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST keep their stable CloudAuthError codes while using the
  global exit map (`PAYLOAD_INVALID` → `2`; other provider/auth failures →
  `1`). `WRITE_REQUIRES_EXECUTE` MUST remain the only exit-3 code.
- `bun test src/cli/commands/bridges.test.ts` SHOULD pass after any change to
  this contract surface.
