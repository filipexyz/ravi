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
