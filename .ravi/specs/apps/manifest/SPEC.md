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

The manifest is the bridge between an app implementation and Ravi OS. It
declares the app id, interfaces, operations, permissions, storage, events,
artifacts, skills, health checks, and versioning rules. It does not grant
permissions and does not execute code by itself.

Canonical manifest file name: `ravi.app.json`.
Canonical manifest protocol: `ravi.app/v1`.

## Invariants

- A Ravi App manifest MUST be declarative metadata. Discovery MUST NOT execute
  app binaries, run health checks, import arbitrary code, or mutate storage.
- A manifest MUST include a stable `id` that matches `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$`.
- A manifest MUST include `schema: "ravi.app/v1"`.
- A manifest MUST include `name`, `version`, and `description`.
- A manifest MUST declare at least one interface under `interfaces`: `cli`,
  `sdk`, `stream`, `tool`, or `ui`.
- A manifest MUST declare `permissions.required` for mutating, sensitive, or
  identity-dependent operations. These declarations are requirements, not
  grants.
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
- A manifest MAY declare top-level `operations` for UI, SDK, agent, or
  automation use. UI queries and actions MUST reference declared operations.
- App UI declarations MUST satisfy `apps/ui`. They MUST NOT include raw CSS,
  HTML, JavaScript, React components, class names, Tailwind classes, or frontend
  bundles in `ravi.app/v1`.
- Duplicate app ids are a hard conflict. The runtime or discovery index MUST
  reject the later declaration and report both source paths.
- A plugin MAY package one or more apps, but the plugin is only the container.
  The app manifest defines the operational capability. The plugin manifest
  defines packaging and install/discovery behavior.
- An app manifest MUST NOT bypass REBAC, context-key authorization, skill
  gates, runtime provider boundaries, or plugin association rules.

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
      "command": "ravi music",
      "json": true,
      "health": "ravi music check --json"
    },
    "sdk": {
      "namespace": "music"
    },
    "stream": {
      "channels": []
    },
    "tool": {
      "names": []
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
    "music.library.list": {
      "interface": "cli",
      "command": "ravi music library list --json",
      "mutating": false,
      "outputSchema": "schemas/music-library-list.v1.json"
    },
    "music.library.sync": {
      "interface": "cli",
      "command": "ravi music library sync --json",
      "mutating": true,
      "permission": "music:write",
      "outputSchema": "schemas/music-library-sync.v1.json"
    }
  },
  "permissions": {
    "required": ["music:read"],
    "optional": [],
    "mutating": ["music:write"]
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

## Interface Rules

- `interfaces.cli.command` SHOULD reference the canonical user/operator
  command. CLI-backed apps SHOULD satisfy `apps/cli`.
- `interfaces.cli.json` SHOULD be true for machine-consumed CLIs.
- `interfaces.sdk.namespace` SHOULD match the generated SDK namespace when the
  app is exposed through the SDK gateway.
- `interfaces.stream.channels` SHOULD list stream/control channels for
  long-running or interactive operations that do not belong in the single-shot
  SDK dispatcher.
- `interfaces.tool.names` SHOULD list explicit runtime tools when the app is
  exposed as a tool surface.
- `interfaces.ui` SHOULD satisfy `apps/ui` when the app has a visual surface.
  It SHOULD declare semantic routes and views that Ravi Web OS can render with
  the unified design system.
- `interfaces.ui` MUST NOT declare raw styling, frontend code, component
  bundles, HTML, CSS, JavaScript, class names, or Tailwind classes.

## Operation Rules

- `operations` MAY declare named app operations used by UI, SDK, agents, or
  automations.
- Operation ids SHOULD be fully qualified dot ids such as `apps.list` or
  `music.library.sync`.
- Each operation MUST declare `interface` as `cli`, `sdk`, `tool`, or `stream`.
- CLI operations MUST declare `command` and SHOULD support `--json`.
- SDK operations MUST declare `namespace` and `method`.
- Tool operations MUST declare `name`.
- Stream operations MUST declare `channel`.
- Operations SHOULD declare `mutating` as a boolean.
- Mutating operations SHOULD declare `permission` or `permissions`.
- Operations SHOULD declare input and output schema references when the
  operation is consumed by UI or automation.
- Discovery MUST validate operation metadata without executing operations.

## Permission Rules

- `permissions.required` are capabilities the caller must have before using
  the app.
- `permissions.optional` are capabilities that unlock extra app behavior.
- `permissions.mutating` are capabilities required for write, delete, send,
  publish, or externally visible operations.
- The runtime MAY use manifest permissions to preflight, explain, or route an
  operation. It MUST still perform the actual authorization check at execution
  time.
- CLI-backed apps running inside Ravi SHOULD receive `RAVI_CONTEXT_KEY` through
  the launcher and resolve identity through the context CLI.

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
  protocol, duplicate app id, malformed interface declarations, or executable
  discovery behavior.
- Manifest validation MUST fail when UI routes, views, queries, or actions
  reference undeclared operations or undeclared views.
- Manifest validation MUST fail when UI declarations include raw styling,
  component, HTML, JavaScript, class, Tailwind, or bundle keys.
- Manifest validation MUST fail when operations have malformed ids, undeclared
  interface targets, invalid target metadata, or invalid `mutating` shape.
- Manifest validation SHOULD warn on missing health checks, missing skill for
  agent-operated apps, missing storage ownership for stateful apps, missing
  event declarations for eventful apps, and human-only CLI interfaces.
- A first-party app with CLI and SDK surfaces SHOULD keep decorator registry,
  SDK codegen, and gateway tests passing.

## Validation

- `ravi specs get apps/manifest --mode rules --json` MUST return this
  contract.
- App manifest indexes SHOULD be testable without executing any declared
  binary.
- Duplicate manifest ids SHOULD be covered by a regression test.
- CLI-backed manifests SHOULD be checked against `apps/cli`.
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
