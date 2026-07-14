# Runtime Target Failover Operator CLI / RUNBOOK

## Operator flow

1. Inspect the configured policy and ordered target ids:

   `ravi runtime targets show --agent <agent> --json`

2. Run a stateless eligibility preflight, with provenance and rejection reasons,
   without launching a turn or evaluating session cooldown/circuit history:

   `ravi runtime targets explain --agent <agent> --json`

3. Replace/create a complete validated policy:

   `ravi runtime targets set --agent <agent> --policy-json '<json>' --json`

4. Reorder an existing policy without reconstructing it:

   `ravi runtime targets reorder --agent <agent> --order codex-live,claude-main,pi-main --json`

5. Disable failover and return to single-target behavior:

   `ravi runtime targets clear --agent <agent> --json`

Changes are live after the config-change event; do not restart the daemon merely
to apply policy configuration.

## Debug flow

1. If `runtime --help` omits `targets`, verify the source barrel includes
   `runtime-targets.ts`, rebuild the CLI, and compare the executable bundle with
   the intended worktree.
2. If `show` reports no policy, the agent is intentionally in single-target
  mode. Use `set --policy-json` before attempting `reorder`.
3. If reorder fails, use the exact ids returned by `show.order`; the list must
   contain every id exactly once.
4. If `explain` rejects a target, inspect the redacted reason and use
   `ravi runtime credentials status` or agent runtime permissions. Do not put
   secrets in policy JSON.
5. For `health-aware`, configured order is only the tie-breaker. Use
   `sessions trace` for live session health; stateless `explain` does not
   reconstruct cooldown/circuit history.
6. Use `ravi sessions trace <session>` to confirm `runtime.target.*` events for
   actual turns.
