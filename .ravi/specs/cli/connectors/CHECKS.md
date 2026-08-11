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
- `connectors connect --no-open --json` MUST return one parseable `started`
  document immediately. A waiting JSON flow MUST emit exactly one terminal
  success or one canonical `CONNECTOR_AUTH_*` failure with exit 1.
- `connectors list --fields a,b,c --json` MUST return connection items
  containing only the requested fields.
- A `ContractError` thrown inside a connectors command MUST pass through
  `runConnectorCommand` with its exit code intact — never rewrapped as
  `SERVER_UNAVAILABLE`.
- Remote failures MUST keep their stable CloudAuthError codes while using the
  global exit map (`PAYLOAD_INVALID` → `2`; other provider/auth failures →
  `1`). `WRITE_REQUIRES_EXECUTE` MUST remain the only exit-3 code.
- `bun test src/cli/commands/connectors.test.ts` SHOULD pass after any change
  to this contract surface.
