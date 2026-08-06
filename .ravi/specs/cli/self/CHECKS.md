# Self agent-first CLI contract / CHECKS

## Checks

- Every `self` op MUST remain read-only: context resolution runs with
  `touch: false, readOnly: true` and no DB/NATS mutation happens.
- No `self` op MUST accept `--execute` — the domain is declared brake-free and
  any brake appearing here is a regression of intent.
- `self context --fields identity,session --json` MUST return only the
  requested top-level sections, and the same projection MUST be printed even
  without `--json` when `--fields` is set.
- `self context --json` without `--fields` MUST keep the full packet
  (identity, actor, session, chat, route, recent, permissions, knowledge,
  explain, nextReads).
- The raw context key MUST never appear in any output, and sensitive metadata
  keys MUST print as `[redacted]`.
- `self recent --limit N` MUST pass the bound to the DB lookup and return at
  most N rows; limits outside 1..100 MUST fail clearly.
- Missing context MUST keep the loud legacy failure (exit 1), not a
  suggestions envelope — there is no entity universe to suggest from.
- `bun test src/cli/commands/self.test.ts` SHOULD pass after any change to the
  self contract surface.
