# Ravi CLI Apps / WHY

## Rationale

The CLI creator work revealed the simplest durable App model: the CLI is the
application. Ravi only needs to discover it, authorize its caller, delegate a
child context, and launch it.

This matters because agents are bad at operating vague scripts. They are good
at operating tools with structured input, structured output, clear failure
modes, and permissions that the runtime can audit.

## Decisions

- Treat CLI as the canonical implementation type for every Ravi App.
- Keep plugin and app concepts separate. A plugin packages assets; an app is
  the operational capability those assets expose.
- Use `RAVI_CONTEXT_KEY` as the app-runtime bridge, not raw session env vars.
- Issue a new least-privilege child context per launch instead of forwarding
  the caller's context.
- Let the app call ordinary `ravi ...` commands. Do not add a private App SDK
  or App JSON-RPC transport.
- Keep `--json` as an output option for machine callers.
- Keep the skill as a teaching layer, not as a substitute for missing CLI UX.
- Allow a first-party App CLI to use the decorated command registry when it is
  implemented as a static Ravi command. Generated SDK/OpenAPI metadata remains
  CLI compatibility metadata; App callers still use the App Router.
- Persist only domain data that improves reuse, lineage, auditability,
  expensive-cache reuse, or recovery.

## Tradeoffs

### CLI App vs Runtime Tool

A runtime tool is good for one narrow action inside a provider session. A CLI
App is better when the domain has entities, lifecycle, storage, health checks,
or reuse outside one turn. A runtime tool may invoke the App Router, but it does
not become a second implementation of the app.

### CLI App vs Ravi Command

A Ravi Command is a prompt template. It is lightweight and user-invoked. A CLI
App is executable infrastructure with structured output and permissioned
actions.

### CLI App vs Plugin

A plugin is the distribution unit. It may contain the skill, command assets,
or app metadata, but it is not the app by itself.

## Rejected Alternatives

- Let every app invent its own auth environment.
  This loses lineage and makes approvals impossible to reason about.
- Forward the parent Ravi context into the app.
  This gives the app more authority than its declared job requires.
- Add a dedicated JSON host protocol.
  The CLI process contract and public Ravi CLI already cover invocation and
  integration.
- Implement the same app again for SDK, tools, and UI.
  This creates drift and inconsistent permission behavior.
- Treat every plugin as an app.
  This blurs packaging with product behavior.
- Make skills compensate for weak CLIs.
  This creates agent-specific hacks instead of improving the app surface.
- Persist all intermediate data by default.
  This grows stale memory without adding operational value.
