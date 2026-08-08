# Artifacts agent-first CLI contract / CHECKS

## Checks

- `artifacts show <unknown-id> --json` MUST exit 1 with the `ARTIFACT_NOT_FOUND`
  envelope and up to three `suggestions` of real ledger ids/titles.
- Every id-taking op (`snapshot`, `versions`, `version`, `restore`, `update`,
  `attach`, `archive`, `event`, `events`) on an unknown artifact MUST exit 1
  with `ARTIFACT_NOT_FOUND` even though the store throws instead of returning
  null.
- `artifacts version <id> --version <unknown-n> --json` and `artifacts restore
  <id> --version <unknown-n> --json` MUST exit 1 with
  `ARTIFACT_VERSION_NOT_FOUND` and a suggestedAction pointing at
  `ravi artifacts versions <id> --json`.
- `artifacts publish` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the publish `plan`, and MUST NOT open an upload session
  or call Console at all; with `--execute` the upload/release MUST happen. The
  plan MUST expose presence booleans rather than route, published-name or
  entrypoint bytes.
- `artifacts release activate` without `--execute` MUST exit 3 and MUST NOT
  call Console; with `--execute` the activation MUST happen.
- A `ContractError` thrown by the brake or a not-found envelope MUST pass
  through the CloudAuthError funnel of `publish`/`release activate` and the
  legacy try/catch of `events` untouched (rethrow-first).
- `artifacts list --fields a,b,c --json` MUST return items containing only the
  requested fields on the standard listing.
- Unbraked writes (`create`, `update`, `attach`, `event`, `snapshot`,
  `archive`, `restore`) MUST keep immediate-write behavior, and the shipped
  `artifacts` skill MUST list them explicitly as unbraked.
- The `blob` op MUST stream raw bytes on success and normalize non-success
  responses to the shared contract without exposing the response body.
- `bun test src/cli/commands/artifacts.test.ts` SHOULD pass after any change to
  the artifacts contract surface.
