# Metrics agent-first CLI contract / CHECKS

## Checks

- `metrics show --by <invalid> --json` MUST exit 2 with the `USAGE_ERROR`
  envelope, `acceptedValues: ["agent", "agent-model", "date"]`, and MUST NOT
  query `daily_metrics`.
- `metrics show --json --fields a,b` MUST return rows containing only the
  requested fields, in both the printed JSON and the returned tool payload.
- `metrics rollup` MUST stay unbraked: no `--execute` flag exists and the
  derived write happens immediately; re-running the same range MUST be
  idempotent.
- The `rollup` CommandAccess kind stays `read` in this wave; any flip to
  `mutate` MUST be a deliberate permission-surface change, not a drive-by.
- An empty `metrics show` result MUST NOT be treated as not-found; the domain
  declares no `*_NOT_FOUND` envelope.
- `metrics dates` keeps its scalar string-array payload; `--fields` is
  declared not applicable there.
- `bun test src/cli/commands/metrics.test.ts` SHOULD pass after any change to
  the metrics contract surface.
