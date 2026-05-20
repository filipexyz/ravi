---
id: onboarding/recipes
title: "Architect Recipe Catalog"
kind: capability
domain: onboarding
capability: recipes
capabilities:
  - recipes
tags:
  - onboarding
  - architect
  - recipes
  - automation
applies_to:
  - .ravi/recipes
  - src/plugins/internal/ravi-system/skills/architect
owners:
  - ravi-dev
status: draft
normative: true
---

# Architect Recipe Catalog

## Intent

Recipes are the source-of-truth declarative bundles that the Architect uses to translate user intent into Ravi primitives. A recipe describes a working setup as a graph of primitives, inputs, and inverse operations.

The catalog MUST live in version control under `.ravi/recipes/`. Runtime-only recipes are not allowed in v1; if an operator wants a new recipe, they author it as a file and commit it.

## Recipe File

A recipe is a single JSON file at `.ravi/recipes/<id>.json`. The file MUST validate against the schema described below.

### Header

```json
{
  "id": "sales-pipeline-basic",
  "version": "1.0.0",
  "title": "Sales Pipeline (basic)",
  "goal": "sales",
  "surfaces": ["whatsapp"],
  "summary": "...",
  "tags": ["lead", "qualifier", "nurture"],
  "owner": "ravi-system",
  "requiresOperatorLevel": "review"
}
```

- `id`: unique slug across the catalog.
- `version`: semver. Plan artifacts reference this version. A patch-only bump MAY be applied to existing runs; minor/major bumps MUST trigger an explicit reconcile.
- `goal`: aligned with the Architect discovery trail.
- `surfaces`: which channels this recipe touches. The Architect MUST intersect this with the user's surfaces.
- `requiresOperatorLevel`: minimum operator-in-the-loop level (`auto | review | manual`). The Architect MUST refuse to apply recipes that exceed the user's chosen level.

### Inputs

Recipes declare the inputs they need. Each input has:

```json
{
  "name": "qualifier_agent",
  "label": "Nome do atendente qualificador",
  "kind": "identifier",
  "required": true,
  "default": null,
  "validate": "^[a-z][a-z0-9-]*$"
}
```

Allowed `kind` values: `slug | identifier | enum | text | bool | int | tag-list | channel | instance-name`.

Inputs MUST be the only source of customization in the recipe. The recipe body MUST reference inputs via `${inputs.<name>}` placeholders, never user-specific values inlined.

### Primitives

Recipes declare a list of primitive operations. Each item describes what to create or update:

```json
{
  "id": "instance-intake-on",
  "kind": "instance",
  "action": "update",
  "target": "${inputs.instance_name}",
  "spec": {
    "contactIntakeMode": "discovered",
    "defaultContactTags": ["${inputs.initial_tag}"]
  },
  "requires": [],
  "reversibility": "reversible",
  "inverse": {
    "action": "update",
    "spec": { "contactIntakeMode": "off", "defaultContactTags": [] }
  }
}
```

Allowed `kind` values map to existing Ravi primitives only:

- `instance` — `ravi instances create|set`
- `agent` — `ravi agents create|set`
- `route` — `ravi routes set`
- `tag-rule` — JSON file in `.ravi/tag-rules/`
- `observer-rule` — `ravi observers rules set`
- `observer-profile` — Markdown bundle under `.ravi/observers/profiles/`
- `reading-list` — `ravi chats lists ensure`
- `task-profile` — Markdown manifest under `.ravi/profiles/`
- `cron-job` — `ravi cron add`
- `trigger` — `ravi triggers add`
- `spec` — emit Markdown under `.ravi/specs/onboarding/runs/<run-id>/`

Each primitive MUST declare `reversibility`. Irreversible primitives MUST also declare why (e.g., bulk message send, identity merge).

Each primitive MUST declare `inverse` so `architect undo` knows how to revert it.

### Composition

Recipes MAY include other recipes by reference:

```json
{
  "id": "include-triage",
  "kind": "include",
  "target": "triage-observer@1.0.0",
  "inputs": {
    "tag_in": "lead:novo",
    "agent": "${inputs.triage_agent}"
  }
}
```

`include` is resolved at plan time. The resolver MUST pin to the exact semver. Circular includes are forbidden.

### Notes Section

Recipes MAY include a free-text `notes` field with guidance for operators (e.g., "this recipe assumes DM-per-peer dm_scope on the target instance"). The Architect MUST display notes during discovery before asking for inputs.

## Catalog Hygiene

- Recipe ids MUST be globally unique and stable across versions.
- A version bump MUST NOT change the recipe id.
- Recipes MUST declare at least one primitive; empty recipes are not allowed.
- Recipes MUST be validated by `ravi architect recipes validate` before listing — schema, slug references, semver pins, primitive kinds.
- Recipes MUST list their tags so the catalog can be filtered by goal, surface, or owner.

## Versioning Semantics

- **Patch** (`1.0.0 → 1.0.1`): bug fix in spec body, no primitive changes, no input changes. Safe to apply to existing runs via `architect reconcile`.
- **Minor** (`1.0.0 → 1.1.0`): adds optional primitives or optional inputs. Existing runs flagged for opt-in reconcile.
- **Major** (`1.0.0 → 2.0.0`): breaking change in primitives or inputs. Existing runs treated as separate setups; reconcile requires explicit operator action.

## Inverse Operations

Every primitive MUST declare an inverse. Inverses MAY be:

- `noop` (only allowed for primitives that did not exist before the recipe applied);
- `delete` (the primitive is removed);
- `update` (the primitive is reverted to a previous spec snapshot);
- `manual` (the operator MUST review; the recipe declares an explanation).

The Architect uses inverses during `architect undo` and during `architect reconcile` when a recipe is downgraded.

## Catalog Bootstrap

The v1 catalog MUST ship with at least these recipes under `.ravi/recipes/`:

- `sales-pipeline-basic` — intake + initial tag + qualifier observer + nurture observer + weekly tick cron
- `support-triage` — reading list + triage observer + escalation observer + tag-rule for SLA cold
- `personal-assistant` — DM-only instance + main agent + memory observer + heartbeat cron
- `content-curation` — reading list + summarizer observer + artifact delivery
- `notification-hub` — trigger + broadcast agent + per-channel routes

Each MUST live in its own JSON file with full schema + inverse declarations.

## Invariants

- Recipes MUST NOT inline executable code. They are pure configuration.
- Recipes MUST NOT call external services or make HTTP requests during the plan stage.
- Recipes MUST NOT declare primitives outside the allowed `kind` list.
- The catalog MUST be reproducible from `.ravi/recipes/` alone; no database state is required to interpret a recipe.
- All recipe primitives MUST have inverses; the Architect MUST reject recipes missing inverse declarations.

## CLI Surface

```bash
ravi architect recipes list [--goal sales|support|...] [--surface whatsapp|...]
ravi architect recipes show <id>[@<version>]
ravi architect recipes validate [<id>]
ravi architect recipes diff <id>@<v1> <id>@<v2>
```

## Acceptance Criteria

- A recipe in `.ravi/recipes/sales-pipeline-basic.json` validates clean and lists in `ravi architect recipes list --goal sales`.
- `ravi architect plan --recipe sales-pipeline-basic --input ...` produces a plan that creates only the primitives declared by the recipe.
- `ravi architect undo` of that plan reverses each primitive via its declared inverse.
- A breaking recipe change bumps major version and existing runs are flagged for reconcile.

## Known Failure Modes

- **Inline values**: recipe leaks user-specific data into the spec body instead of using `${inputs.X}`.
- **Missing inverse**: primitive declared without inverse → undo cannot revert.
- **Unpinned include**: recipe references another recipe without semver → recipe behavior depends on catalog state at plan time.
- **Schema drift**: recipe file written by hand violates schema and lists silently → CLI MUST refuse and surface schema error.
- **Surface mismatch**: recipe declared for `[whatsapp]` applied to a user with only `[telegram]` → Architect MUST reject before planning.
