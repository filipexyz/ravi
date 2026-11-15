# Checks

Run focused tests with an explicit temporary `RAVI_STATE_DIR` before imports and the production-state guard preload:

- `bun run test:attention-storage` (registered in `bun run test` for CI) expands to `bun --no-env-file test --preload ./src/test/isolated-runtime-preload.ts src/orchestration/` and MUST pass without opening operator state or loading a runtime database.
- `task_result_without_requirement_is_persisted_idempotently` MUST persist a result with no dependency/decision, return the same key on replay, and survive database close/reopen without a duplicate.
- `requirement_tuple_is_disjoint_from_task_result` MUST preserve one requirement tuple and allow another subject and a result on the same task without collision.
- Migration replay MUST preserve data and prove both named indexes are partial and unique.
- Direct SQL MUST reject unknown kinds, missing required fields, mixed variants, invalid outcome versions, and alternate keys for the same variant tuple.
- Store replay MUST preserve factual state and fail on a divergent stored canonical key.
- Identity tests MUST reject `thread_decision` and foreign fields and prove deterministic tuples and version separation.
- `GITHUB_BASE_REF=dev bun src/ci/run-quality-gate.ts` MUST pass for the committed diff; full build/typecheck/suite belong to PR CI on this production host.
