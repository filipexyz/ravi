---
id: apps/ui
title: "Ravi App UI Contract"
kind: capability
domain: apps
capability: ui
capabilities:
  - web-os
  - design-system
  - ui-manifest
  - operations
  - events
  - generative-ui
tags:
  - apps
  - ui
  - web-os
  - design-system
  - events
  - artifacts
applies_to:
  - .ravi/specs/apps/ui
  - .ravi/specs/apps/manifest
  - .ravi/specs/artifacts/ui
  - src/apps
  - src/apps/service.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi App UI Contract

## Intent

Define how Ravi Web OS discovers and renders app surfaces from app manifests.

An app UI is a semantic descriptor, not a frontend bundle. The app declares
routes, views, actions, operations, and event subscriptions. Ravi Web OS owns
rendering, design-system tokens, accessibility, responsive behavior, navigation,
permissions preflight, and event wiring.

## Invariants

- App UI MUST be declared under `interfaces.ui` in `ravi.app.json`.
- `interfaces.ui` MUST describe intent with semantic primitives. It MUST NOT
  declare raw CSS, HTML, JavaScript, React components, bundles, class names, or
  Tailwind classes.
- UI routes MUST declare stable `id`, `/apps/<app-id>` path, display `label`,
  design-system `icon`, and target `view`.
- UI views MUST declare stable `id` and a primitive `type`.
- UI view types SHOULD be one of `table`, `list`, `detail`, `form`,
  `dashboard`, `timeline`, `calendar`, `kanban`, `settings`, `split`, or
  `stack`.
- UI views MAY declare `query`, `refreshOn`, `actions`, `layout`, `components`,
  `density`, and domain-specific display hints.
- UI views MAY reference reviewed UI artifacts when the app needs reusable,
  generative, previewable, or cross-surface UI. Such references SHOULD point to
  `ui.catalog`, `ui.spec`, or `ui.component` artifacts as defined by
  `artifacts/ui`.
- App UI descriptors SHOULD keep `query`, `refreshOn`, and `actions` as the app
  harness even when the visual tree comes from a UI artifact. The artifact
  describes renderable UI; the app manifest owns route, operation, freshness,
  and permission wiring.
- UI actions MUST reference a top-level operation. A button without an
  operation is not an app action.
- App operations MUST be declared under top-level `operations`.
- Operation ids MUST be fully qualified dot ids such as `apps.list` or
  `music.playlist.create`.
- Operations MUST declare `interface` as `cli`, `sdk`, `tool`, or `stream`.
- CLI operations MUST declare a command that supports machine-readable output.
  For Ravi-owned CLI apps this SHOULD be `--json`.
- Operations SHOULD declare whether they are `mutating`. Mutating operations
  SHOULD declare required permission or permissions.
- UI state SHOULD start from an operation snapshot and then refresh or patch
  from declared events. UIs MUST NOT scrape stdout for state transitions.
- `refreshOn` event topics MUST be valid dot-separated Ravi event topics.
- Manifest UI declarations do not grant permissions. Runtime execution MUST
  still authorize operations through Ravi permissions/context keys.
- Discovery MUST NOT execute operations, import UI code, run health checks, or
  mutate storage.

## Contract Shape

```json
{
  "interfaces": {
    "ui": {
      "routes": [
        {
          "id": "main",
          "path": "/apps/apps",
          "label": "Apps",
          "icon": "boxes",
          "view": "registry"
        }
      ],
      "views": [
        {
          "id": "registry",
          "type": "table",
          "title": "Apps",
          "density": "compact",
          "query": {
            "operation": "apps.list"
          },
          "refreshOn": [
            "ravi.apps.changed",
            "ravi.apps.checked"
          ],
          "actions": [
            {
              "id": "check",
              "label": "Check",
              "icon": "shield-check",
              "operation": "apps.check",
              "placement": "toolbar"
            }
          ]
        }
      ]
    }
  },
  "operations": {
    "apps.list": {
      "interface": "cli",
      "command": "ravi apps list --json",
      "mutating": false,
      "outputSchema": "schemas/apps-list.v1.json"
    },
    "apps.check": {
      "interface": "cli",
      "command": "ravi apps check {id} --json",
      "mutating": false,
      "outputSchema": "schemas/apps-check.v1.json"
    }
  }
}
```

## UI Artifact References

When a Ravi App uses reusable or generative UI, the app manifest SHOULD
reference UI artifacts instead of embedding large component trees inline:

```json
{
  "interfaces": {
    "ui": {
      "views": [
        {
          "id": "artifact-feed",
          "type": "timeline",
          "uiArtifact": {
            "kind": "ui.spec",
            "artifactId": "art_ui_spec_...",
            "version": 3
          },
          "query": {
            "operation": "artifacts.list"
          },
          "refreshOn": ["ravi.artifacts.completed"]
        }
      ]
    }
  }
}
```

The referenced artifact owns the renderable JSON spec, component contract, or
catalog vocabulary. The app manifest owns the route, operation contract,
freshness policy, and permission boundary.

## Web OS Flow

```text
Web OS boot
  -> ravi apps list/show
  -> render launcher/sidebar from manifests
  -> open /apps/:appId/:route
  -> load interfaces.ui descriptor
  -> execute query operation for snapshot
  -> render with Ravi design-system primitives
  -> user action invokes declared operation
  -> app emits event
  -> UI refreshes, patches, or invalidates affected view
```

## Boundaries

- App UI descriptors are not microfrontends.
- App UI descriptors are not permission grants.
- App UI descriptors are not a replacement for CLI, SDK, or event contracts.
- App-specific frontend bundles MAY exist only behind a future sandboxed UI
  extension spec. They are not part of `ravi.app/v1`.
- Ravi Web OS MUST remain the owner of the unified design system.
- UI artifacts MAY provide reusable render contracts, but they do not grant
  permission to execute actions and they do not carry arbitrary frontend code.

## Validation

- `ravi specs get apps/ui --mode rules --json` MUST return this contract.
- `ravi apps check` SHOULD fail malformed UI routes, views, actions, operation
  references, `uiArtifact` references, forbidden UI code/style keys, and
  malformed operation targets.
- The pilot `apps` manifest SHOULD declare a UI route, view, actions, and
  operations that validate end to end.

## Known Failure Modes

- Letting each app ship its own React/CSS surface fragments the OS.
- Buttons that are not backed by operations create fake UI.
- Eventful apps without `refreshOn` make the UI stale.
- UI code that scrapes stdout couples rendering to human prose.
- Declarative permissions without runtime authorization create false safety.
