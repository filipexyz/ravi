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

Domain operations must use `cli`. UI, SDK, tool, and automation callers invoke
the same operation through the App Router and do not define alternate
executors.

CLI operations must not resolve back through the same dynamic alias:

```text
ravi <app-id> <operation>
```

Use a router builtin for help/show/check placeholders or point the command at a
real static/external executor. A command may be textually `ravi <app-id> ...`
only when `<app-id>` is a registered static command and static resolution
cannot re-enter the App Router.

Confirm the command is tokenized into executable plus argv and spawned without
a shell. Pass an argument such as `$(whoami)` or `; false` and verify it reaches
the CLI literally and executes nothing.

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

Then verify child delegation:

```bash
ravi context list --json
ravi context info <child-context-id> --json
```

Confirm:

- `issuedFor` identifies `app:<app-id>`;
- capabilities do not exceed `manifest.context.allow`;
- lineage points to the caller context;
- the app did not receive the parent key;
- unrelated parent credentials and secret environment variables are absent;
- the process working directory is bounded to the declared app/package root;
- failure to issue the child stopped dispatch.

## Diagnose JSON Contract

Run both surfaces when root alias is expected:

```bash
ravi <app-id> check --json
ravi apps run <app-id> check --json
```

Both should return structured JSON on success and failure. If the app has a
static command collision, only the fallback `ravi apps run` form is expected.

Repeat without `--json` and confirm the same routing and authorization path is
used with human-readable output.

## Diagnose A Failed App Operation

A run whose CLI exited non-zero fails as `APP_OPERATION_FAILED` with exit `1`.
The reason is in the failure itself:

```bash
ravi apps run <app-id> <operation> --json   # read error.message and error.cause
```

- `error.message` is `Ravi app operation failed: <the app's own message>`;
- `error.cause` is the app's `CODE (reason): message` (or the redacted head of
  its stderr);
- `error.context.code` is the app's own error code, `error.appExitCode` its exit
  status (absent when a signal ended it), and `error.suggestedAction` its next
  step.

If the message is only `Ravi app operation failed.`, the CLI printed no error
object on stdout and nothing on stderr. Run the app's CLI by hand from its
directory with its child context to see what it does, and make the CLI print
`{ "ok": false, "error": { "code", "message", "suggestedAction" } }` on stdout
before it exits non-zero. A local run without `--json` is the one case with
nothing to project: the CLI inherits the terminal, so its own output is already
on screen. A run through the gateway (every agent turn) always captures it.
