# Watch CLI / RUNBOOK

## Discover

```bash
ravi watch connectors
ravi watch connectors --json
```

## Create Npm Watch

```bash
ravi watch create npm zod --event package.version_published
```

## Create GitHub Watch

```bash
ravi watch create github owner/repo --event release.published
```

For webhook-backed GitHub watches this should resolve to Console placement when
the Ravi GitHub App is installed:

```text
GET  /api/cli/watches/capabilities?provider=github&eventTypes=release.published
POST /api/cli/watches
```

## Notify Current Group

From the target group chat (dry-run first, then execute):

```bash
ravi watch trigger <watch-id> --message "Resume o evento e diga se precisamos agir."           # exit 3 + plan
ravi watch trigger <watch-id> --message "Resume o evento e diga se precisamos agir." --execute
```

## Inspect

```bash
ravi watch list
ravi watch show <watch-id>
ravi watch events <watch-id>
```

## Stop

```bash
ravi watch disable <watch-id>
ravi triggers disable <trigger-id>
ravi watch rm <watch-id>            # dry-run: exit 3 + plan
ravi watch rm <watch-id> --execute  # actually removes
```

## Agent-First Contract Debug Flow

1. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
2. Exit `1` + `WATCH_NOT_FOUND`: read `error.suggestions` — live watch
   ids/names/resources similar to what was asked. Retry with one of them.
3. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
4. Exit `3`: read `error.plan` (for `trigger` it shows the resolved watch and
   the exact trigger record), confirm it is intended, then re-run the same
   command adding `--execute`.
5. If a braked op (`rm`, `trigger`, `run`) mutated without `--execute`, the
   brake regressed: check the op still calls `contractDryRun` before the
   service call and that `runWatchCommand` still rethrows `ContractError`.

## Validation

```bash
bun test src/cli/commands/watch.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi watch show nope --json                                   # expect exit 1 + suggestions
ravi watch list --no-such-flag --json                         # expect exit 2 + acceptedFlags
ravi watch rm <watch-id> --json                               # expect exit 3 + dryRun plan
ravi watch trigger <watch-id> --message "teste" --json        # expect exit 3 + resolved plan
ravi watch list --fields id,provider,status --json            # expect compact items
```
