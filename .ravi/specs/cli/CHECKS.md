# Global CLI Contract / CHECKS

## Required checks

- Every migrated JSON failure has one canonical envelope and the correct
  operation path.
- Exit `0/1/2/3` survives handler, parser, bootstrap, tool and gateway paths.
- Tool and gateway adapters preserve `ContractError`; neither appends a generic
  error nor maps it to HTTP 500.
- Audit distinguishes `blocked`, `usage_error`, `denied` and `failed`; policy
  blocks are not recorded as execution failures.
- CLI, tool and gateway authorize the same semantic operation and produce the
  same stable code for the same failure.
- A handler using the compatibility `fail()` helper produces one parseable
  `COMMAND_FAILED` envelope in JSON CLI, tool and gateway calls, while an
  unexpected raw exception remains an internal failure.
- Every implementation with persistent mutation, outbound effect, paid
  generation, provider mutation or triggered execution uses
  `@CommandAccess({ kind: "mutate" })`.
- The read-to-mutate compatibility inventory exactly matches the corrected
  live authorization metadata. Exact legacy grants migrate idempotently in
  agent defaults, permission tags, observer rules and observer bindings;
  matching read wildcards produce only exact mutate grants, while runtime
  context snapshots remain unchanged.
- Every braked operation matches at least one confirmation-policy row; local
  reversible writes and cost-only operations below/no threshold are not
  braked.
- A conditional operation is tested both with and without its risky option.
- Dry-run tests spy on every effect boundary and prove zero DB writes, provider
  calls, events, queue publications and worker spawns.
- Cost-based plans contain estimate, unit/currency, basis, confidence and the
  applicable threshold; unknown monetary cost is not presented as estimated.
- Unknown entity and invalid input checks happen before the brake.
- Plans, envelopes, suggestions and audits pass redaction tests.
- `--execute` is the last declared option and every consumer example/smoke of a
  braked operation includes it.
- Migrated roots match `AGENT_CONTRACT_DOMAINS`; list JSON supports bounded
  `--fields` projection.
- Public SDK commands keep concrete return contracts and do not increase a
  return-schema baseline.
- CI comparisons use failing test identities and platform evidence, never only
  aggregate counts.

## Focused validation

```bash
bun test src/cli/commands/usage-exit.smoke.test.ts
bun test src/cli/tools-export.test.ts src/sdk/gateway/dispatcher.test.ts
bun test src/cli/command-access.test.ts src/cli/registry.test.ts
bun test src/cli/commands/command-access-kind.test.ts
bun test src/permissions/command-access-kind-migration.test.ts src/permissions/command-access-kind-migration.store.test.ts
bun test src/cli/schema-inference.test.ts src/sdk/client-codegen/codegen.test.ts
bun run typecheck
```

The changed-spec quality gate is required before approval:

```bash
$env:GITHUB_BASE_REF="dev"
bun src/ci/run-quality-gate.ts
```
