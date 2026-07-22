# Ravi App Runtime Hardening / CHECKS

## Checks

### C1 — Mutation Gate

`bun test src/apps/router.test.ts` proves missing mutation classification,
safety or confirmation fails before spawn, supported dry-run reaches the child,
and flags after `--` are forwarded rather than consumed by the router.

### C2 — Live And Retry Gate

The same suite proves live-disabled writes and write retries remain blocked.

### C3 — Versioned Errors

`src/apps/failure.test.ts` and Tiny failure fixtures cover core validation,
HTTP 403/429/500, parse and timeout failures. They assert the exact
`ravi.app.failure/v1` contract, allowlisted details, deterministic streams/exits
and legacy string compatibility.

### C4 — Timeout And Retry

Fixtures cover a timed-out read, allowlisted HTTP recovery and max three
attempts. They also prove help metadata and an arbitrary child
`retryable=true` cannot enable retry.

### C5 — Readiness Boundary

`apps check` and help tests assert zero child execution; readiness tests assert
explicit safe declarations, bounded timeout and `ready`, `degraded`,
`not_ready` or `unknown` aggregation.

### C6 — Machine Output

Tests reject malformed JSON and verify dotted `--fields` projection for object
and array results, while leaving defaults unchanged when absent.

### C7 — Help

Root and operation help snapshots remain bounded and do not execute the App.

### C8 — Pagination

Inspect each App list contract and run adapter tests for page 1/page 2, unique
records and explicit truncation metadata.

### C9 — Output Schema Boundary

Manifest tests reject missing and incompatible `outputSchema` declarations.
Router/Tiny fixtures validate page 1, page 2 and empty results before wrapping
them in `ravi.app.operation-result/v1`; malformed results fail without exposing
their payload. Projection tests prove `--fields` is an opt-in partial view after
canonical validation.

### Full Validation

```bash
bun test src/apps/service.test.ts src/apps/router.test.ts src/apps/failure.test.ts src/apps/tiny
bun run typecheck
bun run sdk:generate
bun run sdk:check
bunx biome check src/apps src/cli/commands/apps.ts
git diff --check
```
