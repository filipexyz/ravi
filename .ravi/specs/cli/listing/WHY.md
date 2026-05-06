# CLI Listing Contract / WHY

## Rationale

The tasks surface can grow quickly. A call such as "list all tasks" can force the
runtime to read and enrich hundreds or thousands of rows, which is bad for
agents and can stall the conversation.

This is not unique to tasks. Sessions, artifacts, contacts, events, insights,
projects, triggers, hooks, routes, workflows, and calls all need the same
behavior as their histories grow.

## Decisions

- Prefer cursor pagination over offset pagination.
- Make recent bounded output the default.
- Keep full-history scans explicit.
- Use `--all-time` for time-window removal instead of overloading `--all`.
- Treat `--last` as a legacy alias where it already exists.
- Make JSON page metadata mandatory before migrating every CLI.

## Rejected Alternatives

- Keeping each CLI with a different pagination vocabulary.
  This makes agents guess and increases bad calls.
- Returning full matching totals by default.
  Counting can be as expensive as listing and is not always needed.
- Offset pagination as the default.
  Mutable operational data can reorder while an agent is paging through it.
