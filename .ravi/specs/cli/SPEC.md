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
  - src/apps
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

This is the global source of truth for the agent-first command-line interface
(CLI) contract. It binds the process CLI, exported tools, gateway/software
development kit (SDK) calls, authorization and audit.

Specs under `.ravi/specs/cli/<domain>/` may define domain-specific operation
names, entity resolution, risk classification, failure codes and focused
checks. They MUST NOT redefine the global envelope, exit taxonomy,
confirmation policy, authorization semantics or transport behavior. If a
domain spec conflicts with this file, this file wins.

The rules in this document are normative. `draft` means that implementation
evidence is still pending for the current pull-request head. `active` means
that every required check in [`CHECKS.md`](./CHECKS.md) and the pull-request CI
passed before promotion, with the evidence recorded in
[`MIGRACAO-LEDGER.md`](../../../MIGRACAO-LEDGER.md).

## Canonical failure contract

The canonical failure value is a `ContractError` and its envelope:

```json
{
  "success": false,
  "op": "<group> <operation>",
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable explanation",
    "cause": "Original failure reason after diagnostic normalization",
    "context": { "operation": "<group> <operation>", "code": "PROVIDER_OR_OS_CODE" },
    "retryable": false,
    "suggestedAction": "Concrete next action"
  }
}
```

- `op` MUST identify the real operation path.
- The envelope MAY add bounded structured details such as `suggestions`,
  `acceptedFlags`, `acceptedPositionals`, `dryRun` and `plan`.
- The envelope is transport-independent. The process carries the exit code in
  the OS status; tools carry `exitCode` and `outcome` beside the content; the
  gateway adds `exitCode` and `outcome` to the JSON body.
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
  `1`. JSON CLI, tools and gateway MUST receive one canonical envelope whose
  `message` keeps the sanitized expected/daemon cause (or the generic headline
  only when that cause is empty). Text CLI keeps the same concise
  message. A throw-site `suggestedAction` (for example
  `--allow-runtime-mismatch`) MUST reach the envelope. This fallback is not a
  substitute for a domain-specific code or `USAGE_ERROR` when the handler can
  classify the failure more precisely.
- `ContractError` is the shared user-failure constructor. It requires an
  explicit diagnostic `cause` and typed `context`; there is no message-only
  overload. `contractFail` requires its `diagnostic` argument. A caught
  exception MUST supply the actual throwable to the diagnostic projection;
  an expected refusal without a throwable MUST state the concrete failed
  precondition and its operation/origin.
- An unexpected exception is normalized as `UNHANDLED_ERROR`, exit `1`, with
  the real operation, a stable headline and its original failure reason.
  Internal throws retain the original throwable and nested cause chain.
  Integration wrappers may attach typed context and known credential values
  for later redaction; they MUST NOT replace the throwable with a sanitized
  string before the output boundary.
- Diagnostic ingress is an allowlist: only normalized `code`, `message`,
  `cause`, and typed `context` may cross from an exception/provider object.
  Context admits `status`, `provider`, `model`, `operation`, typed `actor`
  (`type`, `id`), `file`, `syscall`, and provider/OS `code`. Headers, cookies,
  query objects, bodies, arbitrary properties and stack are excluded by
  default. Provider payload normalization may extract declared reason/code
  fields; it MUST NOT serialize the rest of the payload, including body/PII
  already embedded in an SDK error message. Domain-owned envelope details
  such as validation issues and dry-run plans retain their separate typed
  projections; they do not widen the diagnostic allowlist.
- Allowed text is still untrusted. The single versioned redactor in
  `packages/ravi-os-sdk/src/diagnostic-redactor.ts` runs at diagnostic egress:
  tool/CLI/gateway envelopes, remote relay, logs, trace events/artifacts and
  the TypeScript SDK envelope. Its finite patterns cover URL/DSN userinfo,
  URL queries/fragments, sensitive query assignments (`key`, `token`, `sig`,
  `secret`, `password`), bearer/API-key credentials, cookies, password tails,
  key-shaped strings and long high-entropy encoded values. Structured or
  opaque embedded payloads are projected or replaced with a field marker.
  Markers such as `[redacted:url-query]` identify the removed field; the
  remaining diagnostic reason and original stable code MUST stay readable.
  A new unrecognized credential encoding requires a corpus row and a shared
  redactor update, not a claim that a finite pattern set detects every secret.
- CLI text, exported tools, gateway, remote relay and client error envelopes
  MUST retain normalized cause/context. Human text prints these after the
  headline. Permission denial retains its supplied operation and typed actor.
  An HTTP status, including 422 or 500, MUST NOT replace the failure reason.
- Logger output is an egress sink, including local/debug output. Raw stacks,
  headers, bodies and arbitrary exception properties MUST NOT be logged or
  persisted in diagnostic trace rows/artifacts. Correlation by request ID,
  bounded context and rate limiting remain available; private logs are not a
  substitute for the caller-visible reason. Audit remains a separate,
  content-minimized projection.
  SQLite retry instrumentation keeps its explicit typed fields (`sqliteCode`,
  `sqliteErrno`, `willRetry`, `attempt`, `statementsAgeMs`, `rssMb`, `heapUsedMb`,
  `heapTotalMb`, `externalMb`) alongside normalized `operation`. Invalid types,
  non-finite/negative metrics, arbitrary metadata and database paths are excluded;
  diagnostic projection MUST NOT discard these operational facts.
  Domain conflict diffs remain bounded, redacted text in the separate control
  projection so callers can choose how to resolve a Library update conflict.
  Resolution controls retain validated scopes/identifiers/hashes and nonnegative
  retry/schema/import counters. A version conflict exposes only the current row
  ID/version and instructs the caller to re-read it; it MUST NOT copy row values
  or body into the failure. Organization guidance projects only its redacted name.
  Failure trace payloads retain typed lifecycle controls (intake reason/stage,
  agent ID, recovery/abort classification, retry counters and boolean state).
  A payload containing only those controls uses the event's error as its cause;
  nested provider events contribute normalized diagnostics, never raw payloads.
- TypeScript shares the versioned redactor. Swift and Dart preserve the same
  typed diagnostic envelope received from the server; their shape/decoding
  contract is not evidence of an identical native redaction implementation.
- A return-shape violation is `RETURN_SHAPE_ERROR`, exit `1`, outcome `failed`
  and MAY retain HTTP `500`. A non-success binary response is normalized to a
  safe stable code before it reaches SDK callers or audit; provider response
  bodies are not forwarded as contract details.

## Mechanical regression gate

`scripts/error-cause-scan.ts` scans the non-test `src` AST and blocks unannotated
catch clauses without bindings, rejection callbacks without bindings, and
unused catch bindings when the block emits a recognized failure surface.
It also rejects logging a caught binding while constructing an unrelated failure,
and manufacturing a recognized failure envelope outside the shared constructor.
Intentional non-error fallbacks require `// no-cause: <concrete reason>`.

Existing debt is enumerated in `scripts/error-cause-baseline.json` against the
frozen baseline. Entries/counts can only decrease; new entries, increased
counts, and debt reintroduced after removal fail CI. The scan generates
`design/error-cause-inventory.md` with directory counts and site states
(`no-cause`, `fixed`, `triaged-follow-up`). Do not maintain a parallel handwritten
follow-up list. A `fixed` static site means the configured AST rules pass; it
does not establish end-to-end propagation through dynamic or aliased code.

`src/cli/error-egress-corpus.test.ts` supplies that complementary behavioral
proof for 13 corpus rows across nine required sinks: process CLI envelope,
exported tool, gateway response, remote relay, gateway log, trace event, trace
blob, TypeScript SDK envelope, and the Slack `chat.postMessage` payload captured
by a mock. Each row asserts exact expected cause/code and absence of every
sentinel at every sink. The harness rejects a missing required sink. This is
finite corpus coverage, not a claim that every application failure boundary or
live chat transport has been exercised.

## Transport equivalence

All public invocation surfaces MUST preserve the same `op`, `error.code`,
details and policy outcome:

- Process CLI: `--json` writes the envelope to stdout and exits with the
  canonical code without adding stderr output. Text mode stays concise and
  keeps the same exit code.
- Exported tool: returns the canonical envelope as tool content without a
  duplicate generic error, plus the canonical `exitCode` and `outcome`. A
  policy block has `outcome: "blocked"` and is not marked as an execution
  error.
- Gateway/SDK: returns the canonical envelope plus `exitCode` and `outcome`.
  HTTP status MAY communicate the broad class, but a known `ContractError`
  MUST NOT become a generic HTTP 500 body.
- Codex PreToolUse hook invocations retain their provider-required hook JSON
  contract. Remote hook calls MUST carry the process stdin in an explicit,
  redacted request field. Transport/authentication failures and invalid remote
  replies MUST become a hook `deny`, never an empty success or generic CLI
  failure that the provider could ignore. See `cli/context`.
- Audit: records the same operation and outcome as `succeeded`, `blocked`,
  `usage_error`, `denied` or `failed`. A policy block MUST NOT be recorded as
  an executed mutation or generic failure.
- Permission denial is `PERMISSION_DENIED`, exit `1`, outcome `denied` across
  CLI, tool, gateway and audit.
- Remote CLI mode delegates authorization to the target gateway instead of
  pre-authorizing against a possibly different local principal. It accepts a
  remote contract body only when `success`, `op`, `exitCode`, `outcome` and the
  error shape are coherent; partial, mismatched or legacy failures are
  normalized to the same safe envelope. Invalid gateway configuration is a
  usage error (`REMOTE_GATEWAY_INVALID`, exit `2`). Remote failure diagnostics
  use the same ingress allowlist and egress redactor; safe provider/OS reason
  text and actionable path components survive the relay.
- Remote details MUST be projected through a local allowlist instead of copied
  blindly. `cause` and diagnostic `context` are explicit members of that
  projection and use the shared egress redactor, separately from dry-run plans.
  `suggestions` may preserve only bounded stable identifiers. A
  remote `plan` may preserve typed booleans/numbers and identifier/ref/enum
  strings that match restricted grammars; free text, paths, URLs,
  token-shaped values, commands and arbitrary objects are discarded. Flags
  and positionals must match their canonical grammars, and `suggestedAction`
  is either bounded, sanitized public copy or a safe local action. Remote command failures MUST NOT discard a safe public message solely because the operation lacks a custom catalog. For `media send`, catalog codes
  `MEDIA_SEND_FAILED`, `OMNI_AUTH_FAILED` and `FILE_NOT_FOUND` MUST keep the
  remote code and use the local catalog message and action; other codes preserve bounded, sanitized public contract copy or name the operation/code and next action. Library and Console-backed refusals
  (`skills`, `themes`, `widgets`, the Library `agents` commands and `pages
  read`), when the outcome is `failed` or `blocked` (not the write brake),
  MUST keep the remote message and `suggestedAction` (bounded, without
  control characters, sanitized again) plus the typed details `conflict`,
  `proposalStatus`, `turn`, `currentVersion`, `baseVersion`, `errors`,
  `warnings`, `existing` (file names), `ref` (`<scope>/<slug>`), `scope`
  (`org`/`project`), `project`, `viewProject`, `archived` and `view`
  (`organization`, `project`, `source` as short names): the daemon already built that envelope as public copy.
  Text mode then prints `Next: <suggestedAction>` when no issue carries it.
  HTTP `status` and structured `issues`
  (`path`, `code`, sanitized `message`) from 400/422 validation failures MUST
  be projected so CLI text and `--json` stay actionable. This privacy
  projection is the permitted exception to byte-for-byte detail parity;
  semantic fields and taxonomy still remain equivalent.

## Authorization and confirmation are different controls

`CommandAccess.kind` controls authority. `--execute` controls confirmation.
One MUST NOT be inferred from the other.

- Every operation that exposes an `--execute` barrier MUST declare
  `requiresConfirmation: true`. This metadata means that the operation has a
  confirmable execution path; for conditional commands it does not mean that
  every invocation is blocked. The handler still classifies the actual
  invocation before deciding whether the flag is required.
- `kind: "read"` is allowed only when the implementation is side-effect-free:
  no persistent mutation, outbound communication, paid generation, provider
  mutation or triggered execution.
- A reversible local write is `kind: "mutate"`, even when it intentionally
  runs without `--execute`.
- Authorization MUST run before entity disclosure and before a confirmation
  plan is returned. In remote mode, the target gateway owns this decision.
- After authorization, every side-effect-free validation and entity lookup
  MUST run before the brake. An invalid argument exits `2`; an unknown visible
  entity exits `1`; neither is replaced by exit `3`.
- A lookup that initializes storage, creates schema or performs another effect
  MUST NOT run during dry-run. Validate its selector without effects, mark the
  deferred resolution in the plan, and perform the lookup only after
  `--execute`. This exception preserves the stronger zero-effect invariant; it
  MUST NOT be used to defer validation that can safely run first.

Changing `kind` is a permission-surface change. It requires a consumer scan,
focused relationship-based access control (REBAC) tests and explicit release
notes; it MUST NOT be deferred as documentation debt when the implementation
already performs the effect.

When this migration corrects an existing `read` operation to `mutate`, Ravi
preserves exact least-privilege grants by appending the corresponding mutate
grant in provider-owned agent defaults, system permission tags, observer rules
and durable observer bindings. The migration MUST preserve the original read
grant and be idempotent. Active, non-revoked runtime context snapshots MUST
receive the same exact compatibility grants so a context issued before the
upgrade does not lose access; expired or revoked contexts MUST remain
unchanged. A legacy read wildcard MUST expand only to exact mutate grants for
reclassified operations that it already authorized; it MUST NOT become a broad
mutate wildcard. The versioned compatibility inventory in
`src/permissions/command-access-kind-migration.ts` MUST stay mechanically
aligned with the live `CommandAccess` metadata.

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
| Emergency stop, authority reduction or containment that reduces exposure | Execute immediately |
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
`agents permissions` requires confirmation only when it expands authority;
revocation, capability removal and no-op updates run immediately.

Commands named `test` are not automatically safe. `triggers test` emits a
synthetic event that can start agent or shell execution and is braked. `hooks
test` is braked only for action types that deliver into sessions. Runtime
`follow-up`, `rollback` and `fork` are braked because they queue work or change
runtime history; an emergency interrupt remains immediate.

## Brake behavior

- The dry-run MUST happen before every side effect: no database/resource
  creation, provider call, event emission, queue publication or worker spawn.
- It MUST return `WRITE_REQUIRES_EXECUTE`, exit `3`, `dryRun: true` and a
  bounded plan identifying the target and material effect.
- Plans, envelopes, suggestions and audits MUST NOT contain tokens, passwords,
  secrets, secret refs, raw invite codes, full prompts/messages/commands,
  secret-bearing paths, provider response bodies or unnecessary personal
  data. Use identifiers and paths only when needed for the decision, plus
  counts, lengths, presence booleans, masked values and bounded non-sensitive
  previews.
- Audit provenance MUST NOT persist raw process or parent-process `argv`
  values. The canonical command and redacted `input` are already recorded;
  `argv` retains only a bounded structural count.
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
- Consumer checks MUST also reject obsolete `--execute` flags on operations
  that now execute immediately; safety and low friction are both contract
  properties.
- Every migrated Commander root is registered in `AGENT_CONTRACT_DOMAINS` in
  `src/cli/index.ts`.

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
6. Update [`MIGRACAO-LEDGER.md`](../../../MIGRACAO-LEDGER.md) with observed
   evidence; never call a regression pre-existing solely because its test file
   was unchanged.
7. Keep the spec `draft` and the PR unapproved until the current head passes
   the global checks and CI. Evidence from an older head does not satisfy this
   gate.
