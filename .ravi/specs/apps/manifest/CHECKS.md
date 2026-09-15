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
  - Fail if `interfaces.cli` is missing.
  - Fail if `interfaces.cli.command` is missing or resolves through the
    dynamic `ravi <app-id>` route.
  - Accept `ravi <app-id>` only when `<app-id>` is a registered static command
    and static resolution cannot re-enter the App Router.
  - Warn if a CLI interface is machine consumed but does not declare JSON
    support.
  - Warn when new manifests declare SDK/tool/stream compatibility metadata
    without a migration reason.
  - Fail if `interfaces.ui` has malformed routes, views, queries, actions, or
    forbidden raw UI code/style keys.
  - Fail if UI routes omit design-system icons.
  - Confirm UI-backed manifests satisfy `apps/ui`.

- Operation check
  - Fail if `operations` exists and is not an object.
  - Fail if operation ids are not fully qualified dot ids.
  - Fail if operation `interface` is not `builtin` or `cli`.
  - Fail if builtin operations omit an allowlisted `handler`.
  - Fail if CLI operations omit `command` or target a different undeclared CLI.
  - Fail if a CLI operation resolves back through its own dynamic app alias.
    Accept identical text only when it resolves to a registered static command.
  - Fail if a command contains shell operators, substitutions, redirection, or
    otherwise requires shell evaluation.
  - Fail if `{args}` is repeated or embedded inside another token.
  - Confirm shell-like user input is passed as literal argv with `shell: false`.
  - Fail if UI query/action operation references are undeclared.
  - Warn if operations omit `mutating`.
  - Fail if mutating, sensitive, or identity-dependent operations omit
    `permission` or `permissions`.

- Permission check
  - Fail if `required`, `optional`, or `mutating` is missing or is not an array.
  - Fail if an operation-level permission is absent from the appropriate
    manifest permission array.
  - Fail if any permission declaration appears to contain a token, key, or raw
    credential.
  - Confirm manifest permissions are treated as requirements, not grants.

- Child-context check
  - Warn and default to an empty capability set when an installed v1 manifest
    omits `context`; fail if `context.allow` is present but not an array.
  - Require new and regenerated manifests to declare `context.allow`.
  - Fail if an entry is not an explicit
    `permission:objectType:objectId` capability.
  - Fail if context metadata requests implicit inheritance.
  - Fail if context metadata contains a raw key, token, credential, or secret.
  - Confirm `context.allow` is treated as a requested ceiling, not a grant.

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
  - Every manifest should satisfy `apps/cli`.
  - UI, SDK, tool, and automation adapters should resolve the same App Router
    operation.
  - Running with and without `--json` should use the same authorization and
    child-context path.
