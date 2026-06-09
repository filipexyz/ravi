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
- broad permanent grant without reason:
  `permissions.grant_permanent_without_reason` is `warn`;
- recent cost event has provider/model usage without price:
  `costs.pricing_unpriced_usage` is at least `warn`;
- recent inbound message lacks actor metadata:
  `channels.inbound_actor_unresolved` is `error`;
- invalid app manifest is surfaced through doctor with app evidence;
- `ravi sdk returns validate --json` failure is surfaced as a doctor finding;
- draft spec applying to production code is reported as governance drift.
