# Insights agent-first CLI contract / CHECKS

## Checks

- `insights show <unknown-id> --json` MUST exit 1 with the
  `INSIGHT_NOT_FOUND` envelope and up to three `suggestions` of real local
  insight ids.
- `insights list --kind <invalid> --json` MUST exit 2 with `USAGE_ERROR` and
  `acceptedValues` listing the valid kinds; `--confidence`, `--importance`
  and `--link-type` MUST behave the same for their enums.
- `insights create` with an invalid enum flag MUST exit 2 and MUST NOT create
  the insight (no insert, no comment, no tag binding).
- An invalid `--limit` on `list` or `search` MUST exit 2 with `USAGE_ERROR`.
- `insights list --json --fields id,kind` MUST return `items` containing only
  the requested fields, with `insights` referencing the same projected array;
  `insights search --json --fields ...` MUST project the same way.
- `insights list --rich` keeps the overlay payload shape and MUST ignore
  `--fields`.
- `insights create` MUST stay unbraked: the local reversible write happens
  immediately, with no `--execute` flag on the surface.
- `bun test src/cli/commands/insights.test.ts` SHOULD pass after any change
  to the insights contract surface.
