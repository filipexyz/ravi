# Context agent-first CLI contract / CHECKS

## Checks

- `context info <unknown-id> --json` MUST exit 1 with the `CONTEXT_NOT_FOUND`
  envelope and up to three `suggestions` built from real context IDs.
- `context lineage <unknown-id> --json` MUST exit 1 with `CONTEXT_NOT_FOUND`.
- `context revoke <id>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with allowed identifiers, `cascade`, and `reasonPresent`; the
  reason text MUST NOT appear and the command MUST NOT revoke anything.
- `context revoke <id> --execute` MUST perform the revoke (cascading unless
  `--no-cascade` was passed).
- `context credentials remove <key>` without `--execute` MUST exit 3 and MUST
  NOT write the store; the plan MUST identify the entry by allowed IDs plus
  path/key/label presence flags, never path, label, full key, or masked key.
- Any error envelope, dry-run plan or suggestion list in this domain MUST NOT
  contain a full `rctx_*` context key — this is the domain's security
  invariant and outranks every convenience concern.
- `context credentials set-default <unknown-key> --json` MUST exit 1 with
  `CREDENTIAL_NOT_FOUND` and id/label suggestions.
- `context prune` MUST keep its `--apply` + `--confirm prune-contexts` brake
  unchanged (no rename to `--execute`), and without `--apply` MUST only plan.
- `context cleanup-agent-runtime` MUST keep dry-run as the default and
  `--revoke` as the explicit execute switch.
- `context list --fields a,b,c --json` and `context credentials list --fields
  a,b,c --json` MUST return items containing only the requested fields.
- The test suite `bun test src/cli/commands/context.test.ts` SHOULD pass after
  any change to this contract surface.
