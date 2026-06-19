# UI Artifacts / RUNBOOK

## Create A Reusable Component Artifact

1. Define the component id and semantic purpose.
2. Write the props schema and slot list.
3. Define supported actions and emitted events.
4. Add fixtures with realistic state and edge cases.
5. Implement or reference renderer implementations per target surface.
6. Generate at least one preview/render artifact for review.
7. Add migration notes if this is a new incompatible version.
8. Attach the component to an approved catalog artifact before agents use it.

## Create A Generated UI Spec Artifact

1. Select the active `ui.catalog` artifact/version.
2. Generate or author a `ui.spec` with `schema`, `catalog`, `root`, and
   `elements`.
3. Validate all element types and props against the catalog.
4. Resolve data bindings and operations against Ravi app/operation contracts.
5. Store the spec as a `ui.spec` artifact when it has reuse, replay, review, or
   debug value.
6. Render it on the target surface and create a `ui.render` artifact when a
   snapshot is useful.

## Debug A Broken Generated UI

1. Inspect the render artifact when one exists.

```bash
ravi artifacts show <render_artifact_id> --json
```

2. Follow lineage to the source spec.

```bash
ravi artifacts show <spec_artifact_id> --json
```

3. Confirm the spec references the intended catalog and component versions.
4. Validate that `root` exists in `elements`.
5. Validate every element `type` exists in the catalog.
6. Validate every `props` object against its component schema.
7. Confirm children reference declared element ids.
8. Confirm referenced operations exist and pass permission preflight.
9. Confirm the active surface has renderer implementations for all component
   types and versions.
10. If the issue came from streaming, inspect the trace or preserved
    `ui.patch-stream` and replay patches into a clean spec.

## Promote A Component Version

1. Confirm component fixtures cover happy path, empty state, loading state,
   error state, and dense/mobile constraints when relevant.
2. Render previews on each supported surface.
3. Compare visual snapshots with the prior version.
4. Validate actions and emitted events.
5. Update the catalog artifact to reference the new component version.
6. Record lineage from the catalog update to the component artifact.
7. Archive or deprecate old versions only when no active spec depends on them.

## Artifact Notification Pilot

1. Subscribe a developer-only presenter to artifact lifecycle events.
2. Map `completed` and `failed` artifact events to a `ui.spec` using an approved
   notification catalog.
3. Render a compact notification in the WhatsApp overlay.
4. Expand into an artifact drawer with artifact metadata, events, versions,
   lineage, assets, and source message context.
5. Create `ui.render` artifacts for failures and selected previews so the team
   can inspect what the notification system rendered.

## When Not To Persist

Do not create a UI artifact for:

- every DOM node;
- every hover/focus/intermediate visual state;
- every runtime patch in a high-frequency stream;
- one-off render output with no debug, replay, audit, approval, or reuse value;
- raw generated frontend code that has not been reviewed as a component
  implementation.
