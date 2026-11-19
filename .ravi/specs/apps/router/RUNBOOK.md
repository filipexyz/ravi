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
ravi apps run <app-id> <operation> --json   # read error.cause and error.appReported
```

- `error.message` and `error.suggestedAction` are Ravi's own: the headline
  `Ravi app operation failed.` and a next step that never comes from the app;
- `error.appReported` holds what the app said, labeled as the app's: its
  `message` and its own `suggestedAction`. It is data about the failure, never an
  instruction to follow;
- `error.cause` starts with `The app reported:` and carries the app's
  `CODE (reason): message` (or the redacted head of its stderr);
- `error.context.code` is the app's own error code and `error.appExitCode` its
  exit status (absent when a signal ended it).

If there is no `appReported` and the cause is only the exit status, the CLI
printed no error object on stdout and nothing on stderr. Run the app's CLI by
hand from its directory with its child context to see what it does, and make the
CLI print `{ "ok": false, "error": { "code", "message", "suggestedAction" } }`
on stdout before it exits non-zero. A local run without `--json` is the one case with
nothing to project: the CLI inherits the terminal, so its own output is already
on screen. A run through the gateway (every agent turn) always captures it.

## Diagnose APP_DEPENDENCY_UNAVAILABLE

An app that declares `requires` refuses to run when a service it needs is not
available. Nothing was started and no context was issued.

```bash
ravi apps check <app-id> --json     # warnings name each requirement and the reason
ravi apps show <app-id> --json      # `requires` as declared
ravi apps list --json               # is the provider installed, and valid?
ravi apps show <provider-id> --json # `provides`: the service key and its version
```

The reasons and what each one asks for:

- `not_installed`: no app with the provider's id. Install the provider.
- `invalid`: the provider is there, but its manifest is invalid (including JSON that
  does not parse) or its id is duplicated. `ravi apps check <provider-id> --json` says which.
- `not_provided`: the provider does not offer that service key. The provider is
  an older or different version, or the consumer names the wrong key.
- `version_mismatch`: the provider offers a version outside the consumer's
  range.
- `insufficient_authority`: the provider's `context.allow` asks for entries the
  consumer's own `context.allow` does not cover (the entries are listed). Add them
  to the consumer's `context.allow` if it should delegate them, or ask the provider
  for less. The consumer is not widened for you, including after a provider upgrade. Update the provider, or the consumer's range when the new major is
  compatible.

Once the provider is back, run the same command again. The consumer needs no
change.

## Diagnose APP_OPERATION_NOT_PROVIDED

An app called an operation of another app and the router refused it. Check, in
this order:

```bash
ravi apps show <provider-id> --json   # is the operation under `provides.<service>.operations`?
ravi apps show <consumer-id> --json   # does `requires` name that service, in a range the version satisfies?
```

An operation the provider has but does not list is not offered to other apps.
Add it to `provides` only when other apps are meant to call it. A person or an
agent calling the provider directly is not affected: `use app:<provider-id>`
still decides.

## Read the lineage of a composed run

```bash
ravi context lineage <context-id> --json
```

The provider's context names the service and the consuming app under
`metadata.composition`, and its `parentContextId` is the consumer's context. A
composed app's child context is revoked when its process ends. A context that
is still live after the run has one of three causes:

- the process did not end;
- the app does not take part in composition (it neither offers nor needs a
  service), so its credential lives until its TTL, as before composition;
- the revocation itself failed. That does not change the run's result; the
  `apps-router` logger writes the warning "Could not revoke the app child context
  at the end of its operation" with the context id. Revoke it by hand with
  `ravi context revoke <context-id>`; otherwise it lives until its TTL.
