# Connectors agent-first CLI contract / CHECKS

## Checks

- `connectors revoke <id>` without `--yes` and without `--execute` MUST exit 3
  with `dryRun: true` and the plan `{id, deletesStoredCredentials: true}`, and
  MUST NOT call the Link revoke endpoint.
- `connectors revoke <id> --execute` MUST revoke, and the legacy
  `connectors revoke <id> --yes` MUST keep revoking (documented equivalent —
  the flag is not renamed and not removed).
- `connectors connect` is declared unbraked (human-in-the-loop browser OAuth)
  and MUST NOT gain an `--execute` requirement.
- `connectors list --fields a,b,c --json` MUST return connection items
  containing only the requested fields.
- A `ContractError` thrown inside a connectors command MUST pass through
  `runConnectorCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST keep the legacy CloudAuthError codes and exit map; the
  brake code `WRITE_REQUIRES_EXECUTE` MUST remain the only exit-3 emitted by
  the contract layer itself.
- `bun test src/cli/commands/connectors.test.ts` SHOULD pass after any change
  to this contract surface.
