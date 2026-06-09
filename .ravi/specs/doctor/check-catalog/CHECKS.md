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
permissions.grant_broad
permissions.grant_permanent_without_reason
permissions.grant_orphan_subject
permissions.grant_orphan_object
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
- A broad permanent grant without reason emits
  `permissions.grant_permanent_without_reason`.
- A mutating command without explicit registry metadata emits
  `permissions.command_mutation_unclassified`.

## False Positive Guards

- Verb heuristics MUST NOT be the only evidence for an `error` permission
  finding.
- Legacy process names MUST be normalized before runtime failures are emitted.
- Disabled instances MUST NOT emit disconnected-instance errors.
- Passive or archived chats MUST NOT emit active route-missing errors.
- Zero-token cost rows MUST NOT be treated as priced token leakage.
- Draft specs MUST NOT fail doctor by default.
