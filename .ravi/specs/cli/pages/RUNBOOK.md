# Pages agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/pages --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `3`: read `error.plan`, confirm the exposure change is intended, then
   re-run the same command adding `--execute`. For `password set` the dry-run
   never prompts — the prompt only appears with `--execute`.
4. Exit `1` + `SITE_NOT_FOUND`: list the real sites with `ravi pages list
   --json` and retry with an existing slug/id.
5. Exit `1` + `ROUTE_NOT_FOUND`: list the live routes with `ravi pages
   published --json`.
6. `PAYLOAD_INVALID` on `password remove`: the replacement `--visibility` is
   missing or invalid — it is validated BEFORE the brake, on purpose.
7. `AUTH_REQUIRED`/`AUTH_EXPIRED`: legacy CloudAuthError funnel, not the
   contract — run `ravi login`.
8. If a publish/password write executed without `--execute`, the brake
   regressed: check the op still calls `contractDryRun` before
   `resolvePagesProject` (publish/password) or before `updatePageSite`
   (update/visibility with `public`).
9. If a braked op in agent context reports a CloudAuthError instead of the
   dry-run envelope, `runPagesCommand` lost the ContractError rethrow.

## Validation

```bash
bun test src/cli/commands/pages.test.ts
```

Live checks against the local CLI (read-only or dry-run):

```bash
ravi pages publish proj site ./dist --route / --visibility public --json  # expect exit 3 + plan, no Console call
ravi pages password set proj site --route / --json                        # expect exit 3, no prompt
ravi pages password remove proj site --route / --json                     # expect PAYLOAD_INVALID (missing --visibility)
ravi pages visibility proj site public --json                             # expect exit 3
ravi pages visibility proj site private --json                            # immediate write (no brake on reductions)
ravi pages list --fields slug,status --json                               # expect compact items
```
