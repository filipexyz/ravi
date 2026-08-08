# Instances & routes agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/instances --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `INSTANCE_NOT_FOUND`: read `error.suggestions` — real instance
   names/omni instanceIds similar to what was asked. Retry with one of them.
4. Exit `1` + `ROUTE_NOT_FOUND`: read `error.suggestions` — real patterns of
   that instance. Quote patterns with `*` in the shell.
5. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
6. Exit `3` is expected only for `pending reject`: read the instance, pending
   kind, and presence flags in `error.plan`, confirm, and re-run with
   `--execute`.
7. `instances delete` and `instances routes remove` are immediate recoverable
   soft-deletes. If either exits 3, an obsolete brake was reintroduced. Route
   removal must still enforce `assertInstanceMutationRuntime` before writing.
8. If a route mutation "succeeded" but live traffic still goes elsewhere, that
   is not a contract failure — run `ravi routes explain <instance> "<pattern>"`
   and compare config route vs live winner (see the CLI Runtime Hierarchy notes
   in AGENTS.md).

## Validation

```bash
bun test src/cli/commands/routes.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi instances show nope --json                       # expect exit 1 + suggestions
ravi routes show main nope --json                     # expect exit 1 + ROUTE_NOT_FOUND
ravi instances list --no-such-flag --json             # expect exit 2 + acceptedFlags
ravi instances delete main --json                     # expect exit 0 + soft-delete
ravi instances routes remove main "5511*" --json      # expect exit 0 + soft-delete
ravi instances pending reject main 5511999 --json     # expect exit 3 + kind/presence plan
ravi routes list --fields pattern,agent --json        # expect compact items
ravi instances list --fields name,channel --json      # expect compact items
```
