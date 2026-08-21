# Routes read-only agent-first CLI contract / RUNBOOK

## Operating flow

1. Discover rules with `ravi specs get cli/routes --mode rules --json`.
2. Inventory with `ravi routes list [instance] --json`; follow
   `pagination.nextCommand` until `hasMore` is false.
3. Use `--fields pattern,agent,channel` for a compact inventory. If exit is 2,
   retry only with values in `acceptedFields`.
4. Use `ravi routes show <instance> <stored-pattern> --json` when the literal
   stored route is required.
5. Use `ravi routes explain <instance> <concrete-target> --json` for semantic
   lookup and config simulation. Read `origin` before the verdict:
   `daemonObserved:false` means current daemon memory was not checked.
6. On `ROUTE_PATTERN_AMBIGUOUS`, choose one exact stored pattern from
   `suggestions`; do not infer precedence.
7. On invalid `--channel`, choose from `acceptedChannels`. Do not retry the
   invented value.
8. `skipped_broad_pattern` means a concrete target is required. It is not
   evidence that the configured glob is absent.

## Normal validation

```bash
bun test src/router/routes-readonly.test.ts src/router/router.test.ts src/router/resolver.test.ts src/cli/commands/routes.test.ts
bun run typecheck
bun run build
bunx biome check src/router/routes-readonly.ts src/router/routes-readonly.test.ts src/router/config.ts src/router/resolver.ts src/router/resolver.test.ts src/router/router.test.ts src/router/index.ts src/cli/runtime-target.ts src/cli/commands/instances.ts src/cli/commands/routes.test.ts src/cli/commands/operational-return-schemas.ts
```

These are ordinary native checks. Do not create or use a benchmark, scenario,
testbench, or production fixture for this domain.

## Failure triage

- Equivalent group lookup fails: compare `normalizeExactRouteTarget` and
  `matchPattern`; they must share one canonical representation.
- Explain says `verified` but `origin.daemonObserved` is true or absent: block
  promotion; the product has overstated its evidence.
- Invalid fields produce `{}`: confirm `ROUTE_LIST_FIELDS` is passed to
  `pickFields`, including empty pages.
- Invalid channel reaches `matchRoute`: validation moved after simulation and
  must be restored before it.
- Repeated unchanged reads differ: inspect newly added timestamps, unstable
  sorting, or non-deterministic suggestions.
- A missing database appears after list: the facade fell back to `getDb()` or a
  tag/runtime helper that initializes schema. Block promotion.
- A WAL probe is stale: ensure the standard readonly connection remains in use;
  never replace it with `immutable=1` while the daemon may write.
