# Global CLI Contract / CHECKS

These are acceptance obligations, not a record of green results. The current
pull-request (PR) head is unverified until continuous integration (CI)
completes successfully; an older green run does not satisfy this file. Terms
and transport names follow [`SPEC.md`](./SPEC.md).

## Required checks

- Every migrated JSON failure has one canonical envelope and the correct
  operation path.
- Exit `0/1/2/3` survives handler, root/domain parser, bootstrap, tool and
  gateway paths; an unknown root command is `USAGE_ERROR`, exit `2`.
- Tool and gateway adapters preserve known `ContractError` values; neither
  appends a generic error nor replaces the envelope with a generic HTTP 500
  body. `UNHANDLED_ERROR` and `RETURN_SHAPE_ERROR` may retain HTTP status `500`.
- Audit distinguishes `blocked`, `usage_error`, `denied` and `failed`; policy
  blocks are not recorded as execution failures.
- CLI, tool and gateway authorize the same semantic operation and produce the
  same stable code for the same failure.
- A denied operation produces one `PERMISSION_DENIED` envelope, exit `1` and
  outcome `denied` on every transport. Remote context/transport failures are
  canonical and redact raw endpoint/provider details.
- Remote dispatch is authorized by the target gateway, accepts only a complete
  coherent contract body for the expected `op`, preserves exit `1/2/3`, and
  fails closed on invalid gateway configuration with exit `2`.
- Non-success binary responses and return-shape failures produce canonical,
  redacted gateway envelopes and matching `failed`/`denied` audit outcomes.
- A handler using the compatibility `fail()` helper produces one parseable
  `COMMAND_FAILED` envelope in JSON CLI, tool and gateway calls, while an
  unexpected raw exception produces one redacted `UNHANDLED_ERROR` envelope,
  exit `1`, and the same operation/error code in audit. Gateway HTTP status may
  remain `500`, but its response body must not expose the raw exception.
- Every implementation with persistent mutation, outbound effect, paid
  generation, provider mutation or triggered execution uses
  `@CommandAccess({ kind: "mutate" })`.
- A global static registry check cross-correlates `CommandAccess.kind`,
  `requiresConfirmation`, the declared `--execute` option and the documented
  policy. Per-domain spot checks alone do not satisfy this gate.
- The read-to-mutate compatibility inventory exactly matches the corrected
  live authorization metadata. Exact legacy grants migrate idempotently in
  agent defaults, permission tags, observer rules and observer bindings;
  matching read wildcards produce only exact mutate grants. Active,
  non-revoked runtime context snapshots receive the same exact grants, while
  expired or revoked snapshots remain unchanged.
- Every braked operation matches at least one confirmation-policy row; local
  reversible writes, authority reductions, emergency containment and
  cost-only operations below/no configured threshold are not braked.
- A conditional operation is tested both with and without its risky option.
- Trigger and runtime tests prove that synthetic trigger emission,
  session-delivery hooks, follow-up, rollback and fork are braked, while
  non-delivering hooks and emergency interrupt remain immediate.
- Dry-run tests spy on every effect boundary and prove zero database writes,
  provider calls, events, queue publications and worker spawns.
- Cost-based plans contain estimate, unit/currency, basis, confidence and the
  applicable threshold; unknown monetary cost is not presented as estimated.
- Invalid input and side-effect-free entity checks happen before the brake.
  Any deferred entity lookup is documented by the plan and proven to be
  side-effecting if attempted earlier.
- Plans, envelopes, suggestions and audits pass redaction tests.
- `--execute` is the last declared option and every consumer example/smoke of a
  braked operation includes it.
- Static consumer checks also reject obsolete `--execute` flags on immediate
  operations.
- Migrated roots match `AGENT_CONTRACT_DOMAINS`; list JSON supports bounded
  `--fields` projection.
- Public SDK commands keep concrete return contracts and do not increase a
  return-schema baseline.
- CI comparisons use failing test identities and platform evidence, never only
  aggregate counts.

## Focused validation

Run these as independent groups so a failure identifies its contract layer.

### Envelope, exit taxonomy and transport parity

```bash
bun test src/cli/commands/usage-exit.smoke.test.ts
bun test src/cli/transport-contract.test.ts
bun test src/cli/tools-export.test.ts
bun test src/sdk/gateway/dispatcher.test.ts
bun test src/cli/remote-gateway.test.ts
bun test src/cli/registry.test.ts
bun test src/cloud-auth/errors.test.ts
```

### Authorization and compatibility migration

```bash
bun test src/cli/command-access.test.ts
bun test src/cli/confirmation-policy.test.ts
bun test src/cli/commands/command-access-kind.test.ts
bun test src/permissions/command-access-kind-migration.test.ts
bun test src/permissions/command-access-kind-migration.store.test.ts
```

### Confirmation policy, dry-run and redaction

```bash
bun test src/cli/commands/agents.test.ts
bun test src/cli/commands/triggers.test.ts
bun test src/cli/commands/hooks.test.ts
bun test src/cli/commands/sessions-runtime.test.ts
bun test src/cli/commands/artifacts.test.ts
bun test src/cli/commands/prox-calls.test.ts
bun test src/cli/commands/media-json.test.ts
bun test src/cli/commands/image-contract.test.ts
bun test src/cli/commands/video.test.ts
bun test src/cli/commands/transcribe.test.ts
bun test src/cli/commands/group.test.ts
bun test src/cli/commands/slack.test.ts
bun test src/cli/commands/youtube.test.ts
bun test src/cli/commands/cron-commands.test.ts
bun test src/cli/commands/devin.test.ts
```

### Consumers, discovery and SDK schemas

```bash
bun test src/cli/execute-consumers.test.ts
bun test src/cli/schema-inference.test.ts
bun test src/sdk/client-codegen/codegen.test.ts
bun src/cli/index.ts sdk client check
bun src/cli/index.ts sdk openapi check --against docs/openapi.json
bun src/cli/index.ts sdk swift check
```

### Repository gates

The pull-request workflow in
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) is authoritative.
It runs dependency installation followed by the four validation steps: build,
typecheck, the repository test script and the diff-based quality gate.

The CI MUST also invoke every focused group above, either through `bun run test`
or a dedicated step. A green legacy suite is insufficient if a transport,
permission-migration or static-policy test was not selected.

Do not mark this spec `active`, update the ledger as passed, or approve the PR
until the focused groups and the four validation steps (build, typecheck, test
and quality gate) are green for the exact current head. Compare failures by
test identity and platform evidence, not only totals.
