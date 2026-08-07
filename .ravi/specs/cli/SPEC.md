---
id: cli
title: "CLI Contract"
kind: domain
domain: cli
capabilities:
  - agent-first-ux
  - machine-json
  - listing-contracts
  - confirmation-policy
  - transport-equivalence
  - permission-integrity
  - audit-integrity
  - sdk-return-contracts
tags:
  - cli
  - agents
  - json
  - safety
  - sdk
applies_to:
  - src/cli
  - src/cli/commands
  - src/cli/agent-contract.ts
  - src/cli/command-access.ts
  - src/cli/registry.ts
  - src/cli/tools-export.ts
  - src/sdk/gateway
owners:
  - ravi-dev
status: active
normative: true
---

## Intent and precedence

This is the global source of truth for the agent-first CLI contract. It binds
the process CLI, exported tools, gateway/SDK calls, authorization and audit.

Specs under `cli/<domain>` may define domain-specific operation names, entity
resolution, risk classification and failure codes. They MUST NOT redefine the
global envelope, exit taxonomy, confirmation policy, authorization semantics
or transport behavior. If a domain spec conflicts with this file, this file
wins.

## Canonical failure contract

The canonical failure value is a `ContractError` and its envelope:

```json
{
  "success": false,
  "op": "<group> <operation>",
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable explanation",
    "retryable": false,
    "suggestedAction": "Concrete next action"
  }
}
```

- `op` MUST identify the real operation path.
- The envelope MAY add bounded structured details such as `suggestions`,
  `acceptedFlags`, `acceptedPositionals`, `dryRun` and `plan`.
- A failure MUST be rendered exactly once. A transport MUST NOT append a
  generic `Error:` line, stack trace or second envelope.
- Exit codes are: `0` success; `1` execution, provider or entity failure; `2`
  invalid usage; `3` blocked by confirmation policy. Exit `3` is a safe block,
  not an execution failure.
- Root parser, domain parser, handler and bootstrap paths MUST preserve this
  taxonomy. Unknown root commands are usage errors (`USAGE_ERROR`, exit `2`),
  including when Commander can suggest a valid command.
- Expected handler failures that still use the compatibility `fail()` helper
  are normalized at the shared transport boundary as `COMMAND_FAILED`, exit
  `1`. JSON CLI, tools and gateway MUST receive one canonical envelope; text
  CLI keeps the concise message. This fallback is not a substitute for a
  domain-specific code or `USAGE_ERROR` when the handler can classify the
  failure more precisely.
- An unexpected exception is normalized as `UNHANDLED_ERROR`, exit `1`, with
  the real operation path and a safe generic message. Process CLI, exported
  tools, gateway and audit MUST NOT expose the raw exception, provider detail
  or stack. The gateway MAY retain HTTP `500` for this internal-fault class,
  but its body remains the canonical contract envelope.

## Transport equivalence

All public invocation surfaces MUST preserve the same `op`, `error.code`,
details and policy outcome:

- Process CLI: `--json` writes the envelope to stdout and exits with the
  canonical code. Text mode stays concise and keeps the same exit code.
- Exported tool: returns the canonical envelope as tool content without a
  duplicate generic error. A policy block remains distinguishable from an
  execution failure.
- Gateway/SDK: returns the canonical envelope plus `exitCode`. HTTP status MAY
  communicate the broad class, but a `ContractError` MUST NOT become a generic
  HTTP 500 body.
- Audit: records the same operation and outcome as `succeeded`, `blocked`,
  `usage_error`, `denied` or `failed`. A policy block MUST NOT be recorded as
  an executed mutation or generic failure.

## Authorization and confirmation are different controls

`@CommandAccess.kind` controls authority. `--execute` controls confirmation.
One MUST NOT be inferred from the other.

- `kind: "read"` is allowed only when the implementation is side-effect-free:
  no persistent mutation, outbound communication, paid generation, provider
  mutation or triggered execution.
- A reversible local write is `kind: "mutate"`, even when it intentionally
  runs without `--execute`.
- Authorization MUST run before entity disclosure and before a confirmation
  plan is returned.
- After authorization, validation and entity resolution MUST run before the
  brake. An invalid argument exits `2`; an unknown visible entity exits `1`;
  neither is replaced by exit `3`.

Changing `kind` is a permission-surface change. It requires a consumer scan,
focused REBAC tests and explicit release notes; it MUST NOT be deferred as
documentation debt when the implementation already performs the effect.

When this migration corrects an existing `read` operation to `mutate`, Ravi
preserves exact least-privilege grants by appending the corresponding mutate
grant in provider-owned agent defaults, system permission tags, observer rules
and durable observer bindings. The migration MUST preserve the original read
grant, be idempotent and leave runtime context snapshots unchanged. A legacy
read wildcard MUST expand only to exact mutate grants for reclassified
operations that it already authorized; it MUST NOT become a broad mutate
wildcard. The versioned compatibility inventory MUST stay mechanically aligned
with the live `CommandAccess` metadata.

## Risk-based confirmation policy

`--execute` exists only when a second call adds material safety. Classify the
actual effect, not the command verb.

| Actual effect | Default |
| --- | --- |
| Reversible local persistence or local file creation | Execute immediately |
| Public/outbound communication, publication or sharing | Require `--execute` |
| Relevant state change in an external service or provider | Require `--execute` |
| Irreversible destruction, secret rotation or authority escalation | Require `--execute` |
| Starting, dispatching or replaying work that continues independently | Require `--execute` |
| Emergency stop that reduces active damage or spend | Execute immediately |
| Paid local generation below the configured confirmation threshold | Execute immediately |
| Reliably estimated cost at or above the configured threshold | Require `--execute` |

Cost alone MUST NOT create a two-call loop unless both a trustworthy estimate
and an applicable limit exist. A cost-based plan MUST include the estimate,
unit/currency, basis, confidence and threshold. When the provider cannot be
estimated reliably, report billable input units where possible and do not
claim a monetary estimate.

Conditional effects are classified per invocation. For example,
`audio generate` writes a local file and runs immediately, while
`audio generate --send` reaches a live chat and requires confirmation.
`artifacts publish` uploads/releases externally and always requires it.

## Brake behavior

- The dry-run MUST happen before every side effect: no DB/resource creation,
  provider call, event emission, queue publication or worker spawn.
- It MUST return `WRITE_REQUIRES_EXECUTE`, exit `3`, `dryRun: true` and a
  bounded plan identifying the target and material effect.
- Plans, envelopes and suggestions MUST NOT contain secrets, credential refs,
  full message bodies or unnecessary personal data. Use identifiers, counts,
  masked values and bounded previews.
- `--execute` MUST be the last declared option of the operation.
- Existing equivalent confirmation contracts (`--apply`, explicit `--dry-run`
  or confirmation token) may remain when documented; do not rename them only
  for uniform spelling.

## Entity resolution and compact output

- Entity lookups return a stable `<RESOURCE>_NOT_FOUND` code and at most three
  suggestions from the same visibility-filtered source used by list/search.
- Omit suggestions when they could enumerate another scope; point to the safe
  listing command instead.
- Migrated list operations accept `--fields a,b,c` and project every array
  alias in the JSON payload. Human output is unaffected.
- Lists are bounded by default. History-sized reads support explicit filters,
  pagination and sorting.
- Per-operation help stays compact. Every skill, runtime hint, smoke fixture
  and documentation example that invokes a braked operation includes the
  confirmation flag.
- Every migrated Commander root is registered in `AGENT_CONTRACT_DOMAINS`.

## SDK return contracts

- Public SDK/OpenAPI commands declare `@Returns(...)` or
  `@Returns.binary()`. Commands that cannot be request/response calls use
  `@CliOnly()`.
- New public commands MUST NOT increase either return-schema debt baseline.
- A public return schema is concrete: no final `unknown`, `any`, unknown array,
  empty passthrough object or arbitrary `additionalProperties` contract.
- OpenAPI preserves declared response types; binary responses use
  `application/octet-stream` with `format: binary`.

## Return schema migration

The `ravi sdk returns` state machine uses `discovered`, `in_progress`,
`blocked`, `typed`, `validated`, `reviewed`, `not_applicable` and `removed`.
A command is complete only when `reviewed` and its stored schema hash matches
the live registry. `not_applicable` is limited to foreground processes,
unbounded streams/watchers and interactive terminal handlers.

Use `ravi sdk returns validate --strict --json` for final review. Strict mode
MUST fail on weak-schema baseline growth, unreviewed typed schemas and
unreviewed `@CliOnly()` exceptions.

## Change protocol

Any cross-domain contract change follows this order:

1. Capture the failing process/transport case and the exact baseline identity.
2. Update this spec and the affected domain classification.
3. Implement the smallest shared fix before domain-specific workarounds.
4. Run focused tests, transport parity tests, consumer smokes and static policy
   checks.
5. Run the repository quality gate and compare failures by test identity, not
   only by count.
6. Update the migration ledger with observed evidence; never call a regression
   pre-existing solely because its test file was unchanged.
