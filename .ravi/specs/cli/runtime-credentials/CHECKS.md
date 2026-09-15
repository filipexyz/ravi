# Runtime credentials agent-first CLI contract / CHECKS

## Checks

- `runtime credentials status <unknown-id> --json` MUST exit 1 with the
  `CREDENTIAL_NOT_FOUND` envelope and up to three `suggestions` built from
  real credential ids and labels.
- `runtime credentials enable|disable|reset-health <unknown-id> --json` MUST
  exit 1 with `CREDENTIAL_NOT_FOUND` even though the store raises a plain
  `Error` for that case.
- `runtime credentials refresh <unknown-id> --json` MUST exit 1 with
  `CREDENTIAL_NOT_FOUND` on the async path too.
- Every error envelope and suggestion list in this domain MUST carry only
  credential ids and labels — secret env var names, secret values and
  unredacted auth-profile paths MUST NOT appear.
- `runtime credentials list --fields a,b,c --json` MUST return credential
  items containing only the requested fields.
- The declared unbraked mutations (`add`, `import`, `enable`, `disable`,
  `reset-health`, `refresh`) MUST keep immediate-write behavior; any future
  `remove` op MUST ship with the `--execute` write brake from its first
  release.
- The test suite `bun test src/cli/commands/runtime-credentials.test.ts`
  SHOULD pass after any change to this contract surface.
