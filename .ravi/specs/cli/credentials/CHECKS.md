# Credentials agent-first CLI contract / CHECKS

## Checks

- `credentials connections show|enable|disable|remove` and `credentials broker
  exec` on an unknown `provider:connection` MUST exit 1 with the
  `CREDENTIAL_CONNECTION_NOT_FOUND` envelope and up to three `suggestions`
  built from local `provider:connection` pairs and ids.
- `credentials connections remove` without `--execute` MUST exit 3 with
  `dryRun: true` and the removal `plan`, and MUST NOT remove metadata nor
  delete any backend secret; with `--execute` the write MUST happen, and
  `--delete-secret` MUST additionally delete the backend secret.
- `credentials broker exec` without `--dry-run` and without `--execute` MUST
  exit 3 with a policy-only plan and MUST NOT resolve any backend secret; with
  `--execute` the broker resolution MUST happen; with the legacy `--dry-run`
  the pre-existing exit-0 planned payload MUST be preserved.
- Every plan, error envelope, and suggestion list in this domain MUST NOT
  contain secret values, raw `secretRef` strings, or backend secret paths —
  the serialized envelope of each contract test is asserted against planted
  secret material.
- Validation (required flags, connection existence) MUST run before the brake:
  an unknown target exits 1, never 3.
- `credentials connections add`, `enable`, and `disable` are declared unbraked
  and MUST keep immediate-write behavior.
- `credentials connections list --fields a,b,c --json` MUST return items
  containing only the requested fields.
- `bun test src/cli/commands/credentials.test.ts` SHOULD pass after any change
  to this contract surface.
