# Costs agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/costs --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `AGENT_NOT_FOUND` / `SESSION_NOT_FOUND`: read
   `error.suggestions` — real local agent ids / session names. If you expected
   history for a deleted entity, remember not-found only fires when there is
   ALSO zero cost history all-time; a hit here means the id truly never
   existed.
4. Payload too large: re-run with `--fields` naming only the columns you need
   (`agents`, `top-sessions` and `pricing` project their array payloads).
5. Recompute looks wrong: re-run with `--recompute --dry-run --json` and read
   `recompute.rows` — per-row `pricingStatus`/`pricingError` explain what the
   real run would write. Only drop `--dry-run` after the preview is right.
6. If a `--dry-run` recompute changed `pricing_status` on re-read, the
   preview regressed: check `recomputePricingRows` still gates
   `dbUpdateCostEventPricing` behind `!dryRun`.

## Validation

```bash
bun test src/cli/commands/costs.test.ts
```

Live checks against the local CLI (read-only or dry-run):

```bash
ravi costs agent ghost-xyz --json                      # expect exit 1 + suggestions
ravi costs session nope-xyz --json                     # expect exit 1 + suggestions
ravi costs agents --json --fields agentId,total_cost   # expect compact items
ravi costs pricing --recompute --dry-run --json        # expect recompute.updated: 0
```
