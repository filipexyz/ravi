# Costs agent-first CLI contract / CHECKS

## Checks

- `costs agent <unknown-id> --json` MUST exit 1 with the `AGENT_NOT_FOUND`
  envelope and up to three `suggestions` from local agent ids/names, and MUST
  fire only when the agent has no config entry AND no cost history all-time.
- `costs agent <deleted-id-with-history> --json` MUST return the cost payload
  normally (deleted agents with history are not not-found).
- `costs session <unknown> --json` MUST exit 1 with `SESSION_NOT_FOUND` and
  suggestions; a raw session key with cost history MUST keep the legacy
  fallback and return its numbers.
- `costs agents --json --fields agentId,total_cost` MUST return `agents` items
  containing only the requested fields; `top-sessions` and `pricing` MUST do
  the same for `sessions` and `rows`.
- `costs pricing --recompute --dry-run --json` MUST report `recompute.dryRun:
  true` with `updated: 0` and per-row results, and MUST NOT call
  `dbUpdateCostEventPricing`.
- The `--dry-run` flag on recompute MUST NOT be renamed to `--execute`; it is
  the documented pre-existing brake equivalent.
- The `pricing` CommandAccess kind stays `read` in this wave; any flip to
  `mutate` MUST be a deliberate permission-surface change, not a drive-by.
- `bun test src/cli/commands/costs.test.ts` SHOULD pass after any change to
  the costs contract surface.
