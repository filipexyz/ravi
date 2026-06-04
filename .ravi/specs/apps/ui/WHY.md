# Ravi App UI Contract / WHY

## Rationale

Ravi needs a web operating system where apps feel native to one environment
instead of a directory of unrelated tools.

The app should decide what it is, which views it exposes, which actions exist,
and which events keep it fresh. The Web OS should decide how that becomes a
screen: tokens, layout behavior, accessibility, interaction states, navigation,
and permission preflight.

## Decisions

- UI is semantic manifest data, not arbitrary app code.
- Operations are top-level because they are useful to UI, agents, SDK clients,
  and automations. A view action should not hide its execution contract inline.
- CLI remains a valid harness. The UI talks to operations; operations may call
  CLI, SDK, tool, or stream surfaces.
- Events are the live bridge. Snapshot comes from operations; freshness comes
  from event topics.
- Raw CSS/HTML/JS/bundles are excluded from `ravi.app/v1` so the first Web OS
  can remain coherent and safe.

## Rejected Alternatives

- Letting apps export React components: rejected for v1 because it creates
  sandboxing, versioning, styling, dependency, and permission problems before
  the OS contract is clear.
- Rendering CLI help as UI: rejected because help text is not state, schema, or
  interaction contract.
- Defining all UI centrally in Web OS: rejected because apps need to own their
  own domain-specific views and actions.
- Using events only with no snapshot operation: rejected because cold boot and
  refresh need deterministic state.
