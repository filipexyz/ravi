---
id: runtime/target-failover/operator-cli
title: "Runtime Target Failover Operator CLI"
kind: feature
domain: runtime
capability: target-failover
feature: operator-cli
capabilities:
  - target-failover
  - runtime-target-configuration
  - cli-discovery
  - skill-guidance
tags:
  - runtime
  - failover
  - cli
  - skills
applies_to:
  - src/cli/commands/runtime-targets.ts
  - src/cli/commands/runtime-targets.test.ts
  - src/cli/registry.ts
  - src/cli/registry-snapshot.ts
  - packages/ravi-os-sdk
  - src/plugins/internal/ravi-system/skills/runtime-target-failover/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

## Contract

## Intent

Make runtime target failover operable without editing SQLite, agent JSON, or
provider-native files. An operator or agent MUST be able to discover the
surface, inspect the configured order, replace a complete policy, reorder an
existing policy atomically, preview effective selection, and clear the opt-in
policy through typed Ravi commands.

## Invariants

- `ravi runtime --help` MUST list `targets`, and every leaf command MUST expose
  actionable `--help` with examples, output shape, errors, and adjacent commands.
- `runtime.targets` commands MUST be present in the tool registry and generated
  TypeScript SDK with explicit `@Returns` and `@CommandAccess` contracts.
- `show` MUST return the complete agent-default policy plus its ordered target
  ids. It MUST NOT execute a provider or expose credentials.
- `set --policy-json` MUST validate and atomically replace one agent-default
  policy while preserving every unrelated agent default.
- `set --order <target-ids>` MUST reorder the existing policy by stable target
  ids. The value MUST be an exact permutation: duplicates, unknown ids, omitted
  ids, and an absent policy MUST fail before mutation.
- Reordering MUST preserve every target object, policy id, strategy, budgets,
  cooldown, circuit-breaker settings, credential constraints, and unrelated
  agent defaults. Provider names are not unique identifiers and MUST NOT be
  used as the reorder key.
- `set` MUST require exactly one mutation input: `--policy-json` or `--order`.
- `explain` MUST remain read-only and report effective source, provenance,
  selected target, and redacted rejection reasons without launching a turn.
- `clear` MUST remove only `defaults.runtimeTargetPolicy` and MUST preserve the
  agent's permanent provider/model and unrelated defaults.
- Successful mutation MUST apply through config refresh/change notification and
  MUST NOT require daemon restart.
- The system skill MUST be a thin operational guide. The CLI `--help` remains
  the source of truth for flags, validation, and examples.
- No command or skill may contain API keys, OAuth tokens, or a hard-coded global
  Claude/Pi/Codex priority.

## Validation

- `bun test src/cli/commands/runtime-targets.test.ts`
- `bun test src/cli/registry.test.ts src/cli/registry-snapshot.test.ts`
- `bun test src/cli/commands/json-coverage.test.ts`
- `bun run sdk:generate && bun run sdk:check`
- `bunx biome check src/cli/commands/runtime-targets.ts src/cli/commands/runtime-targets.test.ts`
- `bun run typecheck`
- Source spike: `bun src/cli/index.ts runtime --help` lists `targets` and
  `bun src/cli/index.ts runtime targets set --help` renders the full contract.
- Isolated-state E2E configures three synthetic targets, reorders them twice,
  proves `show` order and `explain` selection, then clears the policy.

## Known Failure Modes

- A nested decorated command executes through remote dispatch but is absent from
  local help/tool discovery, making a working capability appear unavailable.
- A raw JSON replacement accidentally drops retry/cooldown or credential fields
  when the operator intended only to change order.
- Ordering by provider name becomes ambiguous when one provider has multiple
  models or credential scopes.
- A partial order silently appends omitted targets and changes operator intent.
- Mutation overwrites `runtimePermissions`, effort, locale, or other defaults.
- A skill duplicates stale flag syntax instead of directing agents to CLI help.
