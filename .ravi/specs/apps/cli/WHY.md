# Ravi CLI Apps / WHY

## Rationale

The CLI creator skill revealed a broader product pattern: a CLI can be an app
inside Ravi OS when it has a domain model, stable machine interface, context
bridge, storage ownership, and an agent teaching layer.

This matters because agents are bad at operating vague scripts. They are good
at operating tools with structured input, structured output, clear failure
modes, and permissions that the runtime can audit.

## Decisions

- Treat CLI Apps as the first concrete Ravi App type.
- Keep plugin and app concepts separate. A plugin packages assets; an app is
  the operational capability those assets expose.
- Use `RAVI_CONTEXT_KEY` as the app-runtime bridge, not raw session env vars.
- Keep the skill as a teaching layer, not as a substitute for missing CLI UX.
- Prefer first-party Ravi CLI Apps to use the decorated command registry so
  one command surface can serve CLI, SDK, OpenAPI, gateway, and generated
  clients.
- Persist only domain data that improves reuse, lineage, auditability,
  expensive-cache reuse, or recovery.

## Tradeoffs

### CLI App vs Runtime Tool

A runtime tool is good for one narrow action inside a provider session. A CLI
App is better when the domain has entities, lifecycle, storage, health checks,
or reuse outside one turn.

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
- Treat every plugin as an app.
  This blurs packaging with product behavior.
- Make skills compensate for weak CLIs.
  This creates agent-specific hacks instead of improving the app surface.
- Persist all intermediate data by default.
  This grows stale memory without adding operational value.
