# YouTube agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/youtube --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `VIDEO_NOT_FOUND`: run `ravi yt videos --json` or `ravi yt
   search <query> --json` to find the correct video ID — there is no local
   cache to suggest from.
4. Exit `3`: read `error.plan`, confirm the public write is intended (HITL:
   show the exact text/fields to a human), then re-run adding `--execute`.
5. Exit `1` with the `ravi yt health` hint: credential/provider problem — run
   `ravi yt health --json` and check the connection before retrying; never
   blind-retry a write.
6. If a braked op wrote without `--execute`, the brake regressed: check the op
   still calls `contractDryRun` BEFORE `this.execute(...)`, and that the
   execute wrapper still rethrows `ContractError`.

## Validation

```bash
bun test src/cli/commands/youtube.test.ts
```

Live checks (dry-run only — never publish for validation):

```bash
ravi yt video nope --json                       # expect exit 1 + VIDEO_NOT_FOUND
ravi yt reply <commentId> "texto" --json        # expect exit 3 + dryRun plan
ravi yt playlist-delete <playlistId> --json     # expect exit 3, playlist intact
ravi yt videos --fields videoId,title --json    # expect compact items
```
