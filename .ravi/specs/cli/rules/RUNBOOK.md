# Rules agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/rules --mode rules --json` (and
   `runtime/prompt-rules` for loader/runtime behavior).
2. Exit `2` + `USAGE_ERROR`: the provider filter is wrong. Read
   `error.acceptedValues` (`all`, `claude`, `agents`) and
   `error.suggestions`, fix the positional, re-run.
3. Import "did nothing": that is the native brake, not a bug. Without
   `--write` the run is a dry-run — read the `candidates` list (verbs
   `would-create`/`would-overwrite`) and re-run with `--write`.
4. Import skipped files you expected to update: second brake stage. Files
   already under `.ravi/rules/imported` are counted as `skippedExisting`
   unless you pass `--force`. Confirm the overwrite is intended first.
5. User-level rules missing from the plan: pass `--include-user` — home
   sources are excluded by default on both `sources` and `import`.
6. Rule content appearing in JSON output is a leak regression: candidates
   must serialize without `content`.
7. If an import ever writes without `--write`, or overwrites without
   `--force`, the native brake regressed in `importRaviRules` — stop and fix
   before anything else.

## Validation

```bash
bun test src/cli/commands/rules.test.ts
```

Live checks (dry-run stages are filesystem-safe):

```bash
ravi rules sources all --fields provider,exists --json   # expect compact sources
ravi rules import bogus --json                           # expect exit 2 + acceptedValues
ravi rules import claude --json                          # expect dry-run, no files
ravi rules import claude --force --json                  # still no files (no --write)
ravi rules import claude --write --json                  # creates, skips existing
ravi rules import claude --write --force --json          # overwrites existing
```
