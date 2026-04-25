# Runtime Providers Runbook

## Adding A Provider

1. Implement provider-local adapter code under `src/runtime`.
2. Register it in `provider-registry`.
3. Add model catalog support only if the provider has a curated model list.
4. Declare capabilities explicitly.
5. Add `prepareSession` only for provider bootstrap that cannot live in generic request building.
6. Normalize native events into `RuntimeEvent`.
7. Add fixture tests for native event normalization.
8. Add provider contract tests.
9. Start with one dev-only agent before making the provider selectable broadly.

## Reviewing A Provider Patch

- Verify host runtime files did not grow provider-specific branches.
- Verify permission decisions route through host services or host hooks.
- Verify `turn.complete` includes provider state and usage shape.
- Verify all failure paths emit `turn.failed` or `turn.interrupted`.
- Verify `interrupt()` unblocks the prompt generator.
- Verify session resume rejects stale cwd/provider mismatches.
- Verify provider raw events do not become product logic.

## Control Operations

Provider control must be best-effort and explicit:

- `thread.list`, `thread.read`, `thread.rollback`, and `thread.fork` mutate or inspect provider-native threads.
- `turn.steer` and `turn.interrupt` require an active turn.
- A provider that does not support an operation MUST return a structured failed `RuntimeControlResult`.
- Control operations MUST enforce session access through the sessions CLI layer before reaching the provider.
