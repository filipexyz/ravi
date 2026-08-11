# Insights agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/insights --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `INSIGHT_NOT_FOUND`: read `error.suggestions` — real local
   insight ids similar to what was asked. Retry with one of them, or list:
   `ravi insights list --json --fields id,summary`.
4. Exit `2` + `USAGE_ERROR`: read `error.acceptedValues` when present — the
   list is authoritative for that flag (kinds, confidence/importance levels,
   link types). For `--limit`, use a positive integer.
5. A `USAGE_ERROR` on `create` wrote nothing; fix the flag and re-run the
   same command — no cleanup needed.
6. Payload too large: `list` and `search` accept `--fields a,b,c`; note that
   `--rich` ignores `--fields` (its overlay shape is fixed).
7. If `list --json` shows `items` and `insights` diverging, projection
   regressed: both keys must reference the same projected array.

## Validation

```bash
bun test src/cli/commands/insights.test.ts
```

Live checks against the local CLI (read-only except the reversible create):

```bash
ravi insights show ins-nope --json                 # expect exit 1 + suggestions
ravi insights list --kind bogus --json             # expect exit 2 + acceptedValues
ravi insights list --json --fields id,kind         # expect compact items
ravi insights search "texto" --json --fields id    # expect compact items
```
