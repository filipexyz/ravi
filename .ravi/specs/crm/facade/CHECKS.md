# CRM Agent-First Facade / CHECKS

## Spec Checks

```bash
bun src/cli/index.ts specs sync --json
bun src/cli/index.ts specs get crm/facade --mode full --json
```

- The synced spec MUST have id `crm/facade`, kind `capability`, domain `crm`,
  owner `ravi-dev`, and the real source paths declared in `applies_to`.
- Full retrieval MUST return `SPEC.md`, `WHY.md`, `RUNBOOK.md`, and `CHECKS.md`.

## Behavioral Checks

```bash
bun test src/crm/facade.test.ts
bun test src/cli/commands/crm.test.ts
bun test src/approval/service.test.ts
```

The focused automated tests MUST verify:

- a read-only, hashed 15-minute plan and rejection of tampered payloads;
- durable approval binding to plan hash, message id, and authorized sender;
- single-use application and stale task/fact transition rejection before the
  tested effect runs;
- `applied`, `partial`, and `unknown` task paths without replay;
- canonical contact values and resolved account references;
- facade discovery, hidden-target behavior, and generated approval inputs that
  omit caller-provided source and agent identity.

Before production adoption of each operation, a focused scenario MUST validate
its normalized arguments, precondition recheck, effect dispatch, success
predicate, divergent readback, secondary effects, and all four observation
outcomes. A controlled failure scenario MUST also validate the
journal-before-dispatch boundary and process exit while `applying`.

## Repository Gates

```bash
bun run typecheck
bun run build
bun run test:agent-contract
bun run test:sdk
bun src/cli/index.ts sdk openapi check --against docs/openapi.json
bun src/cli/index.ts sdk openapi check --against openapi.json
bun src/cli/index.ts sdk swift check
bun run test:swift-sdk
```

- Generated TypeScript, OpenAPI, and Swift contracts MUST remain current.
- The repository Quality Gate MUST accept the spec package and its focused test
  coverage before merge.
