# Ravi App Router / CHECKS

## Spec Checks

```bash
ravi specs get apps/router --mode rules --json
ravi specs get apps/router --mode full --json
ravi specs sync --json
```

## Regression Checks

- A valid manifest can be invoked with
  `ravi <app-id> check --json` when `<app-id>` does not collide with a static
  command.
- A valid manifest can also be invoked with
  `ravi apps run <app-id> check --json` without CLI rebuild as router fallback.
- A declared operation id like `<app-id>.test.a` can be invoked with
  `ravi <app-id> test a --json`.
- Static root commands take precedence over dynamic app ids.
- Unknown root commands still use normal CLI error/help handling.
- Duplicate app ids fail before dispatch and report both manifest sources.
- Invalid manifests fail before dispatch.
- Missing operation executors fail before dispatch.
- CLI operations that resolve through `ravi <app-id> ...` for the current app
  fail as recursive aliases.
- The same command text succeeds when `<app-id>` is a registered static
  command and static precedence prevents dynamic-router re-entry.
- `--json` returns structured success and failure output.
- Mutating operations require declared permissions and runtime authorization.
- Read-only operations run without `--execute`.
- Mutating operations with authority but without `--execute` return exit `3`
  before permission-provider evaluation, child-context issuance, builtin
  execution, or subprocess spawn.
- The root alias and `apps run` both consume `--execute` without forwarding it
  to the app argument list.
- The blocked plan contains identifiers and argument count, never raw args.
- Missing-app, provider, and subprocess failures remain one canonical envelope
  in CLI, tool, and gateway responses and expose no raw stdout/stderr.
- A CLI that exits non-zero with a JSON error on stdout fails with
  `APP_OPERATION_FAILED`, exit `1`, and Ravi's own headline
  (`Ravi app operation failed.`) and next step (`Resolve the reported cause and
  retry`). The app's message and next step are under `appReported`, its
  code/reason/message in the `cause` (which starts with `The app reported: `),
  its code as `context.code`, its exit status as `appExitCode`, and its
  `retryable`. Every other field the app printed
  is absent. (Fixture exits `2` with a JSON error; asserted at the router, the
  local contract in JSON and text, and through the gateway and the remote relay.)
- The app's `suggestedAction` never appears as the envelope's `suggestedAction`
  and the headline carries no app text, even when the app writes an
  instruction-shaped message and next step (fixture with sentinel text,
  asserted locally and across the relay).
- A CLI that fails with no JSON error fails with the first line of its stderr
  as `appReported.message` and the redacted, bounded stderr as the `cause`
  (starting with `The app reported: `); its stdout (data, log, stack) is never
  projected. With neither, the cause is the exit status.
- The `cause` starts with `The app reported: ` when it carries the app's words
  (a JSON error or stderr) and has no prefix when the CLI said nothing ("exited
  with code N", "terminated by a signal").
- A long stderr is truncated to at most 2000 characters (prefix included)
  ending in ` [truncated]`, `appReported.message` to at most 300, and a
  credential, bearer value, URL query, or the child context key in it is
  redacted.
- The child context key is masked in every form an app may log it in (as is,
  base64, base64url, hex in both cases, URL-encoded): a CLI that prints its own
  `RAVI_CONTEXT_KEY` six ways leaves no form of it in the failure.
- A CLI that a signal ended reports "terminated by a signal" and carries no
  `appExitCode`; the app's exit status is never mapped onto contract exit `2`
  or `3`.
- `appExitCode` is a non-negative integer or absent, and `appReported` is an
  object of at most a one-line `message` and a one-line `suggestedAction` or
  absent; both exist for `apps run` only, in the local projection and across the
  relay.
- The terminal audit of a failed app run carries no app text.
- Provider `deny`, `needs_grant`, and `not_applicable` decisions remain
  `PERMISSION_DENIED`/`denied`; timeout, process failure, invalid JSON, and
  invalid schema remain `APP_PERMISSION_PROVIDER_FAILED`/`failed`.
- Operation interfaces are limited to `builtin` and `cli`.
- UI, SDK, tool, and automation callers route to the same declared operation.
- Declared commands are spawned with `shell: false`.
- `{args}` expands only as complete argv elements; shell-like user input is
  passed literally.
- Named placeholders such as `{id}` fail validation; `{args}` is the only
  dynamic command token.
- Shell operators, substitutions, redirections, embedded placeholders, and
  repeated dynamic placeholders fail manifest validation before spawn.
- The child working directory resolves to the bounded app root.
- The active transport emits one terminal audit with requested app, operation,
  outcome, exit code, and error code; raw args and process/provider output are
  absent, and the internal router emits no duplicate.
- Runtime CLI execution receives a fresh child `RAVI_CONTEXT_KEY`.
- Child capabilities do not exceed manifest `context.allow`.
- The child process does not receive the parent key or synthesized Ravi
  identity env vars.
- Child environment is allowlisted and contains no unrelated parent
  credentials or secret variables.
- Child-context issuance failure spawns no process.
- Audit and process output contain no raw context key.
- Running with and without `--json` uses the same routing, authorization, and
  child-context path.

## Composition Checks

Asserted in `src/apps/router.test.ts` ("Ravi app composition") with real
processes (a `blog` app that requires `md-render/html`, an `md-render` app that
offers it) and the real context registry.

- A consumer that calls its provider produces the lineage turn → `app:blog` →
  `app:md-render` on the contexts (`parentContextId` and `issuedFor` at each
  step), and the provider's context carries `composition: { service,
  consumerAppId }`. The audit follows the same `contextId` and `parentContextId`.
- Each context holds no more than the one above it: the provider holds exactly
  its own `context.allow`, the consumer holds its own `context.allow` plus
  `use app:<provider>` and the `apps run` access (never the provider's allow), and
  the turn held all of it.
- A provider that asks for more than the consumer declares (including after an
  upgrade inside the range) fails the consumer with `APP_DEPENDENCY_UNAVAILABLE`,
  reason `insufficient_authority` and `missing` naming the entries, starts no
  process and issues no context; once the consumer's own manifest declares them it
  runs again with the provider untouched.
- An invoker that does not hold what the chain needs fails with
  `APP_OPERATION_FAILED`, starts no process and issues no context.
- A consumer reaches its provider through the public command and the real gateway
  (`ravi md-render html`, which the CLI sends as `apps run` with the consumer's own
  key): the gateway command gate passes because the consumer's context carries the
  access its invoker held, and the router mediates the call. Without that access
  the same call fails at the gateway.
- A credential an app derived for itself (`kind: cli-runtime`, no app identity,
  parent in the app's lineage) is refused an operation outside `provides` and passes
  one inside it; the provider's context then records the app as the consumer. This
  holds after twenty derivations in a chain, with no depth at which it stops.
- A context whose lineage cannot be followed to a root (the parent is gone) is
  refused every operation of an app that offers services with
  `APP_OPERATION_NOT_PROVIDED`, starts no process, and is not taken for a turn.
- An invoker that holds only the legacy `execute:group:apps` gets no composed
  consumer (no process, no credential), and an invoker that holds `mutate:apps:*`
  gets a consumer with `mutate:apps:run`, never the wildcard or the group.
- Without the provider installed, the consumer fails with
  `APP_DEPENDENCY_UNAVAILABLE`, `unavailableDependencies` names the requirement
  (reason `not_installed`), no process starts and no context is issued. It passes
  again once the provider is installed, with the consumer's manifest and script
  byte-identical.
- A mutating operation of an app whose provider is missing fails with
  `APP_DEPENDENCY_UNAVAILABLE`, not with the exit-3 preview; once the provider
  is installed the same call returns the preview, and neither starts a process.
- A provider outside the range fails with reason `version_mismatch` and the
  installed version; one that does not offer the service, with `not_provided`.
- `help`, `show` and `check` of the consumer keep passing while its provider is
  missing.
- The public contract error for `APP_DEPENDENCY_UNAVAILABLE` carries the cause
  and the next step, is `retryable: false`, and contains no context key.
- An operation the provider has but does not list under `provides` fails with
  `APP_OPERATION_NOT_PROVIDED` when an app calls it, starts no process and issues
  no context. The turn calling the same operation directly passes.
- An app that holds `use app:<provider>` but never declared `requires` fails
  with `APP_OPERATION_NOT_PROVIDED`; the one that declared it, holding the same
  capabilities, passes.
- Both contexts are revoked when their processes end: the provider's as soon as
  its process returns, the consumer's when its own ends, including on a
  non-zero exit. Neither key resolves afterwards and the turn is untouched.
- An app that neither offers nor needs a service keeps a live child context with
  no `composition` metadata.
- A cycle of `requires` makes every app on it invalid (`requires cycle: a -> b ->
  a.`), and no app on it starts.

## Protected Omie queries

- `bun run test:omie-orders` runs the isolated integration suite and MUST appear
  in `test:shard-1`. `src/ci/quality-gate-shards.test.ts` checks shard wiring.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/apps/router.test.ts`
  verifies that authenticated local context wins over ambient context and that
  a query delegates exact capabilities without requesting writes.
- `scope.test.ts` rejects absent/malformed private host configuration and verifies
  fresh loading. Configuration examples contain only synthetic identifiers.
- `identity.test.ts` validates persisted human ancestry, canonical threads,
  account aliases, membership removal, root/permission/connection revocation,
  and tag removal through the contacts API while the child and channel membership
  remain unchanged. Governed turns MUST not become ungoverned after revocation.
- `conversation-authority.test.ts` runs the executor through a second, fake channel
  adapter (verification, membership and capabilities all come from it), proves a
  type with no adapter fails closed in runtime and delegation, upgrades only the
  exact legacy configuration, and fails if a non-test executor file names a
  channel or imports a channel package (static, multi-line and dynamic imports).
- `client.test.ts` verifies the public CLI receives the original child context,
  exact handler arguments and safe errors; candidate generation grants nothing.
- Before publication, inspect the complete diff AND its commit ancestry for
  installation names/identifiers. Configuration and operational evidence stay
  private; a sanitized final tree does not sanitize earlier commits.
- Production acceptance remains a separate operator-authorized procedure:
  install the reviewed runtime/client, validate manifest, then obtain a real
  human query in both channel and thread. Synthetic tests do not prove this.
