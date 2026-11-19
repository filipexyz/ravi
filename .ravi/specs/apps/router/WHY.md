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
- Domain operations use `interface: "cli"` and point to the app's real CLI.
  They must not call the same public dynamic alias. A textually identical
  registered static command is valid because static resolution does not
  re-enter the router.
- Every runtime launch gets a least-privilege child context. Passing the
  caller's context would make the app inherit unrelated authority.
- Dynamic app routes do not automatically enter the SDK decorator registry.
  SDK, UI, tools, and automations use the generic App Router route; CLI prompts
  teach `ravi <app-id>`.
- The process contract is enough. JSON remains an output mode, and the app uses
  public `ravi ...` commands to talk to the OS.

## Rejected Alternatives

- Generating a TypeScript command file for every app: rejected because app
  installation would require build-time work, codegen, and a CLI rebuild.
- Making only `ravi apps run` available: rejected because humans expect a
  direct operator command once an app exists.
- Supporting SDK, tool, and stream as independent executors: rejected because
  one app would have multiple implementations and auth paths.
- Adding an App-specific JSON protocol: rejected because CLI composition and a
  child `RAVI_CONTEXT_KEY` already provide invocation, identity, and output.
- Executing manifest command strings through a shell: rejected because
  user-supplied argv would become code and quoting would become
  platform-dependent.
- Inheriting the full parent process environment: rejected because it leaks
  unrelated credentials and authority outside the manifest contract.
- Letting app ids override static commands: rejected because it would make app
  installation capable of changing core CLI behavior.
- Using manifest `interface: "cli"` commands like `ravi <app-id> check`:
  rejected for router-owned operations because it recursively re-enters the
  same dispatcher. User-facing invocation of the router builtin remains valid.
- Executing app code during discovery to ask for routes: rejected because
  discovery must stay side-effect-free.

## Composition

Apps need each other (a blog needs a Markdown renderer), and the question is
where that lives. It lives in the app contract, not in a new runtime: the app
stays an isolated process with a child context, and the manifest says what it
offers (`provides`) and what it needs (`requires`). The router already is the
place that knows who is calling, what they hold and when a process ends, so the
rules sit there.

The shape comes from the Cordis paper's two kinds of composition. Spatial: a
plugin declares the services it needs, and when one disappears the plugin that
needs it reacts instead of crashing (here, the router refuses the run with a
named error, and the app runs again when the provider returns). Temporal: an
effect has an inverse, so what a process was given ends with it (here, the
child context is revoked when the process ends, and the revocation cascades).

## Composition Decisions

- A provider's context is born from the consumer's context, not from the turn,
  so authority only narrows down the chain and the audit reads turn → consumer
  → provider.
- That requires the consumer's context to hold what its provider is issued, so
  the consumer has to be allowed it. The first design added every provider's
  `context.allow` to the consumer's ceiling. The independent review rejected it:
  the consumer then grows with every provider upgrade, its manifest does not
  show it, and declaring `requires` is enough to get it. The decision is that
  the consumer declares what it delegates: its own `context.allow` has to cover
  its provider's, checked before anything starts, and a provider that asks for
  more fails closed (`insufficient_authority`). The lineage stays, and so does
  provider ⊆ consumer ⊆ invoker. The alternative (sibling contexts, both from the
  turn) keeps the ceilings apart and loses the lineage, which is the thing being
  asked for.
- Only operations listed under `provides` pass between apps, and only for
  callers that declared the requirement. That is a contract between apps, not a
  permission system for people who hold the app: a turn calling a provider
  directly keeps `use`/`execute app:<id>`.
- A missing provider refuses the run, not the install. Apps are installed in
  any order, and the manifest of an app is not invalidated by what is not there
  yet. A cycle is different: it is a property of the manifests, found once.
- Revocation at process end applies to apps that take part in composition. An
  app that does neither keeps its credential until the TTL because some apps
  start detached work that outlives the launching process; changing that for
  every app needs its own audit.
- The version grammar is strict because the runtime's semver parser accepts any
  text as "satisfied". A typo must be an error, not a license for every version.

## Composition Rejected Alternatives

- Embedding the Cordis runtime: rejected because it adds a second runtime and a
  second plugin model next to an app model that already isolates processes and
  issues contexts.
- A new App-to-App protocol or in-process calls: rejected because the process
  contract and the child context already carry invocation, identity and audit.
- Resolving `requires` at discovery by querying the provider: rejected because
  discovery must not run apps.
- Revoking every app's credential at process end now: rejected for this change
  because detached workers were not audited.
