# Metrics agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/metrics --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `2` + `USAGE_ERROR`: read `error.acceptedValues` — for `--by` the
   only dimensions are `agent`, `agent-model`, `date`.
4. Empty report: this is NOT an error. Check `ravi metrics dates --json` — if
   the range has no rolled-up dates, run `ravi metrics rollup` (unbraked,
   idempotent) and re-read.
5. Payload too large in a loop: re-run `show` with `--fields` naming only the
   columns you need.
6. Numbers look stale: the daemon refreshes roll-ups on its own interval;
   `ravi metrics rollup --since <date>` backfills or refreshes a range
   explicitly. Re-running the same range twice MUST be a no-op difference —
   if it is not, the rollup lost idempotency (see `rollupDailyMetrics`).

## Validation

```bash
bun test src/cli/commands/metrics.test.ts
```

Live checks against the local CLI (read-only or idempotent):

```bash
ravi metrics show --by bogus --json                     # expect exit 2 + acceptedValues
ravi metrics show --json --fields agentId,totalCostUsd  # expect compact rows
ravi metrics dates --json                               # expect scalar date list
ravi metrics rollup --json                              # idempotent derived write
```
