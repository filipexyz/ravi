# UI Artifacts / CHECKS

## Spec Index

```bash
ravi specs get artifacts/ui --mode rules --json
```

Expected:

- the root `artifacts` rules are inherited;
- `UI Artifacts` rules are present;
- the spec is indexed as `artifacts/ui`.

## UI Spec Structural Check

For every `ui.spec` artifact:

- fail if `schema` is missing;
- fail if `root` is missing or does not reference an element id;
- fail if `elements` is missing or is not an object;
- fail if any element omits `type`, `props`, or `children`;
- fail if any child reference points to a missing element;
- fail if generated specs include raw HTML, CSS, JS, class names, Tailwind
  classes, or arbitrary remote bundle references.

## Catalog Check

For every `ui.catalog` artifact:

- fail if a component lacks an id or props schema reference;
- fail if an action lacks a params schema reference or operation mapping;
- fail if catalog prompt/generation guidance references implementation-only
  details that are not part of the public component contract;
- warn if examples or fixtures are missing.

## Component Check

For every `ui.component` artifact:

- fail if `id`, `version`, `propsSchema`, `slots`, or supported surfaces are
  missing;
- fail if component semver changed incompatibly without migration notes;
- fail if supported surfaces have no renderer reference;
- warn if fixtures, previews, or visual snapshots are missing;
- warn if accessibility notes are missing for interactive components.

## Package Layout Check

For packaged UI artifacts:

- fail if `_ravi/ui.catalog.json`, `_ravi/ui.component.json`,
  `_ravi/ui.spec.json`, or `_ravi/ui.render.json` is missing for its
  corresponding artifact kind;
- fail if schema, fixture, preview, or renderer paths are absolute or contain
  `..`;
- fail if renderer references embed arbitrary generated executable source;
- fail if component TSX, JS, CSS, or static assets are referenced by the
  manifest but not present as artifact version/package assets;
- fail if a surface tries to inject packaged JS/CSS directly into a host page
  without a reviewed renderer, build step, or sandboxed preview runtime;
- fail if preserved `patches.jsonl` contains invalid JSON Patch operations.

## Renderer Check

For every target surface:

- fail closed on unknown component ids;
- fail closed on invalid props;
- fail closed on unresolved actions;
- fail closed on missing renderer implementation;
- ensure action invocation goes through Ravi operations and permissions;
- ensure renderer errors are inspectable from trace or `ui.render` artifacts.

## Streaming Check

For every preserved `ui.patch-stream`:

- validate each patch operation shape;
- validate patch paths as JSON Pointer paths into the spec;
- replay patches into an empty spec and validate the final result;
- ensure the final spec references an approved catalog;
- ensure high-frequency streams are not persisted unless replay/debug/audit
  value is documented.

## App Integration Check

For app manifests referencing UI artifacts:

- fail if referenced UI artifacts are missing when the artifact registry is
  available;
- fail if referenced artifact kind is incompatible with the app UI field;
- fail if the app embeds raw frontend code in `interfaces.ui`;
- warn if a view references a UI artifact but has no `query` or `refreshOn`
  strategy for freshness.
