# Specs agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/specs --mode rules --json`.
2. Reproduce with `--json` and branch on `error.code` first.
3. Exit `1` + `SPEC_NOT_FOUND`: read `error.suggestions` — real spec ids from
   the index. Retry with one, or scan the universe compactly:
   `ravi specs list --fields id,kind --json`.
4. Exit `2` + `USAGE_ERROR`: read `error.acceptedValues` — modes are
   `rules|full|checks|why|runbook`, kinds are `domain|capability|feature`;
   `new` also requires `--title` and `--kind`.
5. `Spec already exists` on `new` (exit 1): the id is taken. Update the
   existing spec instead of recreating it — there is deliberately no
   overwrite flag.
6. Suggestions empty on a not-found: the index may be missing or stale for
   this cwd. Run `ravi specs sync --json` (unbraked, idempotent) and retry.
7. `list`/`get` disagreeing with the Markdown on disk: the index is stale —
   `ravi specs sync --json` rebuilds it; Markdown always wins.
8. If `sync` or `new` ever demands `--execute`, the unbraked declaration
   regressed — the CI quality gate and every spec CHECKS that embeds
   `specs sync` will break; fix the CLI, not the callers.

## Validation

```bash
bun test src/cli/commands/specs.test.ts
```

Live checks (use a scratch workspace; all reads/dry-safe ops):

```bash
ravi specs get nope-spec --json                 # expect exit 1 + suggestions
ravi specs get cli/specs --mode bogus --json    # expect exit 2 + acceptedValues
ravi specs list --fields id,kind --json         # expect compact items + specs
ravi specs sync --json                          # expect status:synced, no flags needed
```
