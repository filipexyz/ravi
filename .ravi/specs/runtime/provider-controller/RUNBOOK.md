# Runtime Provider Controller / RUNBOOK

## Debug Flow

Use this flow when an agent did not switch providers, switched unexpectedly, or
leaked runtime internals to an external chat.

1. Confirm the effective target policy.

   ```bash
   ravi runtime targets explain --agent <agent-id> --json
   ```

   If the source is `none`, the agent is not controlled by target failover. Fix
   posture through controller dry-run/apply or an explicit agent/task/session
   policy. Do not infer fallback from installed credentials.

2. Inspect provider access.

   ```bash
   ravi runtime credentials status --json
   ravi runtime credentials select --provider <provider> --model <model> --json
   ```

   Distinguish these states:

   - managed credential slot exists and is healthy;
   - managed slot exists but is disabled, exhausted, invalid, or in cooldown;
   - provider-native profile exists as a read-only slot;
   - provider may be authenticated through legacy untracked auth;
   - no usable access is visible.

3. Inspect the configured chain.

   The selected policy should name each target in order, required capabilities,
   model selectors, and credential constraints. A chain that omits Codex or Pi
   cannot fall back to them even if those tools are authenticated.

4. Verify failure classification.

   Provider failures that mention quota, disabled subscription, billing, auth,
   permissions, or rate limits should appear as canonical runtime failures, not
   successful assistant responses. If a provider emitted `assistant.message`
   before the failure was classified, inspect the terminal event that committed
   the logical turn.

5. Check replay safety.

   If a tool or side effect already happened, target switching may be blocked by
   policy. That is expected. The terminal response should explain exhaustion or
   replay block without exposing raw provider output.

6. Check external delivery.

   If a chat received a `[System]` envelope, raw command frame, stack trace, or
   raw provider error, treat it as a delivery-boundary bug. The runtime trace may
   keep internal detail, but external assistant output must be sanitized.

7. Check no-output turns.

   A turn that appears stuck should have runtime status showing active provider,
   active tool if any, last progress timestamp, and timeout/escalation policy.
   If no status exists, the host loop is missing observability for that state.

## Controller Rollout Flow

1. Run a read-only fleet audit.
2. Generate a dry-run plan for the intended agent set.
3. Review affected agents, current source, proposed target chain, access gaps,
   risk flags, and rollback identifiers.
4. Apply only the reviewed plan id/hash.
5. Re-run explain/status for sampled agents across Claude, Codex, and Pi.
6. Exercise a controlled failure scenario before declaring the rollout live.

## Emergency Mitigation

If controller behavior causes broad regression, disable or clear the explicit
policy at the affected scope and return to single-target behavior. Do not patch
provider adapters to skip the controller; that creates an unaudited second
fallback path.
