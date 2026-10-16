# Widgets agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/widgets --mode rules --json`.
2. Reproduce with `--json` and branch on `error.code`.
3. `WIDGET_INVALID` (exit 2): read `error.issues[]`; each `path` is
   `[file, line, column]`. `A11Y_*` codes are accessibility errors (missing
   `alt`, a button without a name, a heading out of order); template codes
   name the unknown field, filter or piece.
4. Before writing a widget or a page, read `ravi widgets catalog`: an
   unknown piece or filter usually means the name is not in the catalog.
5. `LIBRARY_PACKAGE_INVALID` (exit 2): `widget.html` is missing, or publish
   or propose has no `widget.json` with `name` and `description`.
6. `USAGE_ERROR` on `init --from-view`: pass the view's uuid (from
   `ravi bases views list <base> --json`), not its name.
7. Exit `3` with `WRITE_REQUIRES_EXECUTE`: read `error.plan`, then re-run
   with `--execute`. Inside an agent, `publish` refuses with
   `LIBRARY_AGENT_CANNOT_PUBLISH`; use `ravi widgets propose <dir> --scope
   org --execute`.
8. A page still shows the old widget: pages pin the version they were
   shipped with. Ship the page again; `ravi pages outdated --json` lists the
   routes behind.
