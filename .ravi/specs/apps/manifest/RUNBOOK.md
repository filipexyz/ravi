# Ravi App Manifest / RUNBOOK

## Debug Flow

Use this flow when adding or diagnosing a Ravi App manifest.

## Create or Review a Manifest

1. Confirm the app solves a real operational problem, not just a command idea.
2. Choose a stable app id and check for collisions.
3. Declare `schema`, `id`, `name`, `version`, and `description`.
4. Declare the real app CLI under `interfaces.cli.command`.
5. Declare top-level operations as `cli` or router-owned `builtin`.
6. Declare required, optional, and mutating caller permissions.
7. Declare the child-context ceiling under `context.allow`.
8. Declare optional UI, storage, artifacts, events, and skills when useful.
9. Add safe health checks. For machine checks, prefer `--json`.
10. Validate the manifest without executing app code.

## Discovery Debugging

1. Locate the manifest path that should be indexed.
2. Verify the file is named `ravi.app.json`.
3. Verify `schema` is `ravi.app/v1`.
4. Verify `id` matches the allowed app id pattern.
5. Check for another manifest with the same `id`.
6. Resolve relative paths from the manifest directory.
7. Confirm discovery did not run binaries or health checks.

## Permission Debugging

1. Read `permissions.required` and `permissions.mutating`.
2. Confirm the caller has those capabilities through Ravi permission/context
   checks.
3. Confirm `context.allow` contains only the Ravi capabilities the CLI needs.
4. Confirm the launcher issues and passes a fresh child `RAVI_CONTEXT_KEY`.
5. Confirm the parent key and legacy Ravi identity env vars are absent.
6. Confirm the app resolves identity through the context CLI, not ambient
   session env vars.
7. Confirm the execution path still authorizes at runtime even if the manifest
   preflight passed.

## Health Debugging

1. Run the declared health command manually.
2. Confirm it is safe and non-mutating.
3. Confirm it supports `--json` when machine consumed.
4. Confirm failures explain the missing dependency, permission, config, or
   binary.
5. Confirm the health command does not print secrets or context keys.

## Versioning Debugging

1. If an interface changes, decide whether the app version requires a major,
   minor, or patch bump.
2. If storage changes, declare or run migrations before exposing the new app.
3. If permissions change, update the manifest and any operating skill together.
4. If the app id changes, treat it as a new app unless a migration/alias rule is
   explicitly documented.

## Composition Debugging

To make an app offer a service:

1. Pick the operations other apps may call and nothing else. An operation that
   is not listed under `provides` is not offered to other apps.
2. Declare `provides` with the key `<app-id>/<service>`, an exact version and
   the operation ids.
3. Keep the app's `context.allow` to what those operations need: every app that
   requires the service has to declare it in its own `context.allow`, and a
   provider that starts asking for more breaks its consumers until they do.
4. Bump the major version when an offered operation changes in a way an
   existing caller would notice.
5. An existing app that starts offering a service changes two things: apps that
   already call it are refused until they declare `requires`, and its own
   credential then ends with its process. Tell the apps that call it first.

To make an app need a service:

1. Declare `requires` with the service key and a range such as `^1`.
2. Run `ravi apps check <app-id> --json`: a requirement that nothing satisfies
   shows as a warning with the reason. The app still lists and shows; its CLI
   operations are what the router holds back (spec `apps/router`).
3. Declare in your own `context.allow` what the providers declare in theirs; a
   warning that names entries as missing (`insufficient_authority`) tells which.
4. A validation error naming `requires cycle` means two or more apps need each
   other. Break the cycle by moving the shared part into a third app that both
   require.
4. An error about a range means the text is not one the runtime can read. Use
   `^1`, `~1.2`, `1.4.0` or `>=1.2.0 <2`.
