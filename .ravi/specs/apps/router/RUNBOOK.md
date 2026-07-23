# Ravi App Router / RUNBOOK

## Diagnose Missing App Command

If `ravi <app-id> ...` does not work:

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check <app-id> --json
```

If the app is not listed, fix discovery or manifest placement first.

If the app is listed but the root alias does not work, check for a static CLI
collision:

```bash
ravi --help
```

When the app id collides with a static root command, use:

```bash
ravi apps run <app-id> <operation> --json
```

Otherwise, agent and operator guidance should use:

```bash
ravi <app-id> <operation> --json
```

## Diagnose Operation Dispatch

Inspect the manifest:

```bash
ravi apps show <app-id> --json
```

Check that the operation exists, has a valid `interface`, and declares the
required executor fields:

- `builtin.handler`
- `cli.command`
- `sdk.namespace` and `sdk.method`
- `tool.name`
- `stream.channel`

CLI operations must not point back to the same dynamic alias:

```text
ravi <app-id> <operation>
```

Use a router builtin for help/show/check placeholders or point the command at a
real static/external executor.

For dot-separated operation ids, test the CLI-token form too:

```bash
ravi <app-id> test a --json
```

This should resolve to `<app-id>.test.a` when that operation is declared.

## Diagnose Permissions

Read manifest permissions and operation permissions:

```bash
ravi apps show <app-id> --json
```

For runtime execution, verify the caller context has the declared capability.
Manifest permissions are only preflight metadata; the executor still needs real
authorization.

## Diagnose JSON Contract

Run both surfaces when root alias is expected:

```bash
ravi <app-id> check --json
ravi apps run <app-id> check --json
```

Both should return structured JSON on success and failure. If the app has a
static command collision, only the fallback `ravi apps run` form is expected.
