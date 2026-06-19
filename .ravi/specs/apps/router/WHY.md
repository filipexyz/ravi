# Ravi App Router / WHY

## Rationale

Ravi Apps are meant to behave like applications in a Web OS and CLI ecosystem.
That means a new app should become visible and operable because it registered a
valid manifest, not because the core CLI was rebuilt with a new command file.

The app router gives Ravi two surfaces:

- a stable operator/agent command: `ravi <app-id>`;
- an explicit router fallback/debug API: `ravi apps run`.

This keeps the CLI ergonomic while preserving a single router path that can
validate manifests, preflight permissions, apply context-key lineage, and emit
audit events.

## Decisions

- `ravi <app-id>` is canonical for humans and agents because apps should feel
  like installed CLI applications, not registry subcommands.
- `ravi apps run <app-id>` remains available because it avoids root command
  collisions and is useful for diagnostics.
- Static commands win over dynamic app ids because first-party CLI contracts
  are already part of the stable Ravi surface.
- Dot-separated local operation names can be expressed as CLI path tokens.
  If `app.test.a` exists, `ravi app test a` should resolve to that operation.
- App manifests declare operation executors. They do not create TypeScript CLI
  commands by themselves.
- Router-owned operations use `interface: "builtin"` so scaffolded apps can
  support help/show/check before domain implementation exists.
- CLI operation commands are allowed, but they must not call the same public
  dynamic alias. Recursion is a spec violation, not a runtime trick to support.
- Dynamic app routes do not automatically enter the SDK decorator registry.
  SDK clients can use a generic app router route unless the app explicitly
  ships a typed SDK surface; CLI prompts should still teach `ravi <app-id>`.

## Rejected Alternatives

- Generating a TypeScript command file for every app: rejected because app
  installation would require build-time work, codegen, and a CLI rebuild.
- Making only `ravi apps run` available: rejected because humans expect a
  direct operator command once an app exists.
- Letting app ids override static commands: rejected because it would make app
  installation capable of changing core CLI behavior.
- Using manifest `interface: "cli"` commands like `ravi <app-id> check`:
  rejected for router-owned operations because it recursively re-enters the
  same dispatcher. User-facing invocation of the router builtin remains valid.
- Executing app code during discovery to ask for routes: rejected because
  discovery must stay side-effect-free.
