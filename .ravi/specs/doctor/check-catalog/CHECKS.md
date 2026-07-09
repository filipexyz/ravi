# Doctor Check Catalog Checks

## Catalog Validation

After changing the catalog:

```bash
ravi specs sync --json
ravi specs get doctor/check-catalog --mode full --json
```

## Required Initial Findings

The implementation MUST be able to emit these finding ids:

```text
apps.manifest.invalid
apps.registry.meta_only
specs.draft_applies_to_production
skills.spec_reference_missing
sdk.returns.missing_public
sdk.returns.weak_public_new
permissions.command_mutation_unclassified
permissions.command_mutation_without_permission
permissions.provider_runtime_default_chain
permissions.provider_runtime_boundaries
permissions.local_operator_explicit
permissions.runtime_bootstrap_scope
costs.pricing_unpriced_usage
costs.pricing_catalog_stale
costs.event_incomplete_usage
costs.event_pricing_inconsistent
runtime.daemon_offline
runtime.bundle_mismatch
runtime.branch_drift
runtime.dirty_worktree
runtime.schema_missing
runtime.migration_unverifiable
runtime.disk_space_low
routes.agent_missing
routes.instance_missing
routes.duplicate_effective_route
sessions.agent_missing
sessions.aborted_last_run
chats.eligible_without_route
channels.instance_disconnected
channels.instance_health_missing
channels.provider_health_unavailable
channels.inbound_actor_unresolved
channels.inbound_contact_unresolved
```

## Fixture Expectations

- A route whose `agent_id` does not exist emits `routes.agent_missing`.
- A route whose `instance_id` does not exist emits `routes.instance_missing`.
- Two routes with the same effective account/channel/pattern emit
  `routes.duplicate_effective_route`.
- A recent inbound message with no `actor_type` and no `actor_id` emits
  `channels.inbound_actor_unresolved`.
- A recent inbound user message with no contact or agent metadata emits
  `channels.inbound_contact_unresolved`.
- A provider/model cost row with token usage and no price emits
  `costs.pricing_unpriced_usage`.
- A new public command without a strong return schema emits
  `sdk.returns.weak_public_new`.
- A public command with no return schema emits `sdk.returns.missing_public`.
- A mutating command without explicit registry metadata emits
  `permissions.command_mutation_unclassified`.
- Provider runtime default providers and materializers emit
  `permissions.provider_runtime_default_chain`.
- Provider runtime boundary drift emits
  `permissions.provider_runtime_boundaries`.
- Hidden operator-control authorization drift emits
  `permissions.local_operator_explicit`.
- Runtime bootstrap actor/surface/admin drift emits
  `permissions.runtime_bootstrap_scope`.
- A target (cwd/temp/state) whose free space is below the critical threshold,
  or that fails the temp write/remove smoke test, emits `runtime.disk_space_low`
  at `error`.
- A target whose free space is below the operational margin emits
  `runtime.disk_space_low` at `warn`.
- Healthy free space and a passing smoke test on all targets emits
  `runtime.disk_space_low` at `pass`.

## False Positive Guards

- Verb heuristics MUST NOT be the only evidence for an `error` permission
  finding.
- Legacy process names MUST be normalized before runtime failures are emitted.
- Disabled instances MUST NOT emit disconnected-instance errors.
- Passive or archived chats MUST NOT emit active route-missing errors.
- Zero-token cost rows MUST NOT be treated as priced token leakage.
- Draft specs MUST NOT fail doctor by default.
- `runtime.disk_space_low` MUST NOT delete, prune, vacuum, or mutate any
  pre-existing file; its only write is a self-created temp probe it removes.
- `runtime.disk_space_low` MUST NOT emit raw private paths, secrets, env
  values, or context keys in its evidence.
- A missing/not-yet-created target path MUST degrade to `warn`, not `error`.
