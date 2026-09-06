# Pages agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/pages --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `3`: this is only a remaining brake (`domains`, `password set/remove`,
   or `update`/`visibility` switching to `public`). Read `error.plan`, confirm
   the exposure change is intended, then re-run the same command adding
   `--execute`. For `password set` the dry-run never prompts — the prompt only
   appears with `--execute`. `ship`, `create` and `publish` do not use this
   path; leftover `--execute` on those ops is ignored.
4. Exit `1` + `SITE_NOT_FOUND`: list the real sites with `ravi pages list
   --json` and retry with an existing slug/id.
5. Exit `1` + `ROUTE_NOT_FOUND`: list the live routes with `ravi pages
   published --json`.
6. `PAYLOAD_INVALID` on `password remove`: the replacement `--visibility` is
   missing or invalid — it is validated BEFORE the brake, on purpose.
7. `AUTH_REQUIRED`/`AUTH_EXPIRED`: legacy CloudAuthError funnel, not the
   contract — run `ravi login`.
8. If a domains/password write, or a visibility switch to `public`, executed
   without `--execute`, the brake regressed: check the op still calls
   `contractDryRun` before `resolvePagesProject` (domains/password) or before
   `updatePageSite` (update/visibility with `public`).
9. If `pages ship`, `pages create` or `pages publish` exits 3 with
   `WRITE_REQUIRES_EXECUTE`, the unbrake regressed: those ops must write
   immediately and treat `--execute` as a no-op.
10. If a braked op in agent context reports a CloudAuthError instead of the
    dry-run envelope, `runPagesCommand` lost the ContractError rethrow.

## Validation

```bash
bun test src/cli/commands/pages.test.ts
```

Live checks against the local CLI (read-only or dry-run):

```bash
ravi pages ship --title "Demo" --body "<h1>OK</h1>" --json               # happy path: ensure-host + publish immediately
ravi pages create proj site --visibility private --json                   # advanced/compat: writes the host immediately
ravi pages publish proj site ./dist --route / --visibility public --json  # advanced/compat: publishes immediately
ravi pages domains proj site docs.example.com --json                      # expect exit 3 before credentials
ravi pages domains proj site docs.example.com --execute                  # add shown DNS records, then rerun
ravi pages password set proj site --route / --json                        # expect exit 3, no prompt
ravi pages password remove proj site --route / --json                     # expect PAYLOAD_INVALID (missing --visibility)
ravi pages visibility proj site public --json                             # expect exit 3
ravi pages visibility proj site private --json                            # immediate write (no brake on reductions)
ravi pages list --fields slug,status --json                               # expect compact items
```
