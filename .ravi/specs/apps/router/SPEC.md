---
id: apps/router
title: "Ravi App Router"
kind: capability
domain: apps
capability: router
capabilities:
  - runtime-routing
  - cli-alias
  - operation-dispatch
  - permissions
  - audit
tags:
  - apps
  - router
  - cli
  - runtime
  - operations
applies_to:
  - src/apps/router.ts
  - src/apps/failure.ts
  - src/apps/error-contract.ts
  - src/apps/service.ts
  - src/cli/index.ts
  - src/cli/commands/apps.ts
  - src/cli/registry.ts
  - src/cli/audit.ts
  - src/cli/agent-contract.ts
  - src/cli/remote-gateway.ts
  - src/permissions
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi App Router

## Intent

Resolve Ravi App CLI routes at runtime from app manifests.

The App Router lets a newly discovered CLI become operable without generating a
new TypeScript command file, rebuilding Ravi, or adding static Commander
registration for every app. It is a launcher and authorization boundary, not a
second app runtime.

Operator command:

```bash
ravi <app-id> [operation] [args...] --json
ravi <app-id> [operation] [args...] --execute --json
```

Router fallback/debug command:

```bash
ravi apps run <app-id> [operation] [args...] --json
ravi apps run <app-id> [operation] [args...] --execute --json
```

## Invariants

- App route resolution MUST be runtime-based. A newly discovered valid manifest
  MUST NOT require build-time command registration to be invokable through
  `ravi <app-id> <operation>`.
- Static CLI commands MUST take precedence over dynamic app ids.
- `ravi <app-id> ...` is the canonical operator-facing path. `ravi apps run
  <app-id> ...` is the explicit router fallback/debug path and may be used when
  a static command collision disables the root-level app alias.
- The root-level alias MUST activate only when the first argv token is not a
  registered static command, is a valid discovered app id, and is visible to
  the current runtime context.
- Unknown root commands MUST continue to fail through the normal CLI error/help
  path. The app router MUST NOT swallow unrelated Commander errors.
- The router MUST validate the app manifest before dispatching an operation.
- Invalid manifests, duplicate app ids, malformed operations, or missing
  operation executors MUST fail before any app code is executed.
- Duplicate app ids are a hard routing conflict. The router MUST report the
  conflicting manifest sources and MUST NOT choose one implicitly.
- The router MUST resolve operations deterministically.
- `ravi <app-id>` SHOULD show app help/summary.
- `ravi <app-id> show` SHOULD show the app manifest summary.
- `ravi <app-id> check` SHOULD validate the manifest and the shape/safety of
  declared health metadata without executing the app health command.
- `ravi <app-id> <operation>` MUST map to a declared operation id, declared
  alias, or router-owned builtin.
- Dot-separated local operation ids MAY be invoked as whitespace-separated CLI
  tokens. If `app.test.a` is declared, `ravi app test a` MUST resolve to that
  operation before treating `a` as an argument to `app.test`.
- Router-owned builtin operations MUST use an explicit allowlisted handler.
- CLI-backed operations MUST NOT recursively invoke the same public dynamic
  alias, such as `ravi <app-id> <operation>`.
- CLI-backed operations MUST invoke the app's declared CLI implementation or a
  static internal Ravi command that does not re-enter the same dynamic route.
- The router MUST parse the declared command into executable plus fixed argv
  and spawn it without a shell.
- `{args}` MUST be supported only as a complete argv placeholder. User-supplied
  arguments MUST be inserted as separate argv elements and MUST NOT be
  concatenated into a command string.
- Named placeholders such as `{id}` MUST be rejected. `{args}` is the only
  dynamic command token.
- Shell operators, command substitution, redirection, and executable strings
  that require shell evaluation MUST be rejected during manifest validation.
- The app process working directory MUST default to the manifest's app root.
  Any alternate working directory MUST be declarative, normalized, and bounded
  to an allowed app/package root.
- The router MUST perform manifest permission preflight before dispatch.
- The router MUST still rely on the Permission Provider Runtime at execution
  time for mutating, sensitive, externally visible, or identity-dependent
  operations.
- When a runtime/agent principal exists, the router MUST authorize the app
  object before dispatch:
  - non-mutating operation: `use app:<app-id>`;
  - mutating operation: `execute app:<app-id>`.
- When a runtime/agent principal exists, router-owned discovery builtins
  (`help`, `show`, `check`) MUST require `use app:<app-id>` before returning
  manifest details, validation errors, operation ids, or next commands.
- Mutating operations MUST declare `permission` or `permissions`.
- Read-only operations MUST run without `--execute`.
- A mutating operation MUST return the shared exit-3 policy envelope until the
  caller passes `--execute`. The plan MUST contain only the app id, resolved
  operation id, interface, mutation classification, and argument count. Raw
  arguments MUST NOT be copied into the plan.
- The mutation brake MUST run after app-object authorization and operation
  resolution, but before the app permission provider, child-context issuance,
  builtin handler, or subprocess spawn.
- The dynamic root alias MUST consume `--execute` as a Ravi router flag and
  MUST NOT forward it as an app argument.
- When a runtime caller context exists, the router MUST issue a fresh child
  context before launching the app CLI.
- The child context MUST use stable `cliName: "app:<app-id>"`, a bounded TTL,
  lineage to the caller, and explicit capabilities derived from manifest
  `context.allow`.
- The router MUST fail before spawning the CLI when the child context cannot be
  issued with the declared capabilities.
- The router MUST NOT forward the parent `RAVI_CONTEXT_KEY`.
- The child process MUST receive the child `RAVI_CONTEXT_KEY` as its only Ravi
  identity credential. The router MUST NOT synthesize `RAVI_AGENT_ID`,
  `RAVI_SESSION_KEY`, or `RAVI_SESSION_NAME`.
- The router MUST construct a bounded child environment from approved process
  variables and explicit non-secret app metadata. It MUST NOT blindly spread
  the parent environment.
- The router MUST scrub raw credentials, bearer tokens, and unrelated secret
  environment variables. App credentials MUST be resolved through Ravi's
  credential boundary after authorization, not inherited from the launcher.
- The active CLI, tool, or gateway transport MUST emit exactly one terminal
  audit for each app dispatch attempt. It MUST preserve the requested app,
  operation, semantic outcome, exit code, and error code when present. Runtime
  context provenance MAY be added by the transport. Raw arguments, provider
  output, stdout, stderr, and context keys MUST NOT be logged. The internal
  router MUST NOT emit a second terminal audit.
- `--json` MUST produce machine-readable output for router success and failure
  states when requested. It is an output format, not an App transport.
- Missing apps, permission denials, provider failures, and subprocess failures
  MUST cross public CLI, tool, and gateway boundaries as the shared contract
  envelope. Raw provider errors, command strings, stdout, and stderr MUST NOT
  appear in a failure response. The one thing of a failed subprocess that does
  cross is the redacted, bounded projection defined under "Failed App Output".
- App or provider policy decisions `deny`, `needs_grant`, and `not_applicable`
  are `PERMISSION_DENIED` with outcome `denied`. Provider timeout, process
  failure, invalid JSON, and invalid schema are
  `APP_PERMISSION_PROVIDER_FAILED` with outcome `failed`.
- Discovery and help/show/check/list operations MUST NOT execute app binaries,
  run health commands, import arbitrary code, or mutate storage.
- Interactive or streaming app behavior MUST remain a CLI operation and use a
  TTY/stream-capable launcher. It MUST NOT become a distinct operation executor.
- UI, SDK, runtime tool, and automation callers MUST enter through the generic
  App Router and resolve the same operation as the CLI alias.
- Dynamic app routes MUST NOT be added to the static SDK decorator registry by
  default. SDK clients MAY use the generic App Router API.

## Command Contract

```bash
ravi <app-id> [operation] [args...] --json
ravi apps run <app-id> [operation] [args...] --json
ravi <app-id> <mutating-operation> [args...] --execute --json
ravi apps run <app-id> <mutating-operation> [args...] --execute --json
```

Argument handling:

- `<app-id>` is the manifest id.
- `[operation]` defaults to router help/summary when omitted.
- `[operation]` MAY contain dots (`test.a`) or be expressed as nested CLI
  tokens (`test a`) when the declared operation id matches.
- Remaining args are operation-specific and MUST be passed only after the
  operation executor has been resolved and authorized.
- Each remaining arg MUST remain one argv element. Quoting or shell-like text
  in user input MUST be treated as data, not evaluated.
- Global CLI flags such as `--json` and `--execute` MUST retain their normal
  behavior and MUST NOT be forwarded to the app implementation.
- Successful app process completion MAY preserve exit status, stdout, and
  stderr semantics for the requesting transport. Failed process output is
  private diagnostic material: it MUST NOT cross a public boundary as output.
  The caller learns of the failure through the stable contract error and the
  projection defined under "Failed App Output".

## Failed App Output

A Ravi App CLI that exits non-zero, or that a signal ends, fails the run with
`APP_OPERATION_FAILED`. The caller MUST be able to learn why from the failure
response alone, so the router keeps a projection of what the CLI said and never
the output itself. Collapsing a failure to a bare "operation failed" leaves the
agent with nothing to act on, even when the app wrote a structured error.

- The raw stdout, raw stderr, command line, and arguments MUST NOT appear in the
  failure result, the contract envelope, an audit event, or a log. Only the
  projection below crosses.
- The projection is read from the first source that says something:
  1. The app's own error object on stdout: `{ "error": { "code", "reason",
     "message", "suggestedAction", "retryable", "cause" } }`,
     `{ "error": "<text>", "code": ... }`, or a top-level
     `{ "ok": false, "code": ..., "message": ... }` (the shapes the first-party
     apps print with `--json`). It is read field by field: only those fields are
     kept and every other field the app printed is dropped. It MUST NOT be
     redacted as text, because the shared redactor collapses any `{...}` in free
     text into a provider-body marker.
  2. The head of stderr; its first non-empty line is the headline.
  3. Nothing: the cause is the exit status ("The app CLI exited with code N."),
     or "The app CLI was terminated by a signal." when a signal ended it.
  A stdout that is not an error object (data, a log, a stack) is never projected.
- Every projected string MUST pass the shared diagnostic redactor before it is
  kept, with the child context key also masked by exact value in every form an
  app may log it in: as is, base64 (padded or not), base64url, hex (both cases),
  and URL-encoded. A key inside a longer encoded text is not recognized. A
  projected `code` or `reason` MUST be a plain identifier that redaction leaves
  unchanged, otherwise it is dropped. A `retryable` that is not a boolean is
  ignored.
- The projection MUST be bounded: the cause at most 2000 characters, the
  headline and the next step at most 300 each, and a JSON stdout over 65536
  characters is not parsed as an error object. Truncation cuts at a line
  boundary when there is one, never inside a character, and ends with
  ` [truncated]`. Redaction MUST run before the cut, so a credential is never
  cut in half and left half-masked.
- The contract error keeps the router's own code, exit status, headline, and
  next step: code `APP_OPERATION_FAILED`, exit `1`, outcome `failed`, message
  `Ravi app operation failed.`, and a `suggestedAction` that Ravi writes
  (`Resolve the reported cause and retry` when the CLI reported a cause,
  `Inspect redacted runtime logs and retry` when it said nothing). The app's exit
  status MUST NOT be mapped onto the contract exit taxonomy, so an app cannot
  claim exit `3` (blocked) or `2` (usage) for itself.
- Everything the app reported is the app's text: untrusted data about the
  failure, never an instruction to the caller. It MUST NOT become the envelope's
  `message` or `suggestedAction`. It crosses labeled, in fields that name their
  origin: `appReported`, an object holding the app's `message` and
  `suggestedAction` (each one redacted line of at most 300 characters, and no
  other key); `cause`, the redacted explanation; `context.code`, the app's error
  code as an identifier; `appExitCode`, its exit status as a non-negative
  integer, omitted when a signal ended the CLI; and the app's boolean
  `retryable`. A caller, an agent above all, MUST treat these as data and MUST
  NOT run, or adopt as its own next step, anything in them.
- `appExitCode` and `appReported` exist for `apps run` only. The contract
  projection of any other command drops both, and so does the remote relay. The
  remote relay MUST carry the headline, `cause`, `context.code`,
  `suggestedAction`, `retryable`, `appExitCode`, and `appReported` of an
  `apps run` failure to the calling process, and cleans `appReported` again at
  that boundary.
- The terminal audit keeps recording the outcome, the contract exit code, and
  the error code, never text. The app's text MUST NOT enter an audit event.
- Redaction is pattern-based, so it is a net and not a guarantee: a credential
  with no label and no known prefix, or an argument echoed back, is not
  recognized. An app MUST NOT print a credential value on its error paths.
- An app SHOULD print one structured error object on stdout under `--json` and
  exit non-zero: that is the one form that keeps its code, reason, message, and
  next step intact.

## Resolution Order

1. Registered static CLI commands.
2. Root-level dynamic app alias `ravi <app-id> ...`.
3. `ravi apps run <app-id> ...`.
4. Normal CLI unknown-command handling.

Static commands include generated/decorated first-party commands and manually
registered root commands. A manifest id that collides with a static command is
still discoverable, but its root alias is disabled. Operators and agents MUST
use `ravi apps run <app-id> ...` only for that collision/debug case.

## Operation Executor Contract

Operations MAY dispatch to one of these executor types:

- `builtin`: router-owned allowlisted handler.
- `cli`: the app's declared CLI implementation.

Builtin operations MUST declare `handler`, such as `apps.manifest.show`,
`apps.manifest.check`, `apps.help`, or another router-owned allowlisted
handler.

CLI operations MUST declare `command`. The command MUST NOT resolve through the
same dynamic alias being handled, such as `ravi <app-id>` for the current app
id. The same text MAY be used when `<app-id>` is a registered static command
and static command precedence guarantees no dynamic-router re-entry. The
command MUST resolve to the implementation declared by
`interfaces.cli.command`, unless the manifest explicitly references another
static internal Ravi command as the implementation.

`{args}` MAY appear once as a full token in a CLI operation command. It expands
to zero or more argv values. It MUST NOT be embedded inside another token.
Command strings are declarative command lines, not shell programs.

`sdk`, `tool`, and `stream` MUST NOT be operation executor values. Those
surfaces are adapters that call this router.

## App-To-Ravi Contract

The router does not host an App RPC protocol.

1. Ravi launches the app CLI with a child context.
2. The app resolves itself with `ravi context whoami`.
3. The app checks or requests authority with `ravi context check` or
   `ravi context authorize`.
4. The app invokes the public `ravi ...` command it needs.
5. The app returns normal CLI output and exit status.

An app MAY use `--json` on a Ravi command when it needs structured output. That
is ordinary CLI composition, not a distinct App protocol.

## Boundaries

- The app router is not an app discovery index by itself. It consumes the app
  service/registry and refuses ambiguous or invalid entries.
- The app router is not a permission grant. Manifest permissions describe
  requirements; provider-runtime authorization remains authoritative.
- Provider-runtime decisions equivalent to `use app:<id>` and
  `execute app:<id>` are the app isolation boundary for runtime dispatch.
  Manifest permissions MUST NOT be interpreted as grants.
- The app router is not a replacement for first-party static CLI commands.
  Stable core commands may remain build-time registered when they need SDK
  codegen, decorators, or custom parser behavior.
- The app router does not execute SDK, tool, UI, or stream implementations.
  Those surfaces call the router.
- The root-level alias is the user and agent-facing launcher. `ravi apps run`
  is the lower-level router entrypoint for diagnostics and collision fallback.

## Validation

- `ravi specs get apps/router --mode rules --json` MUST return this contract.
- A valid new app manifest SHOULD become invokable through
  `ravi <app-id> check --json` when its id does not collide with a static
  command.
- A valid new app manifest SHOULD also become invokable through
  `ravi apps run <app-id> check --json` without rebuilding the CLI.
- A declared operation id like `<app-id>.test.a` SHOULD become invokable through
  `ravi <app-id> test a --json`.
- A manifest id that collides with a static command SHOULD remain invokable
  through `ravi apps run <app-id> ...`.
- A hidden manifest id SHOULD NOT resolve as a root-level dynamic alias.
- In agent/runtime context, `ravi apps run <app-id> check --json` MUST fail
  without `use app:<app-id>`.
- In agent/runtime context, a mutating operation MUST fail without
  `execute app:<app-id>` even when `use app:<app-id>` is present.
- With `execute app:<app-id>` but without `--execute`, a mutating operation
  MUST be blocked with exit `3` before provider evaluation or process spawn.
- Adding `--execute` MUST run the same resolved operation without forwarding
  the flag to the app.
- In agent/runtime context, a valid operation MUST launch with a new child
  context no broader than manifest `context.allow`.
- A child-context issuance failure MUST produce no app process.

## Known Failure Modes

- Registering every app as a generated TypeScript command makes the ecosystem
  build-time instead of runtime.
- Letting a dynamic alias override a static command breaks established CLI
  contracts.
- Declaring a CLI operation as `ravi <app-id> <operation>` creates recursive
  routing.
- Treating manifest permissions as grants bypasses the Permission Provider
  Runtime and context-key authorization.
- Forwarding the parent context key gives the app undeclared caller authority.
- Implementing SDK/tool/stream as separate executors creates surface-dependent
  behavior and authorization drift.
- Dropping a failed CLI's output entirely makes every app failure read
  "Ravi app operation failed." with no reason, even when the app wrote a
  structured error (found 2026-11-18 while building the `vault` app). Forwarding
  it raw leaks credentials and payloads. Project it, redacted and bounded.
- Passing the app's JSON error through the text redactor turns it into
  `[redacted:provider.body]`; read the fields one by one instead.
- Mapping the app's exit status onto the contract exit codes lets an app
  impersonate `blocked` (3) or `usage_error` (2); carry it as `appExitCode`.
- Treating JSON output as an App protocol duplicates the CLI process contract.
- Executing manifest commands through a shell lets app arguments become command
  injection.
- Blindly inheriting the parent environment leaks credentials and unrelated
  runtime authority.
- Running health checks during discovery creates side effects and slow startup.
- Hiding app route failures behind generic Commander help makes agents unable
  to diagnose missing manifests or invalid operations.
