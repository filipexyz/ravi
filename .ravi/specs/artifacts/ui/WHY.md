# UI Artifacts / WHY

## Rationale

Ravi is moving toward generative UI, but generated UI must not mean generated
frontend code.

The system needs a stable object model where agents, humans, apps, event
presenters, and renderers can collaborate without coupling every surface to the
same JavaScript runtime. Artifacts already provide lifecycle, lineage,
versions, metadata, attachments, and inspection. UI components and generated UI
specs have the same needs.

The json-render architecture clarifies the primitives:

- catalog: what the AI is allowed to generate;
- spec: the JSON description of UI;
- registry: how a surface renders allowed component types;
- streaming: JSON Patch operations that progressively build or update a spec.

Ravi should absorb those primitives into the artifact ledger so component work
can be reviewed, versioned, previewed, and reused across the entire ecosystem.

## Decisions

- Center reusable UI on artifacts instead of source files alone.
- Treat catalogs, components, specs, selected streams, and debug renders as
  artifact kinds.
- Use a flat `root` plus `elements` UI tree as the default generated spec shape
  because it is easy for agents to patch, validate, diff, and replay.
- Keep renderers surface-owned. The same spec may render in WhatsApp overlay,
  Web OS, terminal, PDF, image, or another surface with different
  implementations.
- Use artifacts for durable UI objects and event/trace storage for high-volume
  patch streams.
- Keep Ravi Apps as the harness and operations layer. Apps may reference UI
  artifacts, but they must not become arbitrary microfrontend bundles.

## Rejected Alternatives

- Letting agents generate React, HTML, CSS, or Tailwind directly.
  Rejected because it is unsafe, hard to review, not portable, and incompatible
  with a unified Ravi design system.
- Making every DOM element an artifact.
  Rejected because artifacts should represent reusable or inspectable units, not
  every transient implementation node.
- Storing only screenshots of UI.
  Rejected because screenshots cannot execute actions, validate props, replay
  patches, or adapt across surfaces.
- Keeping component specs outside the artifact ledger.
  Rejected because this loses lineage, approval state, version history,
  attachments, and relation to generated outputs.
- Adopting one frontend framework as the canonical UI format.
  Rejected because Ravi needs portable specs and surface-native renderers.

## External References

- json-render catalog: https://json-render.dev/docs/catalog
- json-render specs: https://json-render.dev/docs/specs
- json-render registry: https://json-render.dev/docs/registry
- json-render streaming: https://json-render.dev/docs/streaming
- json-render AI SDK integration: https://json-render.dev/docs/ai-sdk
