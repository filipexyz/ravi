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
- CLI operations that call `ravi <app-id> ...` for the current app fail as
  recursive aliases.
- `--json` returns structured success and failure output.
- Mutating operations require declared permissions and runtime authorization.
- Router audit includes `appId`, `operationId`, `interface`, `mutating`, status,
  duration, and error class.
- Child CLI/tool execution receives `RAVI_CONTEXT_KEY` when launched inside
  Ravi runtime.
