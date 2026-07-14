# Runtime Target Failover Operator CLI / CHECKS

## Checks

- Verify `ravi runtime --help` lists `targets` and each leaf help renders at
  least two copyable examples plus `USE`, `DO NOT USE`, `ON ERROR`, and `SEE ALSO`.
- Verify tool manifest contains `runtime_targets_show`,
  `runtime_targets_explain`, `runtime_targets_set`, and `runtime_targets_clear`.
- Configure target ids `claude-main,pi-main,codex-live`; `show.order` MUST match
  the configured order.
- Reorder to `codex-live,claude-main,pi-main`; `show.order` MUST change and all
  target objects/policy metadata MUST remain deep-equal except array order.
- Reorder back to the original order to prove repeated mutation is deterministic.
- Duplicate, unknown, omitted, empty, and whitespace-only order values MUST fail
  with no persisted change.
- Supplying both `--policy-json` and `--order`, or neither, MUST fail with no
  persisted change.
- Reorder without an existing policy MUST fail and recommend the creation command.
- `explain` MUST select the first eligible ordered target and redact credential
  detail; it MUST create no credential attempt or provider session.
- `clear` MUST remove only `runtimeTargetPolicy`; provider, model,
  runtimePermissions, effort, and arbitrary defaults MUST remain unchanged.
- SDK generation/check and OpenAPI drift check MUST pass after return-shape changes.
- `ravi specs sync --json` MUST validate/index this feature spec.
