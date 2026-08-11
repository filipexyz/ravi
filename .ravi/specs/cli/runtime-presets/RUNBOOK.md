# Runtime presets agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/runtime-presets --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `PRESET_NOT_FOUND`: read `error.suggestions` — live preset ids
   similar to what was asked. Retry with one of them, or list with
   `ravi runtime presets list --json`.
4. Exit `1` with a `Next:` hint (no envelope code): that is a store guard —
   most often "agents still reference it". Follow the hint
   (`ravi runtime presets impact <id> --json`) and repoint or migrate the
   referencing agents before disable/delete.
5. Previewing a mutation: add `--dry-run` (this domain's documented
   equivalent) — `set`, `enable`, `disable` and `delete` all support it and
   report `dryRun: true` without persisting or bumping the version.
6. If a `--dry-run` call persisted anything, the local equivalent regressed:
   check the store still short-circuits on `options.dryRun` before
   `executeWrite`.

## Validation

```bash
bun test src/cli/commands/runtime-presets.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi runtime presets show nope --json                  # expect exit 1 + id suggestions
ravi runtime presets delete <id> --dry-run --json      # expect dryRun:true, preset kept
ravi runtime presets set <id> model sonnet-4 --dry-run --json  # expect preview, no version bump
ravi runtime presets list --fields id,enabled --json   # expect compact items
```
