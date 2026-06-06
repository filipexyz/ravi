# Ravi App Router / WHY

## Rationale

Ravi Apps are meant to behave like applications in a Web OS and CLI ecosystem.
That means a new app should become visible and operable because it registered a
valid manifest, not because the core CLI was rebuilt with a new command file.

The app router gives Ravi two surfaces:

- a stable canonical API for agents and automations: `ravi apps run`;
- a human-friendly operator alias: `ravi <app-id>`.

This keeps the CLI ergonomic while preserving a single dispatch path that can
validate manifests, preflight permissions, apply context-key lineage, and emit
audit events.

## Decisions

- `ravi apps run <app-id>` is canonical because it avoids root command
  collisions and is easy for agents to reason about.
- `ravi <app-id>` is allowed as sugar only when no static command owns that
  root token.
- Static commands win over dynamic app ids because first-party CLI contracts
  are already part of the stable Ravi surface.
- App manifests declare operation executors. They do not create TypeScript CLI
  commands by themselves.
- Router-owned operations use `interface: "builtin"` so scaffolded apps can
  support help/show/check before domain implementation exists.
- CLI operation commands are allowed, but they must not call the same public
  dynamic alias. Recursion is a spec violation, not a runtime trick to support.
- Dynamic app routes do not automatically enter the SDK decorator registry.
  SDK clients should use a generic `apps.run` route unless the app explicitly
  ships a typed SDK surface.

## Rejected Alternatives

- Generating a TypeScript command file for every app: rejected because app
  installation would require build-time work, codegen, and a CLI rebuild.
- Making only `ravi apps run` available: rejected because humans expect a
  direct operator command once an app exists.
- Letting app ids override static commands: rejected because it would make app
  installation capable of changing core CLI behavior.
- Using manifest CLI commands like `ravi <app-id> check`: rejected for
  router-owned operations because it recursively re-enters the same dispatcher.
- Executing app code during discovery to ask for routes: rejected because
  discovery must stay side-effect-free.
