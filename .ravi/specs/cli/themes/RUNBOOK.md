# Themes agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/themes --mode rules --json`.
2. Reproduce with `--json` and branch on `error.code`.
3. `THEME_INVALID` (exit 2): read `error.issues[]`; each `path` is
   `[file, line, column]`. Contrast failures name the token pair and the
   mode; raise the contrast of that pair in `theme.json` and run
   `ravi themes check <dir>` again.
4. `LIBRARY_PACKAGE_INVALID` (exit 2): the folder has no `theme.json`, a file
   is not UTF-8 or too large, or `$description` is missing for publish or
   propose.
5. Exit `3` with `WRITE_REQUIRES_EXECUTE`: read `error.plan` (scope, slug,
   version, and for `use` the `from`, `to` and `affectedHosts`), then re-run
   with `--execute`.
6. Exit `3` with `LIBRARY_AGENT_CANNOT_PUBLISH` or
   `LIBRARY_AGENT_CANNOT_SET_THEME`: the caller is an agent. Propose instead
   (`ravi themes propose <dir> --scope org --execute`) or ask the operator to
   run the printed command.
7. `LIBRARY_FILES_EXIST` (exit 3) on `init`: the folder already has theme
   files. Use another folder or pass `--force` on purpose.
8. `THEME_NOT_FOUND` (exit 1): list refs with `ravi themes search --json`.
   `USAGE_ERROR` (exit 2) on `themes show active` (or `default`, `none`,
   `check`, `proposals`): those words are routes, not themes; run the
   command in `suggestedAction` (`ravi themes active`).
   `themes use --execute` that prints `= Nothing changed` (JSON
   `unchanged: true`): the pointer already named that theme; nothing was
   written.
9. Pages still show the old look after `use`: private routes refresh live;
   public routes keep the theme they were shipped with until the next
   `ravi pages ship`. `ravi pages outdated --json` lists them.
