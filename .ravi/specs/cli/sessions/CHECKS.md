# Sessions agent-first CLI contract / CHECKS

## Checks

- `sessions info <unknown> --json` MUST exit 1 with the `SESSION_NOT_FOUND`
  envelope and MUST NOT include `suggestions` (scope enumeration protection).
- An invalid flag on any `sessions` op MUST exit 2 with `acceptedFlags`.
- `sessions reset` and `sessions delete` without `--execute` MUST exit 3 with
  `dryRun: true` and the `plan`, and MUST NOT reset or delete anything.
- `sessions delete-message` and `sessions edit-message` without `--execute`
  MUST exit 3 and MUST NOT queue any provider action.
- Runtime `follow-up`, `rollback` and `fork` without `--execute` MUST exit 3
  before any runtime request; their execute paths MUST forward the option.
- Runtime `interrupt` and `steer` MUST remain immediate.
- With `--execute`, `sessions delete` MUST report `changed: true` and the
  session MUST stop resolving.
- `sessions prune` keeps its native dry-run payload (candidates, exit 0) — the
  generic envelope MUST NOT replace it.
- `sessions list --fields a,b,c --json` MUST return items with only those keys.
- Hint builders and runtime guidance that teach braked ops MUST include
  `--execute` (asserted literally in `sessions.test.ts`).
- `bun test src/cli/commands/sessions.test.ts` SHOULD pass after any change to
  the sessions contract surface.
