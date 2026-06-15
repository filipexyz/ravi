# Ravi Doctor Checks

## Spec Index

After editing this spec tree:

```bash
ravi specs sync --json
ravi specs get doctor --mode full --json
ravi specs get doctor/output --mode full --json
ravi specs get doctor/check-catalog --mode full --json
```

## Implementation Validation

When the doctor implementation is changed, run:

```bash
ravi doctor --json
ravi doctor --full --json
ravi doctor --domain permissions --json
ravi doctor --domain costs --json
ravi sdk returns validate --json
ravi apps check --json
ravi costs pricing --json
ravi daemon status --json
bun test src/cli/commands/doctor.test.ts
bun run typecheck
bun run build
```

## Regression Criteria

- Doctor remains read-only.
- Doctor emits no raw secrets, env values, credentials, context keys, or tokens.
- `--json` output is stable and typed.
- Every failing check has at least one finding.
- Every finding has severity, id, domain, title, summary, and evidence.
- `error` findings make default doctor exit non-zero.
- `warn` findings do not make default doctor exit non-zero.
- `info` findings never make doctor exit non-zero.
- Network or provider timeout produces a skipped/unavailable check, not a
  missing local report.
- False positives from legacy process names are normalized before reporting.

## Fixture Scenarios

Use focused fixtures or local test databases to cover:

- route points to a missing agent: `routes.agent_missing` is `error`;
- route points to a missing instance: `routes.instance_missing` is `error`;
- public mutating command lacks permission metadata:
  `permissions.command_mutation_unclassified` is `warn`;
- provider runtime default chain matches the expected local-operator/context
  providers: `permissions.provider_runtime_default_chain` is emitted;
- provider runtime boundary is isolated from native engines and relation stores:
  `permissions.provider_runtime_boundaries` is emitted;
- no-subject/no-context permission requests fail closed unless explicit
  local-operator mode is requested: `permissions.local_operator_explicit` is
  emitted;
- runtime bootstrap does not grant actor/surface or admin authority:
  `permissions.runtime_bootstrap_scope` is emitted;
- recent cost event has provider/model usage without price:
  `costs.pricing_unpriced_usage` is at least `warn`;
- recent inbound message lacks actor metadata:
  `channels.inbound_actor_unresolved` is `error`;
- invalid app manifest is surfaced through doctor with app evidence;
- `ravi sdk returns validate --json` failure is surfaced as a doctor finding;
- draft spec applying to production code is reported as governance drift.
