# Runtime Target Failover Operator CLI / CHECKS

## Checks

- Verify `ravi runtime --help` lists `targets` and each leaf help renders at
  least two copyable examples plus `USE`, `DO NOT USE`, `ON ERROR`, and `SEE ALSO`.
- Verify tool manifest contains `runtime_targets_show`,
  `runtime_targets_explain`, `runtime_targets_set`, and `runtime_targets_clear`.
- Verify the manifest also contains `runtime_targets_reorder` and generated
  input contracts require `agent+policyJson` for set and `agent+order` for reorder.
- Configure target ids `claude-main,pi-main,codex-live`; `show.order` MUST match
  the configured order.
- Reorder to `codex-live,claude-main,pi-main`; `show.order` MUST change and all
  target objects/policy metadata MUST remain deep-equal except array order.
- Reorder back to the original order to prove repeated mutation is deterministic.
- Duplicate, unknown, omitted, empty, and whitespace-only order values MUST fail
  with no persisted change.
- Missing or whitespace-only `--policy-json`/`--order` MUST fail validation with
  no persisted change; remote invalid bodies MUST return HTTP 400, not 500.
- Reorder without an existing policy MUST fail and recommend the creation command.
- Stateless `explain` MUST identify its evaluation mode, select the first
  eligible ordered target, redact credential detail, and create no credential
  attempt or provider session. It MUST NOT claim live session health.
- Changed mutations MUST emit one config-change notification; no-op and rejected
  mutations MUST emit none.
- `clear` MUST remove only `runtimeTargetPolicy`; provider, model,
  runtimePermissions, effort, and arbitrary defaults MUST remain unchanged.
- SDK generation/check and OpenAPI drift check MUST pass after return-shape changes.
- `ravi specs sync --json` MUST validate/index this feature spec.
