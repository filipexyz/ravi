# Runtime Provider Controller / CHECKS

## Checks

### C1 - Explicit policy materialization

- Inspect controller code paths for provider switching.
- Pass: every cross-provider target is named by an effective
  `RuntimeTargetPolicy` or a dry-run/apply plan, and no fallback is triggered
  only because credentials or provider profiles exist on disk.

### C2 - Preserve existing target semantics

- Test: target switching occurs through host policy events, not provider adapter
  local branches.
- Suggested command:

  ```bash
  bun test src/runtime/runtime-target-failover.e2e.test.ts
  ```

### C3 - KISS first rollout

- Inspection: v1 apply writes `defaults.runtimeTargetPolicy` or another
  existing approved scope.
- Pass: `RuntimeTargetPolicySource` is unchanged unless SDK, registry, and this
  spec are updated together.

### C4 - Provider access inventory

- Demonstration:

  ```bash
  ravi runtime credentials status --json
  ```

- Pass: output distinguishes managed credential slots, provider-native
  read-only slots, and legacy untracked auth for controlled providers.

### C5 - Same-provider-first recovery

- Test a chain with two credentials for provider A and one target for provider B.
- Pass: provider A credential recovery/rotation is exhausted before provider B
  target selection.

### C6 - Fleet dry-run before apply

- Demonstration:

  ```bash
  ravi runtime controller plan --dry-run --json
  ```

  or the final chosen equivalent.

- Pass: output includes affected agents, current source, proposed policy, target
  order, missing access, risk flags, and rollback id; no database mutation
  occurs.

### C7 - Minimal mutation

- Test: snapshot an agent record before apply, apply a controller plan, and diff
  unrelated defaults/task settings.
- Pass: only controller-owned runtime target fields change.

### C8 - Sanitized external delivery

- Test fixtures containing:
  - `[System] Execute: ...`
  - `[System] Answer: ...`
  - raw provider 429/401/402 messages
  - stack traces

- Pass: external delivery blocks or sanitizes them while diagnostics retain
  redacted internal detail.

### C9 - Canonical terminality

- Test: provider emits operational failure text as assistant content followed by
  completion.
- Pass: host records a runtime failure class, skips false success, and continues
  configured fallback when replay is safe.

### C10 - Bounded stuck turns

- Demonstration: run a provider fixture that accepts a prompt and produces no
  output or tool progress.
- Pass: runtime status exposes last progress and the turn reaches timeout or
  escalation according to policy.

### C11 - Future-agent inheritance

- Demonstration: create an agent after controller template configuration.
- Pass: the new agent receives behavior only through explicit template,
  profile, task profile, or materialized defaults; no ambient credential
  discovery changes its policy.

### C12 - Redacted observability

- Inspection: plan/apply/explain/status/trace output.
- Pass: outputs include ids, policy hashes, provider names, model selectors,
  redacted fingerprints, and failure classes; outputs do not include raw
  secrets, OAuth tokens, API keys, auth file contents, or provider profile
  payloads.
