---
id: apps/manifest
title: "Ravi App Manifest"
kind: capability
domain: apps
capability: manifest
capabilities:
  - manifest
  - discovery
  - permissions
  - interfaces
  - operations
  - routing
  - health
tags:
  - apps
  - manifest
  - discovery
  - permissions
  - ui
  - ecosystem
applies_to:
  - .ravi/specs/apps
  - src/plugins
  - src/cli
  - src/sdk/gateway
  - src/runtime/context-registry.ts
  - src/permissions
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi App Manifest

## Intent

Define the machine-readable contract that lets Ravi discover, reason about, and
operate apps as first-class ecosystem units.

The manifest binds one CLI implementation to Ravi OS. It declares the app id,
CLI, operations, caller permissions, child-context ceiling, optional semantic
UI, storage, events, artifacts, skills, health checks, and versioning rules. It
does not grant permissions and does not execute code by itself.

Canonical manifest file name: `ravi.app.json`.
Canonical manifest schema: `ravi.app/v1`.

## Invariants

- A Ravi App manifest MUST be declarative metadata. Discovery MUST NOT execute
  app binaries, run health checks, import arbitrary code, or mutate storage.
- A manifest MUST include a stable `id` that matches `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$`.
- A manifest MUST include `schema: "ravi.app/v1"`.
- A manifest MUST include `name`, `version`, and `description`.
- A manifest MUST declare one canonical CLI implementation under
  `interfaces.cli`.
- `interfaces.cli.command` MUST identify the real app CLI entrypoint and MUST
  NOT resolve through the public dynamic alias `ravi <app-id>`.
- `interfaces.cli.command` MAY be a registered static Ravi command even when
  its text is `ravi <app-id>`, but only when static command precedence
  guarantees that invocation cannot re-enter the dynamic App Router.
- A manifest MAY declare `interfaces.ui` as a semantic presentation descriptor.
- `interfaces.sdk`, `interfaces.tool`, and `interfaces.stream` MAY describe
  discovery metadata, but MUST NOT define operation executors. New manifests
  SHOULD omit them unless another surface consumes that metadata.
- A manifest MUST declare `context.allow` as an array of explicit Ravi
  capabilities requested for the launched child context. An empty array is
  valid for an app that does not call Ravi services.
- A missing `context` block MUST fail validation. The runtime MUST NOT infer or
  inherit capabilities.
- `context.allow` MUST NOT contain `inherit`, wildcard-by-default behavior,
  context keys, tokens, or credentials.
- A manifest MUST declare `permissions.required`, `permissions.optional`, and
  `permissions.mutating` arrays. Empty arrays are valid.
- Mutating, sensitive, or identity-dependent operations MUST declare
  operation-level `permission` or `permissions`, and each declared capability
  MUST appear in the appropriate manifest permission array. These
  declarations are requirements, not grants.
- A manifest MAY declare `permissions.provider` for app-owned domain
  authorization. Provider declarations MUST satisfy `apps/permission-providers`
  and remain decision hooks, not grants.
- A manifest MUST NOT contain secrets, bearer tokens, raw context keys, private
  API keys, or user-specific credentials.
- A manifest SHOULD declare storage ownership when the app persists state. This
  includes database path/table names or file locations, migration notes, and
  retention expectations where useful.
- A manifest SHOULD declare artifacts the app creates, including type, storage
  surface, and lineage fields.
- A manifest SHOULD declare events the app emits or consumes so other agents
  and UIs can observe the app without scraping stdout.
- A manifest SHOULD name the skills that teach agents to operate the app.
- A manifest SHOULD expose health checks for operational readiness. Health
  checks MUST be safe, non-destructive, and support `--json` when CLI-backed.
- A manifest SHOULD declare top-level `operations` for humans, agents, UI, SDK,
  runtime tools, or automations. Every client surface resolves the same
  operation through the App Router.
- A manifest MAY declare operations with `interface: "builtin"` for
  router-owned allowlisted operations such as app help, manifest show, or
  manifest check.
- App UI declarations MUST satisfy `apps/ui`. They MUST NOT include raw CSS,
  HTML, JavaScript, React components, class names, Tailwind classes, or frontend
  bundles in `ravi.app/v1`.
- Duplicate app ids are a hard conflict. The runtime or discovery index MUST
  reject the later declaration and report both source paths.
- A plugin MAY package one or more apps, but the plugin is only the container.
  The app manifest defines the operational capability. The plugin manifest
  defines packaging and install/discovery behavior.
- An app manifest MUST NOT bypass the Permission Provider Runtime, context-key
  authorization, skill gates, runtime provider boundaries, or plugin
  association rules.
- A CLI operation whose command begins with `ravi` MUST execute the entrypoint
  of the current Ravi process. It MUST NOT resolve an older or different Ravi
  installation from `PATH`, because that creates version skew between app
  discovery and operation execution.
- CLI command declarations MUST be tokenizable into executable plus argv and
  MUST NOT require shell evaluation.

## Manifest Shape

The initial manifest contract is:

```json
{
  "schema": "ravi.app/v1",
  "id": "music",
  "name": "Music",
  "version": "0.1.0",
  "description": "Manage playback and playlists.",
  "interfaces": {
    "cli": {
      "command": "musicctl",
      "json": true,
      "health": "musicctl check --json"
    },
    "ui": {
      "routes": [
        {
          "id": "main",
          "path": "/apps/music",
          "label": "Music",
          "icon": "music",
          "view": "library"
        }
      ],
      "views": [
        {
          "id": "library",
          "type": "table",
          "title": "Library",
          "query": {
            "operation": "music.library.list"
          },
          "refreshOn": ["ravi.apps.music.updated"],
          "actions": [
            {
              "id": "sync",
              "label": "Sync",
              "icon": "refresh-cw",
              "operation": "music.library.sync",
              "placement": "toolbar"
            }
          ]
        }
      ]
    }
  },
  "operations": {
    "music.help": {
      "interface": "builtin",
      "handler": "apps.help",
      "mutating": false
    },
    "music.manifest.show": {
      "interface": "builtin",
      "handler": "apps.manifest.show",
      "mutating": false
    },
    "music.permissions.decide": {
      "interface": "cli",
      "command": "musicctl permissions decide --json",
      "mutating": false,
      "inputSchema": "schemas/permission-request.v1.json",
      "outputSchema": "schemas/permission-decision.v1.json"
    },
    "music.library.list": {
      "interface": "cli",
      "command": "musicctl library list --json",
      "mutating": false,
      "outputSchema": "schemas/music-library-list.v1.json"
    },
    "music.library.sync": {
      "interface": "cli",
      "command": "musicctl library sync --json",
      "mutating": true,
      "permission": "music:write",
      "outputSchema": "schemas/music-library-sync.v1.json"
    }
  },
  "context": {
    "allow": [
      "execute:group:artifacts",
      "execute:group:events"
    ]
  },
  "permissions": {
    "required": ["music:read"],
    "optional": [],
    "mutating": ["music:write"],
    "provider": {
      "id": "music.local",
      "version": "0.1.0",
      "interface": "cli",
      "operation": "music.permissions.decide",
      "decisionSchema": "schemas/permission-decision.v1.json",
      "requestSchema": "schemas/permission-request.v1.json",
      "timeoutMs": 500,
      "failClosed": true
    }
  },
  "storage": {
    "sqlite": [
      {
        "id": "state",
        "kind": "state",
        "path": "$RAVI_STATE_DIR/apps/music/state.db",
        "tables": ["playlists", "tracks"],
        "migrations": "migrations/sqlite",
        "retention": "durable"
      }
    ],
    "files": []
  },
  "artifacts": [],
  "events": {
    "emits": [
      {
        "topic": "ravi.apps.music.updated",
        "when": "playlist changes",
        "durability": "logged",
        "schema": "events/music-updated.v1.json"
      }
    ],
    "consumes": []
  },
  "skills": [],
  "health": {
    "checks": []
  },
  "versioning": {
    "compatibility": "semver",
    "migrations": []
  }
}
```

Fields not used by an app MAY be omitted or left empty, except required fields
listed in `Invariants`.

## Discovery

Discovery SHOULD consider these locations, in order, when the relevant runtime
surface supports them:

- `<repo>/src/apps/<app-id>/ravi.app.json`
- `<plugin-root>/apps/<app-id>/ravi.app.json`
- `$RAVI_HOME/apps/<app-id>/ravi.app.json`
- `<agent.cwd>/.ravi/apps/<app-id>/ravi.app.json` only when future runtime-sync
  explicitly enables workspace app discovery

Discovery MUST parse metadata, validate schema, resolve relative paths, and
build an index. It MUST NOT spawn declared binaries or execute health checks
during indexing.

Manifests generated from CLI import are still ordinary `ravi.app/v1`
manifests. Any import provenance, confidence, or review-required metadata
belongs in the import report, generated spec, generated skill, or explicit
manifest extension supported by the validator; discovery MUST NOT infer trust
merely because a manifest was generated.

## Interface Rules

- `interfaces.cli.command` MUST reference the real implementation CLI, such as
  `musicctl` or a registered non-recursive static Ravi command.
- The public operator command is derived from the app id:
  `ravi <app-id> <operation>`. It MUST NOT be used as the implementation
  command when it would resolve through the dynamic App Router.
- A registered static command MAY be textually identical to the app route,
  such as `ravi apps` for the `apps` manifest, only when static resolution
  wins and the command cannot dispatch back into the same dynamic route.
- `interfaces.cli.json` SHOULD be true for machine-consumed CLIs.
- `interfaces.cli.health` MAY point at a safe non-mutating health command under
  the real CLI implementation, such as `musicctl health --json`. It MUST NOT
  point at the public dynamic alias or at the router-owned
  `ravi <app-id> check`.
- SDK, tool, automation, and Web OS callers SHOULD use the generic App Router
  API. They do not require a separate manifest executor.
- Long-running and interactive behavior remains part of the app CLI and SHOULD
  declare CLI launch/display hints rather than a separate stream executor.
- Compatibility `interfaces.sdk`, `interfaces.tool`, or `interfaces.stream`
  metadata MUST NOT be referenced by `operations.*.interface`.
- `interfaces.ui` SHOULD satisfy `apps/ui` when the app has a visual surface.
  It SHOULD declare semantic routes and views that Ravi Web OS can render with
  the unified design system.
- `interfaces.ui` MUST NOT declare raw styling, frontend code, component
  bundles, HTML, CSS, JavaScript, class names, or Tailwind classes.

## Operation Rules

- `operations` MAY declare named app operations used by any caller surface.
- Operation ids SHOULD be fully qualified dot ids such as `apps.list` or
  `music.library.sync`.
- Each operation MUST declare `interface` as `builtin` or `cli`.
- Builtin operations MUST declare an allowlisted router `handler`.
- CLI operations MUST declare `command` and SHOULD support `--json`.
- `{args}` MAY appear once in a CLI operation command, only as a complete argv
  token. It expands to separate user-supplied argv elements and MUST NOT be
  embedded in another token.
- Named placeholders such as `{id}` MUST fail validation. `{args}` is the only
  dynamic command token.
- CLI operation commands MUST NOT contain shell operators, command
  substitutions, redirections, or other constructs that require a shell.
- CLI operation commands MUST resolve to `interfaces.cli.command` or to an
  explicitly declared non-recursive static Ravi implementation command.
- CLI operations generated from imported command metadata SHOULD be reviewed
  before agents or UIs rely on them, especially when mutation risk, permission
  metadata, input schema, or output schema came from heuristics.
- CLI operations MUST NOT command back into their own public dynamic alias,
  such as `ravi <app-id> <operation>`, when that prefix is dynamically routed,
  because that recursively re-enters the app router.
- CLI operations MAY use `ravi <app-id> ...` when `<app-id>` is a registered
  static Ravi command and static resolution guarantees no App Router
  re-entry.
- Operations SHOULD declare `mutating` as a boolean.
- Mutating operations MUST declare `permission` or `permissions`.
- Operations SHOULD declare input and output schema references when the
  operation is consumed by UI or automation.
- Operations MAY declare `authorization.resource` to describe the app-domain
  resource protected by a permission provider. Supported derivations are static
  `id`, positional `idFromArg`, named `idFromOption`, and canonical owner
  principals via `ownerFrom: "actor" | "surface" | "executorAgent"`.
- Operations MAY declare `authorization.input.includeArgs` and
  `authorization.input.includeOptions` to expose selected, sanitized operation
  input fields to an app permission provider. Raw payloads and secret-like
  options MUST NOT be sent by default.
- Discovery MUST validate operation metadata without executing operations.

## Permission Rules

- `permissions.required` are authorization requirements the caller must satisfy
  before using the app.
- `permissions.optional` are capabilities that unlock extra app behavior.
- `permissions.mutating` are capabilities required for write, delete, send,
  publish, or externally visible operations.
- The runtime MAY use manifest permissions to preflight, explain, or route an
  operation. It MUST still perform the actual authorization check at execution
  time.
- `permissions` and `context.allow` are different boundaries:
  - `permissions` gates the caller and app-domain action;
  - `context.allow` bounds what the launched CLI may ask Ravi to do.
- Neither declaration is a grant.
- The App Router MUST issue a fresh child context from `context.allow`, bounded
  by parent authority and runtime policy, before launching the CLI.
- The launcher MUST pass only the child `RAVI_CONTEXT_KEY` as Ravi identity.
  It MUST NOT forward the parent key or synthesize session/agent identity env
  vars.
- Apps MUST use `ravi context ...` and public `ravi ...` commands to consume the
  delegated capability.

## CLI Process Rules

- App input is argv plus any stdin explicitly documented by the app CLI.
- App output is stdout, stderr, and exit status.
- `--json` is a machine-readable output mode. It is not an App host protocol.
- The manifest MUST NOT declare a private App callback URL, JSON-RPC endpoint,
  or raw runtime socket as a requirement for ordinary operation.
- If a CLI command begins with `ravi`, the router MUST execute the current Ravi
  entrypoint rather than resolving another installation from `PATH`.
- The router MUST execute the command without a shell. User input remains argv
  data even when it contains quoting, substitutions, operators, or redirection
  characters.
- The process working directory MUST default to the app root. Any override
  MUST normalize to a bounded allowed app/package root.
- The launcher MUST build an allowlisted environment and MUST NOT inherit
  unrelated parent credentials or secret environment variables.

## Storage Rules

- Ravi core storage (`ravi.db`) is the OS substrate for agents, sessions,
  routes, permissions, context keys, and core runtime state. It MUST NOT become
  a generic database for arbitrary app domain data.
- The app registry/index MAY be shared. It SHOULD be rebuildable from manifests
  and MAY store manifest path, source, hash, version, validation status,
  health status, and `lastCheckedAt`.
- Domain data belongs to app-owned storage. Stateful apps SHOULD declare
  SQLite databases under `$RAVI_STATE_DIR/apps/<app-id>/<db-id>.db`.
- Apps MUST NOT write unrelated domain state into a shared generic
  `app_data` table.
- `storage.sqlite[]` SHOULD declare:
  - `id`: stable database id such as `state`, `cache`, or `ledger`;
  - `kind`: `state`, `cache`, `artifact-index`, `config`, or `ledger`;
  - `path`: concrete or tokenized path;
  - `tables`: tables owned by the app;
  - `migrations`: migration location or strategy when schema changes exist;
  - `retention`: `ephemeral`, `cache`, `durable`, or a domain-specific policy.
- `storage.files[]` SHOULD declare owned file paths or directories, kind,
  retention, and whether entries are cache, config, generated output, or
  artifact backing files.
- App storage paths SHOULD be relative to the app root or use approved tokens
  such as `$RAVI_STATE_DIR`. They MUST NOT rely on operator-specific absolute
  paths unless the app is explicitly local-only.

## Event Rules

- Events belong to the shared Ravi event plane. Apps declare what they emit and
  consume; they do not own the event ledger itself.
- Artifact metadata belongs to the shared artifact ledger. Apps MAY create
  artifacts, but artifact lineage should stay observable through Ravi artifact
  surfaces.
- `events.emits[]` SHOULD declare `topic`, `when`, `durability`, and payload
  schema or schema reference.
- `events.consumes[]` SHOULD declare `topic`, handler/interface, expected
  payload schema, and whether replay is supported.
- Event durability SHOULD be one of `ephemeral`, `logged`, or `replayable`.
- App-emitted events SHOULD carry `appId`, `correlationId`, and relevant
  `artifactId`, `sessionKey`, `contextId`, or domain entity ids when available.
- Apps MUST NOT require agents or UIs to scrape stdout for state transitions
  that should be observable as events.

## Validation Rules

- Manifest validation MUST fail on invalid id, missing required fields, unknown
  schema, duplicate app id, malformed interface declarations, or executable
  discovery behavior.
- Manifest validation MUST fail when UI routes, views, queries, or actions
  reference undeclared operations or undeclared views.
- Manifest validation MUST fail when UI declarations include raw styling,
  component, HTML, JavaScript, class, Tailwind, or bundle keys.
- Manifest validation MUST fail when operations have malformed ids, undeclared
  interface targets, invalid target metadata, or invalid `mutating` shape.
- Manifest validation MUST fail when CLI commands require shell evaluation,
  contain an embedded placeholder, contain more than one dynamic placeholder,
  or cannot be parsed into an executable plus argv.
- Manifest validation MUST fail when an operation interface is not `builtin` or
  `cli`.
- Manifest validation MUST fail when `interfaces.cli` is missing or its command
  resolves to the same dynamic app alias. It MUST accept a textually identical
  registered static command only when static resolution prevents router
  re-entry.
- Manifest validation MUST fail when `context.allow` is present but malformed,
  contains secrets/raw keys, or requests implicit inheritance. A missing block
  in an already-installed v1 manifest MUST warn and resolve to an empty
  capability set; authoring and generation checks MUST still require it.
- Manifest validation MUST fail when router-executed CLI operations recursively
  resolve through `ravi <app-id> ...` for the same app id. It MUST accept that
  text only for registered static commands that cannot enter the dynamic
  route.
- Manifest validation MUST fail when `interfaces.cli.health` resolves through
  the public dynamic alias, targets `ravi <app-id> check`, or invokes a
  mutating/non-health operation.
- Manifest validation MUST fail when builtin operations use handlers outside
  the router allowlist.
- Manifest validation SHOULD warn on missing health checks, missing skill for
  agent-operated apps, missing storage ownership for stateful apps, missing
  event declarations for eventful apps, and human-only CLI interfaces.
- Generic SDK/UI/tool adapters SHOULD be tested against the same App Router
  operation rather than against app-specific executors.

## Validation

- `ravi specs get apps/manifest --mode rules --json` MUST return this
  contract.
- App manifest indexes SHOULD be testable without executing any declared
  binary.
- Duplicate manifest ids SHOULD be covered by a regression test.
- All manifests SHOULD be checked against `apps/cli`.
- UI-backed manifests SHOULD be checked against `apps/ui`.

## Known Failure Modes

- Treating plugin install as a permission grant.
- Executing app binaries during discovery and causing side effects.
- Allowing duplicate app ids and making agent routing ambiguous.
- Shipping a CLI app without `--json`, forcing agents to scrape prose.
- Putting secrets or raw context keys in declarative metadata.
- Declaring permissions in the manifest but skipping runtime authorization.
- Persisting state without declaring ownership, migration, or retention.
- Declaring UI actions that are not backed by operations.
- Letting apps ship raw UI code or styling under the manifest and fragment the
  Web OS design system.
- Defining an app in prose only, with no manifest that UIs, agents, and SDKs can
  inspect.
- Declaring SDK, tool, or stream as independent operation executors.
- Forwarding a parent context key because the manifest omitted a child ceiling.
- Treating `--json` as a private App-to-Ravi protocol.
- Declaring router-owned operations as CLI commands that call the same dynamic
  alias and recurse forever.
- Declaring health checks as the same dynamic app check command and causing
  check recursion.
- Treating declarative CLI commands as shell programs and exposing app args to
  command injection.
