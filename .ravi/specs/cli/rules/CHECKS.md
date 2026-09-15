# Rules agent-first CLI contract / CHECKS

## Checks

- `rules import` without `--write` MUST write nothing — including when
  `--force` is passed — and MUST return the candidate plan without raw rule
  `content` in JSON.
- `rules import --write` MUST create missing files and MUST skip existing
  imported files (counted as `skippedExisting`) unless `--force` is passed.
- `rules import --write --force` MUST overwrite existing imported files under
  `.ravi/rules/imported/<provider>/<scope>/`.
- The flags `--write` and `--force` MUST NOT be renamed and no `--execute`
  may be added to `import` — the native two-stage brake is the declared
  contract equivalent.
- `rules sources <bogus>` and `rules import <bogus>` MUST exit 2 with the
  `USAGE_ERROR` envelope carrying `acceptedValues` and `suggestions`, before
  any filesystem work.
- `rules sources --fields a,b,c --json` MUST return `sources` containing only
  the requested fields.
- User-level sources MUST stay excluded from `sources` and `import` unless
  `--include-user` is passed.
- No `RULE_NOT_FOUND` surface exists (declared): adding a per-rule lookup op
  later MUST bring the not-found envelope with it.
- `bun test src/cli/commands/rules.test.ts` SHOULD pass after any change to
  the rules contract surface.
