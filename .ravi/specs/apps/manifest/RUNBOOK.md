# Ravi App Manifest / RUNBOOK

## Debug Flow

Use this flow when adding or diagnosing a Ravi App manifest.

## Create or Review a Manifest

1. Confirm the app solves a real operational problem, not just a command idea.
2. Choose a stable app id and check for collisions.
3. Declare `schema`, `id`, `name`, `version`, and `description`.
4. Declare at least one interface: CLI, SDK, stream, tool, or UI.
5. Declare top-level operations for UI snapshots, UI actions, SDK calls, agent
   automations, or stream control when they exist.
6. Declare required, optional, and mutating permissions.
7. Declare storage, artifacts, events, and skills when they exist.
8. Add safe health checks. For CLI-backed checks, prefer `--json`.
9. Validate the manifest without executing app code.

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
3. For CLI-backed apps, confirm the launcher passes `RAVI_CONTEXT_KEY`.
4. Confirm the app resolves identity through the context CLI, not ambient
   session env vars.
5. Confirm the execution path still authorizes at runtime even if the manifest
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
