# Settings agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/settings --mode rules --json`.
2. Reproduce the failing call with `--json` and branch on `error.code`, not on
   the message text.
3. Exit `1` + `SETTING_NOT_FOUND`: read `error.suggestions` — real keys from
   the known-settings catalog plus keys actually set. Retry with one, or list
   the universe: `ravi settings list --json` (add `--legacy` for `account.*`).
4. Exit `3`: read `error.plan` — it carries `key`, `valuePresent`, `legacy`,
   `known`. Confirm the key is the one you intend to erase, then re-run the
   same command adding `--execute`. The plan intentionally omits the current
   value and reports only whether one is present.
5. A legacy `account.*` read/write pointing you to `ravi instances` is not a
   contract error — it is the migration hint; follow it.
6. If a `delete` executed without `--execute`, the brake regressed: check that
   `delete` still calls `contractDryRun` before `dbDeleteSetting`, and that
   the registry dispatcher still maps `ContractError.exitCode`.
7. If a delete succeeded but the daemon did not pick it up, check that
   `emitConfigChanged()` ran (it only fires after a real delete).

## Validation

```bash
bun test src/cli/commands/settings.test.ts
```

Live checks against the local CLI (use an isolated `RAVI_STATE_DIR`):

```bash
ravi settings get bogusKey --json                 # expect exit 1 + suggestions
ravi settings set custom.probe on
ravi settings delete custom.probe --json          # expect exit 3 + dryRun plan
ravi settings delete custom.probe --execute --json  # expect deleted
ravi settings list --fields key,value --json      # expect compact items
```
