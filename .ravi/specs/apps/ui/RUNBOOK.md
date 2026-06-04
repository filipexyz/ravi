# Ravi App UI Contract / RUNBOOK

## Add UI To An App

1. Confirm the app has a valid `ravi.app.json`.
2. Declare top-level `operations` for every snapshot or action the UI needs.
3. Add `interfaces.ui.routes` for launcher/navigation entries.
4. Add `interfaces.ui.views` with semantic view types.
5. Link each view `query.operation` to a declared operation.
6. Link each action `operation` to a declared operation.
7. Add `refreshOn` event topics for views that should update after app events.
8. Run `ravi apps check <app-id> --json`.

## Debug A Broken UI Descriptor

1. Run `ravi apps show <app-id> --json` and inspect `manifest.interfaces.ui`.
2. Confirm each route has `id`, `/apps/<app-id>` path, `label`, `icon`, and
   `view`.
3. Confirm each route view exists in `interfaces.ui.views`.
4. Confirm each view query/action references a declared top-level operation.
5. Confirm each operation declares a real interface target.
6. Confirm event topics in `refreshOn` are dot-separated Ravi topics.
7. Remove raw CSS, HTML, JS, bundle, component, class, or Tailwind keys.

## Debug A Stale UI

1. Verify the initial query operation returns current state.
2. Verify the app emits an event after state changes.
3. Verify the view lists that event topic in `refreshOn`.
4. Verify the Web OS event bridge receives the event with `appId` and
   correlation metadata when available.
5. Re-run the query operation to distinguish stale event wiring from stale app
   state.
