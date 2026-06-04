# Ravi App Manifest / CHECKS

## Checks

- `ravi specs get apps/manifest --mode rules --json`
  - Confirms the manifest contract is indexed and retrievable.

- Manifest parse check
  - Parse every discovered `ravi.app.json` as JSON.
  - Fail if `schema` is missing or not `ravi.app/v1`.
  - Fail if required fields are missing.

- App id check
  - Fail if `id` does not match
    `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$`.
  - Fail on duplicate ids and report both paths.

- Interface check
  - Fail if no interface is declared.
  - Warn if a CLI interface is machine consumed but does not declare JSON
    support.
  - Warn if an SDK interface has no namespace.
  - Fail if `interfaces.ui` has malformed routes, views, queries, actions, or
    forbidden raw UI code/style keys.
  - Fail if UI routes omit design-system icons.
  - Confirm UI-backed manifests satisfy `apps/ui`.

- Operation check
  - Fail if `operations` exists and is not an object.
  - Fail if operation ids are not fully qualified dot ids.
  - Fail if operation `interface` is not `cli`, `sdk`, `tool`, or `stream`.
  - Fail if an operation references an undeclared interface block.
  - Fail if CLI operations omit `command`, SDK operations omit
    `namespace`/`method`, tool operations omit `name`, or stream operations omit
    `channel`.
  - Fail if UI query/action operation references are undeclared.
  - Warn if operations omit `mutating`.
  - Warn if mutating operations omit `permission` or `permissions`.

- Permission check
  - Fail if mutating/sensitive interfaces have no declared required or mutating
    permission.
  - Fail if any permission declaration appears to contain a token, key, or raw
    credential.
  - Confirm manifest permissions are treated as requirements, not grants.

- Storage check
  - Fail if `storage` exists and is not an object.
  - Fail if `storage.sqlite` or `storage.files` exists and is not an array.
  - Fail if SQLite entries have invalid `id`, `kind`, `path`, `tables`,
    `migrations`, or `retention` shapes.
  - Fail if file storage entries have invalid `path`, `kind`, or `retention`
    shapes.
  - Fail if storage paths use parent directory segments or operator-specific
    absolute paths instead of relative paths or approved tokens such as
    `$RAVI_STATE_DIR`.

- Event check
  - Fail if `events` exists and is not an object.
  - Fail if `events.emits` or `events.consumes` exists and is not an array.
  - Fail if event topics are not dot-separated topics such as
    `ravi.apps.checked`.
  - Fail if event durability is not `ephemeral`, `logged`, or `replayable`.
  - Fail if consume replay flags are not booleans.
  - Warn when event entries omit `schema`/`schemaRef`, emit `when`, or consume
    handler/interface metadata.

- Discovery safety check
  - Confirm manifest indexing does not spawn binaries, import app code, run
    health checks, or mutate storage.

- Health check
  - Warn if the app has no health check.
  - For CLI-backed health checks, prefer commands ending in `--json`.

- App/CLI consistency check
  - CLI-backed manifests should satisfy `apps/cli`.
  - First-party SDK-facing CLI apps should keep registry, gateway, and SDK
    codegen checks passing.
